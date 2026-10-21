'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Post } from '@/types';
import { useApp } from './AppProvider';
import { PostCard } from './PostCard';
import { Empty, ErrorBox, Skeleton, Spinner } from './ui';

/**
 * Renders a list of post ids from the shared store so that likes / gifts /
 * deletes made anywhere update every list instantly.
 */
export function useFeed(load: (offset: number) => Promise<{ posts: Post[]; nextOffset?: number | null }>, deps: unknown[]) {
  const { upsertPosts, posts } = useApp();
  const [ids, setIds] = useState<string[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const fetchPage = useCallback(async (offset: number, reset: boolean) => {
    const g = gen.current;
    setLoading(true);
    try {
      const r = await load(offset);
      if (g !== gen.current) return;
      upsertPosts(r.posts);
      setIds(prev => (reset ? r.posts.map(p => p.id) : [...prev, ...r.posts.map(p => p.id).filter(id => !prev.includes(id))]));
      setNext(r.nextOffset ?? null);
      setError(null);
    } catch (e) { if (g === gen.current) setError((e as Error).message); }
    finally { if (g === gen.current) setLoading(false); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { gen.current++; setIds([]); fetchPage(0, true); }, [fetchPage]);

  return {
    posts: ids.map(id => posts[id]).filter(Boolean) as Post[],
    loading, error, hasMore: next !== null,
    loadMore: () => next !== null && !loading && fetchPage(next, false),
    reload: () => { gen.current++; fetchPage(0, true); },
    prepend: (p: Post) => setIds(prev => [p.id, ...prev.filter(x => x !== p.id)]),
  };
}

export function FeedList({ feed, empty }: { feed: ReturnType<typeof useFeed>; empty: { title: string; body?: string } }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(e => e[0].isIntersecting && feed.loadMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed]);
  if (feed.error && !feed.posts.length) return <ErrorBox message={feed.error} onRetry={feed.reload} />;
  if (feed.loading && !feed.posts.length) return <><Skeleton h={180} /><Skeleton h={220} /><Skeleton h={160} /></>;
  if (!feed.posts.length) return <Empty {...empty} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {feed.posts.map(p => <PostCard key={p.id} post={p} />)}
      <div ref={sentinel} style={{ height: 1 }} />
      {feed.loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 12, color: '#14975C' }}><Spinner /></div>}
      {!feed.hasMore && feed.posts.length > 5 && <div style={{ textAlign: 'center', fontSize: 12.5, color: '#9AA197', fontWeight: 600, padding: 8 }}>You are all caught up</div>}
    </div>
  );
}
