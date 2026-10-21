'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, mediaUrl } from '@/lib/api';
import { money, timeAgo } from '@/lib/format';
import { act, boostCard, card, H, s, sx } from '@/lib/ui';
import type { Post } from '@/types';
import { useApp } from './AppProvider';
import { Avatar, GiftIcon, I, Icon, Spinner, Verified } from './ui';

export function PostMedia({ post, height }: { post: Post; height?: number }) {
  const isVideo = post.mediaType === 'VIDEO';
  const box = sx('position:relative;margin-top:13px;border-radius:16px;border:1px solid rgba(16,20,16,.07);overflow:hidden', { height: height ?? (isVideo ? 250 : 290) });
  if (post.mediaUrls.length) {
    const url = mediaUrl(post.mediaUrls[0]);
    if (isVideo) return <div style={box}><video src={url} controls style={s('width:100%;height:100%;object-fit:cover;background:#101410')} /></div>;
    const n = post.mediaUrls.length;
    return (
      <div style={{ ...box, display: 'grid', gap: 2, gridTemplateColumns: n > 1 ? '1fr 1fr' : '1fr' }}>
        {post.mediaUrls.slice(0, 4).map(u => <img key={u} src={mediaUrl(u)} alt="" style={s('width:100%;height:100%;object-fit:cover;min-height:0')} />)}
      </div>
    );
  }
  // Seeded posts without files keep the prototype's placeholder
  return (
    <div style={{ ...box, background: 'repeating-linear-gradient(115deg,#EDF1EC 0 14px,#E4EAE3 14px 28px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={s('font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;letter-spacing:.06em;color:#6B7268;background:rgba(255,255,255,.88);padding:6px 11px;border-radius:99px;border:1px solid rgba(16,20,16,.07)')}>{isVideo ? 'video' : 'photo'}</span>
      {isVideo && (
        <span style={s('position:absolute;left:14px;bottom:14px;display:flex;align-items:center;gap:7px;background:rgba(16,20,16,.82);color:#fff;font-size:12px;font-weight:700;padding:6px 11px;border-radius:99px')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5 20 12 7 19.5Z" /></svg>1:24
        </span>
      )}
    </div>
  );
}

/** Shared like / repost / bookmark handlers with optimistic update + server reconciliation. */
export function usePostActions(post: Post) {
  const { patchPost, showToast, me } = useApp();
  const router = useRouter();
  const guard = () => { if (!me) { router.push('/login'); return false; } return true; };
  return {
    like: async () => {
      if (!guard()) return;
      const was = post.liked;
      patchPost(post.id, { liked: !was, likeCount: post.likeCount + (was ? -1 : 1), superLiked: was ? false : post.superLiked });
      try {
        const r = was ? await api.unlike(post.id) : await api.like(post.id);
        patchPost(post.id, { likeCount: r.likeCount, superLikeCount: r.superLikeCount, liked: !was });
      } catch (e) { patchPost(post.id, { liked: was, likeCount: post.likeCount, superLiked: post.superLiked }); showToast((e as Error).message); }
    },
    repost: async () => {
      if (!guard()) return;
      const was = post.reposted;
      patchPost(post.id, { reposted: !was, repostCount: post.repostCount + (was ? -1 : 1) });
      try {
        const r = was ? await api.unrepost(post.id) : await api.repost(post.id);
        patchPost(post.id, { repostCount: r.repostCount });
        if (!was) showToast('Reposted');
      } catch (e) { patchPost(post.id, { reposted: was, repostCount: post.repostCount }); showToast((e as Error).message); }
    },
    bookmark: async () => {
      if (!guard()) return;
      const was = post.bookmarked;
      patchPost(post.id, { bookmarked: !was });
      try { was ? await api.unbookmark(post.id) : await api.bookmark(post.id); showToast(was ? 'Removed from bookmarks' : 'Saved to bookmarks'); }
      catch (e) { patchPost(post.id, { bookmarked: was }); showToast((e as Error).message); }
    },
    share: async () => {
      const url = `${window.location.origin}/post/${post.id}`;
      try { await navigator.clipboard.writeText(url); showToast('Link copied'); } catch { showToast(url); }
    },
  };
}

export function PostCard({ post, onDeleted }: { post: Post; onDeleted?: (id: string) => void }) {
  const { openGift, showToast, removePost, me } = useApp();
  const router = useRouter();
  const a = usePostActions(post);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { upsertPosts } = useApp();
  const saveEdit = async () => {
    if (editing === null || saving) return;
    if (!editing.trim() && !post.mediaUrls.length && !post.poll) { showToast('A post cannot be empty'); return; }
    setSaving(true);
    try { const r = await api.updatePost(post.id, editing.trim()); upsertPosts([r.post]); setEditing(null); showToast('Post updated'); }
    catch (e) { showToast((e as Error).message); }
    finally { setSaving(false); }
  };
  const goProfile = () => router.push('/profile/' + post.author.username);
  const openDetail = () => router.push('/post/' + post.id);

  const del = async () => {
    setMenu(false);
    if (!confirm('Delete this post? This cannot be undone.')) return;
    try { await api.deletePost(post.id); removePost(post.id); onDeleted?.(post.id); showToast('Post deleted'); }
    catch (e) { showToast((e as Error).message); }
  };

  const likeStyle = sx(act, post.liked && 'color:#D0412F');
  const newCreator = (post.author.followers ?? 0) <= 1 && !post.isMine;

  return (
    <article style={post.boosted ? boostCard : card} data-screen-label="Post">
      {post.boosted && (
        <div style={s('display:flex;align-items:center;gap:8px;padding:9px 18px;background:#FCF3E0;border-bottom:1px solid rgba(201,138,18,.18);font-size:12.5px;font-weight:700;color:#8A5E08;flex-wrap:wrap')}>
          <Icon d={I.flame} size={15} sw={2.1} />
          Super Liked · {post.giftCount} gift{post.giftCount === 1 ? '' : 's'} · {money(post.earnedNgn)} earned
          <span style={s('margin-left:auto;font-weight:700;color:#8A5E08;opacity:.8')}>Reach boost active</span>
        </div>
      )}
      <div style={s('padding:16px 18px 6px')}>
        <div style={s('display:flex;align-items:flex-start;gap:12px')}>
          <Avatar user={post.author} size={44} onClick={goProfile} />
          <div style={s('flex:1;min-width:0')}>
            <div style={s('display:flex;align-items:center;gap:6px;flex-wrap:wrap')}>
              <button onClick={goProfile} style={s('font-size:14.5px;font-weight:700')}>{post.author.displayName}</button>
              {post.author.verified && <Verified />}
              <span style={s('font-size:13.5px;color:#6B7268;font-weight:500')}>@{post.author.username}</span>
              <span style={s('font-size:13.5px;color:#9AA197')}>·</span>
              <span style={s('font-size:13.5px;color:#6B7268;font-weight:500')}>{timeAgo(post.createdAt)}{post.editedAt ? ' · edited' : ''}</span>
              {newCreator && <span style={s('font-size:11px;font-weight:700;color:#14975C;background:#E8F5EE;padding:2px 8px;border-radius:99px')}>{post.author.followers ?? 0} follower{post.author.followers === 1 ? '' : 's'}</span>}
            </div>
            {editing !== null ? (
              <div style={s('margin-top:8px')}>
                <textarea value={editing} onChange={e => setEditing(e.target.value)} rows={3} maxLength={1000} autoFocus aria-label="Edit post"
                  style={s('width:100%;border:1px solid rgba(16,20,16,.12);border-radius:12px;padding:10px 12px;outline:none;resize:vertical;font-size:15px;line-height:1.5')} />
                <div style={s('display:flex;gap:8px;justify-content:flex-end;margin-top:8px')}>
                  <button onClick={() => setEditing(null)} disabled={saving} className={H.ghost} style={s('font-size:13px;font-weight:700;padding:8px 14px;border-radius:99px;color:#6B7268')}>Cancel</button>
                  <button onClick={saveEdit} disabled={saving} className={H.green} style={s('font-size:13px;font-weight:700;padding:8px 16px;border-radius:99px;background:#14975C;color:#fff;display:flex;gap:6px;align-items:center')}>{saving && <Spinner size={12} color="#fff" />}Save</button>
                </div>
              </div>
            ) : post.text && <p onClick={openDetail} style={s('margin:7px 0 0;font-size:15.5px;line-height:1.55;text-wrap:pretty;cursor:pointer;white-space:pre-wrap;word-break:break-word')}>{post.text}</p>}
          </div>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMenu(m => !m)} aria-label="More options" className={H.ghostInk} style={s('width:32px;height:32px;border-radius:10px;color:#9AA197;display:flex;align-items:center;justify-content:center;flex:none')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
            </button>
            {menu && (
              <div onMouseLeave={() => setMenu(false)} style={s('position:absolute;right:0;top:36px;z-index:30;width:190px;background:#fff;border:1px solid rgba(16,20,16,.1);border-radius:14px;padding:6px;box-shadow:0 18px 44px rgba(16,20,16,.18);animation:kkUp .16s ease-out')}>
                <button onClick={() => { setMenu(false); openDetail(); }} className={H.soft} style={s('display:block;width:100%;text-align:left;padding:10px 11px;border-radius:10px;font-size:13.5px;font-weight:600')}>Open post</button>
                <button onClick={() => { setMenu(false); a.share(); }} className={H.soft} style={s('display:block;width:100%;text-align:left;padding:10px 11px;border-radius:10px;font-size:13.5px;font-weight:600')}>Copy link</button>
                {post.isMine && <button onClick={() => { setMenu(false); setEditing(post.text); }} className={H.soft} style={s('display:block;width:100%;text-align:left;padding:10px 11px;border-radius:10px;font-size:13.5px;font-weight:600')}>Edit post</button>}
                {post.isMine && <button onClick={del} className={H.soft} style={s('display:block;width:100%;text-align:left;padding:10px 11px;border-radius:10px;font-size:13.5px;font-weight:700;color:#A8331F')}>Delete post</button>}
              </div>
            )}
          </div>
        </div>
        {(post.mediaUrls.length > 0 || post.mediaType) && <PostMedia post={post} />}
        {post.poll && <PostPoll post={post} />}
      </div>

      <div style={s('display:flex;align-items:center;gap:2px;padding:6px 10px 10px;flex-wrap:wrap')}>
        <button onClick={openDetail} aria-label="Comment" style={act} className={H.ghostInk}>
          <Icon d={I.comment} size={18} sw={1.9} />{post.commentCount}
        </button>
        <button onClick={a.like} aria-label="Like" aria-pressed={post.liked} style={likeStyle} className={H.like}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill={post.liked ? '#D0412F' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={post.liked ? s('animation:kkPop .38s cubic-bezier(.2,1.5,.4,1)') : undefined}><path d={I.heart} /></svg>{post.likeCount}
        </button>
        <button onClick={a.repost} aria-label="Repost" style={sx(act, post.reposted && 'color:#14975C')} className={H.greenTint}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V7.5A2.5 2.5 0 0 1 6.5 5H16" /><path d="m13 2 3 3-3 3" /><path d="M20 15v1.5a2.5 2.5 0 0 1-2.5 2.5H8" /><path d="m11 22-3-3 3-3" /></svg>{post.repostCount}
        </button>
        {!post.isMine && (
          <button onClick={() => (me ? openGift({ post, user: post.author }) : router.push('/login'))} aria-label="Send a gift to this creator" className={H.giftBtn}
            style={s('display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:11px;font-size:13px;font-weight:800;color:#8A5E08;background:#FCF3E0;border:1px solid rgba(201,138,18,.28);transition:background .15s, transform .15s')}>
            <GiftIcon />{post.giftCount > 0 ? String(post.giftCount) : 'Gift'}
          </button>
        )}
        {post.isMine && post.giftCount > 0 && (
          <span style={s('display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:11px;font-size:13px;font-weight:800;color:#8A5E08;background:#FCF3E0')}><GiftIcon />{post.giftCount}</span>
        )}
        {post.superLiked && <span title="You Super Liked this post" style={s('display:flex;align-items:center;color:#C98A12;padding:0 6px')}><Icon d={I.flame} size={16} sw={2.1} /></span>}
        <div style={s('flex:1;min-width:4px')} />
        <button onClick={a.share} aria-label="Share" style={act} className={H.ghostInk}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></svg>
        </button>
        <button onClick={a.bookmark} aria-label="Bookmark" aria-pressed={post.bookmarked} style={sx(act, post.bookmarked && 'color:#14975C')} className={H.ghost}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill={post.bookmarked ? '#14975C' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={I.bookmark} /></svg>
        </button>
      </div>
    </article>
  );
}

/** Poll block — markup from the original kam-kam-ui post design. */
export function PostPoll({ post }: { post: Post }) {
  const { upsertPosts, showToast, patchPost } = useApp();
  const [busy, setBusy] = useState(false);
  const poll = post.poll!;
  const vote = async (optionId: string) => {
    if (busy || poll.myVote || post.isMine) { if (poll.myVote) showToast('You already voted'); return; }
    setBusy(true);
    patchPost(post.id, { poll: { ...poll, myVote: optionId, total: poll.total + 1, options: poll.options.map(o => (o.id === optionId ? { ...o, votes: o.votes + 1 } : o)) } });
    try { const r = await api.votePoll(post.id, optionId); upsertPosts([r.post]); showToast('Vote recorded'); }
    catch (e) { patchPost(post.id, { poll }); showToast((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div style={s('margin-top:13px;display:flex;flex-direction:column;gap:8px')}>
      {poll.options.map(o => {
        const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
        const mine = poll.myVote === o.id;
        return (
          <button key={o.id} onClick={() => vote(o.id)} disabled={busy} className={H.pollBorder} aria-pressed={mine}
            style={{ ...s('position:relative;overflow:hidden;display:block;width:100%;text-align:left;border-radius:12px;padding:11px 14px;font-size:14px;font-weight:600'), border: mine ? '1px solid #14975C' : '1px solid rgba(16,20,16,.1)' }}>
            <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: '#E8F5EE', animation: 'kkBar .6s ease-out' }} />
            <span style={s('position:relative;display:flex;justify-content:space-between;gap:12px')}><span>{o.label}{mine ? ' ✓' : ''}</span><span style={s('color:#14975C;font-weight:700')}>{pct}%</span></span>
          </button>
        );
      })}
      <div style={s('font-size:12.5px;color:#6B7268;font-weight:500')}>{poll.total.toLocaleString()} vote{poll.total === 1 ? '' : 's'}{poll.myVote ? ' · You voted' : post.isMine ? '' : ' · Tap to vote'}</div>
    </div>
  );
}