import 'server-only';
import crypto from 'node:crypto';
import { env } from './env';
import { HttpError } from './http';

/**
 * Minimal Paystack REST client (https://api.paystack.co).
 * Amounts are in kobo (₦1 = 100 kobo). Responses have the shape
 * { status: boolean, message: string, data: … }.
 */
type PsResponse<T> = { status: boolean; message: string; data: T };

export class PaystackError extends HttpError {
  constructor(message: string, public httpStatus: number) { super(httpStatus >= 500 ? 502 : 400, message, 'PAYSTACK'); }
}

async function ps<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(env.paystackBase + path, {
      method,
      headers: { Authorization: `Bearer ${env.paystackSecret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new HttpError(503, 'Payment provider is unreachable. Please try again.', 'PROVIDER_UNAVAILABLE');
  }
  const json = (await res.json().catch(() => null)) as PsResponse<T> | null;
  if (!res.ok || !json?.status) throw new PaystackError(json?.message || `Paystack error (${res.status})`, res.status);
  return json.data;
}

export const toKobo = (naira: number | string) => Math.round(Number(naira) * 100);

// ── Collections ───────────────────────────────────────────────────
export function initializeTransaction(p: { email: string; amountKobo: number; reference: string; callbackUrl: string; channels?: string[]; metadata?: Record<string, unknown> }) {
  return ps<{ authorization_url: string; access_code: string; reference: string }>('POST', '/transaction/initialize', {
    email: p.email, amount: p.amountKobo, currency: 'NGN', reference: p.reference, callback_url: p.callbackUrl,
    channels: p.channels, metadata: p.metadata,
  });
}

export type VerifiedTransaction = {
  status: 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'processing' | 'queued' | 'reversed';
  reference: string; amount: number; currency: string; channel: string | null; paid_at: string | null;
};
export const verifyTransaction = (reference: string) =>
  ps<VerifiedTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

// ── Transfers (payouts) ───────────────────────────────────────────
let bankCache: { at: number; banks: { name: string; code: string }[] } | null = null;
export async function listBanks() {
  if (bankCache && Date.now() - bankCache.at < 6 * 3600_000) return bankCache.banks;
  const data = await ps<{ name: string; code: string; active?: boolean; is_deleted?: boolean }[]>('GET', '/bank?country=nigeria&currency=NGN&perPage=100');
  const banks = data.filter(b => b.active !== false && !b.is_deleted).map(b => ({ name: b.name, code: b.code }));
  bankCache = { at: Date.now(), banks };
  return banks;
}

export const resolveAccount = (accountNumber: string, bankCode: string) =>
  ps<{ account_number: string; account_name: string }>('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);

export const createRecipient = (p: { name: string; accountNumber: string; bankCode: string }) =>
  ps<{ recipient_code: string; details?: { bank_name?: string } }>('POST', '/transferrecipient', {
    type: 'nuban', name: p.name, account_number: p.accountNumber, bank_code: p.bankCode, currency: 'NGN',
  });

export type TransferStatus = 'pending' | 'success' | 'failed' | 'reversed' | 'otp' | 'abandoned' | 'blocked' | 'rejected' | 'received';
export const initiateTransfer = (p: { amountKobo: number; recipient: string; reference: string; reason: string }) =>
  ps<{ status: TransferStatus; transfer_code: string; reference: string }>('POST', '/transfer', {
    source: 'balance', amount: p.amountKobo, recipient: p.recipient, reference: p.reference, reason: p.reason, currency: 'NGN',
  });

export const verifyTransfer = (reference: string) =>
  ps<{ status: TransferStatus; transfer_code: string; reference: string; reason?: string }>('GET', `/transfer/verify/${encodeURIComponent(reference)}`);

// ── Webhooks ──────────────────────────────────────────────────────
/** Paystack signs the RAW body with HMAC-SHA512 using the secret key (header x-paystack-signature). */
export function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !env.paystackSecret) return false;
  const expected = crypto.createHmac('sha512', env.paystackSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Map Paystack transfer status → KAMKAM withdrawal state. */
export function transferState(s: TransferStatus): 'processing' | 'success' | 'failed' | 'reversed' | 'otp' {
  if (s === 'success') return 'success';
  if (s === 'reversed') return 'reversed';
  if (s === 'otp') return 'otp';
  if (s === 'failed' || s === 'abandoned' || s === 'blocked' || s === 'rejected') return 'failed';
  return 'processing';
}

/** Paystack transfer references: 16–50 chars, lowercase letters, digits, '-' and '_'. */
export const newReference = (prefix: 'dep' | 'wdr') => `kk_${prefix}_${crypto.randomBytes(10).toString('hex')}`;
