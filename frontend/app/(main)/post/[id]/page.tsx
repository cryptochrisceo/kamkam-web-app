'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { money, timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useApp } from '@/components/AppProvider';
import { PostMedia, PostPoll, usePostActions } from '@/components/PostCard';
import { Avatar, Empty, ErrorBox, GiftIcon, I, Icon, Skeleton, Spinner } from '@/components/ui';
import type { Comment, Post } from '@/types';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { posts, upsertPosts, patchPost, me, showToast } = useApp();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.post(id).then(r => upsertPosts([r.post])).catch(e => setErr(e.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const comments = useAsync(() => api.comments(id), [id]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [sending, setSending] = useState(false);
  const post = posts[id];

  const submit = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const r = await api.comment(id, text.trim(), replyTo?.id);
      patchPost(id, { commentCount: r.commentCount });
      setText(''); setReplyTo(null); comments.reload();
    } catch (e) { showToast((e as Error).message); }
    finally { setSending(false); }
  };

  const back = (
    <button onClick={() => (history.length > 1 ? router.back() : router.push('/'))} className={H.ghost} style={s('display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:#3C433A;margin-bottom:12px;padding:8px 12px;border-radius:99px')}>
      <Icon d={I.back} size={17} sw={2.2} />Back to feed
    </button>
  );
  if (err) return <div>{back}<ErrorBox message={err} /></div>;
  if (!post) return <div>{back}<Skeleton h={260} /></div>;

  const Reply = ({ c, depth }: { c: Comment; depth: number }) => (
    <div style={{ paddingLeft: depth ? 24 : 0 }}>
      <div style={s('display:flex;gap:12px;padding:13px 0;border-top:1px solid rgba(16,20,16,.06)')}>
        <Avatar user={c.author} size={36} onClick={() => router.push('/profile/' + c.author.username)} />
        <div style={s('flex:1;min-width:0')}>
          <div style={s('font-size:13.5px')}><b>{c.author.displayName}</b> <span style={s('color:#6B7268')}>@{c.author.username} · {timeAgo(c.createdAt)}</span></div>
          <p style={s('margin:5px 0 0;font-size:14.5px;line-height:1.55;text-wrap:pretty;white-space:pre-wrap;word-break:break-word')}>{c.text}</p>
          <button onClick={() => { setReplyTo(c); document.getElementById('reply-box')?.focus(); }} style={s('margin-top:6px;font-size:12.5px;font-weight:700;color:#6B7268')}>Reply</button>
        </div>
      </div>
      {c.replies.map(r => <Reply key={r.id} c={r} depth={Math.min(depth + 1, 3)} />)}
    </div>
  );

  return (
    <div>
      {back}
      <DetailArticle post={post} />
      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
        <h2 style={s('margin:0 0 10px;font-size:15.5px;font-weight:800')}>Replies</h2>
        <div style={s('display:flex;gap:12px;padding-bottom:12px')}>
          {me && <Avatar user={me} size={36} />}
          <div style={s('flex:1;min-width:0')}>
            {replyTo && <div style={s('font-size:12.5px;color:#6B7268;margin-bottom:4px')}>Replying to <b>@{replyTo.author.username}</b> <button onClick={() => setReplyTo(null)} style={s('color:#14975C;font-weight:700;margin-left:4px')}>cancel</button></div>}
            <textarea id="reply-box" value={text} onChange={e => setText(e.target.value)} placeholder={post.replyPolicy === 'Everyone' ? 'Post your reply' : `Replies: ${post.replyPolicy.toLowerCase()} only`} rows={2} maxLength={1000} style={s('width:100%;border:1px solid rgba(16,20,16,.1);border-radius:14px;outline:none;resize:none;font-size:14.5px;line-height:1.5;padding:10px 12px;background:#FAFBF9')} />
            <div style={s('display:flex;justify-content:flex-end;margin-top:8px')}>
              <button onClick={submit} disabled={sending || !text.trim()} className={H.green} style={{ ...s('background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:9px 20px;border-radius:99px;display:flex;align-items:center;gap:8px'), opacity: text.trim() ? 1 : 0.55 }}>{sending && <Spinner size={13} color="#fff" />}Reply</button>
            </div>
          </div>
        </div>
        {comments.loading && !comments.data && <div className="kk-skel" style={{ height: 60 }} />}
        {comments.error && <ErrorBox message={comments.error} onRetry={comments.reload} />}
        {comments.data?.comments.map(c => <Reply key={c.id} c={c} depth={0} />)}
        {comments.data && comments.data.comments.length === 0 && <div style={{ marginTop: 6 }}><Empty title="No replies yet" body="Start the conversation." /></div>}
      </div>
    </div>
  );
}

