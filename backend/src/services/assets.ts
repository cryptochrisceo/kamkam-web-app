/**
 * Supported assets & networks.
 * Adding an asset later = add it here + give the price provider a rate.
 */

export type AssetSymbol = 'NGN' | 'USDT' | 'BNB' | 'ETH' | 'SOL';

export interface AssetInfo {
  symbol: AssetSymbol;
  name: string;
  /** Internal storage precision for this asset. */
  precision: number;
  crypto: boolean;
  networks: NetworkName[];
}

export type NetworkName = 'Ethereum' | 'BNB Chain' | 'Polygon' | 'Arbitrum' | 'Base' | 'Solana' | 'TRON';

export interface NetworkInfo {
  name: NetworkName;
  family: 'evm' | 'solana' | 'tron';
  /** Simulated flat network fee, expressed in NGN equivalent. */
  feeNgn: number;
}

export const NETWORKS: Record<NetworkName, NetworkInfo> = {
  Ethereum: { name: 'Ethereum', family: 'evm', feeNgn: 1800 },
  'BNB Chain': { name: 'BNB Chain', family: 'evm', feeNgn: 90 },
  Polygon: { name: 'Polygon', family: 'evm', feeNgn: 30 },
  Arbitrum: { name: 'Arbitrum', family: 'evm', feeNgn: 120 },
  Base: { name: 'Base', family: 'evm', feeNgn: 60 },
  Solana: { name: 'Solana', family: 'solana', feeNgn: 15 },
  TRON: { name: 'TRON', family: 'tron', feeNgn: 1700 },
};

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  NGN: { symbol: 'NGN', name: 'Nigerian Naira', precision: 2, crypto: false, networks: [] },
  USDT: { symbol: 'USDT', name: 'Tether USD', precision: 6, crypto: true, networks: ['Ethereum', 'BNB Chain', 'Polygon', 'Arbitrum', 'Base', 'Solana', 'TRON'] },
  BNB: { symbol: 'BNB', name: 'BNB', precision: 8, crypto: true, networks: ['BNB Chain'] },
  ETH: { symbol: 'ETH', name: 'Ethereum', precision: 8, crypto: true, networks: ['Ethereum', 'Arbitrum', 'Base'] },
  SOL: { symbol: 'SOL', name: 'Solana', precision: 8, crypto: true, networks: ['Solana'] },
};

export const ASSET_SYMBOLS = Object.keys(ASSETS) as AssetSymbol[];
export const CRYPTO_SYMBOLS = ASSET_SYMBOLS.filter(s => ASSETS[s].crypto);
export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[];

export const isAsset = (s: unknown): s is AssetSymbol => typeof s === 'string' && s in ASSETS;
export const isNetwork = (s: unknown): s is NetworkName => typeof s === 'string' && s in NETWORKS;

/** Default network used to estimate fees for an asset (e.g. for swaps). */
export const defaultNetwork = (a: AssetSymbol): NetworkName | null => {
  if (a === 'USDT') return 'BNB Chain';
  return ASSETS[a].networks[0] ?? null;
};
