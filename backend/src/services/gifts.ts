import { NotificationType, Prisma, TxDirection, TxType } from '@prisma/client';
import { prisma, Tx } from '../utils/prisma';
import { badRequest, insufficient, notFound } from '../utils/errors';
import { D, ngn, roundUp } from '../utils/money';
import { makeRef } from '../utils/reference';
import { parse, z } from '../utils/validate';
import { ASSETS, ASSET_SYMBOLS, AssetSymbol, NETWORK_NAMES, NetworkName } from './assets';
import { priceProvider } from './pricing';
import { balanceOf, creditEarnings, debit, ensureWallet, recordTx } from './ledger';
import { notify } from './notifications';
import { fmtNgn, fmtQty } from './format';

/** Creator share. Platform keeps the rest. Change here only. */
export const CREATOR_SHARE = D('0.8');
export const GIFT_TIERS_NGN = [200, 500, 2000, 3000];
export const GIFT_MIN_NGN = 50;
export const GIFT_MAX_NGN = 1_000_000;
const BOOST_HOURS = 24;

export const giftSchema = z.object({
  postId: z.string().min(1).optional(),
  recipientId: z.string().min(1).optional(),
  amountNgn: z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = Number(String(v).replace(/,/g, ''));
    if (!Number.isInteger(n) || n < GIFT_MIN_NGN || n > GIFT_MAX_NGN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Gift must be a whole Naira amount between ₦${GIFT_MIN_NGN} and ₦${GIFT_MAX_NGN.toLocaleString()}` });
      return z.NEVER;
    }
    return n;
  }),
  payAsset: z.enum(ASSET_SYMBOLS as [AssetSymbol, ...AssetSymbol[]]),
  network: z.enum(NETWORK_NAMES as [NetworkName, ...NetworkName[]]).optional(),
}).refine(v => v.postId || v.recipientId, { message: 'postId or recipientId is required' });

export type GiftInput = z.infer<typeof giftSchema>;

/** Pure calculation — the single source of truth for gift math. */
export async function computeGift(amountNgn: number, payAsset: AssetSymbol) {
  const value = D(amountNgn);
  const rateNgn = await priceProvider.rateNgn(payAsset);
  const payAmount = payAsset === 'NGN' ? value : roundUp(value.div(rateNgn), ASSETS[payAsset].precision);
  const creatorAmountNgn = ngn(value.mul(CREATOR_SHARE));
  const platformFeeNgn = value.sub(creatorAmountNgn);
  return { value, rateNgn, payAmount, creatorAmountNgn, platformFeeNgn };
}

async function resolveTarget(db: Tx, i: GiftInput) {
  if (i.postId) {
    const post = await db.post.findUnique({ where: { id: i.postId }, select: { id: true, authorId: true, text: true } });
    if (!post) throw notFound('Post not found.', 'POST_NOT_FOUND');
    return { post, recipientId: post.authorId };
  }
  const u = await db.user.findUnique({ where: { id: i.recipientId! }, select: { id: true } });
  if (!u) throw notFound('Creator not found.', 'USER_NOT_FOUND');
  return { post: null, recipientId: u.id };
}

export async function quoteGift(senderId: string, body: unknown) {
  const i = parse(giftSchema, body);
  const { recipientId } = await resolveTarget(prisma, i);
  if (recipientId === senderId) throw badRequest("You can't gift yourself.", 'SELF_GIFT');
  const w = await ensureWallet(prisma, senderId);
  if (i.payAsset !== 'NGN' && !w.cryptoActivated) throw badRequest('Create your KAMKAM wallet to pay with crypto.', 'WALLET_NOT_ACTIVATED');
  const c = await computeGift(i.amountNgn, i.payAsset);
  const balance = await balanceOf(prisma, w.id, i.payAsset);
  return {
    amountNgn: c.value.toString(),
    payAsset: i.payAsset,
    rateNgn: c.rateNgn.toString(),
    payAmount: c.payAmount.toString(),
    payLabel: fmtQty(i.payAsset, c.payAmount),
    creatorAmountNgn: c.creatorAmountNgn.toString(),
    platformFeeNgn: c.platformFeeNgn.toString(),
    balance: balance.toString(),
    balanceLabel: fmtQty(i.payAsset, balance),
    sufficient: balance.gte(c.payAmount),
    simulated: true,
  };
}

/**
 * Sends a gift atomically. Either ALL of the following happen or NONE:
 *  debit sender · gift record · like + super like · post counters & boost ·
 *  creator earning (80%) · platform fee (20%) · wallet txs both sides · notification
 */
export async function sendGift(senderId: string, body: unknown) {
  const i = parse(giftSchema, body);
  return prisma.$transaction(async tx => {
    const { post, recipientId } = await resolveTarget(tx, i);
    if (recipientId === senderId) throw badRequest("You can't gift yourself.", 'SELF_GIFT');

    const [sender, recipient] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: senderId }, select: { username: true, displayName: true } }),
      tx.user.findUniqueOrThrow({ where: { id: recipientId }, select: { username: true } }),
    ]);
    const sw = await ensureWallet(tx, senderId);
    const rw = await ensureWallet(tx, recipientId);
    if (i.payAsset !== 'NGN' && !sw.cryptoActivated) throw badRequest('Create your KAMKAM wallet to pay with crypto.', 'WALLET_NOT_ACTIVATED');

    const c = await computeGift(i.amountNgn, i.payAsset);
    const reference = makeRef('GFT');

    // 1. Deduct sender (conditional update → cannot overdraw)
    try {
      await debit(tx, sw.id, i.payAsset, c.payAmount);
    } catch (e) {
      const have = await balanceOf(tx, sw.id, i.payAsset);
      throw insufficient(`Insufficient ${i.payAsset === 'NGN' ? 'Naira' : i.payAsset} balance. You need ${fmtQty(i.payAsset, c.payAmount)}, you have ${fmtQty(i.payAsset, have)}.`);
    }

    // 2. Gift record
    const gift = await tx.gift.create({
      data: {
        senderId, recipientId, postId: post?.id ?? null, amountNgn: c.value, payAsset: i.payAsset, payAmount: c.payAmount,
        rateNgn: c.rateNgn, creatorAmountNgn: c.creatorAmountNgn, platformFeeNgn: c.platformFeeNgn, network: i.network ?? null, reference,
      },
    });

    // 3-6. Auto like + super like, counters, boost
    if (post) {
      const existing = await tx.like.findUnique({ where: { userId_postId: { userId: senderId, postId: post.id } } });
      if (!existing) await tx.like.create({ data: { userId: senderId, postId: post.id, superLike: true } });
      else if (!existing.superLike) await tx.like.update({ where: { id: existing.id }, data: { superLike: true } });
      await tx.post.update({
        where: { id: post.id },
        data: {
          giftCount: { increment: 1 },
          likeCount: existing ? undefined : { increment: 1 },
          superLikeCount: existing?.superLike ? undefined : { increment: 1 },
          earnedNgn: { increment: c.creatorAmountNgn },
          boosted: true,
          boostedUntil: new Date(Date.now() + BOOST_HOURS * 3600_000),
        },
      });
    }

    // 7. Creator earnings (80%)
    await tx.creatorEarning.create({ data: { userId: recipientId, giftId: gift.id, amountNgn: c.creatorAmountNgn, sourceAsset: i.payAsset } });
    await creditEarnings(tx, rw.id, c.creatorAmountNgn);

    // 8. Platform fee (20%)
    await tx.platformFee.create({ data: { source: 'GIFT', amountNgn: c.platformFeeNgn, reference, giftId: gift.id } });

    // 10. Wallet transactions for both sides
    await recordTx(tx, {
      walletId: sw.id, userId: senderId, type: TxType.GIFT_SENT, direction: TxDirection.OUT, asset: i.payAsset, amount: c.payAmount,
      valueNgn: c.value, reference, network: i.payAsset === 'NGN' ? 'Naira' : (i.network ?? 'KAMKAM'), counterparty: '@' + recipient.username,
      description: `Gift sent to @${recipient.username}`, metadata: { giftId: gift.id, postId: post?.id ?? null, giftValueNgn: c.value.toString() },
    });
    await recordTx(tx, {
      walletId: rw.id, userId: recipientId, type: TxType.GIFT_RECEIVED, direction: TxDirection.IN, asset: 'NGN', amount: c.creatorAmountNgn,
      valueNgn: c.creatorAmountNgn, reference, network: 'Earnings', counterparty: '@' + sender.username,
      description: `Gift received from @${sender.username}`,
      metadata: { giftId: gift.id, postId: post?.id ?? null, giftValueNgn: c.value.toString(), paidWith: i.payAsset, toEarnings: true },
    });

    // 9. Notify creator
    await notify({
      userId: recipientId, actorId: senderId, type: NotificationType.GIFT_RECEIVED, postId: post?.id ?? null,
      title: `🎁 @${sender.username} sent you a ${fmtNgn(c.value)} Gift.`,
      body: `You earned ${fmtNgn(c.creatorAmountNgn)}.` + (post ? ' Your post received a Super Like.' : ''),
      amountLabel: '+' + fmtNgn(c.creatorAmountNgn),
    }, tx);

    // Gift receipt inside an existing DM thread, if the two already talk.
    const conv = await tx.conversation.findFirst({
      where: { AND: [{ members: { some: { userId: senderId } } }, { members: { some: { userId: recipientId } } }] },
      select: { id: true },
    });
    if (conv) {
      await tx.message.create({ data: { conversationId: conv.id, senderId, kind: 'GIFT', text: `Gift sent · ${fmtNgn(c.value)}`, meta: { creatorAmountNgn: c.creatorAmountNgn.toString() } } });
      await tx.conversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
    }

    return {
      gift: {
        id: gift.id, reference, amountNgn: c.value.toString(), payAsset: i.payAsset, payAmount: c.payAmount.toString(),
        payLabel: fmtQty(i.payAsset, c.payAmount), creatorAmountNgn: c.creatorAmountNgn.toString(), platformFeeNgn: c.platformFeeNgn.toString(),
        recipient: '@' + recipient.username, simulated: true,
      },
      postId: post?.id ?? null,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
}
