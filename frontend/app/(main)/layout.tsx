'use client';
import { ReactNode, Suspense, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { Shell } from '@/components/Shell';
import { Spinner } from '@/components/ui';

export default function MainLayout({ children }: { children: ReactNode }) {
  const { me, authLoading } = useApp();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!authLoading && !me) router.replace('/login?next=' + encodeURIComponent(path));
  }, [authLoading, me, path, router]);
  if (authLoading || !me) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#14975C' }}><Spinner size={26} /></div>;
  }
  return <Suspense><Shell>{children}</Shell></Suspense>;
}
