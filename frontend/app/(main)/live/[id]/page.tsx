'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { clock, money, timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { supabase } from '@/lib/supabase';
import { useApp } from '@/components/AppProvider';
import { Avatar, ErrorBox, GiftIcon, Skeleton, Spinner } from '@/components/ui';
import type { LiveView } from '@/types';

// Leaving is deferred briefly so a quick unmount/remount (navigation, React StrictMode)
// doesn't delete the presence row that the remount's heartbeat just wrote.
const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A live room: presence via heartbeat (every 20s, 45s window server-side), chat and
 * gift events via Supabase Realtime on live_messages, gifts paid from the real NGN balance.
 */
export default function LiveRoom() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, openGift, showToast, giftTarget } = useApp();
  const [v, setV] = useState<LiveView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = async (beat = false) => {
    try { setV(beat && me ? await api.liveHeartbeat(id) : await api.live(id)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => {
    clearTimeout(pendingLeave.get(id)); pendingLeave.delete(id);
    refresh(true);
    const hb = setInterval(() => refresh(true), 20000);
    const ch = supabase().channel('live-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_messages', filter: `session_id=eq.${id}` }, () => refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_sessions', filter: `id=eq.${id}` }, () => refresh())
      .subscribe();
    return () => {
      clearInterval(hb); supabase().removeChannel(ch);
      if (me) pendingLeave.set(id, setTimeout(() => { pendingLeave.delete(id); api.liveLeave(id).catch(() => null); }, 1500));
    };
  }, [id, me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh after a gift sheet closes (gift totals + gift message)
  useEffect(() => { if (!giftTarget) refresh(); }, [giftTarget]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [v?.messages.length]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try { await api.liveChat(id, text); setText(''); await refresh(); }
    catch (e) { showToast((e as Error).message); }
    finally { setSending(false); }
  };
  const end = async () => {
    if (!confirm('End this live session for everyone?')) return;
    setEnding(true);
    try { await api.endLive(id); await refresh(); } catch (e) { showToast((e as Error).message); } finally { setEnding(false); }
  };

  if (err && !v) return <ErrorBox message={err} onRetry={() => refresh(true)} />;
  if (!v) return <><Skeleton h={90} /><Skeleton h={360} /></>;
  const ended = v.status === 'ended';

  return (
    <div>
      <div style={s('background:#101410;border-radius:22px;padding:20px;color:#fff;position:relative;overflow:hidden')}>
        <div style={s('position:absolute;right:-50px;top:-60px;width:200px;height:200px;border-radius:50%;background:rgba(208,65,47,.28)')} />
        <div style={s('position:relative;display:flex;align-items:center;gap:12px;flex-wrap:wrap')}>
          <Avatar user={v.host} size={48} radius="15px" onClick={() => router.push('/profile/' + v.host.username)} />
          <div style={s('flex:1;min-width:0')}>
            <div style={s('display:flex;align-items:center;gap:8px')}>
              <span style={{ ...s('font-size:10.5px;font-weight:800;color:#fff;padding:3px 7px;border-radius:5px'), background: ended ? 'rgba(255,255,255,.2)' : '#D0412F' }}>{ended ? 'ENDED' : 'LIVE'}</span>
              <span style={s('font-size:12.5px;color:rgba(255,255,255,.65)')}>{ended ? 'Ended ' + timeAgo(v.endedAt ?? v.startedAt) : `${v.viewers} watching · peak ${v.viewerPeak}`}</span>
            </div>
            <h1 style={s('margin:6px 0 0;font-size:20px;font-weight:800;letter-spacing:-.02em')}>{v.title}</h1>
            <div style={s('font-size:13px;color:rgba(255,255,255,.65);margin-top:2px')}>@{v.host.username} · {money(v.giftTotal)} in gifts</div>
          </div>
          {v.isHost && !ended && <button onClick={end} disabled={ending} className={H.darkGhost} style={s('background:rgba(255,255,255,.12);color:#fff;font-weight:700;font-size:13.5px;padding:10px 18px;border-radius:99px')}>{ending ? 'Ending…' : 'End live'}</button>}
          {!v.isHost && !ended && me && <button onClick={() => openGift({ user: v.host, liveSessionId: v.id })} className={H.gold} style={s('display:flex;align-items:center;gap:7px;background:#C98A12;color:#fff;font-weight:800;font-size:13.5px;padding:10px 18px;border-radius:99px')}><GiftIcon size={15} sw={2.2} />Gift host</button>}
        </div>
        {v.viewerList.length > 0 && (
          <div style={s('position:relative;display:flex;align-items:center;gap:4px;margin-top:14px;flex-wrap:wrap')}>
            {v.viewerList.slice(0, 12).map(u => <Avatar key={u.id} user={u} size={26} />)}
            {v.viewerList.length > 12 && <span style={s('font-size:12px;color:rgba(255,255,255,.65);margin-left:4px')}>+{v.viewerList.length - 12}</span>}
          </div>
        )}
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px;margin-top:14px')}>
        <h2 style={s('margin:0 0 10px;font-size:15px;font-weight:800')}>Live chat</h2>
        <div ref={listRef} style={s('display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;padding-right:4px')}>
          {v.messages.length === 0 && <div style={s('font-size:13.5px;color:#6B7268;padding:18px 0;text-align:center')}>No messages yet. Say hello!</div>}
          {v.messages.map(m => (
            <div key={m.id} style={{ ...s('display:flex;gap:9px;align-items:flex-start'), ...(m.kind === 'GIFT' ? s('background:#FFFCF4;border:1px solid rgba(201,138,18,.3);border-radius:12px;padding:8px 10px') : {}) }}>
              <Avatar user={m.user} size={26} />
              <div style={s('flex:1;min-width:0')}>
                <span style={s('font-size:13px;font-weight:700')}>@{m.user.username}</span>{' '}
                <span style={{ ...s('font-size:13px;line-height:1.5'), color: m.kind === 'GIFT' ? '#8A5E08' : '#3C433A', fontWeight: m.kind === 'GIFT' ? 800 : 500 }}>{m.kind === 'GIFT' ? '🎁 ' : ''}{m.body}</span>
                <span style={s('font-size:11px;color:#9AA197;margin-left:6px')}>{clock(m.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
        {!ended && me && (
          <div style={s('display:flex;align-items:center;gap:8px;margin-top:12px;background:#F5F7F4;border-radius:99px;padding:6px 6px 6px 14px')}>
            <input value={text} onChange={e => setText(e.target.value.slice(0, 300))} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Say something…" aria-label="Chat message" style={s('flex:1;min-width:0;border:0;background:none;outline:none;font-size:14px')} />
            <button onClick={send} disabled={!text.trim() || sending} className={H.green} style={{ ...s('color:#fff;font-weight:800;font-size:13px;padding:9px 16px;border-radius:99px;display:flex;align-items:center;gap:6px'), background: text.trim() ? '#14975C' : 'rgba(16,20,16,.16)' }}>{sending && <Spinner size={12} color="#fff" />}Send</button>
          </div>
        )}
        {ended && <div style={s('margin-top:12px;font-size:13px;color:#6B7268;text-align:center')}>This live session has ended.</div>}
      </div>
    </div>
  );
}
