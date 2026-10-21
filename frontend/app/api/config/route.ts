import { features, env } from '@/lib/server/env';
import { NETWORKS } from '@/lib/server/chains';
import { ok } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public feature flags — tells the UI which money features are really wired up. No secrets. */
export async function GET() {
  return ok({
    server: features.supabaseAdmin,
    payments: { enabled: features.payments, provider: 'paystack', mode: features.paystackMode },
    crypto: {
      enabled: features.crypto, provider: 'coinbase-cdp', custody: 'provider-managed', mode: env.cryptoMode,
      networks: NETWORKS().map(n => ({ id: n.id, label: n.label, testnet: n.testnet, color: n.color, assets: n.assets.map(a => a.symbol) })),
    },
    unavailable: {
      swap: 'Swaps are not available yet.',
      buy: 'Buying crypto with Naira is not available yet.',
      sell: 'Selling crypto for Naira is not available yet.',
    },
  });
}
