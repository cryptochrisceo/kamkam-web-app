import { formatUnits } from 'viem';
import { env, features } from '@/lib/server/env';
import { HttpError, ok, route } from '@/lib/server/http';
import { requireUser, svc } from '@/lib/server/supabaseAdmin';
import { NETWORKS, readBalance } from '@/lib/server/chains';
import { ngnPrices } from '@/lib/server/prices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Live on-chain balances for the caller's CDP addresses. null = chain unreachable (never a guessed 0). */
export const GET = route('wallet.balances', async (req: Request) => {
  const user = await requireUser(req);
  if (!features.crypto) throw new HttpError(503, 'Crypto wallets are not configured on this server yet.', 'CRYPTO_NOT_CONFIGURED');
  const w = await svc<{ status: string; evm_address: string | null; solana_address: string | null } | null>('svc_crypto_wallet_get', { p_user: user.id });
  if (!w || w.status !== 'ready') throw new HttpError(404, 'Create your crypto wallet first.', 'NO_WALLET');

  const nets = NETWORKS();
  const mainnet = env.cryptoMode === 'mainnet';
  const prices = mainnet ? await ngnPrices(nets.flatMap(n => n.assets.map(a => a.coingeckoId))) : {};

  const networks = await Promise.all(nets.map(async n => {
    const address = (n.family === 'evm' ? w.evm_address : w.solana_address)!;
    const assets = await Promise.all(n.assets.map(async a => {
      const raw = await readBalance(n, a, address);
      const balance = raw === null ? null : formatUnits(raw, a.decimals);
      const price = mainnet ? prices[a.coingeckoId] ?? null : null;
      return { symbol: a.symbol, decimals: a.decimals, balance, priceNgn: price,
        valueNgn: balance !== null && price !== null ? Number(balance) * price : null };
    }));
    return { id: n.id, label: n.label, testnet: n.testnet, color: n.color, address, explorerAddress: n.explorerAddress(address), assets };
  }));
  return ok({ mode: env.cryptoMode, fetchedAt: new Date().toISOString(), networks });
});
