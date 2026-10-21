import {
  Prisma, SellReceiveMethod, TxDirection, TxStatus, TxType, WithdrawalMethod, WithdrawalSource, NotificationType,
} from '@prisma/client';
import { prisma, Tx } from '../utils/prisma';
import { badRequest, insufficient, notFound } from '../utils/errors';
import { D, ngn, parseAmount, roundDown, roundUp, ZERO } from '../utils/money';
import { makeRef } from '../utils/reference';
import { parse, z } from '../utils/validate';
import { ASSETS, AssetSymbol, CRYPTO_SYMBOLS, ASSET_SYMBOLS, NETWORKS, NetworkName, NETWORK_NAMES, defaultNetwork } from './assets';
import { priceProvider } from './pricing';
import { chainProvider } from './chain';
import { balanceOf, credit, debit, debitEarnings, ensureWallet, recordTx } from './ledger';
import { notify } from './notifications';
import { assetLabel, fmtNgn, fmtQty } from './format';

// ───────────── Fee schedule (demo) ─────────────
export const FEES = {
  buyPct: D('0.015'),
  sellPct: D('0.01'),
  swapPct: D('0.005'),
  bankWithdrawNgn: D(50),
  maxTxNgn: D(50_000_000),
  minNgn: D(100),
};

// ───────────── Shared types ─────────────
export interface Row { k: string; v: string; tone?: 'strong' | 'green' | 'gold' | 'muted' }

export interface Quote {
  action: ActionName;
  /** What leaves the user: from a wallet asset, creator earnings, or an external (simulated) payment. */
  debit: { source: 'WALLET' | 'EARNINGS' | 'EXTERNAL'; asset: AssetSymbol; amount: string; label: string };
  receive: { asset: AssetSymbol; amount: string; label: string } | null;
  valueNgn: string;
  rows: Row[];
  available: string;
  availableLabel: string;
  sufficient: boolean;
  status: 'COMPLETED' | 'PENDING';
  warnings: string[];
  simulated: true;
  /** Internal data used by execute(); not user-facing. */
  _: Record<string, unknown>;
}

export type ActionName = 'buy' | 'sell' | 'swap' | 'send' | 'transfer' | 'deposit' | 'withdraw';

const amountField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const d = parseAmount(v);
  if (!d) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid amount greater than 0' }); return z.NEVER; }
  return d;
});
const assetEnum = z.enum(ASSET_SYMBOLS as [AssetSymbol, ...AssetSymbol[]]);
const cryptoEnum = z.enum(CRYPTO_SYMBOLS as [AssetSymbol, ...AssetSymbol[]]);
const networkEnum = z.enum(NETWORK_NAMES as [NetworkName, ...NetworkName[]]);
const bankFields = {
  bankName: z.string().trim().min(2, 'Enter a bank name').max(80).optional(),
  accountNumber: z.string().trim().regex(/^\d{10}$/, 'Account number must be 10 digits').optional(),
  accountName: z.string().trim().min(2, 'Enter the account name').max(80).optional(),
};

export const schemas = {
  buy: z.object({ asset: cryptoEnum, amountNgn: amountField, payWith: z.union([z.literal('CARD'), assetEnum]) }),
  sell: z.object({
    asset: cryptoEnum, amount: amountField,
    receiveMethod: z.nativeEnum(SellReceiveMethod), receiveAsset: cryptoEnum.optional(), ...bankFields,
  }),
  swap: z.object({ from: cryptoEnum, to: cryptoEnum, amount: amountField }),
  send: z.object({ asset: cryptoEnum, network: networkEnum, address: z.string().trim().min(1, 'Enter a recipient address').max(120), amount: amountField }),
  transfer: z.object({ asset: assetEnum, toUsername: z.string().trim().min(1, 'Enter a username').max(40), amount: amountField, note: z.string().max(140).optional() }),
  deposit: z.object({ amount: amountField, method: z.enum(['Bank card', 'Paystack', 'Bank transfer']) }),
  withdraw: z.object({
    source: z.nativeEnum(WithdrawalSource), method: z.nativeEnum(WithdrawalMethod), asset: assetEnum, amount: amountField,
    network: networkEnum.optional(), address: z.string().trim().max(120).optional(), ...bankFields,
  }),
};

type In<A extends ActionName> = z.infer<(typeof schemas)[A]>;

const prec = (a: AssetSymbol) => ASSETS[a].precision;
const rate = (a: AssetSymbol) => priceProvider.rateNgn(a);
const rateRow = (a: AssetSymbol, r: Prisma.Decimal): Row => ({ k: 'Exchange rate', v: `1 ${a} ≈ ${fmtNgn(r)}` });
const demoRow: Row = { k: 'Settlement', v: 'Demo transaction · simulated', tone: 'muted' };

