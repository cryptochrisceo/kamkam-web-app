'use client';
import { useEffect, useRef, useState } from 'react';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { clock, timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useViewport } from '@/hooks/useViewport';
import { useApp } from '@/components/AppProvider';
import { Avatar, GiftIcon, I, Icon, Spinner } from '@/components/ui';
import type { Message } from '@/types';

export default function MessagesPage() {
  const { isMobile } = useViewport();
  const { openGift, showToast, refreshMe } = useApp();
  const router = useRouter();
  const active = useSearchParams().get('c');
  const convs = useAsync(() => api.conversations(), [], { pollMs: 5000 });
  const list = convs.data?.conversations ?? [];
  const activeId = active ?? (!isMobile ? list[0]?.id : undefined);
  const thread = useAsync(() => (activeId ? api.messages(activeId) : Promise.resolve(null)), [activeId], { pollMs: 3000, enabled: !!activeId });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState<Message[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const [rec, setRec] = useState<{ mr: MediaRecorder; started: number } | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  const [attaching, setAttaching] = useState(false);

  // Realtime: new messages in this thread arrive instantly (RLS-filtered); polling remains as fallback.
  useEffect(() => {
    if (!activeId || !supabaseConfigured) return;
    const ch = supabase().channel('conv-' + activeId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${activeId}` }, () => { thread.reload(); api.readConversation(activeId).catch(() => null); })
      .subscribe();
    return () => { supabase().removeChannel(ch); };
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setRecSecs(Math.floor((Date.now() - rec.started) / 1000)), 250);
    return () => clearInterval(t);
  }, [rec]);

  const sendFile = async (file: File, kind: 'IMAGE' | 'AUDIO') => {
    if (!activeId) return;
    setAttaching(true);
    try { const r = await api.sendAttachment(activeId, file, kind); setLocal(l => [...l, r.message]); convs.reload(); }
    catch (e) { showToast((e as Error).message); }
    finally { setAttaching(false); }
  };

  const toggleVoice = async () => {
    if (rec) { rec.mr.stop(); return; }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { showToast('Voice notes are not supported in this browser'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/ogg', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      const started = Date.now();
      mr.ondataavailable = e => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        setRec(null); setRecSecs(0);
        const base = (mr.mimeType || type || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type: base });
        if (blob.size < 800 || Date.now() - started < 600) { showToast('Voice note too short'); return; }
        sendFile(new File([blob], 'voice.' + (base.split('/')[1] || 'webm'), { type: base }), 'AUDIO');
      };
      mr.start();
      setRec({ mr, started });
      // Safety cap: 2 minutes
      setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, 120000);
    } catch { showToast('Microphone permission was denied'); }
  };

  useEffect(() => { setLocal([]); if (activeId) api.readConversation(activeId).then(() => { convs.reload(); refreshMe(); }).catch(() => null); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const msgs = [...(thread.data?.messages ?? []), ...local.filter(l => !thread.data?.messages.some(m => m.id === l.id))];
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  const send = async () => {
    if (!draft.trim() || !activeId) return;
    setSending(true);
    try {
      const r = await api.sendMessage(activeId, draft.trim());
      setLocal(l => [...l, r.message]); setDraft(''); convs.reload();
    } catch (e) { showToast((e as Error).message); }
    finally { setSending(false); }
  };
  const other = thread.data?.user;
  const showList = !isMobile || !activeId;
  const showChat = !isMobile || !!activeId;

  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;overflow:hidden;display:flex;min-height:560px;height:calc(100vh - 150px)')}>
      {showList && (
        <div style={isMobile ? s('width:100%;display:flex;flex-direction:column') : s('width:272px;flex:none;border-right:1px solid rgba(16,20,16,.07);display:flex;flex-direction:column')}>
          <div style={s('padding:16px 16px 12px;border-bottom:1px solid rgba(16,20,16,.07)')}><div style={s('font-size:16px;font-weight:800')}>Messages</div></div>
          <div style={s('overflow-y:auto;flex:1')}>
            {convs.loading && !convs.data && [0, 1, 2].map(i => <div key={i} className="kk-skel" style={{ height: 56, margin: 12 }} />)}
            {convs.error && <div style={s('padding:16px;font-size:13px;color:#A8331F;font-weight:700')}>{convs.error}</div>}
            {convs.data && list.length === 0 && <div style={s('padding:24px 16px;font-size:13.5px;color:#6B7268;line-height:1.6')}>No conversations yet. Open someone’s profile and tap <b>Message</b>.</div>}
            {list.map(t => {
              const on = t.id === activeId;
              return (
                <button key={t.id} onClick={() => router.replace('/messages?c=' + t.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '12px 14px', background: on ? '#F1F6F2' : 'transparent', borderLeft: on ? '3px solid #14975C' : '3px solid transparent', transition: 'background .15s' }}>
                  <Avatar user={t.user} size={42} />
                  <div style={s('flex:1;min-width:0;text-align:left')}>
                    <div style={s('display:flex;justify-content:space-between;gap:8px')}><span style={s('font-size:14px;font-weight:700')}>{t.user.displayName}</span><span style={s('font-size:11.5px;color:#9AA197;font-weight:600')}>{t.lastMessage ? timeAgo(t.lastMessage.createdAt) : ''}</span></div>
                    <div style={{ ...s('font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), color: t.unread ? '#101410' : '#6B7268', fontWeight: t.unread ? 700 : 400 }}>{t.lastMessage ? (t.lastMessage.mine ? 'You: ' : '') + t.lastMessage.text : 'Say hello'}</div>
                  </div>
                  {t.unread > 0 && <span style={s('background:#14975C;color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:99px')}>{t.unread}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {showChat && (
        <div style={s('flex:1;display:flex;flex-direction:column;min-width:0')}>
          {!activeId ? (
            <div style={s('flex:1;display:flex;align-items:center;justify-content:center;color:#6B7268;font-size:14px')}>Select a conversation</div>
          ) : (
            <>
              <div style={s('display:flex;align-items:center;gap:11px;padding:13px 16px;border-bottom:1px solid rgba(16,20,16,.07)')}>
                {isMobile && <button onClick={() => router.replace('/messages')} aria-label="Back" className={H.ghost} style={s('width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#3C433A')}><Icon d={I.back} size={18} sw={2.2} /></button>}
                {other ? <Avatar user={other} size={38} onClick={() => router.push('/profile/' + other.username)} /> : <div className="kk-skel" style={{ width: 38, height: 38, borderRadius: '50%' }} />}
                <div style={s('flex:1;min-width:0')}>
                  <div style={s('font-size:14.5px;font-weight:700')}>{other?.displayName ?? '…'}</div>
                  <div style={s('font-size:12.5px;color:#14975C;font-weight:600')}>{other ? '@' + other.username : ''}</div>
                </div>
                {other && (
                  <button onClick={() => openGift({ user: other })} className={H.goldSoft} style={s('display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#8A5E08;background:#FCF3E0;border:1px solid rgba(201,138,18,.28);padding:8px 13px;border-radius:99px')}>
                    <GiftIcon size={15} full={false} />Gift
                  </button>
                )}
              </div>
              <div style={s('flex:1;padding:18px 16px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;background:#FAFBF9')}>
                {thread.loading && !thread.data && <div style={s('margin:auto;color:#14975C')}><Spinner /></div>}
                {thread.error && <div style={s('font-size:13px;color:#A8331F;font-weight:700')}>{thread.error}</div>}
                {thread.data && msgs.length === 0 && <div style={s('margin:auto;font-size:13.5px;color:#6B7268')}>No messages yet — say hi 👋</div>}
                {msgs.map(m => {
                  const gift = m.kind === 'GIFT';
                  return (
                    <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.mine ? 'flex-end' : 'flex-start', gap: 3 }}>
                      <div style={gift
                        ? s('max-width:78%;padding:12px 15px;border-radius:16px;background:#FCF3E0;border:1px solid rgba(201,138,18,.3);color:#8A5E08;font-size:14.5px;font-weight:800')
                        : { maxWidth: '78%', padding: '11px 14px', borderRadius: m.mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px', background: m.mine ? '#14975C' : '#fff', color: m.mine ? '#fff' : '#101410', border: m.mine ? 'none' : '1px solid rgba(16,20,16,.08)', fontSize: 14.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(m.attachment ? { padding: 6 } : {}) }}>{m.attachment ? <Attachment path={m.attachment} kind={m.kind} /> : m.text}</div>
                      <div style={s('font-size:11px;color:#9AA197;font-weight:600;padding:0 4px')}>
                        {gift && !m.mine && m.meta?.creatorAmountNgn ? `You received ₦${Number(m.meta.creatorAmountNgn).toLocaleString()}` : clock(m.createdAt) + (m.mine && m.read ? ' · Read' : '')}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottom} />
              </div>
              <div style={s('display:flex;align-items:center;gap:8px;padding:12px 14px;border-top:1px solid rgba(16,20,16,.07)')}>
                <input ref={imgInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { const f = e.target.files?.[0]; if (f) sendFile(f, 'IMAGE'); e.target.value = ''; }} />
                <button aria-label="Attach image" disabled={attaching} onClick={() => imgInput.current?.click()} className={H.greenTint} style={s('width:36px;height:36px;border-radius:10px;color:#14975C;display:flex;align-items:center;justify-content:center')}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m4 17 5-5 4 4 3-2.5 4 3.5" /></svg></button>
                <button aria-label={rec ? 'Stop and send voice note' : 'Voice message'} disabled={attaching} onClick={toggleVoice} className={rec ? '' : H.greenTint} style={{ ...s('height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;font-weight:800'), minWidth: 36, padding: rec ? '0 10px' : 0, color: rec ? '#fff' : '#14975C', background: rec ? '#D0412F' : undefined }}>{rec && <span>{Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</span>}<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></button>
                <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} placeholder="Start a message" aria-label="Message" maxLength={2000} style={s('flex:1;min-width:0;border:1px solid rgba(16,20,16,.1);border-radius:99px;padding:10px 16px;outline:none;font-size:14px;background:#FAFBF9')} />
                <button onClick={send} disabled={sending || !draft.trim()} className={H.green} style={{ ...s('background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:10px 18px;border-radius:99px'), opacity: draft.trim() ? 1 : 0.55 }}>Send</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Private DM attachment: fetched through a short-lived signed URL (members only). */
function Attachment({ path, kind }: { path: string; kind: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; api.attachmentUrl(path).then(u => live && setUrl(u)).catch(() => live && setFailed(true)); return () => { live = false; }; }, [path]);
  if (failed) return <span style={s('display:block;padding:6px 8px;font-size:13px;opacity:.8')}>Attachment unavailable</span>;
  if (!url) return <span className="kk-skel" style={{ display: 'block', width: kind === 'AUDIO' ? 220 : 200, height: kind === 'AUDIO' ? 40 : 150 }} />;
  if (kind === 'AUDIO') return <audio controls src={url} style={{ display: 'block', width: 240, maxWidth: '100%' }} />;
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Photo" style={{ display: 'block', maxWidth: 260, maxHeight: 280, borderRadius: 12, objectFit: 'cover' }} /></a>;
}