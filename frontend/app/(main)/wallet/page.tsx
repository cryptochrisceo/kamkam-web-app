'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { assetColor, dateTime, label, money, moneyExact, qty, shortAddr, timeAgo } from '@/lib/format';
import { dot, H, s, statusStyle, statusText } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { supabase } from '@/lib/supabase';
import { useApp } from '@/components/AppProvider';
import type { FlowName } from '@/components/AppProvider';
import { Avatar, Badge, Empty, ErrorBox, I, Icon, Skeleton, Tabs, Toggle } from '@/components/ui';
import type { ChainBalances, WalletTx } from '@/types';

const WTABS = ['Overview', 'Activity', 'Gifts', 'Earnings', 'Security'];
const ACTIONS: [string, string, string, FlowName, boolean][] = [
  ['Send', 'M5 12h14', 'm13 6 6 6-6 6', 'send', true],
  ['Receive', 'M19 12H5', 'm11 6-6 6 6 6', 'receive', true],
  ['Swap', 'M4 8h13M14 5l3 3-3 3', 'M20 16H7m3-3-3 3 3 3', 'swap', false],
  ['Buy', 'M12 5v14', 'M5 12h14', 'buy', false],
  ['Sell', 'M5 12h14', '', 'sell', false],
  ['Deposit', 'M12 4v12', 'm7 11 5 5 5-5M5 20h14', 'deposit', true],
  ['Withdraw', 'M12 20V8', 'm7 13 5-5 5 5M5 4h14', 'withdraw', true],
  ['Transfer', 'M7 7h10M13 3l4 4-4 4', 'M17 17H7m4 4-4-4 4-4', 'transfer', true],
];

