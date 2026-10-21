import { NotificationType, TxDirection, TxStatus, TxType } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../utils/prisma';
import { D } from '../utils/money';
import { AssetSymbol, isAsset } from './assets';
import { credit, ensureWallet, recordTx } from './ledger';
import { notify } from './notifications';
import { fmtQty } from './format';

/**
 * Simulated settlement. Withdrawals, sends and bank payouts are created as
 * PENDING with autoSettle=true. This worker advances them:
 *   PENDING --(SIM_PROCESSING_MS)--> PROCESSING --(SIM_COMPLETE_MS)--> COMPLETED
 * State lives in PostgreSQL, so it survives server restarts.
 *
 * A real integration would replace this with webhooks from a bank / chain indexer.
 */
async function tick() {
  const now = Date.now();

  // PENDING -> PROCESSING
  const pending = await prisma.walletTransaction.findMany({
    where: { autoSettle: true, status: TxStatus.PENDING, updatedAt: { lt: new Date(now - config.simProcessingMs) } },
    select: { id: true, reference: true },
    take: 50,
  });
  for (const t of pending) {
    await prisma.$transaction(async tx => {
      const r = await tx.walletTransaction.updateMany({ where: { id: t.id, status: TxStatus.PENDING }, data: { status: TxStatus.PROCESSING } });
      if (r.count === 0) return;
      await tx.withdrawal.updateMany({ where: { reference: t.reference, status: TxStatus.PENDING }, data: { status: TxStatus.PROCESSING } });
      await tx.sellTransaction.updateMany({ where: { reference: t.reference, status: TxStatus.PENDING }, data: { status: TxStatus.PROCESSING } });
    });
  }

  // PROCESSING -> COMPLETED
  const processing = await prisma.walletTransaction.findMany({
    where: { autoSettle: true, status: TxStatus.PROCESSING, updatedAt: { lt: new Date(now - config.simCompleteMs) } },
    take: 50,
  });
  for (const t of processing) {
    await prisma.$transaction(async tx => {
      const done = new Date();
      const r = await tx.walletTransaction.updateMany({ where: { id: t.id, status: TxStatus.PROCESSING }, data: { status: TxStatus.COMPLETED, completedAt: done } });
      if (r.count === 0) return; // someone else settled it
      const meta = (t.metadata ?? {}) as Record<string, unknown>;

      if (t.type === TxType.WITHDRAWAL) {
        const w = await tx.withdrawal.findUnique({ where: { reference: t.reference } });
        if (w) {
          await tx.withdrawal.update({ where: { id: w.id }, data: { status: TxStatus.COMPLETED, completedAt: done } });
          // Earnings -> KAMKAM wallet: the destination balance is credited on completion.
          if (w.method === 'KAMKAM_WALLET' && isAsset(w.asset)) await credit(tx, t.walletId, w.asset as AssetSymbol, w.amount);
          await notify({
            userId: t.userId, type: NotificationType.WITHDRAWAL_COMPLETED,
            title: 'Withdrawal completed',
            body: `${fmtQty(w.asset, w.amount)} ${w.method === 'BANK' ? 'sent to' : 'delivered to'} ${t.counterparty}. Demo transaction — simulated.`,
            amountLabel: fmtQty(w.asset, w.amount),
          }, tx);
        }
      } else if (t.type === TxType.SELL) {
        await tx.sellTransaction.updateMany({ where: { reference: t.reference }, data: { status: TxStatus.COMPLETED } });
        await notify({ userId: t.userId, type: NotificationType.TRANSACTION_COMPLETED, title: 'Sale payout completed', body: `${String(meta.receive ?? '')} paid out to your bank. Demo transaction — simulated.` }, tx);
      } else if (t.type === TxType.TRANSFER && t.direction === TxDirection.OUT) {
        // Internal delivery when the destination is another KAMKAM demo address
        const rid = meta.internalRecipientId as string | null | undefined;
        if (rid && isAsset(t.asset)) {
          const rw = await ensureWallet(tx, rid);
          await credit(tx, rw.id, t.asset as AssetSymbol, D(t.amount));
          await recordTx(tx, {
            walletId: rw.id, userId: rid, type: TxType.TRANSFER, direction: TxDirection.IN, asset: t.asset, amount: D(t.amount), valueNgn: D(t.valueNgn),
            reference: t.reference, network: t.network, counterparty: '@' + String(meta.sender ?? ''), description: `Received ${t.asset}`,
          });
          await notify({ userId: rid, actorId: t.userId, type: NotificationType.TRANSACTION_COMPLETED, title: `You received ${fmtQty(t.asset, D(t.amount))}`, body: `From @${String(meta.sender ?? '')} on ${t.network}. Demo transaction — simulated.`, amountLabel: '+' + fmtQty(t.asset, D(t.amount)) }, tx);
        }
        await notify({ userId: t.userId, type: NotificationType.TRANSACTION_COMPLETED, title: 'Transaction completed', body: `${fmtQty(t.asset, D(t.amount))} sent on ${t.network}. Demo transaction — nothing was broadcast.` }, tx);
      }
    });
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSettlementWorker() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error('[kamkam] settlement worker error:', (e as Error).message); }
    finally { running = false; }
  }, 1500);
}

export function stopSettlementWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
