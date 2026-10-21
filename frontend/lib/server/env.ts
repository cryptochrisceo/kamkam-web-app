import 'server-only';

/**
 * Server-side configuration. Secrets are read ONLY here and never sent to the
 * browser (no NEXT_PUBLIC_ prefix). Features switch on only when every secret
 * they need is present — otherwise the UI shows "setup required".
 */
const v = (k: string) => (process.env[k] || '').trim();

export const env = {
  supabaseUrl: v('NEXT_PUBLIC_SUPABASE_URL'),
  serviceRoleKey: v('SUPABASE_SERVICE_ROLE_KEY'),
  appUrl: v('APP_URL').replace(/\/$/, ''),

  paystackSecret: v('PAYSTACK_SECRET_KEY'),
  paystackBase: (v('PAYSTACK_BASE_URL') || 'https://api.paystack.co').replace(/\/$/, ''),

  cdpApiKeyId: v('CDP_API_KEY_ID'),
  cdpApiKeySecret: v('CDP_API_KEY_SECRET'),
  cdpWalletSecret: v('CDP_WALLET_SECRET'),
  cryptoMode: (v('CRYPTO_NETWORK_MODE') === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet',
  rpc: {
    ethereum: v('ETHEREUM_RPC_URL'),
    base: v('BASE_RPC_URL'),
    solana: v('SOLANA_RPC_URL'),
  },
  coingeckoKey: v('COINGECKO_API_KEY'),
  cronSecret: v('CRON_SECRET'),
};

export const features = {
  supabaseAdmin: Boolean(env.supabaseUrl && env.serviceRoleKey),
  get payments() { return this.supabaseAdmin && Boolean(env.paystackSecret); },
  get crypto() { return this.supabaseAdmin && Boolean(env.cdpApiKeyId && env.cdpApiKeySecret && env.cdpWalletSecret); },
  paystackMode: env.paystackSecret.startsWith('sk_live_') ? 'live' : env.paystackSecret ? 'test' : 'off',
};
