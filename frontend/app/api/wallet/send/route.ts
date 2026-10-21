import { parseUnits } from 'viem';
import { HttpError, isUuid, ok, readJson, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { getAsset, getNetwork, readBalance, validAddress } from '@/lib/server/chains';
import { submitTransfer } from '@/lib/server/cdp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { network?: string; asset?: string; to?: string; amount?: string; idempotencyKey?: string };
type TxRow = { id: string; status: string; tx_hash: string | null; explorer_url: string | null; error: string | null; duplicate?: boolean };
const view = (t: TxRow) => ({ id: t.id, status: t.status, txHash: t.tx_hash, explorerUrl: t.explorer_url, error: t.error });

/**
 * Send crypto from the caller's CDP account. The response is "submitted" with a real
 * transaction hash; it only becomes "confirmed" after the chain says so (GET /api/wallet/send/[id]).
 */
export const POST = route('wallet.send', async (req: Request) => {
  const user = await requireUser(req);
  const b = await readJson<Body>(req);
  const net = getNetwork(String(b.network || ''));
  if (!net) throw new HttpError(400, 'Unsupported network.', 'VALIDATION');
  const asset = getAsset(net, String(b.asset || ''));
  if (!asset) throw new HttpError(400, `${b.asset} is not supported on ${net.label}.`, 'VALIDATION');
  const to = String(b.to || '').trim();
  if (!validAddress(net, to)) throw new HttpError(400, `That is not a valid ${net.label} address.`, 'INVALID_ADDRESS');
  if (!isUuid(b.idempotencyKey)) throw new HttpError(400, 'Missing idempotency key.', 'VALIDATION');
  const amountStr = String(b.amount || '').trim();
  if (!/^\d+(\.\d+)?$/.test(amountStr)) throw new HttpError(400, 'Enter a valid amount.', 'INVALID_AMOUNT');
  const frac = amountStr.split('.')[1] || '';
  if (frac.length > asset.decimals) throw new HttpError(400, `${asset.symbol} supports at most ${asset.decimals} decimal places.`, 'INVALID_AMOUNT');
  const atomic = parseUnits(amountStr, asset.decimals);
  if (atomic <= 0n) throw new HttpError(400, 'Amount must be greater than zero.', 'INVALID_AMOUNT');

  const w = await svc<{ status: string; evm_address: string | null; solana_address: string | null } | null>('svc_crypto_wallet_get', { p_user: user.id });
  if (!w || w.status !== 'ready') throw new HttpError(404, 'Create your crypto wallet first.', 'NO_WALLET');
  const from = (net.family === 'evm' ? w.evm_address : w.solana_address)!;
  if (from.toLowerCase() === to.toLowerCase()) throw new HttpError(400, 'You cannot send to your own address.', 'VALIDATION');

  // Idempotency first: a retried request returns the original attempt, never a second send.
  const t = await svc<TxRow>('svc_crypto_tx_begin', { p_user: user.id, p_key: b.idempotencyKey, p_network: net.id, p_asset: asset.symbol,
    p_amount: amountStr, p_atomic: atomic.toString(), p_from: from, p_to: to });
  if (t.duplicate) return ok(view(t));

  const balance = await readBalance(net, asset, from);
  if (balance === null || balance < atomic) {
    const error = balance === null ? `Could not reach ${net.label} to check your balance.` : `Insufficient ${asset.symbol} balance on ${net.label}.`;
    await svc('svc_crypto_tx_update', { p_id: t.id, p_status: 'failed', p_hash: null, p_explorer: null, p_error: error });
    throw new HttpError(balance === null ? 503 : 422, error, balance === null ? 'CHAIN_UNAVAILABLE' : 'INSUFFICIENT_BALANCE');
  }

  try {
    const hash = await submitTransfer(user.id, net, asset, to, atomic);
    const explorer = net.explorerTx(hash);
    await svc('svc_crypto_tx_update', { p_id: t.id, p_status: 'submitted', p_hash: hash, p_explorer: explorer, p_error: null });
    return ok({ id: t.id, status: 'submitted', txHash: hash, explorerUrl: explorer, error: null }, 201);
  } catch (e) {
    const error = 'The wallet provider rejected this transaction: ' + String((e as Error)?.message || 'unknown error').slice(0, 200);
    await svc('svc_crypto_tx_update', { p_id: t.id, p_status: 'failed', p_hash: null, p_explorer: null, p_error: error });
    throw new HttpError(502, error, 'PROVIDER_REJECTED');
  }
});
