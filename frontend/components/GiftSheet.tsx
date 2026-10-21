'use client';
import { CSSProperties, useEffect, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { assetColor, compact, money, moneyExact } from '@/lib/format';
import { H, s, sx } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import type { GiftQuote } from '@/types';
import { useApp } from './AppProvider';
import { Avatar, BackBtn, CloseBtn, GiftIcon, I, Icon, Spinner } from './ui';

const TIERS = [200, 500, 2000, 3000];
const CONF = ['#C98A12', '#14975C', '#E8B84B', '#0E7546', '#F2D08A', '#2F6F4E'];

export function GiftSheet() {
  const { giftTarget: t, closeGift, wallet, refreshWallet, upsertPosts, showToast, openFlow, bumpWallet } = useApp();
  const { isMobile } = useViewport();
  const [step, setStep] = useState<'select' | 'review' | 'success'>('select');
  const [tier, setTier] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [quote, setQuote] = useState<GiftQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState<string>('');
  const [sent, setSent] = useState<{ amount: number; costLine: string; net: string } | null>(null);
  const [tiers, setTiers] = useState<number[]>(TIERS);
  const [minGift, setMinGift] = useState(50);
  useEffect(() => { api.giftConfig().then(c => { if (Array.isArray(c.tiers) && c.tiers.length) setTiers(c.tiers.map(Number)); setMinGift(Number(c.min) || 50); }).catch(() => null); }, []);

  // Gifts are paid only from the verified Naira balance (funded via Paystack or received).
  const amt = tier || parseInt(custom.replace(/\D/g, ''), 10) || 0;
  const bal = Number(wallet?.ngn.balance ?? 0);
  const insufficient = amt > 0 && amt > bal;

  if (!t) return null;
  const target = t.user;
  const body = { postId: t.post?.id, recipientId: t.post ? undefined : target.id, liveSessionId: t.liveSessionId, amountNgn: amt };

  const toReview = async () => {
    if (amt <= 0 || insufficient) return;
    if (amt < minGift) { setErr(`Minimum gift is ${money(minGift)}.`); return; }
    setBusy(true); setErr(null);
    try {
      const q = (await api.giftQuote(body)).quote;
      setQuote(q);
      if (!q.sufficient) setErr(`Insufficient balance. You need ${q.payLabel}; you have ${q.balanceLabel}.`);
      else { setIdemKey(newIdempotencyKey()); setStep('review'); }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.sendGift(body, idemKey); // same key on retry → processed once
      if (r.post) upsertPosts([r.post]);
      setSent({ amount: Number(r.gift.amountNgn), net: money(r.gift.creatorAmountNgn), costLine: `${money(r.gift.amountNgn)} deducted from your Naira balance` });
      setStep('success');
      bumpWallet();
      showToast('Gift sent · ' + r.gift.payLabel + ' deducted');
    } catch (e) { setErr((e as Error).message); refreshWallet(); }
    finally { setBusy(false); }
  };

  const close = () => { closeGift(); };
  const sheet: CSSProperties = isMobile
    ? s('margin-top:auto;width:100%;background:#fff;border-radius:26px 26px 0 0;padding:20px 18px 26px;max-height:94vh;overflow-y:auto;animation:kkIn .3s cubic-bezier(.2,.9,.3,1)')
    : s('margin:auto;width:472px;max-width:calc(100% - 32px);background:#fff;border-radius:24px;padding:24px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(16,20,16,.28);animation:kkIn .3s cubic-bezier(.2,.9,.3,1)');

  const creatorLine = (
    <div style={s('display:flex;align-items:center;gap:11px;padding:11px 13px;background:#F5F7F4;border-radius:14px')}>
      <Avatar user={target} size={38} />
      <div style={s('flex:1;min-width:0')}>
        <div style={s('font-size:14px;font-weight:700')}>{target.displayName}</div>
        <div style={s('font-size:12.5px;color:#6B7268')}>@{target.username}{step === 'select' ? ' · ' + (target.followers !== undefined ? `${compact(target.followers)} follower${target.followers === 1 ? '' : 's'}` : 'Creator on KAMKAM') : ''}</div>
      </div>
    </div>
  );

  const breakdown = [
    { k: 'Gift value', v: money(amt), st: 'font-weight:800' },
    { k: 'Paying with', v: 'Naira balance', st: 'font-weight:800' },
    { k: 'Wallet deduction', v: money(amt), st: 'font-weight:800;color:#8A5E08' },
    { k: 'Creator receives', v: moneyExact(Math.round(amt * 80) / 100), st: 'font-weight:800;color:#14975C' },
    { k: 'KAMKAM fee (20%)', v: moneyExact(amt - Math.round(amt * 80) / 100), st: 'font-weight:700;color:#5A6358' },
  ];

  const disabled = amt <= 0 || insufficient || busy;
  return (
    <div style={s('position:fixed;inset:0;z-index:90;background:rgba(16,20,16,.48);backdrop-filter:blur(3px);display:flex;animation:kkFade .18s ease-out')} onClick={step === 'success' || !busy ? close : undefined}>
      <div style={sheet} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send a gift">

        {step === 'select' && (
          <div>
            <div style={s('display:flex;align-items:flex-start;gap:13px')}>
              <div style={s('width:44px;height:44px;border-radius:14px;background:#FCF3E0;color:#C98A12;display:flex;align-items:center;justify-content:center;flex:none')}><GiftIcon size={22} /></div>
              <div style={s('flex:1;min-width:0')}>
                <h2 style={s('margin:0;font-size:20px;font-weight:800;letter-spacing:-.02em')}>Send a Gift</h2>
                <p style={s('margin:3px 0 0;font-size:13.5px;color:#6B7268;line-height:1.5')}>{t.post ? 'Support this creator and give this post a boost.' : 'Support this creator directly.'}</p>
              </div>
              <CloseBtn onClick={close} />
            </div>
            <div style={{ marginTop: 16 }}>{creatorLine}</div>

            <div style={s('display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px')}>
              {tiers.map(n => {
                const on = tier === n;
                return (
                  <button key={n} onClick={() => { setTier(n); setCustom(''); setErr(null); }} aria-pressed={on}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 7, padding: 14, borderRadius: 16, textAlign: 'left', border: on ? '2px solid #C98A12' : '1px solid rgba(16,20,16,.12)', background: on ? '#FFFCF4' : '#fff', boxShadow: on ? '0 6px 18px rgba(201,138,18,.18)' : 'none', transform: on ? 'translateY(-1px)' : 'none', transition: 'all .16s' }}>
                    <span style={{ width: 30, height: 30, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? '#C98A12' : '#FCF3E0', color: on ? '#fff' : '#C98A12', transition: 'all .16s' }}><GiftIcon full={false} /></span>
                    <span style={s('font-size:19px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums')}>{money(n)}</span>
                    <span style={s('font-size:11.5px;font-weight:600;color:#6B7268')}>{n >= 2000 ? 'Big boost' : 'Support creator'}</span>
                  </button>
                );
              })}
            </div>

            <div style={sx('display:flex;align-items:center;gap:9px;margin-top:10px;padding:13px 15px;border-radius:14px', !tier && custom ? 'border:2px solid #C98A12;background:#FFFCF4' : 'border:1px solid rgba(16,20,16,.12);background:#fff')}>
              <span style={s('font-size:13.5px;font-weight:700;color:#3C433A;flex:none')}>Custom</span>
              <span style={s('font-size:15px;font-weight:700;color:#6B7268')}>₦</span>
              <input value={custom} onChange={e => { setCustom(e.target.value.replace(/[^0-9]/g, '')); setTier(null); setErr(null); }} inputMode="numeric" placeholder="Enter amount" aria-label="Custom gift amount" style={s('flex:1;min-width:0;border:0;background:none;outline:none;font-size:15px;font-weight:700')} />
            </div>

            <div style={s('margin-top:18px;display:flex;align-items:baseline;justify-content:space-between;gap:10px')}>
              <span style={s('font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6B7268')}>Pay with</span>
            </div>
            <div style={s('display:flex;flex-direction:column;gap:8px;margin-top:9px')}>
              {!wallet && <div className="kk-skel" style={{ height: 58, borderRadius: 14 }} />}
              {wallet && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '11px 13px', borderRadius: 14, border: '2px solid #14975C', background: '#F3FAF6', textAlign: 'left' }}>
                  <span style={{ width: 34, height: 34, borderRadius: 11, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, color: '#fff', background: assetColor.NGN }}>₦</span>
                  <span style={s('flex:1;min-width:0')}>
                    <span style={s('display:block;font-size:14px;font-weight:750')}>Naira balance</span>
                    <span style={s('display:block;font-size:12.5px;color:#6B7268;margin-top:1px')}>{moneyExact(bal)} available</span>
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: insufficient ? '#C0412F' : '#0E7546', flex: 'none' }}>{amt > 0 ? money(amt) : ''}</span>
                </div>
              )}
            </div>

            {insufficient && (
              <div style={s('margin-top:14px;padding:14px;border-radius:16px;background:#FCEFEC;border:1px solid rgba(192,65,47,.3)')}>
                <div style={s('font-size:14px;font-weight:800;color:#A8331F')}>Insufficient balance</div>
                <div style={s('margin-top:5px;font-size:13px;color:#8A3524;line-height:1.55')}>
                  You need {money(amt)}.<br />Your balance: {moneyExact(bal)}
                </div>
                <div style={s('display:flex;gap:8px;margin-top:11px;flex-wrap:wrap')}>
                  <button onClick={() => { close(); openFlow('deposit'); }} style={s('font-size:13px;font-weight:700;padding:9px 15px;border-radius:99px;background:#14975C;color:#fff')}>Fund wallet</button>
                </div>
              </div>
            )}

            {amt > 0 && !insufficient && (
              <div style={s('margin-top:14px;border:1px solid rgba(201,138,18,.28);background:#FFFCF4;border-radius:16px;padding:14px;animation:kkUp .22s ease-out')}>
                {breakdown.map(b => (
                  <div key={b.k} style={s('display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13.5px')}>
                    <span style={s('color:#5A6358;font-weight:600')}>{b.k}</span><span style={s(b.st)}>{b.v}</span>
                  </div>
                ))}
                {t.post && (
                  <div style={s('display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:9px;margin-top:6px;border-top:1px dashed rgba(201,138,18,.3)')}>
                    <span style={s('font-size:13.5px;color:#5A6358;font-weight:600')}>Post boost</span>
                    <span style={s('display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#8A5E08;background:#FCF3E0;padding:5px 10px;border-radius:99px')}><Icon d={I.flame} size={12} sw={2.4} />Active</span>
                  </div>
                )}
                <p style={s('margin:11px 0 0;font-size:12.5px;color:#6B7268;line-height:1.6')}>80% goes directly to the creator. 20% is retained by KAMKAM as a platform fee. Final amounts are calculated by the server.</p>
              </div>
            )}

            {err && <div role="alert" style={s('margin-top:12px;font-size:13px;font-weight:700;color:#A8331F')}>{err}</div>}

            <button onClick={toReview} disabled={disabled}
              style={{ marginTop: 16, width: '100%', padding: 15, borderRadius: 15, fontSize: 15.5, fontWeight: 800, color: '#fff', background: disabled && !busy ? 'rgba(16,20,16,.16)' : '#C98A12', cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '0 8px 22px rgba(201,138,18,.3)', transition: 'all .18s', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 9 }}>
              {busy && <Spinner size={16} color="#fff" />}
              {insufficient ? 'Insufficient Naira balance' : amt > 0 ? 'Review gift · ' + money(amt) : 'Choose an amount'}
            </button>
            <div style={s('margin-top:10px;text-align:center;font-size:12.5px;color:#6B7268')}>
              Wallet balance {moneyExact(bal)} · <button onClick={() => { close(); openFlow('deposit'); }} style={s('color:#14975C;font-weight:700')}>Fund wallet</button>
            </div>
          </div>
        )}

        {step === 'review' && quote && (
          <div>
            <div style={s('display:flex;align-items:center;gap:11px')}>
              <BackBtn onClick={() => { setStep('select'); setErr(null); }} />
              <h2 style={s('margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em')}>Send Gift</h2>
              <CloseBtn onClick={close} style={{ marginLeft: 'auto' }} />
            </div>
            <div style={{ marginTop: 14 }}>{creatorLine}</div>
            <div style={s('margin-top:14px;border:1px solid rgba(16,20,16,.1);border-radius:16px;overflow:hidden')}>
              {[
                { k: 'Gift value', v: money(quote.amountNgn), st: 'font-weight:800' },
                { k: 'Paying with', v: 'Naira balance', st: 'font-weight:800' },
                { k: 'Wallet deduction', v: quote.payLabel, st: 'font-weight:800;color:#8A5E08' },
                { k: 'Creator receives (80%)', v: moneyExact(quote.creatorAmountNgn), st: 'font-weight:800;color:#14975C' },
                { k: 'KAMKAM fee (20%)', v: moneyExact(quote.platformFeeNgn), st: 'font-weight:700;color:#5A6358' },
                { k: 'Wallet balance', v: quote.balanceLabel, st: 'font-weight:700' },
              ].map((r, i) => (
                <div key={r.k} style={sx('display:flex;justify-content:space-between;gap:14px;padding:12px 15px', i > 0 && 'border-top:1px solid rgba(16,20,16,.07)')}>
                  <span style={s('font-size:13.5px;color:#5A6358;font-weight:600')}>{r.k}</span><span style={sx('font-size:13.5px;text-align:right', r.st)}>{r.v}</span>
                </div>
              ))}
            </div>
            <div style={s('display:flex;flex-direction:column;gap:8px;margin-top:14px')}>
              {(t.post ? ['This gift will automatically like the post.', 'This gift will activate a Super Like.', "This gift will contribute to the post's visibility boost."] : ['This gift goes straight to the creator’s earnings.']).map(x => (
                <div key={x} style={s('display:flex;align-items:flex-start;gap:9px')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#14975C" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 2 }}><path d={I.check} /></svg>
                  <span style={s('font-size:13.5px;font-weight:650;line-height:1.5')}>{x}</span>
                </div>
              ))}
            </div>
            {err && <div role="alert" style={s('margin-top:14px;padding:12px 14px;border-radius:14px;background:#FCEFEC;border:1px solid rgba(192,65,47,.3);font-size:13px;font-weight:700;color:#A8331F')}>Transaction failed: {err}</div>}
            <button onClick={confirm} disabled={busy} className={H.gold} style={s('margin-top:18px;width:100%;padding:15px;border-radius:15px;font-size:15.5px;font-weight:800;color:#fff;background:#C98A12;box-shadow:0 8px 22px rgba(201,138,18,.3);display:flex;justify-content:center;align-items:center;gap:9px')}>
              {busy && <Spinner size={16} color="#fff" />}{busy ? 'Sending gift…' : 'Confirm & Send Gift'}
            </button>
            <p style={s('margin:10px 0 0;text-align:center;font-size:12px;color:#9AA197')}>Paid instantly from your KAMKAM Naira balance. Gifts cannot be refunded.</p>
          </div>
        )}

        {step === 'success' && sent && (
          <div style={s('text-align:center;padding:14px 4px 4px')}>
            <div style={s('position:relative;width:104px;height:104px;margin:0 auto')}>
              <span style={s('position:absolute;inset:0;border-radius:50%;border:2px solid #C98A12;animation:kkRing 1.4s ease-out infinite')} />
              <span style={s('position:absolute;inset:0;border-radius:50%;border:2px solid #C98A12;animation:kkRing 1.4s .45s ease-out infinite')} />
              {Array.from({ length: 26 }, (_, i) => {
                const ang = (i / 26) * Math.PI * 2 + (i % 3) * 0.22, d = 88 + (i % 5) * 26, round = i % 4 === 0;
                const w = round ? 9 : i % 3 ? 6 : 8, h = round ? 9 : i % 3 ? 13 : 9;
                return <span key={i} style={{ position: 'absolute', left: '50%', top: '50%', width: w, height: h, marginLeft: -w / 2, marginTop: -h / 2, borderRadius: round ? '50%' : 2, background: CONF[i % CONF.length], ['--dx' as string]: (Math.cos(ang) * d).toFixed(1) + 'px', ['--dy' as string]: (Math.sin(ang) * d * 0.82 + 30).toFixed(1) + 'px', ['--rot' as string]: ((i % 2 ? 1 : -1) * (220 + i * 27)) + 'deg', animation: `kkConfetti ${(1.25 + (i % 4) * 0.18).toFixed(2)}s ${(i * 0.035).toFixed(2)}s cubic-bezier(.12,.72,.32,1) infinite` } as CSSProperties} />;
              })}
              <div style={s('position:absolute;inset:14px;border-radius:50%;background:#C98A12;color:#fff;display:flex;align-items:center;justify-content:center;animation:kkPop .5s cubic-bezier(.2,1.4,.4,1) both')}><GiftIcon size={36} /></div>
            </div>
            <h2 style={s('margin:20px 0 0;font-size:23px;font-weight:800;letter-spacing:-.02em;animation:kkUp .35s .1s both')}>Gift Sent Successfully</h2>
            <p style={s('margin:8px auto 0;font-size:14.5px;color:#5A6358;line-height:1.6;max-width:36ch;animation:kkUp .35s .18s both')}>You sent a {money(sent.amount)} gift to @{target.username}. {sent.costLine}.</p>
            <div style={s('display:flex;flex-direction:column;gap:8px;margin-top:16px;text-align:left;animation:kkUp .35s .26s both')}>
              {t.post && <>
                <div style={s('display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:13px;background:#FBECEA')}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="#D0412F" stroke="#D0412F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d={I.heart} /></svg>
                  <span style={s('font-size:13.5px;font-weight:750;color:#A8331F')}>Post liked</span>
                </div>
                <div style={s('display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:13px;background:#FCF3E0;color:#C98A12')}>
                  <Icon d={I.flame} size={17} sw={2.1} style={{ flex: 'none' }} />
                  <span style={s('font-size:13.5px;font-weight:750;color:#8A5E08')}>Super Like activated · visibility boost</span>
                </div>
              </>}
              <div style={s('display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:13px;background:#E8F5EE;color:#0E7546')}>
                <Icon d={I.check} size={17} sw={2.4} style={{ flex: 'none' }} />
                <span style={s('font-size:13.5px;font-weight:750;color:#0E7546')}>Creator received {sent.net}</span>
              </div>
            </div>
            <button onClick={close} className={H.ink} style={s('margin-top:22px;width:100%;background:#101410;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px;animation:kkUp .35s .34s both')}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
