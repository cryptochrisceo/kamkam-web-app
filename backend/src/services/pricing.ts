import { Prisma } from '@prisma/client';
import { AssetSymbol, ASSET_SYMBOLS } from './assets';

/**
 * Price provider abstraction.
 *
 * The MVP ships with DemoPriceProvider (fixed, offline rates). To use live
 * prices later, implement PriceProvider (e.g. backed by an exchange API with
 * caching) and swap it in `priceProvider` below — no other code changes.
 */
export interface PriceProvider {
  readonly source: 'demo' | 'live';
  /** Price of 1 unit of `symbol` in NGN. */
  rateNgn(symbol: AssetSymbol): Promise<Prisma.Decimal>;
  all(): Promise<Record<AssetSymbol, Prisma.Decimal>>;
}

const DEMO_RATES: Record<AssetSymbol, number> = {
  NGN: 1,
  USDT: 1600,
  BNB: 980000,
  ETH: 6200000,
  SOL: 240000,
};

export class DemoPriceProvider implements PriceProvider {
  readonly source = 'demo' as const;
  async rateNgn(symbol: AssetSymbol) {
    return new Prisma.Decimal(DEMO_RATES[symbol]);
  }
  async all() {
    const out = {} as Record<AssetSymbol, Prisma.Decimal>;
    for (const s of ASSET_SYMBOLS) out[s] = new Prisma.Decimal(DEMO_RATES[s]);
    return out;
  }
}

export const priceProvider: PriceProvider = new DemoPriceProvider();
