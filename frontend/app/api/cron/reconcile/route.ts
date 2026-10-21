import crypto from 'node:crypto';
import { env, features } from '@/lib/server/env';
import { fail, ok } from '@/lib/server/http';
import { svc } from '@/lib/server/supabaseAdmin';
import { settleDeposit, syncCryptoTx, syncWithdrawal } from '@/lib/server/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Candidates = {
  payments: string[];
  withdrawals: { reference: string; transferCode: string | null; createdAt: string }[];
  cryptoTxs: { id: string; network: string; txHash: string | null; status: string; createdAt: string }[];
};

/**
 * Reconciliation job (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * Re-verifies every non-final deposit, payout and crypto send with its provider,
 * and reports any wallet whose buckets don't match its ledger.
 */
export async function GET(req: Request) {
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(env.cronSecret);
  if (!env.cronSecret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(401, 'Unauthorized', 'UNAUTHORIZED');
  if (!features.supabaseAdmin) return fail(503, 'Server not configured', 'SETUP_REQUIRED');

  const c = await svc<Candidates>('svc_reconcile_candidates', {});
  const report = { deposits: 0, withdrawals: 0, cryptoTxs: 0, errors: 0, ledgerMismatches: 0 };

  if (features.payments) {
    for (const ref of c.payments) {
      try { await settleDeposit(ref); report.deposits++; } catch { report.errors++; }
    }
    for (const w of c.withdrawals) {
      try { await syncWithdrawal(w.reference, { failIfUnknownAfterMs: 30 * 60_000, createdAt: w.createdAt }); report.withdrawals++; } catch { report.errors++; }
    }
  }
  for (const t of c.cryptoTxs) {
    try { await syncCryptoTx({ id: t.id, network: t.network, tx_hash: t.txHash, status: t.status, created_at: t.createdAt }); report.cryptoTxs++; }
    catch { report.errors++; }
  }
  const mismatches = await svc<unknown[]>('svc_ledger_check', {});
  report.ledgerMismatches = Array.isArray(mismatches) ? mismatches.length : 0;
  if (report.ledgerMismatches) console.error('[cron:reconcile] ledger mismatches', report.ledgerMismatches);
  return ok(report);
}
