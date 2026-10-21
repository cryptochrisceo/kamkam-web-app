'use client';
import type { CSSProperties, ReactNode } from 'react';
import { mediaUrl } from '@/lib/api';
import { initials } from '@/lib/format';
import { avStyle, H, s } from '@/lib/ui';

/** Two-path stroke icon, exactly like the prototype's <svg><path d=icon/><path d=icon2/></svg>. */
export function Icon({ d, d2, size = 18, sw = 2, fill = 'none', style }: { d: string; d2?: string; size?: number; sw?: number; fill?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d={d} />{d2 ? <path d={d2} /> : null}
    </svg>
  );
}

export const I = {
  home: 'M3 10.6 12 3.4l9 7.2V20a1 1 0 0 1-1 1h-5v-6.2H9V21H4a1 1 0 0 1-1-1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', search2: 'M16.6 16.6 21 21',
  bell: 'M6 9a6 6 0 0 1 12 0c0 4.5 1.8 5.8 1.8 5.8H4.2S6 13.5 6 9Z', bell2: 'M10 19a2 2 0 0 0 4 0',
  chat: 'M21 11.8A8.4 8.4 0 0 1 9.3 19.4L4 20.8l1.5-5A8.4 8.4 0 1 1 21 11.8Z',
  bookmark: 'M6.5 4.5A1.5 1.5 0 0 1 8 3h8a1.5 1.5 0 0 1 1.5 1.5V21l-5.5-3.7L6.5 21Z',
  people: 'M9 11a3.4 3.4 0 1 0 0-6.8A3.4 3.4 0 0 0 9 11Z', people2: 'M2.8 20c0-3.4 2.8-5.2 6.2-5.2s6.2 1.8 6.2 5.2M16.5 9.6a2.6 2.6 0 1 0 0-5.2M17.5 14.8c2.6.2 3.9 1.9 3.9 4.4',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H17a2 2 0 0 1 2 2v1', wallet2: 'M3 8.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.5h-4a2 2 0 0 1 0-4h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', user2: 'M4.5 20.5c0-4 3.4-6.4 7.5-6.4s7.5 2.4 7.5 6.4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9', settings2: 'M15 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z',
  plus: 'M12 5v14', plus2: 'M5 12h14',
  close: 'M6 6 18 18', close2: 'M18 6 6 18',
  back: 'm14 5-7 7 7 7',
  check: 'm5 12.5 4.5 4.5L19 7',
  heart: 'M12 20.3 4.8 13.4a4.6 4.6 0 0 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 0 1 6.5 6.5Z',
  comment: 'M20.5 11.8A7.8 7.8 0 0 1 9.6 18.9L4.5 20.2l1.4-4.8A7.8 7.8 0 1 1 20.5 11.8Z',
  flame: 'M12 22c4.4 0 7-2.8 7-6.6 0-3.6-2.4-5.6-3.6-8.6-.5 2.1-1.6 3-2.6 3.6.3-2.6-.8-5.7-3.3-7.4.3 3.2-1.8 4.6-3.2 6.7A8.6 8.6 0 0 0 5 15.4C5 19.2 7.6 22 12 22Z',
  warn: 'M12 3 2.5 20h19L12 3Z', warn2: 'M12 9.5v5M12 17.5v.01',
  up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M18 13l-6 6-6-6',
  chevron: 'm6 10 6 6 6-6',
  next: 'm10 5 7 7-7 7',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z',
};

export function GiftIcon({ size = 17, sw = 2, full = true, style }: { size?: number; sw?: number; full?: boolean; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <rect x="3" y="8" width="18" height="4.5" rx="1.4" />
      <path d="M4.6 12.5h14.8V20a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1z" />
      <path d="M12 8v13" />
      {full && <><path d="M12 8S10.4 3.4 8.3 4.2 8 8 12 8Z" /><path d="M12 8s1.6-4.6 3.7-3.8S16 8 12 8Z" /></>}
    </svg>
  );
}

