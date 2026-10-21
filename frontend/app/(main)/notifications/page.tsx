'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { timeAgoLong } from '@/lib/format';
import { s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useApp } from '@/components/AppProvider';
import { Empty, ErrorBox, Skeleton, Tabs } from '@/components/ui';
import type { Notification } from '@/types';

const NI: Record<string, [string, string]> = {
  gift: ['M3 8h18v4.5H3z', 'M5 12.5h14V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM12 8v13'],
  like: ['M12 20.3 4.8 13.4a4.6 4.6 0 0 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 0 1 6.5 6.5Z', ''],
  follow: ['M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M3 20c0-3.6 3-5.8 7-5.8M18 14v6M15 17h6'],
  comment: ['M20.5 11.8A7.8 7.8 0 0 1 9.6 18.9L4.5 20.2l1.4-4.8A7.8 7.8 0 1 1 20.5 11.8Z', ''],
  repost: ['M4 9V7.5A2.5 2.5 0 0 1 6.5 5H16m-3-3 3 3-3 3', 'M20 15v1.5a2.5 2.5 0 0 1-2.5 2.5H8m3 3-3-3 3-3'],
  wallet: ['M3 8.5A2.5 2.5 0 0 1 5.5 6H17a2 2 0 0 1 2 2v1', 'M3 8.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.5h-4a2 2 0 0 1 0-4h4'],
};
const iconFor = (t: Notification['type']) =>
  t === 'GIFT_RECEIVED' ? NI.gift : t === 'LIKE' ? NI.like : t === 'FOLLOW' ? NI.follow : t === 'REPOST' ? NI.repost : t === 'COMMENT' || t === 'MESSAGE' ? NI.comment : NI.wallet;

export default function NotificationsPage() {
  const [tab, setTab] = useState('All');
  const { refreshMe } = useApp();
  const router = useRouter();
  const list = useAsync(() => api.notifications(tab.toLowerCase()), [tab], { pollMs: 8000 });
  useEffect(() => { api.readNotifications().then(refreshMe).catch(() => null); }, [list.data?.notifications.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (n: Notification) => {
    if (n.postId) router.push('/post/' + n.postId);
    else if (n.type === 'FOLLOW' && n.actor) router.push('/profile/' + n.actor.username);
    else if (n.type === 'MESSAGE') router.push('/messages');
    else if (n.type === 'WITHDRAWAL_COMPLETED' || n.type === 'TRANSACTION_COMPLETED') router.push('/wallet?tab=Activity');
  };

  return (
    <div>
      <h1 style={s('margin:0 0 14px;font-size:26px;font-weight:800;letter-spacing:-.02em')}>Notifications</h1>
      <Tabs items={['All', 'Mentions', 'Gifts', 'Likes', 'Comments', 'Followers', 'Wallet']} value={tab} onChange={setTab} />
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <><Skeleton h={80} /><Skeleton h={80} /><Skeleton h={80} /></>}
      {list.data && list.data.notifications.length === 0 && <Empty title="Nothing here yet" body="Likes, gifts, follows and wallet updates show up here." />}
      <div style={s('display:flex;flex-direction:column;gap:10px')}>
        {list.data?.notifications.map(n => {
          const gifty = n.type === 'GIFT_RECEIVED';
          const [d, d2] = iconFor(n.type);
          return (
            <button key={n.id} onClick={() => open(n)} style={{ display: 'flex', gap: 13, alignItems: 'flex-start', padding: '15px 17px', borderRadius: 18, background: gifty ? '#FFFCF4' : '#fff', border: gifty ? '1px solid rgba(201,138,18,.3)' : '1px solid rgba(16,20,16,.08)', textAlign: 'left', width: '100%', position: 'relative' }}>
              <div style={{ width: 38, height: 38, borderRadius: 12, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: gifty ? '#FCF3E0' : '#EEF2EC', color: gifty ? '#C98A12' : '#3C433A' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} />{d2 && <path d={d2} />}</svg>
              </div>
              <div style={s('flex:1;min-width:0')}>
                <div style={s('font-size:14.5px;font-weight:700;line-height:1.4;text-wrap:pretty')}>{n.title}</div>
                <div style={s('margin-top:3px;font-size:13.5px;color:#5A6358;line-height:1.5')}>{n.body}</div>
                <div style={s('margin-top:6px;font-size:12px;color:#9AA197;font-weight:600')}>{timeAgoLong(n.createdAt)}</div>
              </div>
              {n.amountLabel && <div style={s('font-size:15px;font-weight:800;color:#14975C;flex:none')}>{n.amountLabel}</div>}
              {!n.read && <span aria-label="Unread" style={s('position:absolute;top:12px;right:12px;width:7px;height:7px;border-radius:50%;background:#C98A12')} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