function capValue(valueNgn: Prisma.Decimal) {
  if (valueNgn.gt(FEES.maxTxNgn)) throw badRequest(`Amount is too large for this demo (max ${fmtNgn(FEES.maxTxNgn)}).`, 'INVALID_AMOUNT');
}

async function walletCtx(db: Tx, userId: string) {
  const wallet = await ensureWallet(db, userId);
  return wallet;
}

function requireCrypto(activated: boolean) {
  if (!activated) throw badRequest('Create your KAMKAM wallet first to use crypto assets.', 'WALLET_NOT_ACTIVATED');
}

function networkFeeIn(asset: AssetSymbol, network: NetworkName, r: Prisma.Decimal) {
  return roundUp(D(NETWORKS[network].feeNgn).div(r), prec(asset));
}

function validateAddress(network: NetworkName, address: string) {
  if (!chainProvider.validateAddress(network, address)) {
    const hint = NETWORKS[network].family === 'evm' ? 'a 0x… address (42 characters)' : NETWORKS[network].family === 'solana' ? 'a Solana base58 address' : 'a TRON address starting with T';
    throw badRequest(`Invalid ${network} address. Expected ${hint}.`, 'INVALID_ADDRESS');
  }
}

const mask = (acct?: string) => (acct ? '••••' + acct.slice(-4) : '');

async function findInternalRecipient(db: Tx, network: NetworkName, address: string) {
  const w = await db.wallet.findFirst({
    where: { demoAddresses: { path: [network], equals: address } },
    select: { userId: true, user: { select: { username: true } } },
  });
  return w ? { userId: w.userId, username: w.user.username } : null;
}

// ───────────── Quotes ─────────────

async function quoteBuy(db: Tx, userId: string, i: In<'buy'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  requireCrypto(w.cryptoActivated);
  const amountNgn = ngn(i.amountNgn);
  if (amountNgn.lt(FEES.minNgn)) throw badRequest(`Minimum purchase is ${fmtNgn(FEES.minNgn)}.`, 'INVALID_AMOUNT');
  capValue(amountNgn);
  if (i.payWith === i.asset) throw badRequest('Choose a different asset to pay with.', 'INVALID_ASSET');
  const rA = await rate(i.asset);
  const fee = ngn(amountNgn.mul(FEES.buyPct));
  const receive = roundDown(amountNgn.sub(fee).div(rA), prec(i.asset));

  let debitAsset: AssetSymbol = 'NGN', payAmount = amountNgn, source: Quote['debit']['source'] = 'EXTERNAL';
  let available = ZERO, sufficient = true, payLabel = 'Naira · card / bank (simulated)';
  const rows: Row[] = [
    { k: 'You buy', v: fmtQty(i.asset, receive), tone: 'green' },
    { k: 'Amount', v: fmtNgn(amountNgn), tone: 'strong' },
    rateRow(i.asset, rA),
  ];
  if (i.payWith !== 'CARD') {
    debitAsset = i.payWith;
    source = 'WALLET';
    if (ASSETS[debitAsset].crypto) requireCrypto(w.cryptoActivated);
    const rP = await rate(debitAsset);
    payAmount = debitAsset === 'NGN' ? amountNgn : roundUp(amountNgn.div(rP), prec(debitAsset));
    available = await balanceOf(db, w.id, debitAsset);
    sufficient = available.gte(payAmount);
    payLabel = debitAsset === 'NGN' ? 'Naira wallet balance' : `${debitAsset} wallet balance`;
    if (debitAsset !== 'NGN') rows.push({ k: `${debitAsset} rate`, v: `1 ${debitAsset} ≈ ${fmtNgn(rP)}` });
  }
  rows.push(
    { k: 'Pay with', v: payLabel },
    { k: debitAsset === 'NGN' ? 'You pay' : 'Estimated cost', v: fmtQty(debitAsset, payAmount), tone: 'gold' },
    { k: `Fee (${FEES.buyPct.mul(100)}%)`, v: fmtNgn(fee) },
    demoRow,
  );
  return {
    action: 'buy', debit: { source, asset: debitAsset, amount: payAmount.toString(), label: fmtQty(debitAsset, payAmount) },
    receive: { asset: i.asset, amount: receive.toString(), label: fmtQty(i.asset, receive) },
    valueNgn: amountNgn.toString(), rows, available: available.toString(),
    availableLabel: source === 'EXTERNAL' ? 'Paid externally' : fmtQty(debitAsset, available),
    sufficient, status: 'COMPLETED', warnings: [], simulated: true,
    _: { fee: fee.toString(), rA: rA.toString(), payMethod: i.payWith === 'CARD' ? 'Naira (card/bank)' : `${debitAsset} balance` },
  };
}

