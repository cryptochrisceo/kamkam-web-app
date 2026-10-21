'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { moneyExact } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useApp } from '@/components/AppProvider';
import { I, Icon, Spinner } from '@/components/ui';

type St = { reference: string; status: string; credited: boolean; amount: string };

/**
 * Paystack redirects here after checkout. Arriving here proves nothing — we ask the
 * KAMKAM server, which re-verifies the transaction with Paystack before crediting.
 */
export default function DepositCallback() {
  const params = useSearchParams();
  const reference = params.get('reference') || params.get('trxref') || '';
  const { bumpWallet } = useApp();
  const [st, setSt] = useState<St | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!reference) { setErr('Missing payment reference.'); return; }
    let live = true;
    api.depositStatus(reference)
      .then(r => { if (!live) return; setSt(r); setErr(null); if (r.credited) bumpWallet(); })
      .catch(e => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [reference, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = !!st && !st.credited && (st.status === 'initialized' || st.status === 'pending');
  useEffect(() => {
    if (!waiting || tries > 20) return;
    const t = setTimeout(() => setTries(n => n + 1), 3000);
    return () => clearTimeout(t);
  }, [waiting, tries]);

  const ok = st?.credited;
  const failed = st && !st.credited && ['failed', 'abandoned', 'reversed'].includes(st.status);
  const bg = ok ? '#14975C' : failed || err ? '#C0412F' : '#C98A12';

  return (
    <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:22px;padding:34px 24px;text-align:center')}>
      <div style={{ ...s('width:74px;height:74px;margin:0 auto;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center'), background: bg }}>
        {ok ? <Icon d={I.check} size={34} sw={2.4} /> : failed || err ? <Icon d={I.close} d2={I.close2} size={32} sw={2.6} /> : <Spinner size={30} color="#fff" />}
      </div>
      <h1 style={s('margin:18px 0 0;font-size:22px;font-weight:800;letter-spacing:-.02em')}>
        {ok ? 'Wallet Funded' : failed ? 'Payment not completed' : err ? 'Could not check payment' : 'Confirming your payment…'}
      </h1>
      <p style={s('margin:8px auto 0;font-size:14px;color:#5A6358;line-height:1.6;max-width:40ch')}>
        {ok ? <>{moneyExact(st!.amount)} was added to your Naira balance after Paystack confirmed the payment.</>
          : failed ? <>Paystack reported this payment as {st!.status}. You were not charged by KAMKAM and your balance did not change.</>
          : err ? err
          : tries > 20 ? <>Paystack hasn’t confirmed this payment yet. If you were debited, it will be credited automatically once Paystack confirms — check your wallet activity.</>
          : <>We’re waiting for Paystack to confirm. This usually takes a few seconds.</>}
      </p>
      {reference && <p style={s('margin:12px 0 0;font-size:12.5px;color:#9AA197;font-family:ui-monospace,Menlo,monospace')}>{reference}</p>}
      <Link href="/wallet" className={H.ink} style={s('display:inline-block;margin-top:20px;background:#101410;color:#fff;font-weight:800;font-size:15px;padding:14px 30px;border-radius:14px')}>Back to wallet</Link>
    </div>
  );
}
