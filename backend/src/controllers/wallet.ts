import type { Request, Response } from 'express';
import { Prisma, TxDirection, TxStatus, TxType, WalletTransaction } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { badRequest, notFound } from '../utils/errors';
import { uid } from '../middleware/auth';
import { D, ngn } from '../utils/money';
import { ASSETS, ASSET_SYMBOLS, AssetSymbol, NETWORKS, NETWORK_NAMES, isNetwork, isAsset } from '../services/assets';
import { priceProvider } from '../services/pricing';
import { chainProvider } from '../services/chain';
import { ensureWallet } from '../services/ledger';
import { execute, getQuote, isAction } from '../services/walletActions';
import { quoteGift, sendGift, CREATOR_SHARE, GIFT_TIERS_NGN } from '../services/gifts';
import { grantStarter, STARTER_CRYPTO } from '../services/accounts';
import { fmtNgn, fmtQty } from '../services/format';
import { authorSelect, postInclude, publicUser, serializePost } from '../services/posts';

function txView(t: WalletTransaction) {
  const sign = t.direction === TxDirection.IN ? '+' : '−';
  return {
    id: t.id, type: t.type, direction: t.direction, asset: t.asset, amount: t.amount.toString(),
    amountLabel: sign + fmtQty(t.asset, t.amount), valueNgn: t.valueNgn.toString(), valueLabel: fmtNgn(t.valueNgn),
    fee: t.fee.toString(), feeLabel: t.fee.gt(0) && t.feeAsset ? fmtQty(t.feeAsset, t.fee) : null,
    status: t.status, reference: t.reference, network: t.network, counterparty: t.counterparty, description: t.description,
    simulated: t.simulated, metadata: t.metadata, createdAt: t.createdAt, completedAt: t.completedAt,
  };
}

export async function getWallet(req: Request, res: Response) {
  const me = uid(req);
  const w = await ensureWallet(prisma, me);
  const [assets, rates, pending] = await Promise.all([
    prisma.walletAsset.findMany({ where: { walletId: w.id } }),
    priceProvider.all(),
    prisma.walletTransaction.aggregate({ where: { userId: me, status: { in: [TxStatus.PENDING, TxStatus.PROCESSING] }, direction: TxDirection.OUT }, _sum: { valueNgn: true } }),
  ]);
  const bySym = new Map(assets.map(a => [a.symbol, a.balance]));
  const list = ASSET_SYMBOLS.map(s => {
    const bal = bySym.get(s) ?? D(0);
    const valueNgn = ngn(bal.mul(rates[s]));
    return {
      symbol: s, name: ASSETS[s].name, crypto: ASSETS[s].crypto, networks: ASSETS[s].networks,
      balance: bal.toString(), balanceLabel: fmtQty(s, bal), valueNgn: valueNgn.toString(), rateNgn: rates[s].toString(),
    };
  });
  const availableNgn = list.reduce((t, a) => t.add(D(a.valueNgn)), D(0));
  const pendingNgn = pending._sum.valueNgn ?? D(0);
  const totalNgn = availableNgn.add(w.earningsAvailable).add(pendingNgn);
  res.json({
    wallet: {
      cryptoActivated: w.cryptoActivated,
      assets: list,
      availableNgn: availableNgn.toString(),
      earningsAvailable: w.earningsAvailable.toString(),
      pendingNgn: pendingNgn.toString(),
      totalNgn: totalNgn.toString(),
      addresses: w.cryptoActivated ? w.demoAddresses : {},
      networks: NETWORK_NAMES.map(n => ({ name: n, family: NETWORKS[n].family, feeNgn: NETWORKS[n].feeNgn })),
      priceSource: priceProvider.source,
      chainMode: chainProvider.mode,
    },
  });
}

/**
 * Marks the crypto wallet as created. The 12-word recovery phrase is generated
 * and verified entirely in the browser; this endpoint receives NO phrase or key.
 */
export async function activate(req: Request, res: Response) {
  const me = uid(req);
  if (req.body && ('phrase' in req.body || 'mnemonic' in req.body || 'privateKey' in req.body)) {
    throw badRequest('Never send a recovery phrase or private key to the server.', 'SECRET_REJECTED');
  }
  await prisma.$transaction(async tx => {
    const w = await ensureWallet(tx, me);
    if (w.cryptoActivated) return;
    await tx.wallet.update({ where: { id: w.id }, data: { cryptoActivated: true } });
    await grantStarter(tx, me, STARTER_CRYPTO);
  });
  return getWallet(req, res);
}

