'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { Spinner } from '@/components/ui';
import { s } from '@/lib/ui';

/** Email-confirmation landing. supabase-js (detectSessionInUrl + PKCE) completes the sign-in. */
function CallbackInner() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!supabaseConfigured) { setFailed(true); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; router.replace('/'); } };
    const { data: sub } = supabase().auth.onAuthStateChange((event, session) => { if (session) finish(); });
    supabase().auth.getSession().then(({ data }) => { if (data.session) finish(); });
    const t = setTimeout(() => { if (!done) setFailed(true); }, 5000);
    return () => { clearTimeout(t); sub.subscription.unsubscribe(); };
  }, [router]);
  return (
    <div style={s('min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px 16px;color:#14975C;text-align:center')}>
      {!failed ? <Spinner size={26} /> : (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:24px;padding:24px;max-width:420px;color:#101410')}>
          <h1 style={s('margin:0;font-size:20px;font-weight:800')}>Your email link has expired</h1>
          <p style={s('margin:8px 0 0;font-size:14px;color:#6B7268')}>If you already confirmed your email, just log in.</p>
          <Link href="/login" style={s('display:inline-block;margin-top:14px;font-weight:800')}>Go to log in</Link>
        </div>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return <Suspense><CallbackInner /></Suspense>;
}
