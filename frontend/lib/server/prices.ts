import 'server-only';
import { env } from './env';

/**
 * Live NGN prices from CoinGecko's public "simple price" endpoint.
 * On any failure we return null for that asset — the UI shows "price unavailable"
 * rather than inventing a fiat value. Testnet assets have no market value.
 */
let cache: { at: number; prices: Record<string, number> } | null = null;

export async function ngnPrices(ids: string[]): Promise<Record<string, number | null>> {
  const unique = [...new Set(ids)];
  if (!cache || Date.now() - cache.at > 60_000 || unique.some(id => !(id in cache!.prices))) {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (env.coingeckoKey) headers['x-cg-demo-api-key'] = env.coingeckoKey;
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${unique.join(',')}&vs_currencies=ngn`,
        { headers, cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = (await res.json()) as Record<string, { ngn?: number }>;
        const prices: Record<string, number> = {};
        for (const [k, v] of Object.entries(json)) if (typeof v?.ngn === 'number') prices[k] = v.ngn;
        cache = { at: Date.now(), prices };
      }
    } catch { /* keep previous cache, if any */ }
  }
  const out: Record<string, number | null> = {};
  for (const id of unique) out[id] = cache && Date.now() - cache.at < 10 * 60_000 ? cache.prices[id] ?? null : null;
  return out;
}
