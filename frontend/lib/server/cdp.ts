import 'server-only';
import { CdpClient } from '@coinbase/cdp-sdk';
import { env, features } from './env';
import { HttpError } from './http';
import type { AssetCfg, NetworkCfg } from './chains';

/**
 * Coinbase Developer Platform (CDP) Server Wallets.
 * Private keys are generated and held inside CDP's secure enclaves (TEE) and are
 * never returned to KAMKAM — we store only the account NAME and public address.
 * Signing requires CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET (server env only).
 */
let client: CdpClient | null = null;
export function cdp(): CdpClient {
  if (!features.crypto) throw new HttpError(503, 'Crypto wallets are not configured on this server yet.', 'CRYPTO_NOT_CONFIGURED');
  if (!client) client = new CdpClient({ apiKeyId: env.cdpApiKeyId, apiKeySecret: env.cdpApiKeySecret, walletSecret: env.cdpWalletSecret });
  return client;
}

/** Deterministic per-user account name (CDP: 2–36 chars, alphanumeric + hyphens). */
export const accountName = (userId: string) => 'kk-' + userId.replace(/-/g, '').toLowerCase();

/** Idempotent: getOrCreateAccount returns the same account for the same name. */
export async function provisionAccounts(userId: string) {
  const name = accountName(userId);
  const c = cdp();
  const [evm, sol] = await Promise.all([
    c.evm.getOrCreateAccount({ name }),
    c.solana.getOrCreateAccount({ name }),
  ]);
  return { name, evmAddress: evm.address as string, solanaAddress: sol.address as string };
}

/**
 * Submit a real transfer signed by CDP. Returns the chain's transaction hash /
 * signature. The caller must still wait for on-chain confirmation.
 */
export async function submitTransfer(userId: string, net: NetworkCfg, asset: AssetCfg, to: string, amountAtomic: bigint): Promise<string> {
  const c = cdp();
  const name = accountName(userId);
  if (net.family === 'evm') {
    const account = await c.evm.getAccount({ name });
    const token = asset.cdpToken as 'eth' | 'usdc' | `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await account.transfer({ to: to as `0x${string}`, amount: amountAtomic, token, network: net.cdpNetwork as any });
    const hash = r?.transactionHash;
    if (typeof hash !== 'string' || !hash) throw new Error('CDP did not return a transaction hash');
    return hash;
  }
  const account = await c.solana.getAccount({ name });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = await account.transfer({ to, amount: amountAtomic, token: asset.cdpToken, network: net.cdpNetwork as 'mainnet' | 'devnet' });
  const sig = r?.signature;
  if (typeof sig !== 'string' || !sig) throw new Error('CDP did not return a transaction signature');
  return sig;
}
