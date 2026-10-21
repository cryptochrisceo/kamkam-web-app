'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useApp } from '@/components/AppProvider';
import { usePostActions } from '@/components/PostCard';
import { Avatar, Empty, ErrorBox, I, Skeleton } from '@/components/ui';
import type { Post } from '@/types';

function BookmarkCard({ post }: { post: Post }) {
  const a = usePostActions(post);
  const router = useRouter();
  return (
    <article style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:18px;padding:16px 18px')}>
      <div style={s('display:flex;align-items:center;gap:11px')}>
        <Avatar user={post.author} size={40} onClick={() => router.push('/profile/' + post.author.username)} />
        <div><div style={s('font-size:14px;font-weight:700')}>{post.author.displayName}</div><div style={s('font-size:12.5px;color:#6B7268')}>@{post.author.username} · {timeAgo(post.createdAt)}</div></div>
        <button onClick={a.bookmark} aria-label="Remove bookmark" className={H.greenTint} style={s('margin-left:auto;color:#14975C;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d={I.bookmark} /></svg>
        </button>
      </div>
      <p onClick={() => router.push('/post/' + post.id)} style={s('margin:10px 0 0;font-size:15px;line-height:1.55;cursor:pointer;white-space:pre-wrap')}>{post.text}</p>
    </article>
  );
}

export default function BookmarksPage() {
  const { upsertPosts, posts } = useApp();
  const [ids, setIds] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.bookmarks().then(r => { upsertPosts(r.posts); setIds(r.posts.map(p => p.id)); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (ids ?? []).map(id => posts[id]).filter(p => p?.bookmarked);
  return (
    <div>
      <h1 style={s('margin:0 0 4px;font-size:26px;font-weight:800;letter-spacing:-.02em')}>Bookmarks</h1>
      <p style={s('margin:0 0 16px;font-size:14px;color:#6B7268')}>{list.length} saved post{list.length === 1 ? '' : 's'}</p>
      {err && <ErrorBox message={err} onRetry={load} />}
      {!ids && !err && <><Skeleton h={110} /><Skeleton h={110} /></>}
      <div style={s('display:flex;flex-direction:column;gap:12px')}>
        {list.map(p => <BookmarkCard key={p.id} post={p} />)}
        {ids && list.length === 0 && <Empty title="Nothing saved yet" body="Tap the bookmark icon on any post to keep it here." />}
      </div>
    </div>
  );
}
