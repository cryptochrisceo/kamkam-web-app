'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';

export default function MyProfile() {
  const { me } = useApp();
  const router = useRouter();
  useEffect(() => { if (me) router.replace('/profile/' + me.username); }, [me, router]);
  return null;
}