async function quoteSell(db: Tx, userId: string, i: In<'sell'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  requireCrypto(w.cryptoActivated);
  const amount = roundDown(i.amount, prec(i.asset));
  if (amount.lte(0)) throw badRequest('Amount is too small.', 'INVALID_AMOUNT');
  const rA = await rate(i.asset);
  const valueNgn = ngn(amount.mul(rA));
  capValue(valueNgn);
  const fee = ngn(valueNgn.mul(FEES.sellPct));
  const netNgn = valueNgn.sub(fee);
  if (netNgn.lte(0)) throw badRequest('Amount is too small to cover the fee.', 'INVALID_AMOUNT');
  const available = await balanceOf(db, w.id, i.asset);

  let receiveAsset: AssetSymbol = 'NGN', receiveAmount = netNgn, dest = 'Naira balance', status: Quote['status'] = 'COMPLETED';
  if (i.receiveMethod === 'WALLET_ASSET') {
    if (!i.receiveAsset || i.receiveAsset === i.asset) throw badRequest('Choose a different asset to receive.', 'INVALID_ASSET');
    receiveAsset = i.receiveAsset;
    receiveAmount = roundDown(netNgn.div(await rate(receiveAsset)), prec(receiveAsset));
    dest = `${receiveAsset} wallet balance`;
  } else if (i.receiveMethod === 'BANK') {
    if (!i.bankName || !i.accountNumber || !i.accountName) throw badRequest('Enter bank, account number and account name.', 'BANK_DETAILS');
    dest = `${i.bankName} ${mask(i.accountNumber)}`;
    status = 'PENDING';
  }
  const rows: Row[] = [
    { k: 'Selling', v: fmtQty(i.asset, amount), tone: 'strong' },
    rateRow(i.asset, rA),
    { k: 'Estimated value', v: fmtNgn(valueNgn) },
    { k: `Fee (${FEES.sellPct.mul(100)}%)`, v: fmtNgn(fee) },
    { k: 'You receive', v: fmtQty(receiveAsset, receiveAmount), tone: 'green' },
    { k: 'Destination', v: dest },
    demoRow,
  ];
  return {
    action: 'sell', debit: { source: 'WALLET', asset: i.asset, amount: amount.toString(), label: fmtQty(i.asset, amount) },
    receive: { asset: receiveAsset, amount: receiveAmount.toString(), label: fmtQty(receiveAsset, receiveAmount) },
    valueNgn: valueNgn.toString(), rows, available: available.toString(), availableLabel: fmtQty(i.asset, available),
    sufficient: available.gte(amount), status, warnings: i.receiveMethod === 'BANK' ? ['Bank payouts are simulated — no real bank transfer happens.'] : [],
    simulated: true, _: { fee: fee.toString(), rA: rA.toString(), dest },
  };
}

async function quoteSwap(db: Tx, userId: string, i: In<'swap'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  requireCrypto(w.cryptoActivated);
  if (i.from === i.to) throw badRequest('Choose two different assets.', 'INVALID_ASSET');
  const amount = roundDown(i.amount, prec(i.from));
  const [rF, rT] = await Promise.all([rate(i.from), rate(i.to)]);
  const valueNgn = ngn(amount.mul(rF));
  capValue(valueNgn);
  const net = defaultNetwork(i.from) as NetworkName;
  const netFeeNgn = D(NETWORKS[net].feeNgn);
  const platFeeNgn = ngn(valueNgn.mul(FEES.swapPct));
  const outNgn = valueNgn.sub(netFeeNgn).sub(platFeeNgn);
  if (outNgn.lte(0)) throw badRequest('Amount is too small to cover swap fees.', 'INVALID_AMOUNT');
  const receive = roundDown(outNgn.div(rT), prec(i.to));
  const available = await balanceOf(db, w.id, i.from);
  const netFeeFrom = roundUp(netFeeNgn.div(rF), prec(i.from));
  const platFeeFrom = roundUp(platFeeNgn.div(rF), prec(i.from));
  const cross = rF.div(rT);
  const rows: Row[] = [
    { k: 'From', v: fmtQty(i.from, amount), tone: 'strong' },
    { k: 'To', v: i.to },
    { k: 'Estimated receive', v: fmtQty(i.to, receive), tone: 'green' },
    { k: 'Exchange rate', v: `1 ${i.from} ≈ ${fmtQty(i.to, cross)}` },
    { k: 'Network fee', v: `${fmtQty(i.from, netFeeFrom)} (${net})` },
    { k: `Platform fee (${FEES.swapPct.mul(100)}%)`, v: fmtQty(i.from, platFeeFrom) },
    demoRow,
  ];
  return {
    action: 'swap', debit: { source: 'WALLET', asset: i.from, amount: amount.toString(), label: fmtQty(i.from, amount) },
    receive: { asset: i.to, amount: receive.toString(), label: fmtQty(i.to, receive) },
    valueNgn: valueNgn.toString(), rows, available: available.toString(), availableLabel: fmtQty(i.from, available),
    sufficient: available.gte(amount), status: 'COMPLETED', warnings: [], simulated: true,
    _: { rate: cross.toString(), netFee: netFeeFrom.toString(), platFee: platFeeFrom.toString(), platFeeNgn: platFeeNgn.toString(), network: net },
  };
}

