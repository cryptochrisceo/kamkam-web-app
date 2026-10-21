import { features } from '@/lib/server/env';
import { HttpError, ok, readJson, route } from '@/lib/server/http';
import { requireUser } from '@/lib/server/supabaseAdmin';
import { PaystackError, resolveAccount } from '@/lib/server/paystack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Look up the account holder's name with Paystack before a payout. */
export const POST = route('payments.resolve', async (req: Request) => {
  if (!features.payments) throw new HttpError(503, 'Bank withdrawals are not configured on this server yet.', 'PAYMENTS_NOT_CONFIGURED');
  await requireUser(req);
  const { accountNumber, bankCode } = await readJson<{ accountNumber?: string; bankCode?: string }>(req);
  if (!/^\d{10}$/.test(String(accountNumber || ''))) throw new HttpError(400, 'Account numbers have 10 digits.', 'VALIDATION');
  if (!/^[0-9A-Za-z]{2,10}$/.test(String(bankCode || ''))) throw new HttpError(400, 'Choose your bank.', 'VALIDATION');
  try {
    const r = await resolveAccount(String(accountNumber), String(bankCode));
    return ok({ accountName: r.account_name, accountNumber: r.account_number });
  } catch (e) {
    if (e instanceof PaystackError && e.httpStatus < 500) throw new HttpError(422, 'We could not verify that account. Check the number and bank.', 'ACCOUNT_NOT_FOUND');
    throw e;
  }
});
