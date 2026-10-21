import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client. Uses ONLY the public anon/publishable key.
 * All access control is enforced by Row Level Security and trusted
 * Postgres functions in supabase/migrations — never by this code.
 */
export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabaseConfigured = Boolean(SUPABASE_URL && KEY);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error('Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.local.');
  }
  if (!client) {
    client = createClient(SUPABASE_URL, KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    });
  }
  return client;
}
