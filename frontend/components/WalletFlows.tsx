'use client';
import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, newIdempotencyKey, type WithdrawalView } from '@/lib/api';
import { assetColor, label, money, qty, shortAddr } from '@/lib/format';
import { dot, H, s, statusStyle, statusText, sx } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import type { ChainBalances, CryptoSend } from '@/types';
import { useApp } from './AppProvider';
import { BackBtn, Badge, CloseBtn, I, Icon, Modal, Spinner, Warn } from './ui';

/**
 * Wallet flows. Every action here calls a real integration:
 *  • Fund wallet → Paystack checkout (credited only after Paystack confirms)
 *  • Withdraw → Paystack Transfers to a verified Nigerian bank account, or earnings → balance
 *  • Transfer → atomic KAMKAM-to-KAMKAM Naira transfer
 *  • Send / Receive → Coinbase CDP accounts, real on-chain transactions
 *  • Buy / Sell / Swap → not offered (no provider integrated) and clearly marked so
 */

// ───────────── small building blocks ─────────────
const Label = ({ children, mt = 16 }: { children: ReactNode; mt?: number }) => (
  <div style={{ ...s('font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6B7268'), marginTop: mt }}>{children}</div>
);

function Chips({ items, value, onChange, colorDot, render }: { items: string[]; value: string; onChange: (v: string) => void; colorDot?: (v: string) => string; render?: (v: string) => string }) {
  return (
    <div style={s('display:flex;gap:7px;margin-top:8px;overflow-x:auto;padding-bottom:3px;flex-wrap:wrap')}>
      {items.map(a => (
        <button key={a} onClick={() => onChange(a)} aria-pressed={value === a} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '9px 15px', borderRadius: 99, whiteSpace: 'nowrap', border: value === a ? '2px solid #14975C' : '1px solid rgba(16,20,16,.12)', background: value === a ? '#F3FAF6' : '#fff', color: value === a ? '#0E7546' : '#3C433A' }}>
          {colorDot && <span style={dot(colorDot(a))} />}{render ? render(a) : label(a)}
        </button>
      ))}
    </div>
  );
}

function Radio({ on, title, hint, onClick, disabled }: { on: boolean; title: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={disabled ? undefined : onClick} role="radio" aria-checked={on} aria-disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 14, border: on ? '2px solid #14975C' : '1px solid rgba(16,20,16,.12)', background: on ? '#F3FAF6' : '#fff', width: '100%', opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span style={{ width: 19, height: 19, borderRadius: '50%', flex: 'none', border: on ? '6px solid #14975C' : '2px solid rgba(16,20,16,.22)', transition: 'all .15s' }} />
      <span style={s('flex:1;min-width:0;text-align:left')}>
        <span style={s('display:block;font-size:14px;font-weight:700')}>{title}</span>
        {hint && <span style={s('display:block;font-size:12.5px;color:#6B7268;margin-top:1px')}>{hint}</span>}
      </span>
    </button>
  );
}

function AmountBox({ value, onChange, prefix, suffix, onMax, decimals = true }: { value: string; onChange: (v: string) => void; prefix?: string; suffix?: string; onMax?: () => void; decimals?: boolean }) {
  return (
    <div style={s('display:flex;align-items:center;gap:9px;margin-top:8px;border:1px solid rgba(16,20,16,.12);border-radius:14px;padding:13px 15px')}>
      {prefix && <span style={s('font-size:19px;font-weight:700;color:#6B7268')}>{prefix}</span>}
      <input value={value} onChange={e => onChange(decimals ? e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1') : e.target.value.replace(/\D/g, ''))} inputMode={decimals ? 'decimal' : 'numeric'} placeholder="0" aria-label="Amount" style={s('flex:1;min-width:0;border:0;outline:none;background:none;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums')} />
      {onMax && <button onClick={onMax} style={s('font-size:12px;font-weight:800;color:#14975C;background:#E8F5EE;padding:5px 10px;border-radius:99px')}>Max</button>}
      {suffix && <span style={s('font-size:14px;font-weight:700;color:#6B7268')}>{suffix}</span>}
    </div>
  );
}

const fieldStyle = (mono?: boolean) => sx('margin-top:6px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:12px 14px;outline:none;font-size:14.5px;font-weight:600;background:#fff', mono && 'font-family:ui-monospace,Menlo,monospace;font-size:13px');
const fieldLabel = s('display:block;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7268');

function TextField({ label: l, value, onChange, placeholder, mono, inputMode }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; inputMode?: 'numeric' }) {
  return (
    <div style={{ marginTop: 12 }}>
      <label style={fieldLabel}>{l}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode} aria-label={l} style={fieldStyle(mono)} />
    </div>
  );
}

