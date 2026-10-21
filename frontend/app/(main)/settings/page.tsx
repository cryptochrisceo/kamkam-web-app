'use client';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { H, s } from '@/lib/ui';
import { useApp } from '@/components/AppProvider';
import { Toggle } from '@/components/ui';

const GROUPS: { title: string; desc: string; rows: [string, string, string][] }[] = [
  { title: 'Notifications', desc: 'What reaches you, and when.', rows: [['gifts', 'Gift alerts', 'Push me when someone gifts a post'], ['mentions', 'Mentions and replies', 'Only from people I follow'], ['boost', 'Boost updates', 'When a post enters or leaves a boost window']] },
  { title: 'Privacy', desc: 'Your wallet balance is never public.', rows: [['dms', 'Direct messages from anyone', 'Off means followers only'], ['tips', 'Show gifts received on profile', 'Supporter names only, never amounts']] },
  { title: 'Creator', desc: 'How your earnings behave.', rows: [['quiet', 'Auto-withdraw weekly', 'Saved preference — automatic payouts are not available yet']] },
];
const DEFAULTS: Record<string, boolean> = { gifts: true, mentions: true, boost: true, dms: false, tips: true, quiet: false };

export default function SettingsPage() {
  const { me, setMe, showToast, logout } = useApp();
  const router = useRouter();
  const settings = { ...DEFAULTS, ...(me?.settings ?? {}) };
  const toggle = async (key: string) => {
    const next = { ...settings, [key]: !settings[key] };
    if (me) setMe({ ...me, settings: next });
    try { const r = await api.updateMe({ settings: next }); setMe(r.user); }
    catch (e) { showToast((e as Error).message); if (me) setMe({ ...me, settings }); }
  };
  return (
    <div>
      <h1 style={s('margin:0 0 14px;font-size:26px;font-weight:800;letter-spacing:-.02em')}>Settings</h1>
      <div style={s('display:flex;flex-direction:column;gap:12px')}>
        {GROUPS.map(g => (
          <div key={g.title} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
            <h2 style={s('margin:0 0 2px;font-size:15.5px;font-weight:800')}>{g.title}</h2>
            <p style={s('margin:0 0 8px;font-size:13px;color:#6B7268')}>{g.desc}</p>
            {g.rows.map(([key, label, hint]) => (
              <div key={key} style={s('display:flex;align-items:center;gap:14px;padding:13px 0;border-top:1px solid rgba(16,20,16,.06)')}>
                <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:650')}>{label}</div><div style={s('font-size:12.5px;color:#6B7268;margin-top:2px')}>{hint}</div></div>
                <Toggle on={!!settings[key]} onClick={() => toggle(key)} label={label} />
              </div>
            ))}
          </div>
        ))}
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
          <h2 style={s('margin:0 0 2px;font-size:15.5px;font-weight:800')}>Account</h2>
          <p style={s('margin:0 0 12px;font-size:13px;color:#6B7268')}>Signed in as @{me?.username} · {me?.email}</p>
          <div style={s('display:flex;gap:9px;flex-wrap:wrap')}>
            <button onClick={() => router.push('/profile/' + me?.username + '?edit=1')} className={H.ghost} style={s('font-size:13.5px;font-weight:700;border:1px solid rgba(16,20,16,.14);padding:10px 16px;border-radius:99px')}>Edit profile</button>
            <button onClick={async () => { await logout(); router.replace('/login'); }} className={H.ink} style={s('font-size:13.5px;font-weight:700;background:#101410;color:#fff;padding:10px 18px;border-radius:99px')}>Log out</button>
          </div>
        </div>
      </div>
    </div>
  );
}
