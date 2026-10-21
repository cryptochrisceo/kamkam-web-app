import 'server-only';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { env, features } from './env';
import { HttpError, fromDbError } from './http';

let admin: SupabaseClient | null = null;

/** Service-role client. Server only — bypasses RLS, so every call here is deliberate. */
export function adminClient(): SupabaseClient {
  if (!features.supabaseAdmin) throw new HttpError(503, 'Server is not configured (SUPABASE_SERVICE_ROLE_KEY missing).', 'SETUP_REQUIRED');
  if (!admin) admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

/** Verifies the caller's Supabase access token. Never trusts a user id from the request body. */
export async function requireAuth(req: Request): Promise<{ user: User; token: string }> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'You need to log in to do that.', 'UNAUTHENTICATED');
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please log in again.', 'UNAUTHENTICATED');
  return { user: data.user, token };
}
export const requireUser = async (req: Request) => (await requireAuth(req)).user;

/** Client acting AS the caller (anon key + their JWT) — RLS and _uid() apply. */
export function userClient(token: string): SupabaseClient {
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  return createClient(env.supabaseUrl, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export async function userRpc<T>(token: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await userClient(token).rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}

/** Call a service-role SQL function; maps raise_app_error into HttpError. */
export async function svc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await adminClient().rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}
