import { env, features } from '@/lib/server/env';
import { HttpError, ok, readJson, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { initializeTransaction, newReference, toKobo } from '@/lib/server/paystack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Start a Paystack checkout. Nothing is credited here — the balance only changes
 * after Paystack confirms the charge (webhook or verify call, both re-verified server-side).
 */
export const POST = route('payments.deposit', async (req: Request) => {
  if (!features.payments) throw new HttpError(503, 'Naira deposits are not configured on this server yet.', 'PAYMENTS_NOT_CONFIGURED');
  const user = await requireUser(req);
  if (!user.email) throw new HttpError(400, 'Add an email address to your account before funding your wallet.', 'VALIDATION');
  const { amount } = await readJson<{ amount?: string | number }>(req);
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'Enter a valid amount.', 'INVALID_AMOUNT');

  const reference = newReference('dep');
  await svc('svc_payment_create', { p_user: user.id, p_reference: reference, p_amount: value, p_channel: null });

  const origin = env.appUrl || new URL(req.url).origin;
  const init = await initializeTransaction({
    email: user.email, amountKobo: toKobo(value), reference,
    callbackUrl: `${origin}/wallet/deposit/callback`,
    metadata: { kamkam_user: user.id, purpose: 'wallet_deposit' },
  });
  return ok({ reference, authorizationUrl: init.authorization_url }, 201);
});
