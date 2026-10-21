'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { compact, money } from '@/lib/format';
import { s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useApp } from '@/components/AppProvider';
import { Avatar, Empty, ErrorBox, Skeleton, Tabs, Verified } from '@/components/ui';
import { FollowButton } from '@/components/FollowButton';
import { PostCard } from '@/components/PostCard';
import type { PublicUser } from '@/types';

function CreatorRow({ c }: { c: PublicUser }) {
  const router = useRouter();
  return (
    <div style={s('display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid rgba(16,20,16,.06)')}>
      <Avatar user={c} size={40} onClick={() => router.push('/profile/' + c.username)} />
      <Link href={'/profile/' + c.username} style={s('flex:1;min-width:0;color:#101410')}>
        <div style={s('font-size:14px;font-weight:700;display:flex;gap:5px;align-items:center')}>{c.displayName}{c.verified && <Verified size={14} />}</div>
        <div style={s('font-size:12.5px;color:#6B7268')}>@{c.username} · {compact(c.followers ?? 0)} follower{c.followers === 1 ? '' : 's'}</div>
      </Link>
      {!c.isMe && <FollowButton userId={c.id} initial={!!c.isFollowing} />}
    </div>
  );
}

export default function ExplorePage() {
  const q = useSearchParams().get('q')?.trim() ?? '';
  const { upsertPosts, posts: store } = useApp();
  const [tab, setTab] = useState('Top');
  const search = useAsync(async () => { if (!q) return null; const r = await api.search(q); upsertPosts(r.posts); return r; }, [q]);
  const trending = useAsync(async () => { const r = await api.trending(); upsertPosts(r.posts); return r; }, []);
  const creators = useAsync(() => api.suggested(4), []);

  return (
    <div>
      <h1 style={s('margin:0 0 4px;font-size:26px;font-weight:800;letter-spacing:-.02em')}>{q ? 'Search' : 'Explore'}</h1>
      <p style={s('margin:0 0 16px;font-size:14px;color:#6B7268')}>{q ? `Results for “${q}”` : 'Find creators worth supporting.'}</p>
      <Tabs items={['Top', 'People', 'Posts', 'Media', 'Communities']} value={tab} onChange={setTab} style={{ marginBottom: 16 }} />

      {q ? (
        <div>
          {search.error && <ErrorBox message={search.error} onRetry={search.reload} />}
          {search.loading && !search.data && <><Skeleton h={70} /><Skeleton h={160} /></>}
          {search.data && (() => {
            const posts = search.data.posts.map(p => store[p.id] ?? p).filter(p => tab !== 'Media' || p.mediaType);
            const showPeople = tab === 'Top' || tab === 'People';
            const showPosts = tab === 'Top' || tab === 'Posts' || tab === 'Media';
            if (tab === 'Communities') return <Empty title="No communities match" body="Community search arrives with communities." />;
            if ((!showPeople || !search.data.users.length) && (!showPosts || !posts.length)) return <Empty title="No results" body="Try a different name, @username or #hashtag." />;
            return (
              <>
                {showPeople && search.data.users.length > 0 && (
                  <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-bottom:14px')}>
                    <h2 style={s('margin:0 0 14px;font-size:16px;font-weight:800')}>People</h2>
                    {search.data.users.map(u => <CreatorRow key={u.id} c={u} />)}
                  </div>
                )}
                {showPosts && <div style={s('display:flex;flex-direction:column;gap:14px')}>{posts.map(p => <PostCard key={p.id} post={p} />)}</div>}
              </>
            );
          })()}
        </div>
      ) : (
        <>
          <div style={s('display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-bottom:18px')}>
            {trending.loading && !trending.data && [0, 1, 2, 3].map(i => <div key={i} className="kk-skel" style={{ height: 210, borderRadius: 18 }} />)}
            {trending.data?.posts.filter(p => tab === 'Top' || tab === 'Posts' || (tab === 'Media' && p.mediaType)).map(p => {
              const topic = p.text.match(/#[\p{L}\p{N}_]+/u)?.[0]?.slice(1) ?? (p.mediaType ? 'Media' : 'Creators');
              return (
                <Link key={p.id} href={'/post/' + p.id} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:18px;overflow:hidden;color:#101410')}>
                  <div style={s('height:118px;background:repeating-linear-gradient(115deg,#EDF1EC 0 12px,#E4EAE3 12px 24px);display:flex;align-items:center;justify-content:center')}>
                    <span style={s('font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#6B7268')}>{p.mediaType === 'VIDEO' ? 'video' : p.mediaType ? 'photo' : '@' + p.author.username}</span>
                  </div>
                  <div style={s('padding:13px 14px')}>
                    <div style={s('font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#14975C')}>{topic}</div>
                    <div style={s('margin-top:5px;font-size:14px;font-weight:600;line-height:1.4;text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden')}>{p.text}</div>
                    <div style={s('margin-top:9px;font-size:12.5px;color:#6B7268;font-weight:600')}>{p.giftCount} gifts · {Number(p.earnedNgn) > 0 ? money(p.earnedNgn) + ' to creator' : p.likeCount + ' likes'}</div>
                  </div>
                </Link>
              );
            })}
          </div>
          {(tab === 'Top' || tab === 'People') && (
            <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-bottom:14px')}>
              <h2 style={s('margin:0 0 14px;font-size:16px;font-weight:800')}>Suggested creators</h2>
              <div style={s('display:flex;flex-direction:column;gap:2px')}>
                {creators.data?.users.map(c => <CreatorRow key={c.id} c={c} />)}
                {creators.data?.users.length === 0 && <div style={s('font-size:13.5px;color:#6B7268')}>No suggestions right now.</div>}
              </div>
            </div>
          )}
          {tab === 'Communities' && <Empty title="Browse communities" body="Open Communities from the menu to join spaces." />}
          <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
            <h2 style={s('margin:0 0 12px;font-size:16px;font-weight:800')}>Trending topics</h2>
            <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
              {trending.data?.topics.map(t => (
                <Link key={t.tag} href={'/explore?q=' + encodeURIComponent(t.tag)} style={s('font-size:13px;font-weight:700;padding:8px 13px;border-radius:99px;border:1px solid rgba(16,20,16,.1);color:#101410')}>{t.tag} <span style={s('color:#6B7268;font-weight:500')}>{compact(t.count)}</span></Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
