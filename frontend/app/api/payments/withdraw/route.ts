import { features } from '@/lib/server/env';
import { HttpError, isUuid, ok, readJson, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { PaystackError, createRecipient, initiateTransfer, listBanks, newReference, resolveAccount, toKobo, transferState } from '@/lib/server/paystack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { source?: string; amount?: string | number; accountNumber?: string; bankCode?: string; idempotencyKey?: string };
type W = { id: string; reference: string; status: string; amount: string; fee: string; payout: string; transfer_code: string | null; failure_reason: string | null };
const view = (w: W) => ({ reference: w.reference, status: w.status, amount: String(w.amount), fee: String(w.fee), payout: String(w.payout), failureReason: w.failure_reason });

/**
 * Bank payout via Paystack Transfers.
 *  1. resolve the account name with Paystack  2. create a transfer recipient
 *  3. HOLD the funds in the ledger (atomic, idempotent)  4. initiate the transfer
 * The withdrawal only becomes "success" when Paystack confirms (webhook / verify).
 */
export const POST = route('payments.withdraw', async (req: Request) => {
  if (!features.payments) throw new HttpError(503, 'Bank withdrawals are not configured on this server yet.', 'PAYMENTS_NOT_CONFIGURED');
  const user = await requireUser(req);
  const b = await readJson<Body>(req);
  const source = b.source === 'earnings' ? 'earnings' : b.source === 'balance' ? 'balance' : null;
  if (!source) throw new HttpError(400, 'Choose where to withdraw from.', 'VALIDATION');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter a valid amount.', 'INVALID_AMOUNT');
  if (!/^\d{10}$/.test(String(b.accountNumber || ''))) throw new HttpError(400, 'Account numbers have 10 digits.', 'VALIDATION');
  if (!isUuid(b.idempotencyKey)) throw new HttpError(400, 'Missing idempotency key.', 'VALIDATION');
  const bankCode = String(b.bankCode || '');
  const bank = (await listBanks()).find(x => x.code === bankCode);
  if (!bank) throw new HttpError(400, 'Choose your bank.', 'VALIDATION');

  let accountName: string, recipient: string;
  try {
    accountName = (await resolveAccount(String(b.accountNumber), bankCode)).account_name;
    recipient = (await createRecipient({ name: accountName, accountNumber: String(b.accountNumber), bankCode })).recipient_code;
  } catch (e) {
    if (e instanceof PaystackError && e.httpStatus < 500) throw new HttpError(422, 'We could not verify that bank account.', 'ACCOUNT_NOT_FOUND');
    throw e;
  }
  const bankAccountId = await svc<string>('svc_bank_account_upsert', { p_user: user.id, p_bank_code: bankCode, p_bank_name: bank.name,
    p_account_name: accountName, p_last4: String(b.accountNumber).slice(-4), p_recipient_code: recipient });

  // Hold funds (returns the existing row on a retried key — never a second hold).
  const w = await svc<W>('svc_withdrawal_create', { p_user: user.id, p_source: source, p_amount: amount, p_bank_account: bankAccountId,
    p_reference: newReference('wdr'), p_key: b.idempotencyKey });
  if (w.status !== 'pending' || w.transfer_code) return ok(view(w));

  try {
    const t = await initiateTransfer({ amountKobo: toKobo(w.payout), recipient, reference: w.reference, reason: 'KAMKAM withdrawal' });
    const st = transferState(t.status);
    if (st === 'otp') {
      await svc('svc_withdrawal_update', { p_reference: w.reference, p_status: 'failed', p_transfer_code: t.transfer_code,
        p_reason: 'Payouts need OTP approval on the provider account. Funds returned.' });
    } else {
      await svc('svc_withdrawal_update', { p_reference: w.reference, p_status: st, p_transfer_code: t.transfer_code, p_reason: null });
    }
  } catch (e) {
    if (e instanceof PaystackError && e.httpStatus < 500) {
      // Paystack refused to create the transfer → nothing left our account; release the hold.
      await svc('svc_withdrawal_update', { p_reference: w.reference, p_status: 'failed', p_reason: e.message.slice(0, 200) });
    } else {
      // Unknown outcome (timeout / 5xx): keep the hold; reconciliation verifies with Paystack.
      console.error('[api:payments.withdraw] transfer outcome unknown', w.reference);
    }
  }
  const latest = await svc<W>('svc_withdrawal_create', { p_user: user.id, p_source: source, p_amount: amount, p_bank_account: bankAccountId,
    p_reference: w.reference, p_key: b.idempotencyKey });
  return ok(view(latest), 201);
});
