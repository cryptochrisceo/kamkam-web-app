import { features } from '@/lib/server/env';
import { HttpError, ok, route } from '@/lib/server/http';
import { requireUser } from '@/lib/server/supabaseAdmin';
import { listBanks } from '@/lib/server/paystack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route('payments.banks', async (req: Request) => {
  if (!features.payments) throw new HttpError(503, 'Bank withdrawals are not configured on this server yet.', 'PAYMENTS_NOT_CONFIGURED');
  await requireUser(req);
  return ok({ banks: await listBanks() });
});
