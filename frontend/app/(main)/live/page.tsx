'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useApp } from '@/components/AppProvider';
import { Avatar, Empty, ErrorBox, Skeleton, Spinner } from '@/components/ui';

export default function LivePage() {
  const router = useRouter();
  const { me, showToast } = useApp();
  const lives = useAsync(() => api.lives(), [], { pollMs: 20000 });
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = lives.data?.find(l => l.isHost);

  const start = async () => {
    setBusy(true); setErr(null);
    try { const l = await api.startLive(title.trim()); showToast('You are live'); router.push('/live/' + l.id); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1 style={s('margin:0 0 4px;font-size:26px;font-weight:800;letter-spacing:-.02em')}>Live</h1>
      <p style={s('margin:0 0 14px;font-size:14px;color:#6B7268')}>Live rooms with real-time chat, viewers and gifts. Video streaming is not available yet.</p>

      {me && (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-bottom:14px')}>
          {mine ? (
            <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap')}>
              <div style={s('flex:1;min-width:0')}><div style={s('font-size:14.5px;font-weight:800')}>You’re live: {mine.title}</div><div style={s('font-size:12.5px;color:#6B7268')}>{mine.viewers} watching · started {timeAgo(mine.startedAt)}</div></div>
              <button onClick={() => router.push('/live/' + mine.id)} className={H.green} style={s('background:#14975C;color:#fff;font-weight:800;font-size:13.5px;padding:10px 18px;border-radius:99px')}>Open your room</button>
            </div>
          ) : (
            <>
              <h2 style={s('margin:0;font-size:16px;font-weight:800')}>Go live</h2>
              <input value={title} onChange={e => setTitle(e.target.value.slice(0, 100))} placeholder="What’s your live about?" aria-label="Live title" style={s('margin-top:10px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:12px 14px;outline:none;font-size:14.5px;font-weight:600')} />
              {err && <div role="alert" style={s('margin-top:10px;font-size:13px;font-weight:700;color:#A8331F')}>{err}</div>}
              <button onClick={start} disabled={busy || title.trim().length < 3} style={{ ...s('margin-top:12px;color:#fff;font-weight:800;font-size:14.5px;padding:12px 22px;border-radius:14px;display:flex;align-items:center;gap:8px'), background: busy || title.trim().length < 3 ? 'rgba(16,20,16,.16)' : '#D0412F' }}>
                {busy && <Spinner size={14} color="#fff" />}Start live room
              </button>
            </>
          )}
        </div>
      )}

      {lives.error && <ErrorBox message={lives.error} onRetry={lives.reload} />}
      {lives.loading && !lives.data && <Skeleton h={140} />}
      {lives.data?.length === 0 && <Empty title="No one is live right now" body="When creators go live, their rooms show up here." />}
      <div style={s('display:flex;flex-direction:column;gap:10px')}>
        {lives.data?.map(l => (
          <button key={l.id} onClick={() => router.push('/live/' + l.id)} className={H.soft} style={s('display:flex;align-items:center;gap:12px;text-align:left;padding:14px;border-radius:18px;background:#fff;border:1px solid rgba(16,20,16,.08)')}>
            <Avatar user={l.host} size={44} radius="14px" />
            <div style={s('flex:1;min-width:0')}>
              <div style={s('font-size:14.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{l.title}</div>
              <div style={s('font-size:12.5px;color:#6B7268')}>@{l.host.username} · {l.viewers} watching · {timeAgo(l.startedAt)}</div>
            </div>
            <span style={s('font-size:10.5px;font-weight:800;color:#fff;background:#D0412F;padding:3px 7px;border-radius:5px;flex:none')}>LIVE</span>
          </button>
        ))}
      </div>
    </div>
  );
}
