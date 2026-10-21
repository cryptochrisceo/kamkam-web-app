'use client';
import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { compact, money } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import { useAsync } from '@/hooks/useAsync';
import { supabase } from '@/lib/supabase';
import type { Earnings, LiveSession, PublicUser } from '@/types';
import { useApp } from './AppProvider';
import { Avatar, GiftIcon, I, Icon } from './ui';
import { GiftSheet } from './GiftSheet';
import { WalletFlowModal } from './WalletFlows';
import { CreateWalletModal } from './CreateWallet';
import { ComposerModal } from './Composer';
import { FollowButton } from './FollowButton';

const NAV: [string, string, string, string][] = [
  ['/', 'Home', I.home, ''],
  ['/explore', 'Explore', I.search, I.search2],
  ['/notifications', 'Notifications', I.bell, I.bell2],
  ['/messages', 'Messages', I.chat, ''],
  ['/bookmarks', 'Bookmarks', I.bookmark, ''],
  ['/communities', 'Communities', I.people, I.people2],
  ['/wallet', 'Wallet', I.wallet, I.wallet2],
  ['/profile', 'Profile', I.user, I.user2],
  ['/settings', 'Settings', I.settings, I.settings2],
];

const Logo = ({ size = 34 }: { size?: number }) => (
  <div style={{ width: size, height: size, borderRadius: size > 30 ? 11 : 10, background: '#14975C', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: '#fff' }}>
    <GiftIcon size={size > 30 ? 19 : 17} sw={2.1} />
  </div>
);

