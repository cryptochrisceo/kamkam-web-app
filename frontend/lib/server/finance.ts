import 'server-only';
import { svc } from './supabaseAdmin';
import { verifyTransaction, verifyTransfer, transferState, PaystackError, type VerifiedTransaction } from './paystack';
import { getNetwork, readTxState } from './chains';

/**
 * Every balance change below is driven by a response fetched FROM the provider
 * (Paystack verify API / chain RPC), never by data the browser sent us.
 */

const depositStatus = (s: VerifiedTransaction['status']) =>
  s === 'success' ? 'success' : s === 'failed' ? 'failed' : s === 'abandoned' ? 'abandoned' : s === 'reversed' ? 'reversed' : 'pending';

/** Verify a deposit with Paystack and settle it (idempotent — safe to call any number of times). */
export async function settleDeposit(reference: string) {
  let tx: VerifiedTransaction;
  try {
    tx = await verifyTransaction(reference);
  } catch (e) {
    // Paystack returns 4xx for references it has never seen (customer never opened checkout).
    if (e instanceof PaystackError && e.httpStatus < 500) return { outcome: 'pending' as const };
    throw e;
  }
  return svc<{ outcome: string; amount?: string }>('svc_payment_settle', {
    p_reference: reference, p_status: depositStatus(tx.status), p_amount_kobo: tx.amount, p_currency: tx.currency,
    p_channel: tx.channel, p_paid_at: tx.paid_at,
  });
}

/** Verify a payout with Paystack and move the withdrawal state machine. */
export async function syncWithdrawal(reference: string, opts: { failIfUnknownAfterMs?: number; createdAt?: string } = {}) {
  try {
    const t = await verifyTransfer(reference);
    const st = transferState(t.status);
    if (st === 'otp') {
      return svc('svc_withdrawal_update', { p_reference: reference, p_status: 'failed', p_transfer_code: t.transfer_code,
        p_reason: 'Transfer requires OTP approval — disable OTP for API transfers in the Paystack dashboard.' });
    }
    return svc('svc_withdrawal_update', { p_reference: reference, p_status: st, p_transfer_code: t.transfer_code, p_reason: t.reason || null });
  } catch (e) {
    // Paystack has no transfer with this reference → it was never created, so the hold can be released.
    const age = opts.createdAt ? Date.now() - new Date(opts.createdAt).getTime() : 0;
    if (e instanceof PaystackError && e.httpStatus === 404 && opts.failIfUnknownAfterMs && age > opts.failIfUnknownAfterMs) {
      return svc('svc_withdrawal_update', { p_reference: reference, p_status: 'failed', p_reason: 'Transfer was not created by the provider.' });
    }
    throw e;
  }
}

type CryptoTxRow = { id: string; network: string; tx_hash: string | null; status: string; created_at: string };

/** Check a crypto send against the chain itself. */
export async function syncCryptoTx(tx: CryptoTxRow) {
  const net = getNetwork(tx.network);
  if (!net) return tx.status;
  if (tx.status === 'submitting') {
    // Submission never returned a hash; after 10 minutes treat as not broadcast.
    if (!tx.tx_hash && Date.now() - new Date(tx.created_at).getTime() > 10 * 60_000) {
      await svc('svc_crypto_tx_update', { p_id: tx.id, p_status: 'dropped', p_hash: null, p_explorer: null, p_error: 'Submission did not complete.' });
      return 'dropped';
    }
    return tx.status;
  }
  if (tx.status !== 'submitted' || !tx.tx_hash) return tx.status;
  const state = await readTxState(net, tx.tx_hash);
  if (state === 'confirmed' || state === 'failed') {
    await svc('svc_crypto_tx_update', { p_id: tx.id, p_status: state, p_hash: null, p_explorer: null,
      p_error: state === 'failed' ? 'Transaction reverted on-chain.' : null });
    return state;
  }
  if (state === 'pending' && Date.now() - new Date(tx.created_at).getTime() > 24 * 3600_000) {
    await svc('svc_crypto_tx_update', { p_id: tx.id, p_status: 'dropped', p_hash: null, p_explorer: null, p_error: 'Not found on-chain after 24 hours.' });
    return 'dropped';
  }
  return 'submitted';
}