async function quoteSend(db: Tx, userId: string, i: In<'send'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  requireCrypto(w.cryptoActivated);
  if (!ASSETS[i.asset].networks.includes(i.network)) throw badRequest(`${i.asset} is not supported on ${i.network}.`, 'INVALID_NETWORK');
  validateAddress(i.network, i.address);
  const amount = roundDown(i.amount, prec(i.asset));
  const rA = await rate(i.asset);
  const valueNgn = ngn(amount.mul(rA));
  capValue(valueNgn);
  const fee = networkFeeIn(i.asset, i.network, rA);
  const total = amount.add(fee);
  const available = await balanceOf(db, w.id, i.asset);
  const internal = await findInternalRecipient(db, i.network, i.address);
  if (internal?.userId === userId) throw badRequest('That is your own address.', 'INVALID_ADDRESS');
  const rows: Row[] = [
    { k: 'Asset', v: i.asset }, { k: 'Network', v: i.network },
    { k: 'Recipient', v: i.address.slice(0, 10) + '…' + i.address.slice(-4) + (internal ? ` (@${internal.username})` : '') },
    { k: 'Amount', v: fmtQty(i.asset, amount), tone: 'strong' },
    { k: 'Network fee', v: '≈ ' + fmtQty(i.asset, fee) },
    { k: 'Total deducted', v: fmtQty(i.asset, total), tone: 'gold' },
    demoRow,
  ];
  return {
    action: 'send', debit: { source: 'WALLET', asset: i.asset, amount: total.toString(), label: fmtQty(i.asset, total) },
    receive: { asset: i.asset, amount: amount.toString(), label: fmtQty(i.asset, amount) },
    valueNgn: valueNgn.toString(), rows, available: available.toString(), availableLabel: fmtQty(i.asset, available),
    sufficient: available.gte(total), status: 'PENDING',
    warnings: [
      `Make sure you are sending ${i.asset} on ${i.network}. Assets sent on the wrong network cannot be recovered.`,
      internal ? `This is a KAMKAM demo address — it will settle internally to @${internal.username}.` : 'Demo transaction: nothing is broadcast to a real blockchain.',
    ],
    simulated: true, _: { fee: fee.toString(), amount: amount.toString(), internal },
  };
}

async function quoteTransfer(db: Tx, userId: string, i: In<'transfer'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  if (ASSETS[i.asset].crypto) requireCrypto(w.cryptoActivated);
  const uname = i.toUsername.replace(/^@/, '').toLowerCase();
  const to = await db.user.findUnique({ where: { username: uname }, select: { id: true, username: true, displayName: true } });
  if (!to) throw notFound(`No KAMKAM user @${uname}.`, 'USER_NOT_FOUND');
  if (to.id === userId) throw badRequest('You cannot transfer to yourself.', 'INVALID_RECIPIENT');
  const amount = roundDown(i.amount, prec(i.asset));
  const valueNgn = ngn(amount.mul(await rate(i.asset)));
  capValue(valueNgn);
  const available = await balanceOf(db, w.id, i.asset);
  return {
    action: 'transfer', debit: { source: 'WALLET', asset: i.asset, amount: amount.toString(), label: fmtQty(i.asset, amount) },
    receive: { asset: i.asset, amount: amount.toString(), label: fmtQty(i.asset, amount) },
    valueNgn: valueNgn.toString(), available: available.toString(), availableLabel: fmtQty(i.asset, available),
    rows: [
      { k: 'To', v: `${to.displayName} (@${to.username})` },
      { k: 'Amount', v: fmtQty(i.asset, amount), tone: 'strong' },
      { k: 'Value', v: fmtNgn(valueNgn) },
      { k: 'Fee', v: 'Free · KAMKAM to KAMKAM' },
      { k: 'Arrives', v: 'Instantly' },
    ],
    sufficient: available.gte(amount), status: 'COMPLETED', warnings: [], simulated: true, _: { to },
  };
}

