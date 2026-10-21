'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useApp } from '@/components/AppProvider';
import { Avatar, I, Icon, Spinner, Tabs } from '@/components/ui';
import { FeedList, useFeed } from '@/components/Feed';
import { MediaPreview, PollEditor, ToolRow, useComposer } from '@/components/Composer';
import { StoryViewer } from '@/components/StoryViewer';
import { initials } from '@/lib/format';

const TABS: Record<string, string> = { 'For You': 'foryou', Following: 'following', Trending: 'trending' };

export default function HomePage() {
  const { me, setComposerOpen, composerOpen } = useApp();
  const [tab, setTab] = useState('For You');
  const feed = useFeed(offset => api.posts(TABS[tab], offset), [tab]);
  const composer = useComposer(p => { if (p) feed.prepend(p); });
  // Real 24h stories from you + people you follow; refreshed after sharing a story
  const stories = useAsync(() => api.stories(), [me?.id, composerOpen]);
  const [story, setStory] = useState<number | null>(null);
  const storyUsers = stories.data ?? [];

  return (
    <div>
      <Tabs items={Object.keys(TABS)} value={tab} onChange={setTab} style={{ overflowX: 'visible' }} />

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px 4px 16px 16px;margin-bottom:14px')}>
        <div style={s('display:flex;align-items:baseline;justify-content:space-between;padding-right:16px;margin-bottom:12px')}>
          <span style={s('font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6B7268')}>Stories</span>
          <span style={s('font-size:12px;color:#6B7268;font-weight:600')}>Last 24h</span>
        </div>
        <div style={s('display:flex;gap:14px;overflow-x:auto;padding-bottom:6px;padding-right:16px;scrollbar-width:thin')}>
          <button onClick={() => setComposerOpen('story')} style={s('display:flex;flex-direction:column;align-items:center;gap:8px;flex:none;width:66px')}>
            <div style={s('width:62px;height:62px;border-radius:50%;border:2px dashed rgba(16,20,16,.18);display:flex;align-items:center;justify-content:center;color:#14975C')}>
              <Icon d={I.plus} d2={I.plus2} size={22} sw={2.4} />
            </div>
            <span style={s('font-size:11.5px;font-weight:600;color:#3C433A')}>Add story</span>
          </button>
          {stories.data && !storyUsers.length && <span style={s('align-self:center;font-size:12.5px;color:#9AA197;font-weight:600;padding-right:8px')}>No stories yet. Follow creators or share your own.</span>}
          {stories.loading && !storyUsers.length && [0, 1, 2, 3].map(i => <div key={i} className="kk-skel" style={{ width: 62, height: 62, borderRadius: '50%', flex: 'none' }} />)}
          {storyUsers.map((u, i) => (
            <button key={u.id} onClick={() => setStory(i)} style={s('display:flex;flex-direction:column;align-items:center;gap:8px;flex:none;width:66px')}>
              <div style={{ width: 62, height: 62, borderRadius: '50%', padding: 2.5, background: i < 3 ? 'conic-gradient(from 210deg,#14975C,#C98A12,#14975C)' : 'rgba(16,20,16,.14)' }}>
                <div style={{ width: '100%', height: '100%', borderRadius: '50%', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: '#fff', background: u.avatarColor, overflow: 'hidden' }}>
                  {u.avatar ? <Avatar user={u} size={53} /> : initials(u.displayName)}
                </div>
              </div>
              <span style={s('font-size:11.5px;font-weight:600;color:#3C433A;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{u.isMe ? 'Your story' : u.displayName.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px;margin-bottom:14px')}>
        <div style={s('display:flex;gap:12px')}>
          <Avatar user={me!} size={42} />
          <div style={s('flex:1;min-width:0')}>
            <textarea value={composer.draft} onChange={e => composer.setDraft(e.target.value)} placeholder="What's happening?" aria-label="Write a post" rows={2} maxLength={1000} style={s('width:100%;border:0;outline:none;resize:none;font-size:17px;font-weight:500;line-height:1.5;background:none;padding:8px 0 4px')} />
            <PollEditor c={composer} />
            <MediaPreview c={composer} />
            <div style={s('display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin-top:6px')}>
              <ToolRow c={composer} />
              <button onClick={composer.submit} disabled={composer.posting || composer.uploading || (!composer.draft.trim() && !composer.media.length)} className={H.green} aria-label="Publish post"
                style={{ ...s('margin-left:auto;margin-right:16px;background:#14975C;color:#fff;font-weight:700;font-size:14px;padding:10px 24px;border-radius:99px;transition:background .16s;display:flex;align-items:center;gap:8px'), opacity: !composer.draft.trim() && !composer.media.length ? 0.55 : 1 }}>
                {composer.posting && <Spinner size={14} color="#fff" />}Post
              </button>
            </div>
          </div>
        </div>
      </div>

      <FeedList feed={feed} empty={tab === 'Following' ? { title: 'Nothing here yet', body: 'Follow creators to see their posts in this tab.' } : { title: 'No posts yet', body: 'Be the first to post something.' }} />
      {story !== null && storyUsers.length > 0 && <StoryViewer users={storyUsers} index={story} onIndex={setStory} onClose={() => setStory(null)} onChanged={stories.reload} />}
    </div>
  );
}
