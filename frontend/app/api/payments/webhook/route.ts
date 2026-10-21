import { features } from '@/lib/server/env';
import { fail, ok } from '@/lib/server/http';
import { svc } from '@/lib/server/supabaseAdmin';
import { verifySignature } from '@/lib/server/paystack';
import { settleDeposit, syncWithdrawal } from '@/lib/server/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Event = { event?: string; data?: { id?: number | string; reference?: string; transfer_code?: string } };

/**
 * Paystack webhook. Steps:
 *  1. verify x-paystack-signature (HMAC-SHA512 of the raw body) — reject otherwise
 *  2. never trust the payload's amount/status: re-fetch the transaction/transfer from Paystack
 *  3. settle idempotently (duplicate deliveries are no-ops)
 * A non-2xx response makes Paystack retry, so we only return 500 when processing failed.
 */
export async function POST(req: Request) {
  if (!features.payments) return fail(503, 'Payments not configured', 'PAYMENTS_NOT_CONFIGURED');
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get('x-paystack-signature'))) return fail(401, 'Invalid signature', 'BAD_SIGNATURE');

  let evt: Event;
  try { evt = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON', 'BAD_JSON'); }
  const event = String(evt.event || '');
  const reference = evt.data?.reference ? String(evt.data.reference) : '';

  try {
    if (event === 'charge.success' && reference) {
      await settleDeposit(reference);
    } else if ((event === 'transfer.success' || event === 'transfer.failed' || event === 'transfer.reversed') && reference) {
      await syncWithdrawal(reference);
    }
    const key = `${event}:${evt.data?.id ?? reference}:${reference}`;
    await svc('svc_webhook_seen', { p_provider: 'paystack', p_event: event || 'unknown', p_key: key, p_reference: reference || null });
    return ok({ received: true });
  } catch (e) {
    console.error('[api:payments.webhook]', event, (e as Error)?.message?.slice(0, 200));
    return fail(500, 'Processing failed', 'RETRY');
  }
}
