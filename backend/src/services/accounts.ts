import { TxDirection, TxType } from '@prisma/client';
import { config } from '../config';
import { Tx } from '../utils/prisma';
import { D } from '../utils/money';
import { makeRef } from '../utils/reference';
import { AssetSymbol } from './assets';
import { credit, ensureWallet, recordTx } from './ledger';
import { priceProvider } from './pricing';

/** Clearly-labelled demo credits so a fresh account can try every flow. */
export const STARTER_NGN = 50_000;
export const STARTER_CRYPTO: Partial<Record<AssetSymbol, string>> = { USDT: '100', BNB: '0.25', ETH: '0.05', SOL: '3' };

export async function grantStarter(tx: Tx, userId: string, assets: Partial<Record<AssetSymbol, string>>) {
  if (!config.demoStarterBalances) return;
  const w = await ensureWallet(tx, userId);
  for (const [sym, amt] of Object.entries(assets) as [AssetSymbol, string][]) {
    const amount = D(amt);
    const ref = makeRef('DEP');
    await credit(tx, w.id, sym, amount);
    await tx.deposit.create({ data: { userId, asset: sym, amount, method: 'Demo starter credit', reference: ref } });
    await recordTx(tx, {
      walletId: w.id, userId, type: TxType.DEPOSIT, direction: TxDirection.IN, asset: sym, amount,
      valueNgn: amount.mul(await priceProvider.rateNgn(sym)), reference: ref, network: sym === 'NGN' ? 'Naira' : 'Demo',
      description: 'Demo starter credit (not real money)',
    });
  }
}

const COLORS = ['#2F6F4E', '#B0553C', '#3A5C8C', '#6B4E8C', '#1F6E7A', '#8C6A2F', '#14975C', '#8C3F5C'];
export const colorFor = (s: string) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
