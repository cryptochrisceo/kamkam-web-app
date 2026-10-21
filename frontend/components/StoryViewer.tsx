'use client';
import { useEffect, useState } from 'react';
import { api, mediaUrl, type StoryAuthor } from '@/lib/api';
import { timeAgoLong } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import { useApp } from './AppProvider';
import { Avatar, GiftIcon, I, Icon } from './ui';

/** 24-hour stories (stored in Supabase), shown in the prototype's story viewer. */
export function StoryViewer({ users, index, onClose, onIndex, onChanged }: {
  users: StoryAuthor[]; index: number; onClose: () => void; onIndex: (i: number) => void; onChanged?: () => void;
}) {
  const { isMobile } = useViewport();
  const { openGift, showToast } = useApp();
  const u = users[index % users.length];
  const [k, setK] = useState(0);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => setK(0), [u.id]);
  const story = u.stories[Math.min(k, u.stories.length - 1)];

  const next = () => {
    if (k < u.stories.length - 1) setK(k + 1);
    else if (index < users.length - 1) onIndex(index + 1);
    else onClose();
  };
  const prev = () => { if (k > 0) setK(k - 1); else if (index > 0) onIndex(index - 1); };

  const sendReply = async () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const c = await api.startConversation(u.id);
      await api.sendMessage(c.id, `Replying to your story: ${reply.trim()}`);
      setReply(''); showToast('Reply sent to ' + u.displayName);
    } catch (e) { showToast((e as Error).message); }
    finally { setSending(false); }
  };
  const remove = async () => {
    if (!confirm('Delete this story?')) return;
    try { await api.deleteStory(story.id); showToast('Story deleted'); onChanged?.(); onClose(); }
    catch (e) { showToast((e as Error).message); }
  };

  return (
    <div style={s('position:fixed;inset:0;z-index:95;background:#0B0E0B;display:flex;align-items:center;justify-content:center;animation:kkFade .2s ease-out')} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Story"
        style={{ position: 'relative', width: isMobile ? '100%' : 392, height: isMobile ? '100%' : 700, maxHeight: '100vh', background: '#141814', borderRadius: isMobile ? 0 : 24, display: 'flex', flexDirection: 'column', animation: 'kkIn .28s cubic-bezier(.2,.9,.3,1)' }}>
        <div style={s('display:flex;gap:4px;padding:12px 12px 0')}>
          {u.stories.map((_, i) => <span key={i} style={{ flex: 1, height: 3, borderRadius: 99, background: i <= k ? '#fff' : 'rgba(255,255,255,.28)' }} />)}
        </div>
        <div style={s('display:flex;align-items:center;gap:11px;padding:12px')}>
          <Avatar user={u} size={36} />
          <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700;color:#fff')}>{u.isMe ? 'Your story' : u.displayName}</div><div style={s('font-size:12px;color:rgba(255,255,255,.6)')}>{story ? timeAgoLong(story.createdAt) : ''}</div></div>
          <button onClick={onClose} aria-label="Close story" className={H.darkGhost2} style={s('width:34px;height:34px;border-radius:11px;color:#fff;display:flex;align-items:center;justify-content:center')}><Icon d={I.close} d2={I.close2} size={19} sw={2.2} /></button>
        </div>
        <div onClick={next} style={{ ...s('position:relative;flex:1;margin:0 12px;border-radius:18px;display:flex;align-items:center;justify-content:center;min-height:300px;text-align:center;overflow:hidden;cursor:pointer'), background: story?.mediaPath ? '#0B0E0B' : 'repeating-linear-gradient(115deg,#1A201A 0 16px,#232A23 16px 32px)', padding: story?.mediaPath ? 0 : 24 }}>
          {story?.mediaPath && story.mediaKind === 'VIDEO' && <video src={mediaUrl(story.mediaPath)} autoPlay playsInline controls style={s('width:100%;height:100%;object-fit:contain')} />}
          {story?.mediaPath && story.mediaKind === 'IMAGE' && <img src={mediaUrl(story.mediaPath)} alt="" style={s('width:100%;height:100%;object-fit:contain')} />}
          {story?.text && (
            <p style={story.mediaPath
              ? s('position:absolute;left:12px;right:12px;bottom:14px;margin:0;color:#fff;font-size:16px;font-weight:700;line-height:1.5;background:rgba(16,20,16,.6);padding:10px 12px;border-radius:12px')
              : s('margin:0;color:#fff;font-size:20px;font-weight:700;line-height:1.5;text-wrap:pretty;white-space:pre-wrap')}>{story.text}</p>
          )}
          <button aria-label="Previous story" onClick={e => { e.stopPropagation(); prev(); }} style={s('position:absolute;left:0;top:0;bottom:0;width:28%')} />
        </div>
        <div style={s('display:flex;align-items:center;gap:9px;padding:14px 12px')}>
          {u.isMe ? (
            <button onClick={remove} style={s('flex:1;font-size:13.5px;font-weight:700;color:#fff;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:99px;padding:11px 16px')}>Delete story</button>
          ) : <>
            <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendReply()} placeholder={'Reply to @' + u.username} aria-label="Reply to story" maxLength={500} style={s('flex:1;min-width:0;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:99px;padding:11px 16px;color:#fff;outline:none;font-size:14px')} />
            <button onClick={() => { onClose(); openGift({ user: u }); }} aria-label="Send gift" className={H.gold} style={s('width:44px;height:44px;border-radius:50%;background:#C98A12;color:#fff;display:flex;align-items:center;justify-content:center;flex:none')}><GiftIcon size={20} sw={2.1} full={false} /></button>
          </>}
        </div>
        {!isMobile && (
          <button onClick={next} aria-label="Next story" className={H.darkGhost} style={s('position:absolute;right:-56px;top:50%;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center')}>
            <Icon d={I.next} size={19} sw={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