export function Verified({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#14975C" aria-label="Verified">
      <path d="m12 2 2.2 1.9 2.9-.4 1.1 2.7 2.7 1.1-.4 2.9L22.4 12l-1.9 2.2.4 2.9-2.7 1.1-1.1 2.7-2.9-.4L12 22.4l-2.2-1.9-2.9.4-1.1-2.7-2.7-1.1.4-2.9L1.6 12l1.9-2.2-.4-2.9 2.7-1.1L6.9 3.1l2.9.4Z" />
      <path d="m8.6 12.2 2.3 2.3 4.6-4.7" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Avatar({ user, size, radius, style, onClick }: { user: { displayName: string; avatarColor: string; avatar?: string | null }; size: number; radius?: string; style?: CSSProperties; onClick?: () => void }) {
  const st = { ...avStyle(user.avatarColor, size, radius), ...style, ...(onClick ? { cursor: 'pointer' } : {}) };
  const inner = user.avatar
    ? <img src={mediaUrl(user.avatar)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    : initials(user.displayName);
  return onClick ? <button onClick={onClick} style={st} aria-label={user.displayName}>{inner}</button> : <div style={st}>{inner}</div>;
}

export function CloseBtn({ onClick, style }: { onClick: () => void; style?: CSSProperties }) {
  return (
    <button onClick={onClick} aria-label="Close" className={H.ghost} style={{ ...s('width:34px;height:34px;border-radius:11px;color:#6B7268;display:flex;align-items:center;justify-content:center;flex:none'), ...style }}>
      <Icon d={I.close} d2={I.close2} size={18} sw={2.2} />
    </button>
  );
}

export function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="Back" className={H.ghost} style={s('width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none;color:#3C433A')}>
      <Icon d={I.back} size={18} sw={2.2} />
    </button>
  );
}

/** Modal shell (bottom sheet on mobile) — same geometry as prototype modalStyle. */
export function Modal({ onClose, isMobile, children, label, width = 520, z = 90 }: { onClose: () => void; isMobile: boolean; children: ReactNode; label: string; width?: number; z?: number }) {
  const sheet: CSSProperties = isMobile
    ? s('margin-top:auto;width:100%;background:#fff;border-radius:26px 26px 0 0;padding:20px 18px 26px;max-height:94vh;overflow-y:auto;animation:kkIn .3s cubic-bezier(.2,.9,.3,1)')
    : { ...s('margin:auto;max-width:calc(100% - 32px);background:#fff;border-radius:24px;padding:24px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(16,20,16,.28);animation:kkIn .3s cubic-bezier(.2,.9,.3,1)'), width: width + 'px' };
  return (
    <div style={{ ...s('position:fixed;inset:0;background:rgba(16,20,16,.48);backdrop-filter:blur(3px);display:flex;animation:kkFade .18s ease-out'), zIndex: z }} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

export function Spinner({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', border: `2px solid ${color}`, borderTopColor: 'transparent', animation: 'kkSpin .7s linear infinite', flex: 'none' }} />;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={s('padding:14px;border-radius:16px;background:#FCEFEC;border:1px solid rgba(192,65,47,.3)')} role="alert">
      <div style={s('font-size:14px;font-weight:800;color:#A8331F')}>Something went wrong</div>
      <div style={s('margin-top:5px;font-size:13px;color:#8A3524;line-height:1.55')}>{message}</div>
      {onRetry && <button onClick={onRetry} style={s('margin-top:10px;font-size:13px;font-weight:700;padding:8px 14px;border-radius:99px;border:1px solid rgba(168,51,31,.3);color:#A8331F')}>Try again</button>}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div style={s('background:#fff;border:1px dashed rgba(16,20,16,.14);border-radius:18px;padding:44px 20px;text-align:center')}>
      <div style={s('font-size:15px;font-weight:700')}>{title}</div>
      {body && <div style={s('margin-top:6px;font-size:13.5px;color:#6B7268')}>{body}</div>}
    </div>
  );
}

export function Skeleton({ h = 120, r = 20 }: { h?: number; r?: number }) {
  return <div className="kk-skel" style={{ height: h, borderRadius: r, marginBottom: 14 }} />;
}

export function Tabs({ items, value, onChange, style, inner }: { items: string[]; value: string; onChange: (v: string) => void; style?: CSSProperties; inner?: boolean }) {
  const pillStyle = (on: boolean): CSSProperties => ({ flex: '1 1 auto', whiteSpace: 'nowrap', padding: '9px 14px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 700, color: on ? '#fff' : '#5A6358', background: on ? '#101410' : 'transparent', transition: 'background .16s, color .16s' });
  return (
    <div style={{ ...(inner ? s('display:flex;gap:4px;padding:4px;background:#F1F4F0;border-radius:14px') : s('display:flex;gap:4px;padding:4px;background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:16px;margin-bottom:14px;overflow-x:auto')), ...style }}>
      {items.map(l => <button key={l} onClick={() => onChange(l)} style={pillStyle(value === l)}>{l}</button>)}
    </div>
  );
}

export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} aria-label={label} style={{ width: 46, height: 27, borderRadius: 99, background: on ? '#14975C' : 'rgba(16,20,16,.16)', padding: 3, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none', transition: 'background .18s' }}>
      <span style={{ width: 21, height: 21, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'all .18s' }} />
    </button>
  );
}

/** Small uppercase pill (e.g. "Testnet", "Test mode"). */
export function Badge({ text, title }: { text: string; title?: string }) {
  return <span style={s('font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6B4E8C;background:#F1ECF7;padding:2px 7px;border-radius:99px;white-space:nowrap')} title={title}>{text}</span>;
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div style={s('display:flex;gap:9px;align-items:flex-start;margin-top:12px;padding:12px 14px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3);border-radius:13px')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C98A12" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 1 }}><path d={I.warn} /><path d={I.warn2} /></svg>
      <span style={s('font-size:12.5px;font-weight:700;color:#8A5E08;line-height:1.55')}>{children}</span>
    </div>
  );
}
