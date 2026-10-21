'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, mediaUrl } from '@/lib/api';
import { H, s } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import type { Post } from '@/types';
import { useApp } from './AppProvider';
import { Avatar, CloseBtn, Icon, Modal, Spinner } from './ui';

export const COMPOSER_TOOLS: [string, string, string][] = [
  ['Add image', 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'm4 17 5-5 4 4 3-2.5 4 3.5M8.5 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  ['Add video', 'M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'm15 10 6-3.5v11L15 14'],
  ['Emoji', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.01M15 9.5v.01'],
  ['Poll', 'M6 20V10M12 20V4M18 20v-6', ''],
  ['Location', 'M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
];
const EMOJI = ['🔥', '❤️', '😂', '🙏', '🎁', '💚', '👏', '🚀', '🇳🇬', '⚽', '🎶', '✨'];

/** Shared post-creation logic used by the inline composer and the modal. */
export function useComposer(onPosted?: (p: Post | null) => void, story = false) {
  const { upsertPosts, showToast } = useApp();
  const [draft, setDraft] = useState('');
  const [media, setMedia] = useState<{ url: string; type: 'IMAGE' | 'VIDEO' }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [replyWho, setReplyWho] = useState('Everyone');
  const [location, setLocation] = useState<string | null>(null);
  const [poll, setPoll] = useState<string[] | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    if (story && media.length) { showToast('A story can have one photo or video'); return; }
    const list = Array.from(files).slice(0, story ? 1 : 4 - media.length);
    const hasVideo = list.some(f => f.type.startsWith('video/')) || media.some(m => m.type === 'VIDEO');
    if (hasVideo && list.length + media.length > 1) { showToast('A post can have up to 4 images or 1 video'); return; }
    setUploading(true);
    try { const r = await api.upload(list); setMedia(m => [...m, ...r.files]); }
    catch (e) { showToast((e as Error).message); }
    finally { setUploading(false); }
  };

  const submit = async () => {
    const text = (draft.trim() + (location ? `\n📍 ${location}` : '')).trim();
    if (!text && !media.length) return false;
    if (posting) return false;
    const options = poll?.map(o => o.trim()).filter(Boolean) ?? null;
    if (poll && (!options || options.length < 2)) { showToast('Add at least two poll options'); return false; }
    setPosting(true);
    try {
      if (story) {
        await api.createStory({ text, media: media[0] ?? null });
        onPosted?.(null);
        showToast('Story shared · visible for 24 hours');
      } else {
        const r = await api.createPost({ text, media, replyPolicy: replyWho, poll: options ?? undefined });
        upsertPosts([r.post]);
        onPosted?.(r.post);
        showToast('Post published');
      }
      setDraft(''); setMedia([]); setLocation(null); setPoll(null);
      return true;
    } catch (e) { showToast((e as Error).message); return false; } // input is kept so the user can retry
    finally { setPosting(false); }
  };

  return { draft, setDraft, media, setMedia, uploading, posting, upload, submit, replyWho, setReplyWho, location, setLocation, poll, setPoll, story };
}

export function ToolRow({ c, size = 36, onPick }: { c: ReturnType<typeof useComposer>; size?: number; onPick?: () => void }) {
  const { showToast } = useApp();
  const img = useRef<HTMLInputElement>(null);
  const vid = useRef<HTMLInputElement>(null);
  const [emoji, setEmoji] = useState(false);
  const act = (label: string) => {
    onPick?.();
    if ((label === 'Add image' || label === 'Add video') && c.poll) { showToast('A post can have media or a poll, not both'); return; }
    if (label === 'Add image') img.current?.click();
    else if (label === 'Add video') vid.current?.click();
    else if (label === 'Emoji') setEmoji(e => !e);
    else if (label === 'Location') {
      const l = prompt('Add a location', c.location ?? 'Lagos, Nigeria');
      if (l !== null) c.setLocation(l.trim() || null);
    } else if (c.story) showToast('Polls are for posts, not stories');
    else if (c.media.length) showToast('A post can have media or a poll, not both');
    else c.setPoll(p => (p ? null : ['', '']));
  };
  return (
    <>
      <input ref={img} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => { c.upload(e.target.files); e.target.value = ''; }} />
      <input ref={vid} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={e => { c.upload(e.target.files); e.target.value = ''; }} />
      {COMPOSER_TOOLS.map(([label, icon, icon2]) => (
        <span key={label} style={{ position: 'relative' }}>
          <button aria-label={label} title={label} onClick={() => act(label)} className={H.greenTint} style={{ ...s('border-radius:10px;display:flex;align-items:center;justify-content:center;color:#14975C'), width: size, height: size }}>
            <Icon d={icon} d2={icon2} size={19} sw={1.9} />
          </button>
          {label === 'Emoji' && emoji && (
            <div style={s('position:absolute;left:0;top:42px;z-index:40;display:grid;grid-template-columns:repeat(6,32px);gap:4px;padding:8px;background:#fff;border:1px solid rgba(16,20,16,.1);border-radius:14px;box-shadow:0 18px 44px rgba(16,20,16,.18)')}>
              {EMOJI.map(e => <button key={e} onClick={() => { c.setDraft(d => d + e); setEmoji(false); }} className={H.soft} style={s('width:32px;height:32px;border-radius:8px;font-size:18px')}>{e}</button>)}
            </div>
          )}
        </span>
      ))}
    </>
  );
}

