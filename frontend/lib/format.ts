import type { AssetSymbol } from '@/types';

export const money = (n: number | string) => '₦' + Math.round(Number(n)).toLocaleString('en-US');
export const moneyExact = (n: number | string) => '₦' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

const DEC: Record<string, number> = { USDT: 2, USDC: 2, ETH: 6, SOL: 4 };
export function qty(sym: AssetSymbol | string, n: number | string) {
  if (sym === 'NGN') return moneyExact(n);
  const v = Number(n), d = DEC[sym] ?? 4;
  const small = v !== 0 && Math.abs(v) < 10 ** -d * 10;
  const s = small ? Number(v.toPrecision(3)).toString() : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('en-US', { minimumFractionDigits: sym === 'USDT' || sym === 'USDC' ? 2 : 0, maximumFractionDigits: d });
  return s + ' ' + sym;
}

export const shortAddr = (a: string) => (a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a);

export const compact = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);

export function timeAgo(iso: string) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  const d = Math.floor(h / 24); if (d < 7) return d + 'd';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function timeAgoLong(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string) {
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  if (d.toDateString() === now.toDateString()) return 'Today, ' + t;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday, ' + t;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';

export const assetName: Record<string, string> = { NGN: 'Nigerian Naira', USDT: 'Tether USD', USDC: 'USD Coin', ETH: 'Ether', SOL: 'Solana' };
export const assetColor: Record<string, string> = { NGN: '#14975C', USDT: '#1F6E7A', USDC: '#2F5BD6', ETH: '#5B6BD6', SOL: '#3E9E7A' };
export const label = (a: string) => (a === 'NGN' ? 'Naira' : a);