export function Shell({ children }: { children: ReactNode }) {
  const { me, wallet, toast, setComposerOpen, giftTarget, flow } = useApp();
  const { isMobile, isTablet, narrow, showRight } = useViewport();
  const path = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => { if (path === '/explore') setQ(params.get('q') ?? ''); }, [path, params]);

  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const profileHref = me ? '/profile/' + me.username : '/login';
  const ngn = Number(wallet?.ngn.balance ?? 0);
  const onSearch = (v: string) => {
    setQ(v);
    router.replace('/explore' + (v.trim() ? '?q=' + encodeURIComponent(v) : ''));
  };

  return (
    <div style={s('display:flex;min-height:100vh;background:#F5F7F4;align-items:flex-start')}>
      {!isMobile && (
        <aside style={{ ...s('position:sticky;top:0;height:100vh;min-height:0;overflow-y:auto;overscroll-behavior:contain;flex:none;padding:20px 14px 18px;display:flex;flex-direction:column;border-right:1px solid rgba(16,20,16,.07);background:#F5F7F4'), width: isTablet ? 82 : 248 }}>
          <Link href="/" style={s('display:flex;align-items:center;gap:10px;padding:4px 10px 22px;color:#101410')}>
            <Logo />
            {!isTablet && <span style={s('font-family:"Bricolage Grotesque",Manrope,sans-serif;font-weight:800;font-size:20px;letter-spacing:-.03em')}>KAMKAM</span>}
          </Link>
          <nav style={s('display:flex;flex-direction:column;gap:2px')} aria-label="Primary">
            {NAV.map(([href, label, icon, icon2]) => {
              const on = href === '/profile' ? path.startsWith('/profile/' + (me?.username ?? '')) : active(href);
              const badge = href === '/notifications' ? me?.unreadNotifications : href === '/messages' ? me?.unreadMessages : 0;
              return (
                <Link key={href} href={href === '/profile' ? profileHref : href} aria-label={label} title={label}
                  style={{ display: 'flex', alignItems: 'center', gap: 13, justifyContent: isTablet ? 'center' : 'flex-start', padding: '11px 13px', borderRadius: 13, color: on ? '#0E7546' : '#3C433A', background: on ? '#E8F5EE' : 'transparent', transition: 'background .15s, color .15s', width: '100%', textAlign: 'left', position: 'relative' }}>
                  <Icon d={icon} d2={icon2} size={21} sw={on ? 2.2 : 1.85} style={{ flex: 'none' }} />
                  {!isTablet && <span style={{ fontSize: 14.5, fontWeight: on ? 750 : 550 }}>{label}</span>}
                  {!!badge && <span style={isTablet ? s('position:absolute;top:6px;right:12px;background:#14975C;color:#fff;font-size:10px;font-weight:700;padding:0 5px;border-radius:99px') : s('margin-left:auto;background:#14975C;color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:99px')}>{badge > 99 ? '99+' : badge}</span>}
                </Link>
              );
            })}
          </nav>
          <button onClick={() => setComposerOpen(true)} className={H.greenLift} style={s('margin-top:14px;display:flex;align-items:center;justify-content:center;gap:9px;background:#14975C;color:#fff;font-weight:700;font-size:14.5px;padding:13px 16px;border-radius:14px;box-shadow:0 6px 16px rgba(20,151,92,.24);transition:background .16s, transform .16s')}>
            <Icon d={I.plus} d2={I.plus2} size={18} sw={2.4} />
            {!isTablet && <span>Create Post</span>}
          </button>
          {me && (
            <div style={s('margin-top:auto')}>
              <button onClick={() => router.push(profileHref)} className={H.ghost} style={s('display:flex;align-items:center;gap:10px;width:100%;padding:9px;border-radius:14px;text-align:left;transition:background .15s')}>
                <Avatar user={me} size={36} />
                {!isTablet && <div style={s('flex:1;min-width:0')}>
                  <div style={s('font-size:13.5px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{me.displayName}</div>
                  <div style={s('font-size:12px;color:#6B7268;line-height:1.3')}>@{me.username}</div>
                </div>}
                {!isTablet && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7268" strokeWidth="2.4" strokeLinecap="round"><circle cx="5" cy="12" r=".6" /><circle cx="12" cy="12" r=".6" /><circle cx="19" cy="12" r=".6" /></svg>}
              </button>
            </div>
          )}
        </aside>
      )}

      <main style={{ flex: 1, minWidth: 0, paddingBottom: isMobile ? 110 : 86 }}>
        <header style={{ ...s('position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:10px;background:rgba(245,247,244,.9);backdrop-filter:blur(12px);border-bottom:1px solid rgba(16,20,16,.07)'), padding: isMobile ? '10px 14px' : '12px 26px' }}>
          {isMobile && <Link href="/" aria-label="Home" style={s('display:flex;align-items:center;gap:8px;flex:none')}><Logo size={30} /></Link>}
          <div style={s('flex:1;min-width:0;display:flex;align-items:center;gap:9px;background:#fff;border:1px solid rgba(16,20,16,.09);border-radius:99px;padding:9px 16px;max-width:420px')}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6B7268" strokeWidth="2.2" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="11" cy="11" r="7" /><path d="M16.6 16.6 21 21" /></svg>
            <input value={q} onChange={e => onSearch(e.target.value)} onFocus={() => path !== '/explore' && router.push('/explore' + (q ? '?q=' + encodeURIComponent(q) : ''))} placeholder="Search KAMKAM" aria-label="Search KAMKAM" style={s('border:0;background:none;outline:none;width:100%;font-size:14px;font-weight:500')} />
          </div>
          <div style={s('display:flex;align-items:center;gap:6px;flex:none')}>
            <Link href="/notifications" aria-label="Notifications" className={H.ghost} style={s('position:relative;width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#3C433A')}>
              <Icon d={I.bell} d2={I.bell2} size={20} sw={1.9} />
              {!!me?.unreadNotifications && <span style={s('position:absolute;top:7px;right:8px;width:7px;height:7px;border-radius:50%;background:#C98A12;border:1.5px solid #fff')} />}
            </Link>
            <Link href="/messages" aria-label="Messages" className={H.ghost} style={s('position:relative;width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#3C433A')}>
              <Icon d={I.chat} size={20} sw={1.9} />
              {!!me?.unreadMessages && <span style={s('position:absolute;top:7px;right:8px;width:7px;height:7px;border-radius:50%;background:#14975C;border:1.5px solid #fff')} />}
            </Link>
            {!isMobile && me && (
              <Link href="/wallet" className={H.chip} style={s('display:flex;align-items:center;gap:7px;background:#E8F5EE;color:#0E7546;font-weight:800;font-size:13px;padding:9px 14px;border-radius:99px')}>
                <Icon d={I.wallet} d2={I.wallet2} size={16} />{wallet ? money(ngn) : '…'}
              </Link>
            )}
            {isMobile && me && <Link href="/wallet" aria-label="Wallet" className={H.ghost} style={s('width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#0E7546')}><Icon d={I.wallet} d2={I.wallet2} size={20} sw={1.9} /></Link>}
            {me && <Avatar user={me} size={36} onClick={() => router.push(profileHref)} style={{ marginLeft: 2 }} />}
          </div>
        </header>

        <div style={{ display: 'flex', gap: narrow ? 18 : 26, padding: isMobile ? 14 : '20px 26px', alignItems: 'flex-start', justifyContent: 'center' }}>
          <div style={s('flex:1;min-width:0;max-width:640px')}>{children}</div>
          {showRight && <RightRail width={narrow ? 292 : 324} />}
        </div>
      </main>

      {isMobile && (
        <nav style={s('position:fixed;left:0;right:0;bottom:0;z-index:60;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-top:1px solid rgba(16,20,16,.08);display:flex;align-items:center;justify-content:space-around;padding:8px 6px 10px')} aria-label="Mobile navigation">
          {([['/', 'Home', I.home, ''], ['/explore', 'Explore', I.search, I.search2], ['create', 'Create', I.plus, I.plus2], ['/notifications', 'Alerts', I.bell, I.bell2], ['/messages', 'Inbox', I.chat, '']] as const).map(([href, label, icon, icon2]) => {
            if (href === 'create') return (
              <button key={href} onClick={() => setComposerOpen(true)} aria-label="Create" style={s('display:flex;align-items:center;justify-content:center;width:52px;height:46px;border-radius:16px;background:#14975C;color:#fff;box-shadow:0 6px 14px rgba(20,151,92,.3)')}><Icon d={icon} d2={icon2} size={22} sw={2.6} /></button>
            );
            const on = active(href);
            return (
              <Link key={href} href={href} aria-label={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 12px', borderRadius: 12, color: on ? '#0E7546' : '#6B7268', minWidth: 58 }}>
                <Icon d={icon} d2={icon2} size={21} sw={on ? 2.2 : 1.85} />
                <span style={{ fontSize: 10.5, fontWeight: on ? 750 : 600 }}>{label}</span>
              </Link>
            );
          })}
        </nav>
      )}

      {giftTarget && <GiftSheet key={(giftTarget.post?.id ?? '') + giftTarget.user.id} />}
      {flow && <WalletFlowModal />}
      <CreateWalletModal />
      <ComposerModal />
      {toast && (
        <div role="status" style={{ ...s('position:fixed;left:50%;transform:translateX(-50%);z-index:120;display:flex;align-items:center;gap:9px;background:#101410;color:#fff;font-size:13.5px;font-weight:700;padding:12px 18px;border-radius:99px;box-shadow:0 12px 30px rgba(16,20,16,.3);animation:kkUp .25s ease-out;max-width:calc(100% - 32px)'), bottom: isMobile ? 96 : 28 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#7BE0AE" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d={I.check} /></svg>{toast}
        </div>
      )}
    </div>
  );
}

/** Real live sessions from the database, refreshed by Realtime (with a polling fallback). */
function LiveNow() {
  const router = useRouter();
  const path = usePathname();
  const [lives, setLives] = useState<LiveSession[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api.lives().then(r => { if (live) { setLives(r); setErr(false); } }).catch(() => live && setErr(true));
    load();
    const t = setInterval(load, 30000);
    const ch = supabase().channel('live-rail').on('postgres_changes', { event: '*', schema: 'public', table: 'live_sessions' }, load).subscribe();
    return () => { live = false; clearInterval(t); supabase().removeChannel(ch); };
  }, [path]);
  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px')}>
      <div style={s('display:flex;align-items:center;gap:8px;margin-bottom:12px')}>
        <span style={{ ...s('width:7px;height:7px;border-radius:50%;background:#D0412F'), animation: lives?.length ? 'kkPulse 1.8s infinite' : undefined, opacity: lives?.length ? 1 : 0.35 }} />
        <span style={s('font-size:12.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase')}>Live on KAMKAM</span>
        <Link href="/live" style={s('margin-left:auto;font-size:12px;font-weight:800;color:#14975C')}>Go live</Link>
      </div>
      {!lives && !err && [0, 1].map(i => <div key={i} className="kk-skel" style={{ height: 46, marginBottom: 8, borderRadius: 14 }} />)}
      {err && !lives && <div style={s('font-size:13px;color:#6B7268;padding:4px 8px')}>Live sessions are unavailable right now.</div>}
      {lives?.length === 0 && <div style={s('font-size:13px;color:#6B7268;padding:4px 8px;line-height:1.55')}>No one is live right now. Start a session and chat with your followers in real time.</div>}
      <div style={s('display:flex;flex-direction:column;gap:10px')}>
        {lives?.slice(0, 4).map(l => (
          <button key={l.id} onClick={() => router.push('/live/' + l.id)} className={H.soft} style={s('display:flex;align-items:center;gap:11px;text-align:left;padding:8px;border-radius:14px')}>
            <Avatar user={l.host} size={38} radius="13px" />
            <div style={s('flex:1;min-width:0')}>
              <div style={s('font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{l.title}</div>
              <div style={s('font-size:12px;color:#6B7268')}>@{l.host.username} · {l.viewers} watching</div>
            </div>
            <span style={s('font-size:10.5px;font-weight:800;color:#fff;background:#D0412F;padding:3px 7px;border-radius:5px;flex:none')}>LIVE</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RightRail({ width }: { width: number }) {
  const { me, walletVersion, openFlow } = useApp();
  const router = useRouter();
  const earn = useAsync<Earnings | null>(() => (me ? api.earnings().then(r => r.earnings) : Promise.resolve(null)), [me?.id, walletVersion]);
  const trend = useAsync(() => api.trending(), []);
  const sugg = useAsync(() => api.suggested(3), [me?.id]);
  return (
    <aside style={{ ...s('position:sticky;top:78px;flex:none;display:flex;flex-direction:column;gap:14px'), width }}>
      {me && <LiveNow />}

      {me && (
        <div style={s('background:#101410;border-radius:20px;padding:18px;color:#fff;position:relative;overflow:hidden')}>
          <div style={s('position:absolute;right:-40px;bottom:-50px;width:150px;height:150px;border-radius:50%;background:rgba(201,138,18,.22)')} />
          <div style={s('position:relative')}>
            <div style={s('font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55)')}>Creator earnings</div>
            <div style={s('font-size:28px;font-weight:800;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums')}>{earn.data ? money(earn.data.availableNgn) : '—'}</div>
            <div style={s('display:flex;gap:18px;margin-top:12px')}>
              <div><div style={s('font-size:11px;color:rgba(255,255,255,.55);font-weight:700')}>This month</div><div style={s('font-size:14.5px;font-weight:700;margin-top:2px')}>{earn.data ? money(earn.data.thisMonthNgn) : '—'}</div></div>
              <div><div style={s('font-size:11px;color:rgba(255,255,255,.55);font-weight:700')}>Total gifts</div><div style={s('font-size:14.5px;font-weight:700;margin-top:2px')}>{earn.data ? earn.data.totalGifts.toLocaleString() : '—'}</div></div>
            </div>
            <button onClick={() => openFlow('withdraw', { source: 'EARNINGS' })} className={H.greenLight} style={s('margin-top:16px;width:100%;background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:11px;border-radius:12px')}>Withdraw</button>
            <button onClick={() => router.push('/wallet?tab=Earnings')} style={s('margin-top:8px;width:100%;color:rgba(255,255,255,.7);font-weight:700;font-size:12.5px;padding:4px')}>View earnings dashboard →</button>
          </div>
        </div>
      )}

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px')}>
        <h2 style={s('margin:0 0 11px;font-size:12.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6B7268')}>Trending</h2>
        <div style={s('display:flex;flex-direction:column')}>
          {trend.loading && !trend.data && [0, 1, 2].map(i => <div key={i} className="kk-skel" style={{ height: 36, marginBottom: 6 }} />)}
          {trend.data?.topics.length === 0 && <div style={s('font-size:13px;color:#6B7268;padding:6px 8px')}>No hashtags yet. Start one!</div>}
          {trend.data?.topics.map(t => (
            <button key={t.tag} onClick={() => router.push('/explore?q=' + encodeURIComponent(t.tag))} className={H.soft} style={s('display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:12px;text-align:left')}>
              <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700')}>{t.tag}</div><div style={s('font-size:12px;color:#6B7268')}>{compact(t.count)} posts</div></div>
              <span style={s('font-size:11.5px;font-weight:700;color:#14975C')}>{t.rise}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px')}>
        <h2 style={s('margin:0 0 10px;font-size:12.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6B7268')}>Who to follow</h2>
        <div style={s('display:flex;flex-direction:column;gap:4px')}>
          {sugg.data?.users.map((c: PublicUser) => (
            <div key={c.id} style={s('display:flex;align-items:center;gap:11px;padding:7px 0')}>
              <Avatar user={c} size={40} onClick={() => router.push('/profile/' + c.username)} />
              <Link href={'/profile/' + c.username} style={s('flex:1;min-width:0;color:#101410')}><div style={s('font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{c.displayName}</div><div style={s('font-size:12px;color:#6B7268')}>@{c.username}</div></Link>
              <FollowButton userId={c.id} initial={!!c.isFollowing} small />
            </div>
          ))}
          {sugg.data?.users.length === 0 && <div style={s('font-size:13px;color:#6B7268')}>You follow everyone. Nice.</div>}
        </div>
      </div>

      <p style={s('margin:0;font-size:11.5px;color:#9AA197;line-height:1.7;padding:0 6px')}>KAMKAM · Creators keep 80% of every gift.</p>
    </aside>
  );
}
