import { HttpError, isUuid, ok, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { syncCryptoTx } from '@/lib/server/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TxRow = { id: string; network: string; asset: string; amount: string; to_address: string; tx_hash: string | null;
  explorer_url: string | null; status: string; error: string | null; created_at: string; confirmed_at: string | null };

/** Confirmation status, decided by the chain (receipt / signature status). */
export const GET = route('wallet.send.status', async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, 'Transaction not found.', 'NOT_FOUND');
  let t = await svc<TxRow | null>('svc_crypto_tx_get', { p_id: id, p_user: user.id });
  if (!t) throw new HttpError(404, 'Transaction not found.', 'NOT_FOUND');
  if (t.status === 'submitted' || t.status === 'submitting') {
    await syncCryptoTx(t);
    t = (await svc<TxRow | null>('svc_crypto_tx_get', { p_id: id, p_user: user.id }))!;
  }
  return ok({ id: t.id, network: t.network, asset: t.asset, amount: t.amount, to: t.to_address, txHash: t.tx_hash,
    explorerUrl: t.explorer_url, status: t.status, error: t.error, createdAt: t.created_at, confirmedAt: t.confirmed_at });
});
