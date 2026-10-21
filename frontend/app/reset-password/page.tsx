'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { AuthForm } from '@/components/AuthForm';
import { Spinner } from '@/components/ui';
import { s } from '@/lib/ui';

/** Landing page of the password-reset email. supabase-js exchanges the link's code for a session. */
function ResetInner() {
  const [state, setState] = useState<'checking' | 'ready' | 'invalid'>('checking');
  useEffect(() => {
    if (!supabaseConfigured) { setState('invalid'); return; }
    let done = false;
    const { data: sub } = supabase().auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') { done = true; setState('ready'); }
    });
    supabase().auth.getSession().then(({ data }) => { if (data.session) { done = true; setState('ready'); } });
    const t = setTimeout(() => { if (!done) setState('invalid'); }, 4000);
    return () => { clearTimeout(t); sub.subscription.unsubscribe(); };
  }, []);
  if (state === 'ready') return <AuthForm mode="reset" />;
  return (
    <div style={s('min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px 16px;color:#14975C;text-align:center')}>
      {state === 'checking' ? <Spinner size={26} /> : (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:24px;padding:24px;max-width:420px;color:#101410')}>
          <h1 style={s('margin:0;font-size:20px;font-weight:800')}>This reset link is invalid or expired</h1>
          <p style={s('margin:8px 0 0;font-size:14px;color:#6B7268')}>Request a new link and use it within the hour.</p>
          <Link href="/forgot-password" style={s('display:inline-block;margin-top:14px;font-weight:800')}>Request a new link</Link>
        </div>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><ResetInner /></Suspense>;
}