export default function WalletPage() {
  const params = useSearchParams();
  const router = useRouter();
  const { wallet, walletError, refreshWallet, walletVersion, openFlow, config } = useApp();
  const [tab, setTabState] = useState(params.get('tab') && WTABS.includes(params.get('tab')!) ? params.get('tab')! : 'Overview');
  const setTab = (t: string) => { setTabState(t); router.replace('/wallet' + (t === 'Overview' ? '' : '?tab=' + t)); };
  useEffect(() => { const t = params.get('tab'); if (t && WTABS.includes(t)) setTabState(t); }, [params]);
  const [network, setNetwork] = useState('all');
  const [netMenu, setNetMenu] = useState(false);
  const [locked, setLocked] = useState(false);
  const autoLock = useApp().me?.walletSecurity?.pin !== false;
  useEffect(() => {
    if (!autoLock || locked) return;
    let t = setTimeout(() => setLocked(true), 5 * 60_000);
    const bump = () => { clearTimeout(t); t = setTimeout(() => setLocked(true), 5 * 60_000); };
    const evs = ['pointerdown', 'keydown', 'scroll'] as const;
    evs.forEach(e => window.addEventListener(e, bump, { passive: true }));
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, bump)); };
  }, [autoLock, locked]);
  useEffect(() => { refreshWallet(); }, [walletVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wallet && walletError) return <ErrorBox message={walletError} onRetry={refreshWallet} />;
  if (!wallet) return <><Skeleton h={60} /><Skeleton h={220} /><Skeleton h={120} /></>;
  const has = wallet.cryptoActivated;
  const nets = config?.crypto.networks ?? [];
  const testnet = has && wallet.crypto?.networkMode === 'testnet';
  const netLabel = network === 'all' ? 'All Networks' : nets.find(n => n.id === network)?.label ?? 'All Networks';

  return (
    <div>
      <div style={s('display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px')}>
        <div>
          <h1 style={s('margin:0;font-size:26px;font-weight:800;letter-spacing:-.02em;display:flex;align-items:center;gap:10px')}>Wallet {testnet && <Badge text="Testnet" title="Crypto runs on test networks — tokens have no real value" />}{config?.payments.mode === 'test' && <Badge text="Payments test mode" title="Paystack test keys — no real money moves" />}</h1>
          <p style={s('margin:4px 0 0;font-size:14px;color:#6B7268')}>Naira balance, gifts, earnings{has ? ' and on-chain crypto' : ''}.</p>
        </div>
        {has && nets.length > 0 && (
          <div style={s('margin-left:auto;position:relative')}>
            <button onClick={() => setNetMenu(o => !o)} style={s('display:flex;align-items:center;gap:9px;background:#fff;border:1px solid rgba(16,20,16,.1);border-radius:99px;padding:10px 15px;font-size:13.5px;font-weight:700')} aria-label="Select network">
              <span style={dot(network === 'all' ? '#14975C' : nets.find(n => n.id === network)?.color ?? '#14975C')} />{netLabel}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7268" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={I.chevron} /></svg>
            </button>
            {netMenu && (
              <div style={s('position:absolute;right:0;top:48px;z-index:50;width:230px;background:#fff;border:1px solid rgba(16,20,16,.1);border-radius:16px;padding:6px;box-shadow:0 18px 44px rgba(16,20,16,.18);animation:kkUp .16s ease-out')}>
                {[{ id: 'all', label: 'All Networks', color: '#14975C' }, ...nets].map(n => {
                  const on = network === n.id;
                  return (
                    <button key={n.id} onClick={() => { setNetwork(n.id); setNetMenu(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 11px', borderRadius: 11, fontSize: 13.5, fontWeight: on ? 750 : 600, background: on ? '#F1F6F2' : 'transparent', textAlign: 'left' }}>
                      <span style={dot(n.color)} />{n.label}
                      {on && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#14975C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }}><path d={I.check} /></svg>}
                    </button>
                  );
                })}
                <p style={s('margin:6px 4px 4px;font-size:11.5px;color:#9AA197;line-height:1.55')}>Supported networks only: Ethereum, Base and Solana.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <Tabs items={WTABS} value={tab} onChange={setTab} />
      {locked ? (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:22px;padding:34px 24px;text-align:center')}>
          <h2 style={s('margin:0;font-size:20px;font-weight:800')}>Wallet locked</h2>
          <p style={s('margin:8px 0 0;font-size:14px;color:#6B7268')}>Balances are hidden until you unlock.</p>
          <button onClick={() => setLocked(false)} className={H.green} style={s('margin-top:16px;background:#14975C;color:#fff;font-weight:800;font-size:14.5px;padding:12px 26px;border-radius:14px')}>Unlock</button>
        </div>
      ) : (
        <>
          {tab === 'Overview' && <Overview network={network} onTab={setTab} openFlow={openFlow} />}
          {tab === 'Activity' && <ActivityTab />}
          {tab === 'Gifts' && <GiftsTab />}
          {tab === 'Earnings' && <EarningsTab />}
          {tab === 'Security' && <SecurityTab onLock={() => setLocked(true)} />}
        </>
      )}
    </div>
  );
}

function CreateCryptoCard() {
  const { setCreateWalletOpen, config } = useApp();
  const enabled = !!config?.crypto.enabled;
  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:22px;padding:34px 24px;text-align:center;margin-top:14px')}>
      <div style={s('width:62px;height:62px;margin:0 auto;border-radius:20px;background:#E8F5EE;color:#14975C;display:flex;align-items:center;justify-content:center')}><Icon d={I.wallet} d2={I.wallet2} size={30} sw={1.9} /></div>
      <h2 style={s('margin:18px 0 0;font-size:22px;font-weight:800;letter-spacing:-.02em')}>Create Your Crypto Wallet</h2>
      <p style={s('margin:9px auto 0;font-size:14.5px;color:#5A6358;line-height:1.6;max-width:44ch;text-wrap:pretty')}>{enabled ? 'Get real on-chain addresses on Ethereum, Base and Solana to send and receive crypto from KAMKAM.' : 'Crypto wallets are not available on this server yet. Your Naira balance, gifts and earnings work without one.'}</p>
      {enabled && (
        <>
          <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0 4px;text-align:left')}>
            {[['Provider-managed keys', 'Secured by Coinbase Developer Platform.'], ['Multi-chain', 'ETH, USDC and SOL on supported networks.'], ['Real transactions', 'Every send has an on-chain hash.']].map(([t, d]) => (
              <div key={t} style={s('padding:13px 15px;border-radius:14px;background:#F5F7F4')}><div style={s('font-size:13px;font-weight:750')}>{t}</div><div style={s('margin-top:3px;font-size:12.5px;color:#6B7268;line-height:1.5')}>{d}</div></div>
            ))}
          </div>
          <button onClick={() => setCreateWalletOpen(true)} className={H.green} style={s('margin-top:16px;width:100%;max-width:320px;background:#14975C;color:#fff;font-weight:800;font-size:15px;padding:15px;border-radius:15px')}>Create Wallet</button>
        </>
      )}
    </div>
  );
}

function TxRow({ t }: { t: WalletTx }) {
  const [open, setOpen] = useState(false);
  const inbound = t.direction === 'IN';
  return (
    <div style={s('border-top:1px solid rgba(16,20,16,.06)')}>
      <button onClick={() => setOpen(o => !o)} style={s('display:flex;align-items:center;gap:12px;padding:13px 0;width:100%;text-align:left')}>
        <div style={{ width: 34, height: 34, borderRadius: 11, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: inbound ? '#E8F5EE' : '#EEF2EC', color: inbound ? '#14975C' : '#5A6358' }}>
          <Icon d={inbound ? I.up : I.down} size={16} sw={2.2} />
        </div>
        <div style={s('flex:1;min-width:0')}>
          <div style={s('font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{t.description}</div>
          <div style={s('display:flex;align-items:center;gap:8px;margin-top:3px;flex-wrap:wrap')}>
            <span style={s('font-size:12.5px;color:#6B7268')}>{t.network ?? label(t.asset)} · {dateTime(t.createdAt)}</span>
            <span style={statusStyle(t.status)}>{statusText(t.status)}</span>
          </div>
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: inbound ? '#14975C' : '#3C433A', fontVariantNumeric: 'tabular-nums', flex: 'none', whiteSpace: 'nowrap' }}>{t.amountLabel}</div>
      </button>
      {open && (
        <div style={s('margin:0 0 12px 46px;padding:11px 13px;border-radius:12px;background:#F5F7F4;font-size:12.5px;display:grid;grid-template-columns:auto 1fr;gap:5px 14px')}>
          <span style={s('color:#6B7268;font-weight:600')}>Reference</span><span style={s('font-family:ui-monospace,Menlo,monospace;font-weight:700;word-break:break-all')}>{t.txHash ? shortAddr(t.txHash) : t.reference}</span>
          <span style={s('color:#6B7268;font-weight:600')}>Type</span><span style={s('font-weight:700')}>{t.type.replace('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())}</span>
          {t.counterparty && <><span style={s('color:#6B7268;font-weight:600')}>Counterparty</span><span style={s('font-weight:700;word-break:break-all')}>{t.counterparty}</span></>}
          <span style={s('color:#6B7268;font-weight:600')}>Date</span><span style={s('font-weight:700')}>{new Date(t.createdAt).toLocaleString()}</span>
          {t.explorerUrl && <><span style={s('color:#6B7268;font-weight:600')}>On-chain</span><a href={t.explorerUrl} target="_blank" rel="noopener noreferrer" style={s('font-weight:800;color:#14975C')}>View on explorer ↗</a></>}
        </div>
      )}
    </div>
  );
}

function CryptoAssets({ network }: { network: string }) {
  const { walletVersion } = useApp();
  const b = useAsync<ChainBalances>(() => api.chainBalances(), [walletVersion]);
  const nets = (b.data?.networks ?? []).filter(n => network === 'all' || n.id === network);
  return (
    <>
      {b.error && <div style={{ marginTop: 8 }}><ErrorBox message={b.error} onRetry={b.reload} /></div>}
      {b.loading && !b.data && <div className="kk-skel" style={{ height: 110, marginTop: 10 }} />}
      {nets.flatMap(n => n.assets.map(a => (
        <div key={n.id + a.symbol} style={s('display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid rgba(16,20,16,.06)')}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: assetColor[a.symbol] ?? n.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: a.symbol.length > 3 ? 10 : 11.5, fontWeight: 800, flex: 'none' }}>{a.symbol}</div>
          <div style={s('flex:1;min-width:0')}>
            <div style={s('font-size:14.5px;font-weight:700')}>{a.symbol}</div>
            <div style={s('font-size:12.5px;color:#6B7268;display:flex;align-items:center;gap:6px')}><span style={dot(n.color)} />{n.label}</div>
          </div>
          <div style={s('text-align:right;flex:none')}>
            <div style={s('font-size:14.5px;font-weight:800;font-variant-numeric:tabular-nums')}>{a.balance === null ? 'Unavailable' : qty(a.symbol, a.balance)}</div>
            <div style={s('font-size:12.5px;color:#6B7268;font-variant-numeric:tabular-nums')}>{n.testnet ? 'Testnet · no value' : a.valueNgn !== null ? '≈ ' + money(a.valueNgn) : a.balance === null ? 'Network unreachable' : 'Price unavailable'}</div>
          </div>
        </div>
      )))}
      {b.data && <div style={s('font-size:11.5px;color:#9AA197;margin-top:6px')}>Read live from each blockchain · {timeAgo(b.data.fetchedAt)}{b.data.mode === 'mainnet' ? ' · prices from CoinGecko' : ''}</div>}
    </>
  );
}

function Overview({ network, onTab, openFlow }: { network: string; onTab: (t: string) => void; openFlow: (n: FlowName, p?: Record<string, string>) => void }) {
  const { wallet, walletVersion } = useApp();
  const earn = useAsync(() => api.earnings().then(r => r.earnings), [walletVersion]);
  const recent = useAsync(() => api.transactions('all'), [walletVersion]);
  const w = wallet!;
  const e = earn.data;
  const held = Number(w.ngn.held);
  const stats = [
    { label: 'Naira balance', value: money(w.ngn.balance), delta: 'Ready to spend' },
    { label: 'Earnings this month', value: e ? money(e.thisMonthNgn) : '—', delta: e?.monthDelta ?? '' },
    { label: 'Gift earnings (total)', value: e ? money(e.totalEarnedNgn) : '—', delta: '80% of every gift' },
    { label: 'Total gifts', value: e ? e.totalGifts.toLocaleString() : '—', delta: e ? `From ${e.supporters} supporter${e.supporters === 1 ? '' : 's'}` : '' },
  ];

  return (
    <div>
      <div style={s('background:#101410;border-radius:22px;padding:24px;color:#fff;position:relative;overflow:hidden')}>
        <div style={s('position:absolute;right:-60px;top:-60px;width:220px;height:220px;border-radius:50%;background:rgba(20,151,92,.28)')} />
        <div style={s('position:relative')}>
          <div style={s('font-size:12.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.6)')}>Naira balance</div>
          <div style={s('font-size:40px;font-weight:800;letter-spacing:-.03em;margin-top:6px;font-variant-numeric:tabular-nums')}>{moneyExact(w.ngn.balance)}</div>
          <div style={s('display:flex;gap:9px;flex-wrap:wrap;margin-top:14px')}>
            <span style={s('display:flex;align-items:center;gap:7px;background:rgba(20,151,92,.35);padding:8px 13px;border-radius:99px;font-size:13px;font-weight:700')}>Earnings {moneyExact(w.ngn.earnings)}</span>
            {held > 0 && <span style={s('display:flex;align-items:center;gap:7px;background:rgba(201,138,18,.22);padding:8px 13px;border-radius:99px;font-size:13px;font-weight:700')}>Withdrawing {moneyExact(held)}</span>}
          </div>
          <div style={s('display:flex;gap:9px;flex-wrap:wrap;margin-top:18px')}>
            <button onClick={() => openFlow('deposit')} className={H.greenLight} style={s('background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:99px')}>Fund wallet</button>
            <button onClick={() => openFlow('withdraw')} className={H.darkGhost} style={s('background:rgba(255,255,255,.12);color:#fff;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:99px')}>Withdraw</button>
          </div>
        </div>
      </div>

      <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:9px;margin-top:14px')}>
        {ACTIONS.map(([l, d, d2, f, available]) => (
          <button key={l} onClick={() => openFlow(f)} className={H.outlineGreenLift} title={available ? undefined : 'Not available yet'} style={{ ...s('display:flex;flex-direction:column;align-items:center;gap:7px;padding:13px 6px;border-radius:15px;background:#fff;border:1px solid rgba(16,20,16,.09);font-size:12px;font-weight:700;color:#101410;transition:all .15s'), opacity: available ? 1 : 0.5 }}>
            <Icon d={d} d2={d2} size={19} />{l}{!available && <span style={s('font-size:10px;font-weight:700;color:#9AA197;margin-top:-4px')}>Soon</span>}
          </button>
        ))}
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px')}>
          <h2 style={s('margin:0;font-size:16px;font-weight:800')}>Assets</h2>
        </div>
        <div style={s('display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid rgba(16,20,16,.06)')}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: assetColor.NGN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, flex: 'none' }}>₦</div>
          <div style={s('flex:1;min-width:0')}><div style={s('font-size:14.5px;font-weight:700')}>Nigerian Naira</div><div style={s('font-size:12.5px;color:#6B7268')}>KAMKAM balance</div></div>
          <div style={s('text-align:right;flex:none')}><div style={s('font-size:14.5px;font-weight:800;font-variant-numeric:tabular-nums')}>{moneyExact(w.ngn.balance)}</div><div style={s('font-size:12.5px;color:#6B7268')}>Naira</div></div>
        </div>
        {w.cryptoActivated && <CryptoAssets network={network} />}
      </div>
      {!w.cryptoActivated && <CreateCryptoCard />}

      <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px')}>
        {stats.map(st => (
          <div key={st.label} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:16px;padding:16px')}>
            <div style={s('font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6B7268')}>{st.label}</div>
            <div style={s('margin-top:7px;font-size:21px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums')}>{st.value}</div>
            <div style={s('margin-top:4px;font-size:12px;color:#14975C;font-weight:700')}>{st.delta}</div>
          </div>
        ))}
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:6px')}>
          <h2 style={s('margin:0;font-size:16px;font-weight:800')}>Creator earnings</h2>
          <span style={s('font-size:12px;font-weight:700;color:#8A5E08;background:#FCF3E0;padding:5px 11px;border-radius:99px')}>80% to you</span>
        </div>
        <p style={s('margin:0 0 14px;font-size:13.5px;color:#6B7268;line-height:1.55')}>Every gift sent to your posts settles here instantly. KAMKAM keeps 20% as a platform fee.</p>
        {e?.history.slice(0, 5).map(h => (
          <div key={h.id} style={s('display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid rgba(16,20,16,.06)')}>
            <div style={s('width:34px;height:34px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;background:#E8F5EE;color:#14975C')}><Icon d={I.up} size={16} sw={2.2} /></div>
            <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700')}>Gift received from @{h.from.username}</div><div style={s('font-size:12.5px;color:#6B7268')}>{dateTime(h.createdAt)} · {h.giftLabel} gift</div></div>
            <div style={s('font-size:14.5px;font-weight:800;color:#14975C;font-variant-numeric:tabular-nums;flex:none')}>{h.amountLabel}</div>
          </div>
        ))}
        {e && e.history.length === 0 && <div style={s('font-size:13.5px;color:#6B7268;padding:6px 0')}>No gifts yet. Post something worth gifting!</div>}
        <button onClick={() => onTab('Earnings')} style={s('margin-top:8px;font-size:13px;font-weight:700;color:#14975C')}>Open earnings dashboard →</button>
      </div>

      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:6px')}>
          <h2 style={s('margin:0;font-size:16px;font-weight:800')}>Recent transactions</h2>
          <button onClick={() => onTab('Activity')} style={s('font-size:13px;font-weight:700;color:#14975C')}>View all</button>
        </div>
        {recent.error && <ErrorBox message={recent.error} onRetry={recent.reload} />}
        {recent.data?.transactions.slice(0, 6).map(t => <TxRow key={t.id} t={t} />)}
        {recent.data?.transactions.length === 0 && <div style={s('font-size:13.5px;color:#6B7268')}>No transactions yet.</div>}
      </div>
    </div>
  );
}

const FILTERS = ['All', 'Received', 'Sent', 'Gifts', 'Deposits', 'Withdrawals', 'Transfers', 'Earnings'];
function ActivityTab() {
  const { walletVersion } = useApp();
  const [f, setF] = useState('All');
  const [poll, setPoll] = useState(false);
  const txs = useAsync(() => api.transactions(f.toLowerCase()), [f, walletVersion], { pollMs: poll ? 6000 : undefined });
  useEffect(() => { setPoll(!!txs.data?.transactions.some(t => t.status === 'PENDING' || t.status === 'PROCESSING')); }, [txs.data]);
  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
      <h2 style={s('margin:0 0 12px;font-size:16px;font-weight:800')}>Transaction history</h2>
      <div style={s('display:flex;gap:6px;overflow-x:auto;padding-bottom:4px')}>
        {FILTERS.map(l => <button key={l} onClick={() => setF(l)} style={{ flex: '1 1 auto', whiteSpace: 'nowrap', padding: '9px 14px', borderRadius: 12, fontSize: 13.5, fontWeight: 700, color: f === l ? '#fff' : '#5A6358', background: f === l ? '#101410' : 'transparent' }}>{l}</button>)}
      </div>
      {txs.error && <ErrorBox message={txs.error} onRetry={txs.reload} />}
      {txs.loading && !txs.data && <div className="kk-skel" style={{ height: 200, marginTop: 10 }} />}
      {txs.data?.transactions.map(t => <TxRow key={t.id} t={t} />)}
      {txs.data?.transactions.length === 0 && <div style={s('padding:30px 0 10px;text-align:center;font-size:13.5px;color:#6B7268')}>No {f === 'All' ? '' : f.toLowerCase() + ' '}transactions yet.</div>}
      <p style={s('margin:12px 0 0;font-size:11.5px;color:#9AA197;line-height:1.55')}>Incoming crypto appears in your on-chain balances on the Overview tab.</p>
    </div>
  );
}

function GiftsTab() {
  const { walletVersion } = useApp();
  const [dir, setDir] = useState('Gifts Sent');
  const g = useAsync(() => api.gifts(dir === 'Gifts Sent' ? 'sent' : 'received'), [dir, walletVersion]);
  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
      <h2 style={s('margin:0 0 12px;font-size:16px;font-weight:800')}>Gift history</h2>
      <Tabs items={['Gifts Sent', 'Gifts Received']} value={dir} onChange={setDir} inner />
      {g.error && <ErrorBox message={g.error} onRetry={g.reload} />}
      {g.loading && !g.data && <div className="kk-skel" style={{ height: 140, marginTop: 10 }} />}
      {g.data?.gifts.length === 0 && <div style={s('padding:30px 0 10px;text-align:center;font-size:13.5px;color:#6B7268')}>{dir === 'Gifts Sent' ? 'You have not sent any gifts yet.' : 'No gifts received yet.'}</div>}
      {g.data?.gifts.map(x => {
        const sent = dir === 'Gifts Sent';
        return (
          <div key={x.id} style={s('display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid rgba(16,20,16,.06);margin-top:8px')}>
            <div style={{ width: 34, height: 34, borderRadius: 11, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: sent ? '#FCF3E0' : '#E8F5EE', color: sent ? '#C98A12' : '#14975C' }}>
              {sent ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="8" width="18" height="4.5" rx="1.4" /><path d="M12 8v13" /></svg> : <Icon d={I.up} size={16} sw={2.2} />}
            </div>
            <div style={s('flex:1;min-width:0')}>
              <div style={s('font-size:14px;font-weight:700')}>{x.valueLabel} Gift</div>
              <div style={s('font-size:12.5px;color:#6B7268;margin-top:2px')}>
                {sent ? <>Paid from Naira balance · @{x.recipient.username}</> : <>From @{x.sender.username} · Creator earnings: {x.creatorLabel}</>} · {timeAgo(x.createdAt)}
              </div>
            </div>
            <span style={statusStyle('COMPLETED')}>Completed</span>
          </div>
        );
      })}
    </div>
  );
}

function EarningsTab() {
  const { walletVersion, openFlow } = useApp();
  const router = useRouter();
  const e = useAsync(() => api.earnings().then(r => r.earnings), [walletVersion], { pollMs: 15000 });
  if (e.error) return <ErrorBox message={e.error} onRetry={e.reload} />;
  if (!e.data) return <Skeleton h={300} />;
  const d = e.data;
  const cards = [
    { label: 'Available earnings', value: moneyExact(d.availableNgn), delta: 'Ready to withdraw', gold: true },
    { label: 'Total earned', value: money(d.totalEarnedNgn), delta: 'All time (80% share)' },
    { label: 'Total gifts', value: d.totalGifts.toLocaleString(), delta: `From ${d.supporters} supporter${d.supporters === 1 ? '' : 's'}` },
    { label: 'This month', value: money(d.thisMonthNgn), delta: d.monthDelta },
  ];
  return (
    <div>
      <div style={s('background:#101410;border-radius:22px;padding:24px;color:#fff;position:relative;overflow:hidden')}>
        <div style={s('position:absolute;right:-40px;bottom:-50px;width:180px;height:180px;border-radius:50%;background:rgba(201,138,18,.22)')} />
        <div style={s('position:relative')}>
          <div style={s('font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55)')}>Creator earnings</div>
          <div style={s('font-size:40px;font-weight:800;letter-spacing:-.03em;margin-top:6px;font-variant-numeric:tabular-nums')}>{moneyExact(d.availableNgn)}</div>
          <div style={s('font-size:13px;color:rgba(255,255,255,.6);margin-top:4px')}>Creators keep 80% of every gift · KAMKAM keeps 20%</div>
          <button onClick={() => openFlow('withdraw', { source: 'EARNINGS' })} disabled={Number(d.availableNgn) <= 0} className={H.greenLight} style={{ ...s('margin-top:16px;background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:11px 22px;border-radius:99px'), opacity: Number(d.availableNgn) > 0 ? 1 : 0.5 }}>Withdraw earnings</button>
        </div>
      </div>
      <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px')}>
        {cards.map(c => (
          <div key={c.label} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:16px;padding:16px')}>
            <div style={s('font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6B7268')}>{c.label}</div>
            <div style={{ ...s('margin-top:7px;font-size:21px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums'), color: c.gold ? '#0E7546' : undefined }}>{c.value}</div>
            <div style={s('margin-top:4px;font-size:12px;color:#14975C;font-weight:700')}>{c.delta}</div>
          </div>
        ))}
      </div>
      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
        <h2 style={s('margin:0 0 8px;font-size:16px;font-weight:800')}>Earnings history</h2>
        {d.history.length === 0 && <Empty title="No earnings yet" body="When someone gifts your post, 80% lands here." />}
        {d.history.map(h => (
          <div key={h.id} style={s('display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid rgba(16,20,16,.06)')}>
            <Avatar user={h.from} size={36} onClick={() => router.push('/profile/' + h.from.username)} />
            <div style={s('flex:1;min-width:0')}>
              <div style={s('font-size:14px;font-weight:700')}>@{h.from.username} sent a {h.giftLabel} gift</div>
              <div style={s('font-size:12.5px;color:#6B7268;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{dateTime(h.createdAt)}{h.post ? <> · <Link href={'/post/' + h.post.id}>“{h.post.text.slice(0, 40)}”</Link></> : null}</div>
            </div>
            <div style={s('font-size:14.5px;font-weight:800;color:#14975C;flex:none')}>{h.amountLabel}</div>
          </div>
        ))}
      </div>
      {d.withdrawals.length > 0 && (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:14px')}>
          <h2 style={s('margin:0 0 8px;font-size:16px;font-weight:800')}>Earnings withdrawals</h2>
          {d.withdrawals.map(x => (
            <div key={x.id} style={s('display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid rgba(16,20,16,.06)')}>
              <div style={s('flex:1;min-width:0')}>
                <div style={s('font-size:14px;font-weight:700')}>{x.valueLabel} → Bank account</div>
                <div style={s('font-size:12.5px;color:#6B7268')}>{dateTime(x.createdAt)} · {x.reference}</div>
              </div>
              <span style={statusStyle(x.status)}>{statusText(x.status)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SecurityTab({ onLock }: { onLock: () => void }) {
  const { showToast, me, setMe, logout, wallet } = useApp();
  const router = useRouter();
  const t = { biometric: false, txConfirm: true, pin: true, ...(me?.walletSecurity ?? {}) } as Record<'biometric' | 'txConfirm' | 'pin', boolean>;
  const setT = async (key: 'txConfirm' | 'pin') => {
    const next = !t[key];
    if (me) setMe({ ...me, walletSecurity: { ...t, [key]: next } });
    try { const r = await api.updateWalletSecurity(key, next); if (me) setMe({ ...me, walletSecurity: r }); }
    catch (e) { if (me) setMe({ ...me, walletSecurity: t }); showToast((e as Error).message); }
  };
  const signOutEverywhere = async () => {
    if (!confirm('Sign out of KAMKAM on every device, including this one?')) return;
    try { await supabase().auth.signOut({ scope: 'global' }); } catch { /* fall through */ }
    await logout(); router.replace('/login');
  };
  const rows = [
    { label: 'Key custody', hint: wallet?.cryptoActivated ? 'Crypto keys are held by Coinbase Developer Platform in a secure enclave. KAMKAM stores only public addresses.' : 'No crypto wallet yet. Naira funds are held in KAMKAM’s payment provider account.', action: 'Info', go: () => showToast('Keys never reach KAMKAM or your device') },
    { label: 'Connected devices', hint: 'Sessions on all devices signed in to your account', action: 'Sign out everywhere', go: signOutEverywhere },
    { label: 'Wallet PIN', hint: 'Not available yet — every transaction is confirmed on a review screen', action: 'Not available', go: undefined },
  ];
  return (
    <div>
      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
        <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap')}>
          <h2 style={s('margin:0;font-size:16px;font-weight:800')}>Wallet security</h2>
        </div>
        {rows.map(r => (
          <div key={r.label} style={s('display:flex;align-items:center;gap:14px;padding:13px 0;border-top:1px solid rgba(16,20,16,.06);margin-top:6px')}>
            <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700')}>{r.label}</div><div style={s('font-size:12.5px;color:#6B7268;margin-top:2px')}>{r.hint}</div></div>
            <button onClick={r.go} disabled={!r.go} className={r.go ? H.outlineGreen : ''} style={{ ...s('font-size:12.5px;font-weight:700;padding:8px 14px;border-radius:99px;border:1px solid rgba(16,20,16,.14);flex:none'), opacity: r.go ? 1 : 0.5 }}>{r.action}</button>
          </div>
        ))}
      </div>
      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px;margin-top:12px')}>
        {([['biometric', 'Biometric authentication', 'Needs the KAMKAM mobile app — not available on web yet'], ['txConfirm', 'Transaction confirmation', 'Always review before confirming (always on)'], ['pin', 'Lock wallet after 5 minutes', 'Hides balances after 5 minutes of inactivity']] as const).map(([k, l, h]) => (
          <div key={k} style={s('display:flex;align-items:center;gap:14px;padding:13px 0;border-top:1px solid rgba(16,20,16,.06)')}>
            <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:650')}>{l}</div><div style={s('font-size:12.5px;color:#6B7268;margin-top:2px')}>{h}</div></div>
            {k === 'pin' ? <Toggle on={t.pin} onClick={() => setT('pin')} label={l} /> : <span style={{ opacity: 0.5, pointerEvents: 'none' }} aria-disabled><Toggle on={k === 'txConfirm'} onClick={() => {}} label={l} /></span>}
          </div>
        ))}
      </div>
      <div style={s('margin-top:12px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3);border-radius:18px;padding:16px;display:flex;gap:12px')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#C98A12" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d={I.warn} /><path d={I.warn2} /></svg>
        <p style={s('margin:0;font-size:13.5px;font-weight:700;color:#8A5E08;line-height:1.6')}>KAMKAM will never ask for your password, a one-time code or any key to move your funds.</p>
      </div>
      <button onClick={onLock} className={H.ink} style={s('margin-top:12px;width:100%;background:#101410;color:#fff;font-weight:800;font-size:14.5px;padding:14px;border-radius:14px')}>Lock wallet</button>
    </div>
  );
}
