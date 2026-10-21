import { features } from '@/lib/server/env';
import { HttpError, ok, route } from '@/lib/server/http';
import { requireAuth, userRpc } from '@/lib/server/supabaseAdmin';
import { syncWithdrawal } from '@/lib/server/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = { reference: string; status: string } | null;

export const GET = route('payments.withdraw.status', async (req: Request, ctx: { params: Promise<{ reference: string }> }) => {
  const { token } = await requireAuth(req);
  const { reference } = await ctx.params;
  if (!/^[a-z0-9_-]{8,60}$/.test(reference)) throw new HttpError(404, 'Withdrawal not found.', 'NOT_FOUND');
  let s = await userRpc<Status>(token, 'withdrawal_status', { p_reference: reference });
  if (!s) throw new HttpError(404, 'Withdrawal not found.', 'NOT_FOUND');
  if (features.payments && (s.status === 'pending' || s.status === 'processing')) {
    try { await syncWithdrawal(reference); } catch { /* provider unreachable — report current state */ }
    s = await userRpc<Status>(token, 'withdrawal_status', { p_reference: reference });
  }
  return ok(s);
});
