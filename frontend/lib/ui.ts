import type { CSSProperties } from 'react';

/**
 * s('display:flex;gap:10px') → React style object.
 * Lets the components reuse the prototype's inline CSS verbatim so the port
 * stays pixel-identical to kam-kam-ui. Results are cached.
 */
const cache = new Map<string, CSSProperties>();
export function s(css: string): CSSProperties {
  const hit = cache.get(css);
  if (hit) return hit;
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (!k) continue;
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  cache.set(css, out as CSSProperties);
  return out as CSSProperties;
}

/** Merge style objects / css strings. */
export const sx = (...parts: (CSSProperties | string | false | null | undefined)[]): CSSProperties =>
  Object.assign({}, ...parts.filter(Boolean).map(p => (typeof p === 'string' ? s(p) : p)));

// Tailwind hover classes equivalent to the prototype's `style-hover` attributes.
// `!` (important) is needed because base styles are inline.
export const H = {
  ghost: 'hover:bg-[#EEF2EC]!',
  ghostInk: 'hover:bg-[#EEF2EC]! hover:text-[#101410]!',
  soft: 'hover:bg-[#F5F7F4]!',
  green: 'hover:bg-[#0E7546]!',
  greenLift: 'hover:bg-[#0E7546]! hover:-translate-y-px',
  greenLight: 'hover:bg-[#18AC69]!',
  greenTint: 'hover:bg-[#E8F5EE]!',
  chip: 'hover:bg-[#DFF0E7]!',
  gold: 'hover:bg-[#B07A0C]!',
  goldSoft: 'hover:bg-[#F7E6BE]!',
  giftBtn: 'hover:bg-[#F7E6BE]! hover:-translate-y-px',
  like: 'hover:bg-[#FBECEA]!',
  ink: 'hover:bg-[#2A302A]!',
  darkGhost: 'hover:bg-[rgba(255,255,255,.2)]!',
  darkGhost2: 'hover:bg-[rgba(255,255,255,.14)]!',
  outlineGreen: 'hover:border-[#14975C]! hover:text-[#0E7546]!',
  outlineGreenLift: 'hover:border-[#14975C]! hover:text-[#0E7546]! hover:-translate-y-px',
  optionGreen: 'hover:border-[#14975C]! hover:bg-[#F3FAF6]!',
  pollBorder: 'hover:border-[#14975C]!',
  quick: 'hover:border-[#14975C]! hover:text-[#14975C]!',
  row: 'hover:bg-[#F7F9F6]!',
};

export function pill(active: boolean): CSSProperties {
  return { flex: '1 1 auto', whiteSpace: 'nowrap', padding: '9px 14px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 700, color: active ? '#fff' : '#5A6358', background: active ? '#101410' : 'transparent', transition: 'background .16s, color .16s' };
}

export function avStyle(color: string, size: number, radius?: string): CSSProperties {
  return { width: size + 'px', height: size + 'px', borderRadius: radius || '50%', background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.36) + 'px', flex: 'none', overflow: 'hidden' };
}

export const card: CSSProperties = { background: '#fff', border: '1px solid rgba(16,20,16,.08)', borderRadius: '20px', overflow: 'hidden', transition: 'box-shadow .2s' };
export const boostCard: CSSProperties = { ...card, border: '1px solid rgba(201,138,18,.34)', boxShadow: '0 1px 0 rgba(201,138,18,.12)' };
export const act: CSSProperties = { display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 11px', borderRadius: '11px', fontSize: '13px', fontWeight: 700, color: '#6B7268', transition: 'background .15s, color .15s' };

export const dot = (c: string): CSSProperties => ({ width: '9px', height: '9px', borderRadius: '50%', background: c, flex: 'none' });

export const toggleTrack = (on: boolean): CSSProperties => ({ width: '46px', height: '27px', borderRadius: '99px', background: on ? '#14975C' : 'rgba(16,20,16,.16)', padding: '3px', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none', transition: 'background .18s' });
export const toggleKnob: CSSProperties = { width: '21px', height: '21px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'all .18s' };

export const statusStyle = (status: string): CSSProperties => {
  const ok = status === 'COMPLETED' || status === 'SUCCESS', bad = ['FAILED', 'CANCELLED', 'REVERSED', 'ABANDONED', 'DROPPED'].includes(status);
  return { fontSize: '11.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '99px', color: ok ? '#0E7546' : bad ? '#A8331F' : '#8A5E08', background: ok ? '#E8F5EE' : bad ? '#FCEFEC' : '#FCF3E0', whiteSpace: 'nowrap' };
};
export const statusText = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
