'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from './AppProvider';

/** Follow / Following toggle — the two button styles from the prototype. */
export function FollowButton({ userId, initial, small, onChange }: { userId: string; initial: boolean; small?: boolean; onChange?: (following: boolean, followers: number) => void }) {
  const { me, showToast, refreshMe } = useApp();
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!me) return router.push('/login');
    setBusy(true);
    const was = on;
    setOn(!was);
    try {
      const r = was ? await api.unfollow(userId) : await api.follow(userId);
      setOn(r.following); onChange?.(r.following, r.followers); refreshMe();
    } catch (e) { setOn(was); showToast((e as Error).message); }
    finally { setBusy(false); }
  };
  const style = small
    ? (on ? { fontSize: 12.5, fontWeight: 700, border: '1px solid rgba(16,20,16,.14)', padding: '7px 13px', borderRadius: 99, flex: 'none' } : { fontSize: 12.5, fontWeight: 700, background: '#101410', color: '#fff', padding: '7px 15px', borderRadius: 99, flex: 'none' })
    : (on ? { fontSize: 13, fontWeight: 700, border: '1px solid rgba(16,20,16,.14)', padding: '8px 16px', borderRadius: 99, flex: 'none' } : { fontSize: 13, fontWeight: 700, background: '#101410', color: '#fff', padding: '8px 18px', borderRadius: 99, flex: 'none' });
  return <button onClick={toggle} disabled={busy} style={style} aria-pressed={on}>{on ? 'Following' : 'Follow'}</button>;
}
