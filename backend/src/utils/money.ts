import { Prisma } from '@prisma/client';

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const ZERO = D(0);

/** Round NGN to kobo. */
export const ngn = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Round an asset quantity to its display precision, always rounding UP for amounts a user pays. */
export const roundUp = (v: Prisma.Decimal, dp: number) => v.toDecimalPlaces(dp, Prisma.Decimal.ROUND_UP);
export const roundDown = (v: Prisma.Decimal, dp: number) => v.toDecimalPlaces(dp, Prisma.Decimal.ROUND_DOWN);

export const formatNgn = (v: Prisma.Decimal.Value) =>
  '₦' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Parse a user-supplied positive amount. Returns null if invalid. */
export function parseAmount(raw: unknown): Prisma.Decimal | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = D(s);
  if (d.lte(0)) return null;
  return d;
}