export function MediaPreview({ c }: { c: ReturnType<typeof useComposer> }) {
  if (!c.media.length && !c.uploading && !c.location) return null;
  return (
    <div style={{ marginTop: 10 }}>
      {c.location && <div style={s('font-size:13px;font-weight:700;color:#14975C;margin-bottom:6px')}>📍 {c.location} <button onClick={() => c.setLocation(null)} style={s('color:#9AA197;margin-left:6px')}>×</button></div>}
      <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
        {c.media.map(m => (
          <div key={m.url} style={s('position:relative;width:96px;height:96px;border-radius:12px;overflow:hidden;border:1px solid rgba(16,20,16,.08)')}>
            {m.type === 'VIDEO' ? <video src={mediaUrl(m.url)} style={s('width:100%;height:100%;object-fit:cover')} /> : <img src={mediaUrl(m.url)} alt="" style={s('width:100%;height:100%;object-fit:cover')} />}
            <button aria-label="Remove media" onClick={() => c.setMedia(x => x.filter(y => y.url !== m.url))} style={s('position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(16,20,16,.7);color:#fff;font-size:13px;line-height:22px')}>×</button>
          </div>
        ))}
        {c.uploading && <div style={s('width:96px;height:96px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#F5F7F4;color:#14975C')}><Spinner /></div>}
      </div>
    </div>
  );
}

export function PollEditor({ c }: { c: ReturnType<typeof useComposer> }) {
  if (!c.poll) return null;
  const set = (i: number, v: string) => c.setPoll(p => p!.map((x, j) => (j === i ? v.slice(0, 80) : x)));
  return (
    <div style={s('margin-top:12px;display:flex;flex-direction:column;gap:8px')}>
      {c.poll.map((o, i) => (
        <div key={i} style={s('display:flex;gap:8px;align-items:center')}>
          <input value={o} onChange={e => set(i, e.target.value)} placeholder={`Option ${i + 1}`} aria-label={`Poll option ${i + 1}`} maxLength={80}
            style={s('flex:1;min-width:0;border:1px solid rgba(16,20,16,.1);border-radius:12px;padding:11px 14px;font-size:14px;font-weight:600;outline:none')} />
          {c.poll!.length > 2 && <button onClick={() => c.setPoll(p => p!.filter((_, j) => j !== i))} aria-label="Remove option" style={s('color:#9AA197;font-size:18px;width:28px')}>×</button>}
        </div>
      ))}
      <div style={s('display:flex;gap:12px')}>
        {c.poll.length < 4 && <button onClick={() => c.setPoll(p => [...p!, ''])} style={s('font-size:13px;font-weight:700;color:#14975C')}>+ Add option</button>}
        <button onClick={() => c.setPoll(null)} style={s('font-size:13px;font-weight:700;color:#A8331F;margin-left:auto')}>Remove poll</button>
      </div>
    </div>
  );
}