async function quoteDeposit(db: Tx, userId: string, i: In<'deposit'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  const amount = ngn(i.amount);
  if (amount.lt(FEES.minNgn)) throw badRequest(`Minimum deposit is ${fmtNgn(FEES.minNgn)}.`, 'INVALID_AMOUNT');
  if (amount.gt(5_000_000)) throw badRequest('Maximum demo deposit is ₦5,000,000.', 'INVALID_AMOUNT');
  const available = await balanceOf(db, w.id, 'NGN');
  return {
    action: 'deposit', debit: { source: 'EXTERNAL', asset: 'NGN', amount: amount.toString(), label: fmtNgn(amount) },
    receive: { asset: 'NGN', amount: amount.toString(), label: fmtNgn(amount) },
    valueNgn: amount.toString(), available: available.toString(), availableLabel: fmtNgn(available),
    rows: [
      { k: 'Amount', v: fmtNgn(amount), tone: 'strong' },
      { k: 'Payment method', v: i.method },
      { k: 'Fee', v: '₦0' },
      { k: 'New Naira balance', v: fmtNgn(available.add(amount)), tone: 'green' },
      demoRow,
    ],
    sufficient: true, status: 'COMPLETED', warnings: ['Demo only — no real payment is processed.'], simulated: true, _: {},
  };
}

async function quoteWithdraw(db: Tx, userId: string, i: In<'withdraw'>): Promise<Quote> {
  const w = await walletCtx(db, userId);
  const fromEarnings = i.source === 'EARNINGS';
  let debitAsset: AssetSymbol, debitAmount: Prisma.Decimal, receiveAsset: AssetSymbol, receiveAmount: Prisma.Decimal;
  let fee = ZERO, feeAsset: AssetSymbol = 'NGN', dest = '', network: NetworkName | null = null;
  const rows: Row[] = [];

  if (i.method === 'KAMKAM_WALLET' && !fromEarnings) throw badRequest('Wallet balances are already in your KAMKAM wallet.', 'INVALID_METHOD');
  if (i.method === 'BANK' && i.asset !== 'NGN') throw badRequest('Bank withdrawals are in Naira. Sell crypto first or choose another method.', 'INVALID_ASSET');
  if (i.method === 'EXTERNAL_WALLET' && !ASSETS[i.asset].crypto) throw badRequest('Choose a crypto asset for external wallet withdrawals.', 'INVALID_ASSET');
  if (ASSETS[i.asset].crypto) requireCrypto(w.cryptoActivated);

  const available = fromEarnings ? w.earningsAvailable : await balanceOf(db, w.id, i.asset);

  if (fromEarnings) {
    debitAsset = 'NGN';
    debitAmount = ngn(i.amount);
    if (debitAmount.lt(FEES.minNgn)) throw badRequest(`Minimum withdrawal is ${fmtNgn(FEES.minNgn)}.`, 'INVALID_AMOUNT');
  } else {
    debitAsset = i.asset;
    debitAmount = roundDown(i.amount, prec(i.asset));
  }
  const rA = await rate(i.asset);
  const valueNgn = fromEarnings ? debitAmount : ngn(debitAmount.mul(rA));
  capValue(valueNgn);
  rows.push({ k: 'From', v: fromEarnings ? 'Creator earnings' : `${assetLabel(i.asset)} wallet balance` });
  rows.push({ k: 'Amount', v: fmtQty(debitAsset, debitAmount), tone: 'strong' });

  if (i.method === 'KAMKAM_WALLET') {
    receiveAsset = i.asset;
    receiveAmount = i.asset === 'NGN' ? debitAmount : roundDown(debitAmount.div(rA), prec(i.asset));
    dest = i.asset === 'NGN' ? 'KAMKAM Wallet · Naira' : `KAMKAM Wallet · ${i.asset}`;
    if (i.asset !== 'NGN') rows.push(rateRow(i.asset, rA));
    rows.push({ k: 'Fee', v: '₦0' });
  } else if (i.method === 'EXTERNAL_WALLET') {
    if (!i.network) throw badRequest('Choose a network.', 'INVALID_NETWORK');
    if (!i.address) throw badRequest('Enter the external wallet address.', 'INVALID_ADDRESS');
    if (!ASSETS[i.asset].networks.includes(i.network)) throw badRequest(`${i.asset} is not supported on ${i.network}.`, 'INVALID_NETWORK');
    validateAddress(i.network, i.address);
    network = i.network;
    const gross = fromEarnings ? roundDown(debitAmount.div(rA), prec(i.asset)) : debitAmount;
    fee = networkFeeIn(i.asset, i.network, rA);
    feeAsset = i.asset;
    receiveAsset = i.asset;
    receiveAmount = gross.sub(fee);
    if (receiveAmount.lte(0)) throw badRequest('Amount is too small to cover the network fee.', 'INVALID_AMOUNT');
    dest = i.address.slice(0, 10) + '…' + i.address.slice(-4);
    if (fromEarnings) rows.push(rateRow(i.asset, rA));
    rows.push({ k: 'Network', v: i.network }, { k: 'Network fee', v: '≈ ' + fmtQty(i.asset, fee) });
  } else {
    if (!i.bankName || !i.accountNumber || !i.accountName) throw badRequest('Enter bank, account number and account name.', 'BANK_DETAILS');
    fee = FEES.bankWithdrawNgn;
    receiveAsset = 'NGN';
    receiveAmount = debitAmount.sub(fee);
    if (receiveAmount.lte(0)) throw badRequest('Amount is too small to cover the transfer fee.', 'INVALID_AMOUNT');
    dest = `${i.bankName} ${mask(i.accountNumber)}`;
    rows.push({ k: 'Account name', v: i.accountName }, { k: 'Transfer fee', v: fmtNgn(fee) });
  }
  rows.push(
    { k: 'Destination', v: dest },
    { k: 'You receive', v: fmtQty(receiveAsset, receiveAmount), tone: 'green' },
    { k: 'Arrives', v: 'Pending → Processing → Completed (~10s demo)' },
    demoRow,
  );
  return {
    action: 'withdraw',
    debit: { source: fromEarnings ? 'EARNINGS' : 'WALLET', asset: debitAsset, amount: debitAmount.toString(), label: fmtQty(debitAsset, debitAmount) },
    receive: { asset: receiveAsset, amount: receiveAmount.toString(), label: fmtQty(receiveAsset, receiveAmount) },
    valueNgn: valueNgn.toString(), rows, available: available.toString(),
    availableLabel: fromEarnings ? fmtNgn(available) : fmtQty(i.asset, available),
    sufficient: available.gte(debitAmount), status: 'PENDING',
    warnings: i.method === 'BANK' ? ['Bank payouts are simulated — no real bank transfer happens.'] : i.method === 'EXTERNAL_WALLET' ? ['Demo transaction: nothing is broadcast to a real blockchain.'] : [],
    simulated: true, _: { fee: fee.toString(), feeAsset, dest, network },
  };
}

