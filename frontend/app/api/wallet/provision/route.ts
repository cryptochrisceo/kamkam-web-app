import { env } from '@/lib/server/env';
import { ok, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { accountName, cdp, provisionAccounts } from '@/lib/server/cdp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Wallet = { status: string; evm_address: string | null; solana_address: string | null; network_mode: string; last_error: string | null };
const view = (w: Wallet) => ({ status: w.status, evmAddress: w.evm_address, solanaAddress: w.solana_address, networkMode: w.network_mode, lastError: w.last_error });

/** Create (or fetch) the caller's CDP server accounts on EVM + Solana. Idempotent. */
export const POST = route('wallet.provision', async (req: Request) => {
  const user = await requireUser(req);
  cdp(); // throws 503 CRYPTO_NOT_CONFIGURED before we write anything
  const existing = await svc<Wallet | null>('svc_crypto_wallet_get', { p_user: user.id });
  if (existing?.status === 'ready' && existing.evm_address && existing.solana_address) return ok(view(existing));

  const name = accountName(user.id);
  await svc('svc_crypto_wallet_upsert', { p_user: user.id, p_mode: env.cryptoMode, p_evm_name: name, p_sol_name: name,
    p_evm: null, p_sol: null, p_status: 'provisioning', p_error: null });
  try {
    const acc = await provisionAccounts(user.id);
    const w = await svc<Wallet>('svc_crypto_wallet_upsert', { p_user: user.id, p_mode: env.cryptoMode, p_evm_name: name, p_sol_name: name,
      p_evm: acc.evmAddress, p_sol: acc.solanaAddress, p_status: 'ready', p_error: null });
    return ok(view(w), 201);
  } catch (e) {
    const msg = 'Wallet provider error: ' + String((e as Error)?.message || 'unknown').slice(0, 200);
    const w = await svc<Wallet>('svc_crypto_wallet_upsert', { p_user: user.id, p_mode: env.cryptoMode, p_evm_name: name, p_sol_name: name,
      p_evm: null, p_sol: null, p_status: 'failed', p_error: msg });
    return ok(view(w), 502);
  }
});
