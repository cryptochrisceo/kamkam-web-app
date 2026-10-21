import { Suspense } from 'react';
import { AuthForm } from '@/components/AuthForm';

export default function ForgotPasswordPage() {
  return <Suspense><AuthForm mode="forgot" /></Suspense>;
}
