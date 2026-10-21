'use client';
import { FormEvent, ReactNode, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { supabaseConfigured } from '@/lib/supabase';
import { H, s } from '@/lib/ui';
import { useApp } from './AppProvider';
import { GiftIcon, Spinner } from './ui';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={s('display:block;margin-top:14px')}>
      <span style={s('display:block;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7268')}>{label}</span>
      {children}
    </label>
  );
}
const input = s('margin-top:6px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:13px 14px;outline:none;font-size:15px;font-weight:600;background:#fff');

type Mode = 'login' | 'register' | 'forgot' | 'reset';
const TITLES: Record<Mode, [string, string, string]> = {
  login: ['Welcome back', 'Log in to gift, earn and post.', 'Log in'],
  register: ['Create your account', 'Creators keep 80% of every gift.', 'Create account'],
  forgot: ['Reset your password', 'We will email you a link to choose a new password.', 'Send reset link'],
  reset: ['Choose a new password', 'Use at least 8 characters.', 'Update password'],
};

export function AuthForm({ mode }: { mode: Mode }) {
  const { setMe, refreshMe } = useApp();
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';
  const [f, setF] = useState({ identifier: '', password: '', confirm: '', username: '', displayName: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const go = () => router.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      if (mode === 'login') {
        const r = await api.login({ identifier: f.identifier, password: f.password });
        setMe(r.user); go();
      } else if (mode === 'register') {
        const r = await api.register({ username: f.username, displayName: f.displayName, email: f.email, password: f.password });
        if (r.needsConfirmation) setInfo(`Almost there! We sent a confirmation link to ${f.email.trim()}. Open it to activate your account, then log in.`);
        else { setMe(r.user); go(); }
      } else if (mode === 'forgot') {
        await api.requestPasswordReset(f.email);
        setInfo('If an account exists for that email, a reset link is on its way. Check your inbox.');
      } else {
        if (f.password !== f.confirm) throw new Error('The two passwords do not match.');
        await api.updatePassword(f.password);
        await refreshMe();
        setInfo('Password updated. Taking you to KAMKAM…');
        setTimeout(() => router.replace('/'), 900);
      }
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };

  const [title, sub, cta] = TITLES[mode];
  const done = !!info && (mode === 'register' || mode === 'forgot');
  return (
    <div style={s('min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px 16px;background:#F5F7F4')}>
      <div style={s('width:100%;max-width:420px')}>
        <div style={s('display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:22px')}>
          <div style={s('width:40px;height:40px;border-radius:13px;background:#14975C;display:flex;align-items:center;justify-content:center;color:#fff')}><GiftIcon size={22} sw={2.1} /></div>
          <span style={s('font-family:"Bricolage Grotesque",Manrope,sans-serif;font-weight:800;font-size:26px;letter-spacing:-.03em')}>KAMKAM</span>
        </div>
        <form onSubmit={submit} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:24px;padding:24px;animation:kkIn .3s cubic-bezier(.2,.9,.3,1)')}>
          <h1 style={s('margin:0;font-size:22px;font-weight:800;letter-spacing:-.02em')}>{title}</h1>
          <p style={s('margin:6px 0 4px;font-size:14px;color:#6B7268;line-height:1.55')}>{sub}</p>
          {!supabaseConfigured && <div role="alert" style={s('margin-top:12px;padding:12px 14px;border-radius:13px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3);font-size:13px;font-weight:700;color:#8A5E08')}>KAMKAM is not connected to Supabase yet. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.</div>}
          {!done && <>
            {mode === 'register' && <>
              <Field label="Name"><input style={input} value={f.displayName} onChange={set('displayName')} autoComplete="name" required maxLength={50} /></Field>
              <Field label="Username"><input style={input} value={f.username} onChange={e => setF(x => ({ ...x, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} autoComplete="username" required minLength={3} maxLength={20} placeholder="letters, numbers, _" /></Field>
            </>}
            {(mode === 'register' || mode === 'forgot') && <Field label="Email"><input style={input} type="email" value={f.email} onChange={set('email')} autoComplete="email" required autoFocus={mode === 'forgot'} /></Field>}
            {mode === 'login' && <Field label="Email"><input style={input} type="email" value={f.identifier} onChange={set('identifier')} autoComplete="email" required autoFocus /></Field>}
            {mode !== 'forgot' && <Field label={mode === 'reset' ? 'New password' : 'Password'}><input style={input} type="password" value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 8} /></Field>}
            {mode === 'reset' && <Field label="Confirm new password"><input style={input} type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required minLength={8} /></Field>}
            {mode === 'login' && <div style={s('margin-top:10px;text-align:right')}><Link href="/forgot-password" style={s('font-size:13px;font-weight:700')}>Forgot password?</Link></div>}
          </>}
          {err && <div role="alert" style={s('margin-top:14px;padding:12px 14px;border-radius:13px;background:#FCEFEC;border:1px solid rgba(192,65,47,.3);font-size:13.5px;font-weight:700;color:#A8331F')}>{err}</div>}
          {info && <div role="status" style={s('margin-top:14px;padding:12px 14px;border-radius:13px;background:#E8F5EE;border:1px solid rgba(20,151,92,.25);font-size:13.5px;font-weight:700;color:#0E7546;line-height:1.55')}>{info}</div>}
          {!done && (
            <button type="submit" disabled={busy || !supabaseConfigured} className={H.green} style={s('margin-top:18px;width:100%;background:#14975C;color:#fff;font-weight:800;font-size:15px;padding:15px;border-radius:15px;display:flex;align-items:center;justify-content:center;gap:9px')}>
              {busy && <Spinner size={16} color="#fff" />}{cta}
            </button>
          )}
          <p style={s('margin:16px 0 0;text-align:center;font-size:13.5px;color:#6B7268')}>
            {mode === 'login' && <>New to KAMKAM? <Link href="/register" style={s('font-weight:700')}>Create an account</Link></>}
            {mode === 'register' && <>Already have an account? <Link href="/login" style={s('font-weight:700')}>Log in</Link></>}
            {(mode === 'forgot' || mode === 'reset') && <Link href="/login" style={s('font-weight:700')}>Back to log in</Link>}
          </p>
        </form>
        {mode === 'login' && process.env.NEXT_PUBLIC_SHOW_DEMO_LOGIN === 'true' && (
          <div style={s('margin-top:14px;padding:13px 15px;border-radius:16px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3);font-size:13px;color:#8A5E08;line-height:1.6;font-weight:600')}>
            <b>Demo account:</b> amaka@kamkam.demo · password123
            <button type="button" onClick={() => setF(x => ({ ...x, identifier: 'amaka@kamkam.demo', password: 'password123' }))} style={s('margin-left:8px;font-weight:800;color:#14975C')}>Fill in</button>
          </div>
        )}
      </div>
    </div>
  );
}