const QUOTES = {
  buy: quoteBuy, sell: quoteSell, swap: quoteSwap, send: quoteSend,
  transfer: quoteTransfer, deposit: quoteDeposit, withdraw: quoteWithdraw,
} as const;

export function isAction(a: string): a is ActionName {
  return a in QUOTES;
}

export async function getQuote(userId: string, action: ActionName, body: unknown) {
  const input = parse(schemas[action], body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = await (QUOTES[action] as any)(prisma, userId, input) as Quote;
  return q;
}

// ───────────── Execution ─────────────

export interface ExecResult { reference: string; status: TxStatus; quote: Quote }

export async function execute(userId: string, action: ActionName, body: unknown): Promise<ExecResult> {
  const input = parse(schemas[action], body);
  const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });

  return prisma.$transaction(async tx => {
    // Recompute everything server-side inside the DB transaction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await (QUOTES[action] as any)(tx, userId, input) as Quote;
    if (!q.sufficient) {
      throw Object.assign(badRequest(`Insufficient ${assetLabel(q.debit.asset)} balance. You need ${q.debit.label}, you have ${q.availableLabel}.`, 'INSUFFICIENT_BALANCE'), { status: 422 });
    }
    const w = await ensureWallet(tx, userId);
    const debitAmt = D(q.debit.amount);
    const recvAmt = q.receive ? D(q.receive.amount) : ZERO;
    const valueNgn = D(q.valueNgn);

    switch (action) {
      case 'deposit': {
        const i = input as In<'deposit'>;
        const ref = makeRef('DEP');
        await credit(tx, w.id, 'NGN', recvAmt);
        await tx.deposit.create({ data: { userId, asset: 'NGN', amount: recvAmt, method: i.method, reference: ref, status: 'COMPLETED' } });
        await recordTx(tx, { walletId: w.id, userId, type: TxType.DEPOSIT, direction: TxDirection.IN, asset: 'NGN', amount: recvAmt, valueNgn, reference: ref, network: 'Naira', description: `Wallet funded · ${i.method}` });
        return { reference: ref, status: TxStatus.COMPLETED, quote: q };
      }

      case 'buy': {
        const i = input as In<'buy'>;
        const ref = makeRef('BUY');
        if (q.debit.source === 'WALLET') {
          await debit(tx, w.id, q.debit.asset, debitAmt);
          await recordTx(tx, { walletId: w.id, userId, type: TxType.BUY, direction: TxDirection.OUT, asset: q.debit.asset, amount: debitAmt, valueNgn, reference: ref, description: `Paid for ${i.asset} purchase` });
        }
        await credit(tx, w.id, i.asset, recvAmt);
        await recordTx(tx, {
          walletId: w.id, userId, type: TxType.BUY, direction: TxDirection.IN, asset: i.asset, amount: recvAmt, valueNgn,
          fee: D(q._.fee as string), feeAsset: 'NGN', reference: ref, description: `Bought ${i.asset} · ${q._.payMethod}`,
        });
        await tx.buyTransaction.create({ data: { userId, asset: i.asset, amount: recvAmt, payAsset: q.debit.asset, payAmount: debitAmt, rate: D(q._.rA as string), fee: D(q._.fee as string), paymentMethod: String(q._.payMethod), reference: ref } });
        await tx.platformFee.create({ data: { source: 'BUY', amountNgn: D(q._.fee as string), reference: ref } });
        return { reference: ref, status: TxStatus.COMPLETED, quote: q };
      }

      case 'sell': {
        const i = input as In<'sell'>;
        const ref = makeRef('SEL');
        const bank = i.receiveMethod === 'BANK';
        const status = bank ? TxStatus.PENDING : TxStatus.COMPLETED;
        await debit(tx, w.id, i.asset, debitAmt);
        await recordTx(tx, {
          walletId: w.id, userId, type: TxType.SELL, direction: TxDirection.OUT, asset: i.asset, amount: debitAmt, valueNgn,
          fee: D(q._.fee as string), feeAsset: 'NGN', reference: ref, status, autoSettle: bank,
          description: `Sold ${i.asset} → ${q._.dest}`, metadata: { receive: q.receive?.label ?? null },
        });
        if (!bank && q.receive) {
          await credit(tx, w.id, q.receive.asset, recvAmt);
          await recordTx(tx, { walletId: w.id, userId, type: TxType.SELL, direction: TxDirection.IN, asset: q.receive.asset, amount: recvAmt, valueNgn: D(q.valueNgn).sub(D(q._.fee as string)), reference: ref, description: `Proceeds from ${i.asset} sale` });
        }
        await tx.sellTransaction.create({
          data: {
            userId, asset: i.asset, amount: debitAmt, receiveMethod: i.receiveMethod, receiveAsset: q.receive!.asset, receiveAmount: recvAmt,
            rate: D(q._.rA as string), fee: D(q._.fee as string), bankName: i.bankName, accountNumber: i.accountNumber, accountName: i.accountName, status, reference: ref,
          },
        });
        await tx.platformFee.create({ data: { source: 'SELL', amountNgn: D(q._.fee as string), reference: ref } });
        return { reference: ref, status, quote: q };
      }

      case 'swap': {
        const i = input as In<'swap'>;
        const ref = makeRef('SWP');
        await debit(tx, w.id, i.from, debitAmt);
        await credit(tx, w.id, i.to, recvAmt);
        await recordTx(tx, { walletId: w.id, userId, type: TxType.SWAP, direction: TxDirection.OUT, asset: i.from, amount: debitAmt, valueNgn, fee: D(q._.netFee as string).add(D(q._.platFee as string)), feeAsset: i.from, reference: ref, network: String(q._.network), description: `Swapped ${i.from} → ${i.to}` });
        await recordTx(tx, { walletId: w.id, userId, type: TxType.SWAP, direction: TxDirection.IN, asset: i.to, amount: recvAmt, valueNgn, reference: ref, network: String(q._.network), description: `Swapped ${i.from} → ${i.to}` });
        await tx.swap.create({ data: { userId, fromAsset: i.from, toAsset: i.to, fromAmount: debitAmt, toAmount: recvAmt, rate: D(q._.rate as string), networkFee: D(q._.netFee as string), platformFee: D(q._.platFee as string), network: String(q._.network), reference: ref } });
        await tx.platformFee.create({ data: { source: 'SWAP', amountNgn: D(q._.platFeeNgn as string), reference: ref } });
        return { reference: ref, status: TxStatus.COMPLETED, quote: q };
      }

      case 'send': {
        const i = input as In<'send'>;
        const ref = makeRef('SND');
        await debit(tx, w.id, i.asset, debitAmt);
        const chain = await chainProvider.submitTransfer({ network: i.network, asset: i.asset, to: i.address, amount: String(q._.amount) });
        const internal = q._.internal as { userId: string; username: string } | null;
        await recordTx(tx, {
          walletId: w.id, userId, type: TxType.TRANSFER, direction: TxDirection.OUT, asset: i.asset, amount: recvAmt, valueNgn,
          fee: D(q._.fee as string), feeAsset: i.asset, status: TxStatus.PENDING, autoSettle: true, reference: ref, network: i.network,
          counterparty: internal ? '@' + internal.username : i.address,
          description: `Sent ${i.asset}` + (internal ? ` to @${internal.username}` : ''),
          metadata: { address: i.address, simulated: chain.simulated, txHash: chain.txHash, internalRecipientId: internal?.userId ?? null, sender: me.username },
        });
        return { reference: ref, status: TxStatus.PENDING, quote: q };
      }

      case 'transfer': {
        const i = input as In<'transfer'>;
        const to = q._.to as { id: string; username: string };
        const ref = makeRef('TRF');
        await debit(tx, w.id, i.asset, debitAmt);
        const tw = await ensureWallet(tx, to.id);
        await credit(tx, tw.id, i.asset, debitAmt);
        await recordTx(tx, { walletId: w.id, userId, type: TxType.TRANSFER, direction: TxDirection.OUT, asset: i.asset, amount: debitAmt, valueNgn, reference: ref, network: 'KAMKAM', counterparty: '@' + to.username, description: `Transfer to @${to.username}`, metadata: { note: i.note ?? null } });
        await recordTx(tx, { walletId: tw.id, userId: to.id, type: TxType.TRANSFER, direction: TxDirection.IN, asset: i.asset, amount: debitAmt, valueNgn, reference: ref, network: 'KAMKAM', counterparty: '@' + me.username, description: `Transfer from @${me.username}`, metadata: { note: i.note ?? null } });
        await notify({ userId: to.id, actorId: userId, type: NotificationType.TRANSACTION_COMPLETED, title: `@${me.username} sent you ${fmtQty(i.asset, debitAmt)}`, body: i.note ? `"${i.note}"` : 'The transfer has been added to your KAMKAM wallet.', amountLabel: '+' + fmtQty(i.asset, debitAmt) }, tx);
        return { reference: ref, status: TxStatus.COMPLETED, quote: q };
      }

      case 'withdraw': {
        const i = input as In<'withdraw'>;
        const ref = makeRef('WDR');
        const fromEarnings = i.source === 'EARNINGS';
        if (fromEarnings) await debitEarnings(tx, w.id, debitAmt);
        else await debit(tx, w.id, i.asset, debitAmt);
        await tx.withdrawal.create({
          data: {
            userId, source: i.source, method: i.method, asset: q.receive!.asset, amount: recvAmt, valueNgn, fee: D(q._.fee as string),
            network: (q._.network as string) ?? null, address: i.method === 'EXTERNAL_WALLET' ? i.address : null,
            bankName: i.bankName, accountNumber: i.accountNumber, accountName: i.accountName, status: TxStatus.PENDING, reference: ref,
          },
        });
        const toWallet = i.method === 'KAMKAM_WALLET';
        // Earnings -> KAMKAM wallet increases the wallet balance (IN); everything else leaves (OUT).
        await recordTx(tx, {
          walletId: w.id, userId, type: TxType.WITHDRAWAL, direction: toWallet ? TxDirection.IN : TxDirection.OUT,
          asset: toWallet ? q.receive!.asset : q.debit.asset, amount: toWallet ? recvAmt : debitAmt, valueNgn,
          fee: D(q._.fee as string), feeAsset: String(q._.feeAsset), status: TxStatus.PENDING, autoSettle: true, reference: ref,
          network: (q._.network as string) ?? (i.method === 'BANK' ? 'Naira' : 'KAMKAM'), counterparty: String(q._.dest),
          description: (fromEarnings ? 'Earnings withdrawal → ' : 'Withdrawal → ') + String(q._.dest),
          metadata: { method: i.method, source: i.source, receiveAsset: q.receive!.asset, receiveAmount: recvAmt.toString() },
        });
        return { reference: ref, status: TxStatus.PENDING, quote: q };
      }
    }
  });
}