const FILTERS: Record<string, Prisma.WalletTransactionWhereInput> = {
  received: { type: TxType.TRANSFER, direction: TxDirection.IN },
  sent: { type: TxType.TRANSFER, direction: TxDirection.OUT },
  transfers: { type: TxType.TRANSFER },
  swaps: { type: TxType.SWAP },
  gifts: { type: { in: [TxType.GIFT_SENT, TxType.GIFT_RECEIVED] } },
  deposits: { type: TxType.DEPOSIT },
  withdrawals: { type: TxType.WITHDRAWAL },
  buys: { type: TxType.BUY },
  sells: { type: TxType.SELL },
};

export async function listTransactions(req: Request, res: Response) {
  const me = uid(req);
  const f = String(req.query.filter || 'all').toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const rows = await prisma.walletTransaction.findMany({ where: { userId: me, ...(FILTERS[f] ?? {}) }, orderBy: { createdAt: 'desc' }, take: limit });
  res.json({ transactions: rows.map(txView) });
}

export async function getTransaction(req: Request, res: Response) {
  const me = uid(req);
  const rows = await prisma.walletTransaction.findMany({ where: { userId: me, reference: String(req.params.reference) }, orderBy: { createdAt: 'asc' } });
  if (!rows.length) throw notFound('Transaction not found.', 'TX_NOT_FOUND');
  res.json({ reference: req.params.reference, status: rows[0].status, transactions: rows.map(txView) });
}

export async function receiveInfo(req: Request, res: Response) {
  const me = uid(req);
  const w = await ensureWallet(prisma, me);
  if (!w.cryptoActivated) throw badRequest('Create your KAMKAM wallet first.', 'WALLET_NOT_ACTIVATED');
  const network = String(req.query.network || 'BNB Chain');
  const asset = String(req.query.asset || 'USDT');
  if (!isNetwork(network)) throw badRequest('Unknown network.', 'INVALID_NETWORK');
  if (!isAsset(asset) || !ASSETS[asset].networks.includes(network)) throw badRequest(`${asset} is not supported on ${network}.`, 'INVALID_NETWORK');
  const addresses = w.demoAddresses as Record<string, string>;
  res.json({ network, asset, address: addresses[network], demo: true, note: 'Demo address — not derived from a real key. Do not send real funds.' });
}

export async function quote(req: Request, res: Response) {
  const action = String(req.params.action);
  if (!isAction(action)) throw notFound('Unknown wallet action.');
  const q = await getQuote(uid(req), action, req.body);
  const { _, ...pub } = q; void _;
  res.json({ quote: pub });
}

export async function run(req: Request, res: Response) {
  const action = String(req.params.action);
  if (!isAction(action)) throw notFound('Unknown wallet action.');
  const r = await execute(uid(req), action, req.body);
  const { _, ...pub } = r.quote; void _;
  res.status(201).json({ reference: r.reference, status: r.status, quote: pub, simulated: true });
}

export async function rates(_req: Request, res: Response) {
  const r = await priceProvider.all();
  res.json({ source: priceProvider.source, rates: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toString()])) });
}

// ───────────── Gifts ─────────────

export async function giftQuote(req: Request, res: Response) {
  res.json({ quote: await quoteGift(uid(req), req.body) });
}

export async function giftSend(req: Request, res: Response) {
  const me = uid(req);
  const r = await sendGift(me, req.body);
  const post = r.postId ? await prisma.post.findUnique({ where: { id: r.postId }, include: postInclude }) : null;
  res.status(201).json({ gift: r.gift, post: post ? await serializePost(post, me) : null });
}

export async function giftConfig(_req: Request, res: Response) {
  res.json({ tiers: GIFT_TIERS_NGN, creatorShare: CREATOR_SHARE.toString(), platformShare: D(1).sub(CREATOR_SHARE).toString() });
}

