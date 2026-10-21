import 'server-only';
import { NextResponse } from 'next/server';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR') { super(message); }
}

export const ok = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });

export const fail = (status: number, message: string, code = 'ERROR') =>
  NextResponse.json({ error: { message, code } }, { status, headers: { 'cache-control': 'no-store' } });

/** Map a Supabase RPC error (raise_app_error → hint = code) to an HttpError. */
export function fromDbError(e: { message?: string; hint?: string | null; code?: string } | null | undefined): HttpError {
  const code = e?.hint || e?.code || 'DB_ERROR';
  const status = code === 'INSUFFICIENT_BALANCE' ? 422 : code === 'RATE_LIMITED' ? 429 : code === 'FORBIDDEN' ? 403
    : code === 'NOT_FOUND' || code === 'USER_NOT_FOUND' ? 404 : e?.code === 'P0001' ? 400 : 500;
  return new HttpError(status, status === 500 ? 'Something went wrong. Please try again.' : String(e?.message || 'Request failed'), code);
}

/** Route wrapper: consistent JSON errors, and logs that never include secrets or bodies. */
export function route<A extends unknown[]>(name: string, fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.code);
      console.error(`[api:${name}]`, (e as Error)?.name, (e as Error)?.message?.slice(0, 300));
      return fail(500, 'Something went wrong. Please try again.', 'INTERNAL');
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, 'Invalid JSON body.', 'BAD_JSON'); }
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
