import { Prisma } from '@prisma/client';
import { AssetSymbol } from './assets';

/** Display decimals (matches the KAMKAM UI). Storage precision lives in assets.ts. */
export const DISPLAY_DP: Record<AssetSymbol, number> = { NGN: 2, USDT: 2, BNB: 4, ETH: 5, SOL: 3 };

export function fmtNgn(v: Prisma.Decimal.Value) {
  const n = Number(v);
  return '₦' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "0.0020 BNB", "1.25 USDT", "₦2,000". Tiny values keep 3 significant digits. */
export function fmtQty(asset: AssetSymbol | string, v: Prisma.Decimal.Value) {
  if (asset === 'NGN') return fmtNgn(v);
  const d = new Prisma.Decimal(v);
  const dp = DISPLAY_DP[asset as AssetSymbol] ?? 6;
  let s: string;
  if (!d.isZero() && d.abs().lt(new Prisma.Decimal(10).pow(-dp).mul(10))) {
    s = d.toSignificantDigits(3).toFixed();
  } else {
    const n = d.toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    s = n.toLocaleString('en-US', { minimumFractionDigits: asset === 'USDT' ? 2 : 0, maximumFractionDigits: dp });
  }
  return `${s} ${asset}`;
}

export const assetLabel = (a: string) => (a === 'NGN' ? 'Naira' : a);