export async function listGifts(req: Request, res: Response) {
  const me = uid(req);
  const dir = String(req.query.direction || 'sent');
  const gifts = await prisma.gift.findMany({
    where: dir === 'received' ? { recipientId: me } : { senderId: me },
    include: { sender: { select: authorSelect }, recipient: { select: authorSelect }, post: { select: { id: true, text: true } } },
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  res.json({
    gifts: gifts.map(g => ({
      id: g.id, reference: g.reference, createdAt: g.createdAt,
      amountNgn: g.amountNgn.toString(), valueLabel: fmtNgn(g.amountNgn),
      payAsset: g.payAsset, payLabel: fmtQty(g.payAsset, g.payAmount),
      creatorAmountNgn: g.creatorAmountNgn.toString(), creatorLabel: fmtNgn(g.creatorAmountNgn), platformFeeLabel: fmtNgn(g.platformFeeNgn),
      sender: publicUser(g.sender), recipient: publicUser(g.recipient),
      post: g.post ? { id: g.post.id, text: g.post.text } : null,
      status: 'COMPLETED',
    })),
  });
}

// ───────────── Creator earnings ─────────────

export async function earnings(req: Request, res: Response) {
  const me = uid(req);
  const w = await ensureWallet(prisma, me);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const prevStart = new Date(monthStart); prevStart.setMonth(prevStart.getMonth() - 1);
  const [total, month, prev, count, supporters, byAsset, history, withdrawals] = await Promise.all([
    prisma.creatorEarning.aggregate({ where: { userId: me }, _sum: { amountNgn: true } }),
    prisma.creatorEarning.aggregate({ where: { userId: me, createdAt: { gte: monthStart } }, _sum: { amountNgn: true } }),
    prisma.creatorEarning.aggregate({ where: { userId: me, createdAt: { gte: prevStart, lt: monthStart } }, _sum: { amountNgn: true } }),
    prisma.gift.count({ where: { recipientId: me } }),
    prisma.gift.groupBy({ by: ['senderId'], where: { recipientId: me } }),
    prisma.gift.groupBy({ by: ['payAsset'], where: { recipientId: me }, _sum: { payAmount: true, creatorAmountNgn: true }, _count: { _all: true } }),
    prisma.creatorEarning.findMany({
      where: { userId: me }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { gift: { include: { sender: { select: authorSelect }, post: { select: { id: true, text: true } } } } },
    }),
    prisma.withdrawal.findMany({ where: { userId: me, source: 'EARNINGS' }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  const monthSum = month._sum.amountNgn ?? D(0);
  const prevSum = prev._sum.amountNgn ?? D(0);
  const delta = prevSum.gt(0) ? `${monthSum.sub(prevSum).div(prevSum).mul(100).toDecimalPlaces(0).toString()}% vs last month` : 'This calendar month';
  res.json({
    earnings: {
      availableNgn: w.earningsAvailable.toString(),
      totalEarnedNgn: (total._sum.amountNgn ?? D(0)).toString(),
      thisMonthNgn: monthSum.toString(),
      monthDelta: delta.startsWith('-') ? delta : (prevSum.gt(0) ? '+' + delta : delta),
      totalGifts: count,
      supporters: supporters.length,
      byAsset: byAsset.map(b => ({ asset: b.payAsset as AssetSymbol, count: b._count._all, paidLabel: fmtQty(b.payAsset, b._sum.payAmount ?? 0), creatorNgn: (b._sum.creatorAmountNgn ?? D(0)).toString() })),
      history: history.map(h => ({
        id: h.id, createdAt: h.createdAt, amountNgn: h.amountNgn.toString(), amountLabel: '+' + fmtNgn(h.amountNgn),
        giftLabel: fmtNgn(h.gift.amountNgn), sourceAsset: h.sourceAsset, paidLabel: fmtQty(h.gift.payAsset, h.gift.payAmount),
        from: publicUser(h.gift.sender), post: h.gift.post, reference: h.gift.reference,
      })),
      withdrawals: withdrawals.map(x => ({
        id: x.id, method: x.method, asset: x.asset, amountLabel: fmtQty(x.asset, x.amount), valueLabel: fmtNgn(x.valueNgn),
        status: x.status, reference: x.reference, createdAt: x.createdAt, completedAt: x.completedAt,
      })),
    },
  });
}