function DetailArticle({ post }: { post: Post }) {
  const router = useRouter();
  const { openGift, showToast } = useApp();
  const a = usePostActions(post);
  return (
      <article style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:20px')}>
        <div style={s('display:flex;align-items:center;gap:12px')}>
          <Avatar user={post.author} size={44} onClick={() => router.push('/profile/' + post.author.username)} />
          <div style={s('flex:1;min-width:0')}><div style={s('font-size:15px;font-weight:700')}>{post.author.displayName}</div><div style={s('font-size:13px;color:#6B7268')}>@{post.author.username} · {timeAgo(post.createdAt)}{post.editedAt ? ' · edited' : ''}</div></div>
          {post.isMine && <button onClick={async () => { if (!confirm('Delete this post?')) return; try { await api.deletePost(post.id); showToast('Post deleted'); router.push('/'); } catch (e) { showToast((e as Error).message); } }} className={H.ghost} style={s('font-size:12.5px;font-weight:700;color:#A8331F;padding:7px 12px;border-radius:99px')}>Delete</button>}
        </div>
        {post.text && <p style={s('margin:14px 0 0;font-size:18px;line-height:1.6;text-wrap:pretty;white-space:pre-wrap;word-break:break-word')}>{post.text}</p>}
        {(post.mediaUrls.length > 0 || post.mediaType) && <PostMedia post={post} />}
        {post.poll && <PostPoll post={post} />}
        {post.giftCount > 0 && (
          <div style={s('display:flex;flex-wrap:wrap;gap:8px;margin-top:14px')}>
            <span style={s('font-size:12.5px;font-weight:700;color:#8A5E08;background:#FCF3E0;padding:6px 12px;border-radius:99px')}>{post.giftCount} gift{post.giftCount === 1 ? '' : 's'}</span>
            {post.boosted && <span style={s('font-size:12.5px;font-weight:700;color:#8A5E08;background:#FCF3E0;padding:6px 12px;border-radius:99px')}>Reach boost active</span>}
            <span style={s('font-size:12.5px;font-weight:700;color:#14975C;background:#E8F5EE;padding:6px 12px;border-radius:99px')}>{money(post.earnedNgn)} earned</span>
          </div>
        )}
        <div style={s('display:flex;gap:22px;margin-top:16px;padding-top:14px;border-top:1px solid rgba(16,20,16,.07);font-size:13.5px;color:#6B7268;font-weight:600;flex-wrap:wrap;align-items:center')}>
          <button onClick={a.like} style={{ color: post.liked ? '#D0412F' : undefined }}><b style={{ color: post.liked ? '#D0412F' : '#101410' }}>{post.likeCount}</b> {post.liked ? 'Liked' : 'Likes'}</button>
          <button onClick={a.repost} style={{ color: post.reposted ? '#14975C' : undefined }}><b style={{ color: post.reposted ? '#14975C' : '#101410' }}>{post.repostCount}</b> Reposts</button>
          <span><b style={s('color:#101410')}>{post.commentCount}</b> Comments</span>
          {post.superLikeCount > 0 && <span style={s('color:#8A5E08')}>🔥 <b>{post.superLikeCount}</b> Super Like{post.superLikeCount === 1 ? '' : 's'}</span>}
          <span style={s('margin-left:auto;display:flex;gap:12px')}>
            <button onClick={a.bookmark} style={{ color: post.bookmarked ? '#14975C' : undefined }}>{post.bookmarked ? 'Saved' : 'Save'}</button>
            <button onClick={a.share}>Share</button>
          </span>
        </div>
        {!post.isMine && (
          <button onClick={() => openGift({ post, user: post.author })} className={H.gold} style={s('margin-top:16px;width:100%;display:flex;align-items:center;justify-content:center;gap:9px;background:#C98A12;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px')}>
            <GiftIcon size={18} sw={2.1} full={false} />Gift this post
          </button>
        )}
      </article>
  );
}