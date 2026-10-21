import { Prisma, TxDirection, TxStatus, TxType } from '@prisma/client';
import { Tx } from '../utils/prisma';
import { insufficient, notFound } from '../utils/errors';
import { ASSET_SYMBOLS, AssetSymbol } from './assets';
import { demoAddressesFor } from './chain';

/**
 * Ledger primitives. Every balance change in KAMKAM goes through these
 * functions, always inside a Prisma interactive transaction (`tx`).
 */

export async function ensureWallet(tx: Tx, userId: string) {
  const existing = await tx.wallet.findUnique({ where: { userId } });
  if (existing) return existing;
  const wallet = await tx.wallet.create({
    data: {
      userId,
      demoAddresses: demoAddressesFor(userId),
      assets: { create: ASSET_SYMBOLS.map(symbol => ({ symbol })) },
    },
  });
  return wallet;
}

export async function getWalletOrThrow(tx: Tx, userId: string) {
  const w = await tx.wallet.findUnique({ where: { userId } });
  if (!w) throw notFound('Wallet not found.', 'WALLET_NOT_FOUND');
  return w;
}

export async function balanceOf(tx: Tx, walletId: string, symbol: AssetSymbol) {
  const a = await tx.walletAsset.findUnique({ where: { walletId_symbol: { walletId, symbol } } });
  return a?.balance ?? new Prisma.Decimal(0);
}

export async function credit(tx: Tx, walletId: string, symbol: AssetSymbol, amount: Prisma.Decimal) {
  await tx.walletAsset.upsert({
    where: { walletId_symbol: { walletId, symbol } },
    create: { walletId, symbol, balance: amount },
    update: { balance: { increment: amount } },
  });
}

/**
 * Conditional debit: the UPDATE only matches if balance >= amount, so two
 * concurrent requests can never overdraw the same balance.
 */
export async function debit(tx: Tx, walletId: string, symbol: AssetSymbol, amount: Prisma.Decimal) {
  const r = await tx.walletAsset.updateMany({
    where: { walletId, symbol, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });
  if (r.count !== 1) {
    const have = await balanceOf(tx, walletId, symbol);
    throw insufficient(`Insufficient ${symbol === 'NGN' ? 'Naira' : symbol} balance. You need ${amount.toString()} ${symbol}, you have ${have.toString()} ${symbol}.`);
  }
}

export async function creditEarnings(tx: Tx, walletId: string, amountNgn: Prisma.Decimal) {
  await tx.wallet.update({ where: { id: walletId }, data: { earningsAvailable: { increment: amountNgn } } });
}

export async function debitEarnings(tx: Tx, walletId: string, amountNgn: Prisma.Decimal) {
  const r = await tx.wallet.updateMany({
    where: { id: walletId, earningsAvailable: { gte: amountNgn } },
    data: { earningsAvailable: { decrement: amountNgn } },
  });
  if (r.count !== 1) throw insufficient('Insufficient creator earnings for this withdrawal.');
}

export interface RecordTxInput {
  walletId: string;
  userId: string;
  type: TxType;
  direction: TxDirection;
  asset: string;
  amount: Prisma.Decimal;
  valueNgn: Prisma.Decimal;
  fee?: Prisma.Decimal;
  feeAsset?: string;
  status?: TxStatus;
  reference: string;
  network?: string | null;
  counterparty?: string | null;
  description: string;
  autoSettle?: boolean;
  metadata?: Prisma.InputJsonValue;
}

export function recordTx(tx: Tx, i: RecordTxInput) {
  const status = i.status ?? TxStatus.COMPLETED;
  return tx.walletTransaction.create({
    data: {
      walletId: i.walletId,
      userId: i.userId,
      type: i.type,
      direction: i.direction,
      asset: i.asset,
      amount: i.amount,
      valueNgn: i.valueNgn.toDecimalPlaces(2),
      fee: i.fee ?? 0,
      feeAsset: i.feeAsset,
      status,
      reference: i.reference,
      network: i.network ?? null,
      counterparty: i.counterparty ?? null,
      description: i.description,
      simulated: true,
      autoSettle: i.autoSettle ?? false,
      metadata: i.metadata,
      completedAt: status === TxStatus.COMPLETED ? new Date() : null,
    },
  });
}