export function ComposerModal() {
  const { composerOpen, setComposerOpen, me } = useApp();
  const { isMobile } = useViewport();
  const router = useRouter();
  const story = composerOpen === 'story';
  const c = useComposer(() => { setComposerOpen(false); router.push('/'); }, story);
  const drop = useRef<HTMLInputElement>(null);
  if (!composerOpen || !me) return null;
  const close = () => setComposerOpen(false);
  return (
    <Modal onClose={close} isMobile={isMobile} label="Create post">
      <div style={s('display:flex;align-items:center;justify-content:space-between;gap:12px')}>
        <h2 style={s('margin:0;font-size:18px;font-weight:800')}>{story ? 'New story' : 'New post'}</h2>
        <CloseBtn onClick={close} />
      </div>
      <div style={s('display:flex;gap:12px;margin-top:16px')}>
        <Avatar user={me} size={42} />
        <textarea autoFocus value={c.draft} onChange={e => c.setDraft(e.target.value)} placeholder={story ? 'Share a moment (visible for 24 hours)' : "What's happening?"} aria-label={story ? 'Story text' : 'Post text'} rows={5} maxLength={story ? 280 : 1000} style={s('flex:1;border:0;outline:none;resize:none;font-size:17px;line-height:1.55;background:none;font-weight:500')} />
      </div>
      <PollEditor c={c} />
      {c.poll ? null : c.media.length || c.uploading ? <MediaPreview c={c} /> : (
        <button onClick={() => drop.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); c.upload(e.dataTransfer.files); }}
          style={s('margin-top:14px;width:100%;height:132px;border-radius:16px;border:1px dashed rgba(16,20,16,.16);background:repeating-linear-gradient(115deg,#F3F6F2 0 12px,#EAEFE9 12px 24px);display:flex;align-items:center;justify-content:center')}>
          <span style={s('font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#6B7268')}>drop image or video</span>
          <input ref={drop} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden onChange={e => { c.upload(e.target.files); e.target.value = ''; }} />
        </button>
      )}
      {c.location && !c.media.length && <div style={s('margin-top:8px;font-size:13px;font-weight:700;color:#14975C')}>📍 {c.location}</div>}
      {!story && <div style={s('display:flex;align-items:center;gap:9px;margin-top:14px;padding:11px 13px;border:1px solid rgba(16,20,16,.1);border-radius:14px;flex-wrap:wrap')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#14975C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>
        <span style={s('font-size:13.5px;font-weight:600;color:#3C433A;flex:none')}>Who can reply?</span>
        <div style={s('display:flex;gap:4px;margin-left:auto;flex-wrap:wrap')}>
          {['Everyone', 'Followers', 'Mentioned'].map(l => (
            <button key={l} onClick={() => c.setReplyWho(l)} style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 99, color: c.replyWho === l ? '#fff' : '#5A6358', background: c.replyWho === l ? '#14975C' : '#F1F4F0' }}>{l}</button>
          ))}
        </div>
      </div>}
      <div style={s('display:flex;align-items:center;gap:2px;margin-top:14px;flex-wrap:wrap')}>
        <ToolRow c={c} size={38} />
        <span style={s('margin-left:auto;font-size:12px;color:#9AA197;font-weight:600;margin-right:10px')}>{c.draft.length}/{story ? 280 : 1000}</span>
        <button onClick={c.submit} disabled={c.posting || c.uploading || (!c.draft.trim() && !c.media.length)} className={H.green}
          style={{ ...s('background:#14975C;color:#fff;font-weight:700;font-size:14.5px;padding:11px 26px;border-radius:99px;display:flex;gap:8px;align-items:center'), opacity: (!c.draft.trim() && !c.media.length) ? 0.5 : 1 }}>
          {c.posting && <Spinner size={14} color="#fff" />}{story ? 'Share' : 'Post'}
        </button>
      </div>
    </Modal>
  );
}