type Row = { k: string; v: ReactNode; tone?: 'strong' | 'green' | 'gold' };
function Rows({ rows }: { rows: Row[] }) {
  const tone: Record<string, string> = { strong: 'font-weight:800', green: 'font-weight:800;color:#14975C', gold: 'font-weight:800;color:#8A5E08' };
  return (
    <div style={s('margin-top:16px;border:1px solid rgba(16,20,16,.1);border-radius:16px;overflow:hidden')}>
      {rows.map((r, i) => (
        <div key={r.k + i} style={sx('display:flex;justify-content:space-between;gap:14px;padding:13px 15px', i > 0 && 'border-top:1px solid rgba(16,20,16,.07)')}>
          <span style={s('font-size:13.5px;color:#6B7268;font-weight:600;flex:none')}>{r.k}</span>
          <span style={sx('font-size:14px;font-weight:700;text-align:right;word-break:break-all', r.tone && tone[r.tone])}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

const primaryBtn = (disabled: boolean): CSSProperties => ({ marginTop: 18, width: '100%', background: disabled ? 'rgba(16,20,16,.16)' : '#14975C', color: '#fff', fontWeight: 800, fontSize: 15, padding: 15, borderRadius: 15, cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 9 });
const inkBtn = s('margin-top:16px;width:100%;background:#101410;color:#fff;font-weight:800;font-size:15px;padding:15px;border-radius:15px;display:flex;justify-content:center;align-items:center;gap:9px');
const ghostBtn = s('margin-top:9px;width:100%;font-weight:700;font-size:14px;padding:12px;border-radius:14px;color:#6B7268');

function Header({ title, onClose, onBack, badge }: { title: string; onClose: () => void; onBack?: () => void; badge?: ReactNode }) {
  return (
    <div style={s('display:flex;align-items:center;gap:11px')}>
      {onBack && <BackBtn onClick={onBack} />}
      <h2 style={s('margin:0;font-size:19px;font-weight:800;display:flex;align-items:center;gap:9px')}>{title}{badge}</h2>
      <CloseBtn onClick={onClose} style={{ marginLeft: 'auto' }} />
    </div>
  );
}

const ErrLine = ({ msg }: { msg: string | null }) => (msg ? <div role="alert" style={s('margin-top:12px;font-size:13px;font-weight:700;color:#A8331F')}>{msg}</div> : null);

function Notice({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div style={s('margin-top:16px;padding:14px;border-radius:16px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3)')}>
      <div style={s('font-size:14px;font-weight:800;color:#8A5E08')}>{title}</div>
      <div style={s('margin-top:5px;font-size:13px;color:#8A5E08;line-height:1.55')}>{body}</div>
    </div>
  );
}

/** Result screen. `state` comes from the provider/chain — never assumed from the click. */
function Result({ state, title, body, rows, onClose, onRetry, steps }: {
  state: 'ok' | 'pending' | 'fail'; title: string; body?: ReactNode; rows?: Row[]; onClose: () => void; onRetry?: () => void;
  steps?: { labels: string[]; index: number };
}) {
  const bg = state === 'ok' ? '#14975C' : state === 'fail' ? '#C0412F' : '#C98A12';
  return (
    <div style={s('text-align:center;padding:10px 4px 4px')}>
      <div style={{ ...s('width:74px;height:74px;margin:0 auto;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;animation:kkPop .5s cubic-bezier(.2,1.4,.4,1) both'), background: bg }}>
        {state === 'ok' ? <Icon d={I.check} size={34} sw={2.4} /> : state === 'fail' ? <Icon d={I.close} d2={I.close2} size={32} sw={2.6} /> : <Spinner size={30} color="#fff" />}
      </div>
      <h2 style={s('margin:18px 0 0;font-size:21px;font-weight:800;letter-spacing:-.02em')}>{title}</h2>
      {body && <p style={s('margin:8px auto 0;font-size:14px;color:#5A6358;line-height:1.6;max-width:38ch')}>{body}</p>}
      {steps && (
        <div style={s('display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;flex-wrap:wrap')}>
          {steps.labels.map((st, i) => (
            <span key={st} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...statusStyle(i < steps.index || (i === steps.index && state === 'ok') ? 'COMPLETED' : 'PENDING'), opacity: i <= steps.index ? 1 : 0.4, display: 'flex', alignItems: 'center', gap: 6 }}>
                {i === steps.index && state === 'pending' && <Spinner size={10} />}{st}
              </span>
              {i < steps.labels.length - 1 && <span style={{ color: '#9AA197' }}>→</span>}
            </span>
          ))}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={s('margin-top:16px;padding:12px 14px;border-radius:14px;background:#F5F7F4;text-align:left;display:flex;flex-direction:column;gap:6px')}>
          {rows.map(r => (
            <div key={r.k} style={s('display:flex;justify-content:space-between;gap:10px;font-size:13px;align-items:center')}>
              <span style={s('color:#6B7268;font-weight:600;flex:none')}>{r.k}</span>
              <span style={s('font-weight:700;text-align:right;word-break:break-all')}>{r.v}</span>
            </div>
          ))}
        </div>
      )}
      {state === 'fail' && onRetry && <button onClick={onRetry} className={H.green} style={primaryBtn(false)}>Try again</button>}
      <button onClick={onClose} className={H.ink} style={s('margin-top:16px;width:100%;background:#101410;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px')}>{state === 'pending' ? 'Close — keep tracking in Activity' : 'Done'}</button>
    </div>
  );
}

const mono = (v: string) => <span style={s('font-family:ui-monospace,Menlo,monospace')}>{v}</span>;
const explorerLink = (url: string | null | undefined, text = 'View on explorer') =>
  url ? <a href={url} target="_blank" rel="noopener noreferrer" style={s('color:#14975C;font-weight:800')}>{text} ↗</a> : null;

// ───────────── Router ─────────────
export function WalletFlowModal() {
  const { flow, closeFlow } = useApp();
  const { isMobile } = useViewport();
  if (!flow) return null;
  const p = { onClose: closeFlow, isMobile, preset: flow.preset };
  switch (flow.name) {
    case 'receive': return <ReceiveFlow {...p} />;
    case 'deposit': return <DepositFlow {...p} />;
    case 'withdraw': return <WithdrawFlow {...p} />;
    case 'transfer': return <TransferFlow {...p} />;
    case 'send': return <SendFlow {...p} />;
    default: return <UnavailableFlow action={flow.name} {...p} />;
  }
}
type FlowProps = { onClose: () => void; isMobile: boolean; preset?: Record<string, string> };

// ───────────── Buy / Sell / Swap: not offered ─────────────
function UnavailableFlow({ action, onClose, isMobile }: FlowProps & { action: 'buy' | 'sell' | 'swap' }) {
  const { config } = useApp();
  const title = action === 'buy' ? 'Buy Crypto' : action === 'sell' ? 'Sell Crypto' : 'Swap';
  return (
    <Modal onClose={onClose} isMobile={isMobile} label={title} z={92}>
      <Header title={title} onClose={onClose} />
      <Notice title="Not available yet" body={<>{config?.unavailable[action] ?? 'This feature is not available yet.'} KAMKAM has not integrated a licensed {action === 'swap' ? 'exchange' : 'on/off-ramp'} provider, so this action is switched off rather than simulated.</>} />
      <p style={s('margin:14px 0 0;font-size:13.5px;color:#5A6358;line-height:1.6')}>You can fund your Naira balance with Paystack, and send or receive crypto on supported networks.</p>
      <button onClick={onClose} className={H.ink} style={inkBtn}>Close</button>
    </Modal>
  );
}

// ───────────── Fund wallet (Paystack) ─────────────
function DepositFlow({ onClose, isMobile }: FlowProps) {
  const { config, wallet } = useApp();
  const [amount, setAmount] = useState('10000');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enabled = !!config?.payments.enabled;
  const lim = wallet?.limits;
  const n = Number(amount);
  const invalid = !n || (lim ? n < lim.depositMin || n > lim.depositMax : false);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.startDeposit(n);
      window.location.assign(r.authorizationUrl); // Paystack-hosted checkout
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} isMobile={isMobile} label="Fund wallet" z={92}>
      <Header title="Fund wallet" onClose={onClose} badge={config?.payments.mode === 'test' ? <Badge text="Test mode" title="Paystack test keys — no real money moves" /> : undefined} />
      {!config && <div className="kk-skel" style={{ height: 120, marginTop: 16, borderRadius: 16 }} />}
      {config && !enabled && <Notice title="Not available yet" body="Naira deposits are not configured on this server. No payment can be taken until the payment provider is connected." />}
      {config && enabled && (
        <>
          <label style={{ ...fieldLabel, marginTop: 18 }}>Amount</label>
          <AmountBox value={amount} onChange={setAmount} prefix="₦" />
          <div style={s('display:flex;gap:8px;margin-top:10px;flex-wrap:wrap')}>
            {[2000, 5000, 10000, 25000].map(v => <button key={v} onClick={() => setAmount(String(v))} className={H.quick} style={s('font-size:13px;font-weight:700;border:1px solid rgba(16,20,16,.12);padding:8px 14px;border-radius:99px')}>{money(v)}</button>)}
          </div>
          {lim && <div style={s('margin-top:10px;font-size:12.5px;color:#6B7268;font-weight:600')}>Between {money(lim.depositMin)} and {money(lim.depositMax)} per deposit.</div>}
          <Rows rows={[
            { k: 'You pay', v: n ? money(n) : '—', tone: 'strong' },
            { k: 'Payment', v: 'Paystack — card, bank transfer or USSD' },
            { k: 'Credited to', v: 'Naira balance, after Paystack confirms' },
          ]} />
          <ErrLine msg={err} />
          <button onClick={go} disabled={invalid || busy} className={invalid || busy ? '' : H.green} style={primaryBtn(invalid || busy)}>
            {busy && <Spinner size={16} color="#fff" />}{busy ? 'Opening Paystack…' : 'Continue to Paystack'}
          </button>
          <p style={s('margin:11px 0 0;text-align:center;font-size:12px;color:#9AA197')}>You’ll pay on Paystack’s secure page. KAMKAM never sees your card details.</p>
        </>
      )}
    </Modal>
  );
}

// ───────────── Withdraw (bank via Paystack, or earnings → balance) ─────────────
function WithdrawFlow({ onClose, isMobile, preset }: FlowProps) {
  const { wallet, config, bumpWallet } = useApp();
  const bal = Number(wallet?.ngn.balance ?? 0), earn = Number(wallet?.ngn.earnings ?? 0);
  const [source, setSource] = useState<'earnings' | 'balance'>(preset?.source === 'EARNINGS' || (preset?.source !== 'WALLET' && earn > 0) ? 'earnings' : 'balance');
  const [dest, setDest] = useState<'bank' | 'kamkam'>('bank');
  const [banks, setBanks] = useState<{ name: string; code: string }[] | null>(null);
  const [bankErr, setBankErr] = useState<string | null>(null);
  const [bankCode, setBankCode] = useState('');
  const [acct, setAcct] = useState('');
  const [resolved, setResolved] = useState<{ name: string; key: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'result'>('form');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idem, setIdem] = useState('');
  const [w, setW] = useState<WithdrawalView | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);

  const payments = !!config?.payments.enabled;
  const d = source === 'earnings' ? dest : 'bank';
  const available = source === 'earnings' ? earn : bal;
  const fee = wallet?.limits.withdrawFee ?? 0;
  const minW = wallet?.limits.withdrawMin ?? 0;
  const n = Number(amount);
  const bank = banks?.find(b => b.code === bankCode);
  const key = bankCode + ':' + acct;

  useEffect(() => {
    if (d !== 'bank' || !payments || banks) return;
    api.banks().then(r => setBanks(r.banks)).catch(e => setBankErr((e as Error).message));
  }, [d, payments, banks]);

  useEffect(() => {
    setResolved(null);
    if (d !== 'bank' || !bankCode || acct.length !== 10) return;
    let live = true;
    setResolving(true); setErr(null);
    const t = setTimeout(() => {
      api.resolveAccount(acct, bankCode)
        .then(r => { if (live) setResolved({ name: r.accountName, key }); })
        .catch(e => { if (live) setErr((e as Error).message); })
        .finally(() => { if (live) setResolving(false); });
    }, 400);
    return () => { live = false; clearTimeout(t); setResolving(false); };
  }, [bankCode, acct, d]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the provider-verified status until it is final.
  useEffect(() => {
    if (step !== 'result' || !w || !['pending', 'processing'].includes(w.status)) return;
    const t = setInterval(async () => {
      try { const r = await api.withdrawalStatus(w.reference); setW(r); if (!['pending', 'processing'].includes(r.status)) bumpWallet(); } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [step, w?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountErr = !n ? null : n > available ? `You only have ${money(available)} available.`
    : d === 'bank' && n < minW ? `Minimum bank withdrawal is ${money(minW)}.` : d === 'bank' && n <= fee ? `Amount must be more than the ${money(fee)} fee.` : null;
  const formOk = n > 0 && !amountErr && (d === 'kamkam' || (payments && !!resolved && resolved.key === key));

  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      if (d === 'kamkam') {
        const r = await api.moveEarnings(String(n), idem);
        setMoved(r.reference);
      } else {
        const r = await api.withdrawToBank({ source, amount: n, accountNumber: acct, bankCode }, idem);
        setW(r);
      }
      bumpWallet();
      setStep('result');
    } catch (e) { setFailMsg((e as Error).message); setStep('result'); }
    finally { setBusy(false); }
  };

  const reviewRows: Row[] = d === 'kamkam'
    ? [{ k: 'From', v: 'Creator earnings' }, { k: 'To', v: 'KAMKAM Naira balance' }, { k: 'Amount', v: money(n), tone: 'strong' }, { k: 'Fee', v: 'Free' }, { k: 'Arrives', v: 'Instantly' }]
    : [{ k: 'From', v: source === 'earnings' ? 'Creator earnings' : 'Naira balance' }, { k: 'Bank', v: bank?.name ?? '' }, { k: 'Account', v: `${resolved?.name ?? ''} · ••••${acct.slice(-4)}` },
       { k: 'Amount', v: money(n), tone: 'strong' }, { k: 'Transfer fee', v: money(fee) }, { k: 'You receive', v: money(n - fee), tone: 'green' }, { k: 'Arrives', v: 'Usually within minutes, after the bank confirms' }];

  return (
    <Modal onClose={busy ? () => {} : onClose} isMobile={isMobile} label="Withdraw" z={92}>
      {step === 'form' && (
        <div>
          <Header title="Withdraw" onClose={onClose} />
          <div style={s('margin-top:14px;padding:13px 15px;background:#E8F5EE;border-radius:14px')}>
            <div style={s('font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#0E7546')}>Available to withdraw</div>
            <div style={s('font-size:24px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums;color:#0E7546')}>{money(available)}</div>
          </div>
          <Label>From</Label>
          <Chips items={['Creator earnings', 'Naira balance']} value={source === 'earnings' ? 'Creator earnings' : 'Naira balance'} onChange={v => setSource(v === 'Creator earnings' ? 'earnings' : 'balance')} />
          <Label>Withdraw to</Label>
          <div style={s('display:flex;flex-direction:column;gap:9px;margin-top:9px')}>
            {source === 'earnings' && <Radio on={d === 'kamkam'} title="KAMKAM balance" hint="Move earnings into your spendable Naira balance · instant, free" onClick={() => setDest('kamkam')} />}
            <Radio on={d === 'bank'} title="Bank account" hint={payments ? `Naira to a Nigerian bank via Paystack · ${money(fee)} fee` : 'Not available yet — payouts are not configured'} onClick={() => setDest('bank')} disabled={!payments} />
          </div>
          {d === 'bank' && payments && (
            <>
              <div style={{ marginTop: 12 }}>
                <label style={fieldLabel} htmlFor="kk-bank">Bank</label>
                <select id="kk-bank" value={bankCode} onChange={e => setBankCode(e.target.value)} style={fieldStyle()} disabled={!banks}>
                  <option value="">{banks ? 'Choose your bank' : bankErr ? 'Could not load banks' : 'Loading banks…'}</option>
                  {banks?.map(b => <option key={b.code + b.name} value={b.code}>{b.name}</option>)}
                </select>
              </div>
              <TextField label="Account number" value={acct} onChange={v => setAcct(v.replace(/\D/g, '').slice(0, 10))} placeholder="10 digits" inputMode="numeric" />
              <div style={s('margin-top:8px;min-height:20px;font-size:13px;font-weight:700')}>
                {resolving && <span style={s('display:flex;align-items:center;gap:7px;color:#6B7268')}><Spinner size={12} />Verifying account…</span>}
                {resolved && resolved.key === key && <span style={s('color:#0E7546')}>✓ {resolved.name}</span>}
              </div>
              <ErrLine msg={bankErr} />
            </>
          )}
          {(d === 'kamkam' || payments) && (
            <>
              <Label>Amount</Label>
              <AmountBox value={amount} onChange={setAmount} prefix="₦" onMax={() => setAmount(String(Math.floor(available)))} />
              {d === 'bank' && n > fee && !amountErr && <div style={s('margin-top:8px;font-size:12.5px;color:#6B7268;font-weight:600')}>You receive {money(n - fee)} after the {money(fee)} transfer fee.</div>}
            </>
          )}
          <ErrLine msg={amountErr ?? err} />
          <button onClick={() => { setIdem(newIdempotencyKey()); setStep('review'); }} disabled={!formOk} className={formOk ? H.green : ''} style={primaryBtn(!formOk)}>Review withdrawal</button>
        </div>
      )}
      {step === 'review' && (
        <div>
          <Header title="Review withdrawal" onClose={onClose} onBack={() => setStep('form')} />
          <p style={s('margin:8px 0 0;font-size:13.5px;color:#6B7268')}>Check the details. Bank transfers cannot be recalled once sent.</p>
          <Rows rows={reviewRows} />
          <button onClick={confirm} disabled={busy} className={H.ink} style={inkBtn}>{busy && <Spinner size={16} color="#fff" />}{busy ? 'Processing…' : 'Confirm withdrawal'}</button>
          <button onClick={() => setStep('form')} disabled={busy} className={H.ghost} style={ghostBtn}>Back</button>
        </div>
      )}
      {step === 'result' && (
        failMsg ? <Result state="fail" title="Withdrawal failed" body={<>{failMsg}<br />No money left your balance.</>} onClose={onClose} onRetry={() => { setFailMsg(null); setStep('review'); }} />
        : moved ? <Result state="ok" title="Earnings moved" body={<>{money(n)} is now in your Naira balance.</>} rows={[{ k: 'Reference', v: mono(moved) }]} onClose={onClose} />
        : w ? (
          <Result
            state={w.status === 'success' ? 'ok' : w.status === 'failed' || w.status === 'reversed' ? 'fail' : 'pending'}
            title={w.status === 'success' ? 'Withdrawal completed' : w.status === 'failed' ? 'Withdrawal failed' : w.status === 'reversed' ? 'Withdrawal reversed' : 'Withdrawal in progress'}
            body={w.status === 'success' ? <>{money(w.payout)} was paid to your bank account.</>
              : w.status === 'failed' || w.status === 'reversed' ? <>{w.failureReason ?? 'The bank transfer did not go through.'} {money(w.amount)} has been returned to your {source === 'earnings' ? 'earnings' : 'balance'}.</>
              : <>Paystack is processing the transfer. {money(w.amount)} is held until the bank confirms.</>}
            steps={w.status === 'failed' || w.status === 'reversed' ? undefined : { labels: ['Requested', 'Processing', 'Paid'], index: w.status === 'success' ? 2 : w.status === 'processing' ? 1 : 0 }}
            rows={[{ k: 'Reference', v: mono(w.reference) }, { k: 'Status', v: <span style={statusStyle(w.status.toUpperCase())}>{statusText(w.status.toUpperCase())}</span> }, { k: 'You receive', v: money(w.payout) }]}
            onClose={onClose}
          />
        ) : null
      )}
    </Modal>
  );
}

// ───────────── Transfer (KAMKAM → KAMKAM, Naira) ─────────────
function TransferFlow({ onClose, isMobile, preset }: FlowProps) {
  const { wallet, bumpWallet } = useApp();
  const bal = Number(wallet?.ngn.balance ?? 0);
  const [to, setTo] = useState(preset?.to ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'result'>('form');
  const [busy, setBusy] = useState(false);
  const [idem, setIdem] = useState('');
  const [res, setRes] = useState<{ ok: true; reference: string; to: string } | { ok: false; msg: string } | null>(null);
  const n = Number(amount);
  const handle = to.trim().replace(/^@/, '').toLowerCase();
  const amountErr = n && n > bal ? `You only have ${money(bal)} available.` : n && wallet && n > wallet.limits.transferMax ? `Maximum transfer is ${money(wallet.limits.transferMax)}.` : null;
  const ok = /^[a-z0-9_]{3,20}$/.test(handle) && n > 0 && Number.isInteger(n) && !amountErr;

  const confirm = async () => {
    setBusy(true);
    try { const r = await api.transfer({ toUsername: handle, amount: String(n), note: note.trim() || undefined }, idem); setRes({ ok: true, reference: r.reference, to: r.to }); bumpWallet(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
    finally { setBusy(false); setStep('result'); }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} isMobile={isMobile} label="Transfer" z={92}>
      {step === 'form' && (
        <div>
          <Header title="Transfer" onClose={onClose} />
          <p style={s('margin:8px 0 0;font-size:13.5px;color:#6B7268')}>Send Naira to any KAMKAM user instantly. Free.</p>
          <TextField label="To (@username)" value={to} onChange={setTo} placeholder="@username" />
          <Label>Amount</Label>
          <AmountBox value={amount} onChange={setAmount} prefix="₦" decimals={false} onMax={() => setAmount(String(Math.floor(bal)))} />
          <div style={s('margin-top:8px;font-size:12.5px;color:#6B7268;font-weight:600')}>Available: {money(bal)}</div>
          <TextField label="Note (optional)" value={note} onChange={v => setNote(v.slice(0, 140))} />
          <ErrLine msg={amountErr} />
          <button onClick={() => { setIdem(newIdempotencyKey()); setStep('review'); }} disabled={!ok} className={ok ? H.green : ''} style={primaryBtn(!ok)}>Review transfer</button>
        </div>
      )}
      {step === 'review' && (
        <div>
          <Header title="Review Transfer" onClose={onClose} onBack={() => setStep('form')} />
          <Rows rows={[{ k: 'To', v: '@' + handle }, { k: 'Amount', v: money(n), tone: 'strong' }, { k: 'Fee', v: 'Free' }, ...(note.trim() ? [{ k: 'Note', v: note.trim() }] : []), { k: 'Arrives', v: 'Instantly' }]} />
          <button onClick={confirm} disabled={busy} className={H.ink} style={inkBtn}>{busy && <Spinner size={16} color="#fff" />}{busy ? 'Processing…' : 'Confirm Transfer'}</button>
          <button onClick={() => setStep('form')} disabled={busy} className={H.ghost} style={ghostBtn}>Back</button>
        </div>
      )}
      {step === 'result' && res && (res.ok
        ? <Result state="ok" title="Transfer Successful" body={<>You sent <b>{money(n)}</b> to {res.to}.</>} rows={[{ k: 'Reference', v: mono(res.reference) }]} onClose={onClose} />
        : <Result state="fail" title="Transfer Failed" body={<>{res.msg}<br />No balance was changed.</>} onClose={onClose} onRetry={() => { setRes(null); setStep('review'); }} />)}
    </Modal>
  );
}

// ───────────── Crypto: shared guard ─────────────
function NeedsCryptoWallet({ title, onClose, isMobile }: { title: string; onClose: () => void; isMobile: boolean }) {
  const { config, setCreateWalletOpen } = useApp();
  return (
    <Modal onClose={onClose} isMobile={isMobile} label={title} z={92}>
      <Header title={title} onClose={onClose} />
      {config && !config.crypto.enabled
        ? <Notice title="Not available yet" body="Crypto wallets are not configured on this server." />
        : <>
            <p style={s('margin:14px 0 0;font-size:14px;color:#5A6358;line-height:1.6')}>Create your KAMKAM crypto wallet to send and receive crypto.</p>
            <button onClick={() => { onClose(); setCreateWalletOpen(true); }} className={H.green} style={primaryBtn(false)}>Create Wallet</button>
          </>}
    </Modal>
  );
}

function useChainBalances(enabled: boolean) {
  const [data, setData] = useState<ChainBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); api.chainBalances().then(setData).catch(e => setError((e as Error).message)); };
  useEffect(() => { if (enabled) load(); }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load };
}

// ───────────── Send crypto (CDP, on-chain) ─────────────
function SendFlow({ onClose, isMobile, preset }: FlowProps) {
  const { wallet, config, bumpWallet } = useApp();
  const ready = !!wallet?.cryptoActivated && !!config?.crypto.enabled;
  const bals = useChainBalances(ready);
  const [netId, setNetId] = useState(preset?.network ?? '');
  const [asset, setAsset] = useState(preset?.asset ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'result'>('form');
  const [busy, setBusy] = useState(false);
  const [idem, setIdem] = useState('');
  const [tx, setTx] = useState<CryptoSend | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 'result' || !tx || !['submitting', 'submitted'].includes(tx.status)) return;
    const t = setInterval(async () => {
      try { const r = await api.cryptoSendStatus(tx.id); setTx(r); if (!['submitting', 'submitted'].includes(r.status)) bumpWallet(); } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [step, tx?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wallet) return null;
  if (!ready) return <NeedsCryptoWallet title="Send" onClose={onClose} isMobile={isMobile} />;

  const nets = bals.data?.networks ?? [];
  const net = nets.find(x => x.id === netId) ?? nets[0];
  const a = net?.assets.find(x => x.symbol === asset) ?? net?.assets[0];
  const native = net?.assets[0];
  const balance = a?.balance === null || a?.balance === undefined ? null : Number(a.balance);
  const n = Number(amount);
  const evm = net?.id !== 'solana';
  const addrOk = net ? (evm ? /^0x[0-9a-fA-F]{40}$/.test(to.trim()) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim())) : false;
  const amountErr = !n ? null : balance !== null && n > balance ? `You only have ${qty(a!.symbol, balance)} on ${net!.label}.` : null;
  const noGas = a && native && a.symbol !== native.symbol && Number(native.balance ?? 0) === 0;
  const ok = !!net && !!a && addrOk && n > 0 && !amountErr && balance !== null && to.trim() !== net.address;

  const confirm = async () => {
    setBusy(true);
    try { const r = await api.sendCrypto({ network: net!.id, asset: a!.symbol, to: to.trim(), amount }, idem); setTx(r); bumpWallet(); }
    catch (e) { setFailMsg((e as Error).message); }
    finally { setBusy(false); setStep('result'); }
  };

  const testBadge = net?.testnet ? <Badge text="Testnet" title="Test network — tokens have no real value" /> : undefined;
  return (
    <Modal onClose={busy ? () => {} : onClose} isMobile={isMobile} label="Send" z={92}>
      {step === 'form' && (
        <div>
          <Header title="Send" onClose={onClose} badge={testBadge} />
          {bals.error && <><ErrLine msg={bals.error} /><button onClick={bals.reload} style={s('margin-top:8px;font-size:13px;font-weight:700;color:#14975C')}>Try again</button></>}
          {!bals.data && !bals.error && <div className="kk-skel" style={{ height: 160, marginTop: 16, borderRadius: 16 }} />}
          {net && a && (
            <>
              <Label>Network</Label>
              <Chips items={nets.map(x => x.id)} value={net.id} onChange={v => { setNetId(v); setAsset(''); }} colorDot={v => nets.find(x => x.id === v)!.color} render={v => nets.find(x => x.id === v)!.label} />
              <Label>Asset</Label>
              <Chips items={net.assets.map(x => x.symbol)} value={a.symbol} onChange={setAsset} colorDot={v => assetColor[v] ?? '#14975C'} />
              <Label>Recipient address</Label>
              <input value={to} onChange={e => setTo(e.target.value)} placeholder={evm ? '0x…' : 'Paste Solana address'} aria-label="Recipient address" style={s('margin-top:8px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:13px 15px;outline:none;font-family:ui-monospace,Menlo,monospace;font-size:13px')} />
              {to.trim() && !addrOk && <ErrLine msg={`That is not a valid ${net.label} address.`} />}
              <Label>Amount</Label>
              <AmountBox value={amount} onChange={setAmount} suffix={a.symbol} onMax={balance ? () => setAmount(a.balance!) : undefined} />
              <div style={s('display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:13.5px')}><span style={s('color:#5A6358;font-weight:600')}>Available on {net.label}</span><span style={s('font-weight:700')}>{balance === null ? 'Unavailable' : qty(a.symbol, balance)}</span></div>
              <ErrLine msg={amountErr} />
              {noGas && <Warn>You need some {native!.symbol} on {net.label} to pay the network fee for this {a.symbol} transfer.</Warn>}
              <Warn>Make sure the recipient can receive {a.symbol} on {net.label}. Funds sent to the wrong network or address cannot be recovered.</Warn>
              <button onClick={() => { setIdem(newIdempotencyKey()); setStep('review'); }} disabled={!ok} className={ok ? H.green : ''} style={primaryBtn(!ok)}>Review Transaction</button>
            </>
          )}
        </div>
      )}
      {step === 'review' && net && a && (
        <div>
          <Header title="Confirm Transaction" onClose={onClose} onBack={() => setStep('form')} badge={testBadge} />
          <p style={s('margin:8px 0 0;font-size:13.5px;color:#6B7268')}>Blockchain transactions cannot be reversed. Check every detail.</p>
          <Rows rows={[
            { k: 'Network', v: net.label }, { k: 'Asset', v: a.symbol }, { k: 'Amount', v: qty(a.symbol, amount), tone: 'strong' },
            { k: 'To', v: mono(to.trim()) }, { k: 'From', v: mono(shortAddr(net.address)) },
            { k: 'Network fee', v: `Paid in ${native?.symbol} at the network’s current rate` },
          ]} />
          <button onClick={confirm} disabled={busy} className={H.ink} style={inkBtn}>{busy && <Spinner size={16} color="#fff" />}{busy ? 'Signing & broadcasting…' : 'Confirm & Send'}</button>
          <button onClick={() => setStep('form')} disabled={busy} className={H.ghost} style={ghostBtn}>Back</button>
        </div>
      )}
      {step === 'result' && (failMsg || !tx
        ? <Result state="fail" title="Transaction Failed" body={failMsg ?? 'The transaction was not submitted.'} onClose={onClose} onRetry={() => { setFailMsg(null); setIdem(newIdempotencyKey()); setStep('review'); }} />
        : <Result
            state={tx.status === 'confirmed' ? 'ok' : tx.status === 'failed' || tx.status === 'dropped' ? 'fail' : 'pending'}
            title={tx.status === 'confirmed' ? 'Transaction Confirmed' : tx.status === 'failed' ? 'Transaction Failed' : tx.status === 'dropped' ? 'Transaction Dropped' : 'Transaction Submitted'}
            body={tx.status === 'confirmed' ? <>{qty(a?.symbol ?? '', amount)} was sent on {net?.label}.</> : tx.status === 'failed' || tx.status === 'dropped' ? (tx.error ?? 'The network did not accept this transaction.') : <>Broadcast to {net?.label}. Waiting for the network to confirm it.</>}
            steps={tx.status === 'failed' || tx.status === 'dropped' ? undefined : { labels: ['Submitted', 'Confirmed'], index: tx.status === 'confirmed' ? 1 : 0 }}
            rows={[...(tx.txHash ? [{ k: 'Transaction hash', v: mono(shortAddr(tx.txHash)) }] : []), ...(tx.explorerUrl ? [{ k: 'Explorer', v: explorerLink(tx.explorerUrl) }] : [])]}
            onClose={onClose}
          />)}
    </Modal>
  );
}

// ───────────── Receive crypto (real CDP addresses) ─────────────
function ReceiveFlow({ onClose, isMobile }: FlowProps) {
  const { wallet, config, showToast } = useApp();
  const ready = !!wallet?.cryptoActivated;
  const nets = config?.crypto.networks ?? [];
  const [netId, setNetId] = useState('');
  const [qr, setQr] = useState('');
  const net = nets.find(n => n.id === netId) ?? nets[0];
  const address = !net || !wallet?.crypto ? null : net.id === 'solana' ? wallet.crypto.solanaAddress : wallet.crypto.evmAddress;
  const req = useRef(0);
  useEffect(() => {
    const id = ++req.current;
    setQr('');
    if (address) QRCode.toDataURL(address, { margin: 0, width: 296, color: { dark: '#101410', light: '#ffffff' } }).then(u => { if (id === req.current) setQr(u); });
  }, [address]);

  if (!wallet) return null;
  if (!ready) return <NeedsCryptoWallet title="Receive" onClose={onClose} isMobile={isMobile} />;

  return (
    <Modal onClose={onClose} isMobile={isMobile} label="Receive crypto" z={92}>
      <Header title="Receive" onClose={onClose} badge={net?.testnet ? <Badge text="Testnet" title="Test network — tokens have no real value" /> : undefined} />
      {net && (
        <>
          <div style={s('margin-top:16px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6B7268')}>Select network</div>
          <Chips items={nets.map(n => n.id)} value={net.id} onChange={setNetId} colorDot={v => nets.find(n => n.id === v)!.color} render={v => nets.find(n => n.id === v)!.label} />
        </>
      )}
      <div style={s('margin-top:16px;display:flex;flex-direction:column;align-items:center;gap:14px;padding:20px;background:#F5F7F4;border-radius:18px')}>
        <div style={s('width:168px;height:168px;padding:10px;background:#fff;border-radius:14px;display:flex;align-items:center;justify-content:center')}>
          {qr && address ? <img src={qr} alt={`QR code for ${address}`} style={{ width: 148, height: 148 }} /> : <div className="kk-skel" style={{ width: 148, height: 148 }} />}
        </div>
        <div style={s('text-align:center')}>
          <div style={s('font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6B7268')}>Your {net?.label} address</div>
          <div style={s('font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600;word-break:break-all;line-height:1.6;margin-top:4px')}>{address ?? 'Unavailable'}</div>
        </div>
      </div>
      <div style={s('display:flex;gap:9px;margin-top:12px')}>
        <button disabled={!address} onClick={async () => { try { await navigator.clipboard.writeText(address!); showToast('Address copied'); } catch { showToast('Copy failed — select the address manually'); } }} className={H.green} style={s('flex:1;background:#14975C;color:#fff;font-weight:800;font-size:14px;padding:13px;border-radius:13px')}>Copy address</button>
        <button disabled={!address} onClick={async () => { try { if (navigator.share) await navigator.share({ text: address! }); else { await navigator.clipboard.writeText(address!); showToast('Address copied to share'); } } catch { /* cancelled */ } }} className={H.ghost} style={s('flex:1;border:1px solid rgba(16,20,16,.14);font-weight:800;font-size:14px;padding:13px;border-radius:13px')}>Share</button>
      </div>
      {net && <Warn>Only send {net.assets.join(' or ')} on {net.label} to this address.{net.testnet ? ' This is a test network — never send real funds here.' : ''} Deposits show up once the network confirms them.</Warn>}
    </Modal>
  );
}
