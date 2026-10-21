import { features } from '@/lib/server/env';
import { HttpError, ok, route } from '@/lib/server/http';
import { requireAuth, userRpc } from '@/lib/server/supabaseAdmin';
import { settleDeposit } from '@/lib/server/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = { reference: string; status: string; credited: boolean; amount: string } | null;

/** Deposit status for the callback page. Re-verifies with Paystack when not yet final. */
export const GET = route('payments.deposit.status', async (req: Request, ctx: { params: Promise<{ reference: string }> }) => {
  const { token } = await requireAuth(req);
  const { reference } = await ctx.params;
  if (!/^[a-z0-9_-]{8,60}$/.test(reference)) throw new HttpError(404, 'Payment not found.', 'NOT_FOUND');
  // Ownership: payment_status only returns the caller's own payments.
  let s = await userRpc<Status>(token, 'payment_status', { p_reference: reference });
  if (!s) throw new HttpError(404, 'Payment not found.', 'NOT_FOUND');
  if (features.payments && !s.credited && (s.status === 'initialized' || s.status === 'pending')) {
    await settleDeposit(reference);
    s = await userRpc<Status>(token, 'payment_status', { p_reference: reference });
  }
  return ok(s);
});
