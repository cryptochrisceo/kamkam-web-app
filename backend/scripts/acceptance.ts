/* eslint-disable no-console */
/**
 * KAMKAM Final Acceptance Test (spec §41) — runs against the live local API.
 *   1) start PostgreSQL + backend (npm run dev)
 *   2) npm run test:acceptance   (from backend/)
 * Creates two fresh users each run; does not wipe existing data.
 */
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL || 'http://localhost:4000/api';
const prisma = new PrismaClient();
let passed = 0, failed = 0;

function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { ...json, http: r.status } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const tag = Date.now().toString(36).slice(-6);
  console.log(`\nKAMKAM acceptance test → ${API}\n`);

  console.log('1–2. Register users');
  const ra = await call(null, 'POST', '/auth/register', { username: `usera_${tag}`, displayName: 'User A', email: `a_${tag}@test.local`, password: 'password123' });
  const rb = await call(null, 'POST', '/auth/register', { username: `userb_${tag}`, displayName: 'User B', email: `b_${tag}@test.local`, password: 'password123' });
  check('User A registered', ra.http === 201, ra);
  check('User B registered', rb.http === 201, rb);
  const A = ra.token as string, B = rb.token as string, aId = ra.user.id as string, bId = rb.user.id as string;
  check('Password stored hashed', (await prisma.user.findUnique({ where: { id: aId } }))!.passwordHash.startsWith('$2'));
  check('Unauthenticated wallet request rejected', (await call(null, 'GET', '/wallet')).http === 401);

  console.log('3. User A creates a post');
  const cp = await call(A, 'POST', '/posts', { text: `Acceptance test post ${tag} #KAMKAM` });
  check('Post created', cp.http === 201, cp);
  const postId = cp.post.id as string;

  console.log('4. User B sees the post');
  const feed = await call(B, 'GET', '/posts?tab=foryou&limit=50');
  check('Post in B\'s feed', feed.posts.some((p: { id: string }) => p.id === postId));

  console.log('5–6. Like + comment');
  check('B liked the post', (await call(B, 'POST', `/posts/${postId}/like`)).likeCount === 1);
  const cm = await call(B, 'POST', `/posts/${postId}/comment`, { text: 'Great post!' });
  check('B commented', cm.http === 201 && cm.commentCount === 1, cm);

  console.log('7–11. Gift ₦2,000 paid with USDT');
  const act = await call(B, 'POST', '/wallet/activate', {});
  check('B wallet created (no phrase sent)', act.wallet?.cryptoActivated === true, act);
  const usdtBefore = Number(act.wallet.assets.find((a: { symbol: string }) => a.symbol === 'USDT').balance);
  const q = await call(B, 'POST', '/gifts/quote', { postId, amountNgn: 2000, payAsset: 'USDT' });
  check('Backend computed 1.25 USDT for ₦2,000 (demo rate 1,600)', Number(q.quote?.payAmount) === 1.25, q);
  check('Quote shows 80% = ₦1,600', Number(q.quote?.creatorAmountNgn) === 1600);
  // Frontend-supplied financial values must be ignored
  const g = await call(B, 'POST', '/gifts', { postId, amountNgn: 2000, payAsset: 'USDT', creatorAmountNgn: 999999, payAmount: 0.0001 });
  check('Gift sent', g.http === 201, g);

  console.log('12–17. Verify gift effects');
  const w = await call(B, 'GET', '/wallet');
  const usdtAfter = Number(w.wallet.assets.find((a: { symbol: string }) => a.symbol === 'USDT').balance);
  check('Backend deducted exactly 1.25 USDT', Math.abs(usdtBefore - usdtAfter - 1.25) < 1e-9, { usdtBefore, usdtAfter });
  const pv = await call(B, 'GET', `/posts/${postId}`);
  check('Post liked', pv.post.liked === true);
  check('Super Like active', pv.post.superLiked === true && pv.post.superLikeCount === 1);
  check('Gift count increased', pv.post.giftCount === 1);
  check('Boost flag applied', pv.post.boosted === true);
  check('Like not double-counted', pv.post.likeCount === 1);
  const gift = await prisma.gift.findUnique({ where: { reference: g.gift.reference }, include: { earning: true, platformFee: true } });
  check('Creator earning = ₦1,600', Number(gift?.earning?.amountNgn) === 1600);
  check('KAMKAM platform fee = ₦400', Number(gift?.platformFee?.amountNgn) === 400);

  console.log('18–19. Notification + both histories');
  const na = await call(A, 'GET', '/notifications?filter=gifts');
  check('A got gift notification', na.notifications.some((n: { title: string; body: string }) => n.title.includes('₦2,000 Gift') && n.body.includes('₦1,600')), na.notifications[0]);
  const ta = await call(A, 'GET', '/wallet/transactions?filter=gifts');
  const tb = await call(B, 'GET', '/wallet/transactions?filter=gifts');
  check('A history has GIFT_RECEIVED', ta.transactions.some((t: { type: string; reference: string }) => t.type === 'GIFT_RECEIVED' && t.reference === g.gift.reference));
  check('B history has GIFT_SENT', tb.transactions.some((t: { type: string; reference: string }) => t.type === 'GIFT_SENT' && t.reference === g.gift.reference));

  console.log('20–23. Creator earnings + withdrawals');
  const e = await call(A, 'GET', '/earnings');
  check('A available earnings ₦1,600', Number(e.earnings.availableNgn) === 1600, e.earnings);
  await call(A, 'POST', '/wallet/activate', {});
  const wd1 = await call(A, 'POST', '/wallet/withdraw', { source: 'EARNINGS', method: 'KAMKAM_WALLET', asset: 'NGN', amount: 500 });
  const wd2 = await call(A, 'POST', '/wallet/withdraw', { source: 'EARNINGS', method: 'BANK', asset: 'NGN', amount: 500, bankName: 'Kuda Microfinance Bank', accountNumber: '2044121234', accountName: 'User A' });
  const wd3 = await call(A, 'POST', '/wallet/withdraw', { source: 'EARNINGS', method: 'EXTERNAL_WALLET', asset: 'USDT', network: 'BNB Chain', address: '0x' + 'ab'.repeat(20), amount: 600 });
  check('Withdraw → KAMKAM wallet accepted (PENDING)', wd1.http === 201 && wd1.status !== 'x' && wd1.reference, wd1);
  check('Withdraw → Bank accepted', wd2.http === 201, wd2);
  check('Withdraw → External wallet accepted', wd3.http === 201, wd3);
  const over = await call(A, 'POST', '/wallet/withdraw', { source: 'EARNINGS', method: 'BANK', asset: 'NGN', amount: 5000, bankName: 'Kuda', accountNumber: '2044121234', accountName: 'User A' });
  check('Over-withdrawal rejected (insufficient)', over.http === 422, over);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const t = await call(A, 'GET', `/wallet/transactions/${wd2.reference}`);
    seen.add(t.status);
    if (t.status === 'COMPLETED') break;
    await sleep(1000);
  }
  check('Status moved Pending → Processing → Completed', ['PENDING', 'PROCESSING', 'COMPLETED'].every(s => seen.has(s)) || (seen.has('PROCESSING') && seen.has('COMPLETED')), [...seen]);
  await sleep(2500);
  const wa = await call(A, 'GET', '/wallet');
  const ngnA = Number(wa.wallet.assets.find((a: { symbol: string }) => a.symbol === 'NGN').balance);
  check('KAMKAM-wallet withdrawal credited ₦500 to Naira balance', ngnA === 50000 + 500, ngnA);
  const nw = await call(A, 'GET', '/notifications?filter=wallet');
  check('Withdrawal completed notification', nw.notifications.some((n: { type: string }) => n.type === 'WITHDRAWAL_COMPLETED'));

  console.log('24. Buy / Sell / Swap / Send / Receive / Transfer / Deposit');
  const buy = await call(B, 'POST', '/wallet/buy', { asset: 'USDT', amountNgn: 10000, payWith: 'NGN' });
  check('Buy USDT with Naira', buy.http === 201, buy);
  const buy2 = await call(B, 'POST', '/wallet/buy', { asset: 'USDT', amountNgn: 5000, payWith: 'BNB' });
  check('Buy USDT paying with BNB', buy2.http === 201, buy2);
  const sell = await call(B, 'POST', '/wallet/sell', { asset: 'SOL', amount: 0.5, receiveMethod: 'NAIRA_BALANCE' });
  check('Sell SOL → Naira', sell.http === 201, sell);
  const swap = await call(B, 'POST', '/wallet/swap', { from: 'USDT', to: 'BNB', amount: 10 });
  check('Swap USDT → BNB', swap.http === 201, swap);
  const rcv = await call(A, 'GET', '/wallet/receive?network=BNB%20Chain&asset=USDT');
  check('Receive shows demo address', /^0x[0-9a-f]{40}$/.test(rcv.address) && rcv.demo === true, rcv);
  const bad = await call(B, 'POST', '/wallet/send', { asset: 'USDT', network: 'BNB Chain', address: '0x123', amount: 1 });
  check('Invalid address rejected', bad.http === 400 && bad.error?.code === 'INVALID_ADDRESS', bad);
  const send = await call(B, 'POST', '/wallet/send', { asset: 'USDT', network: 'BNB Chain', address: rcv.address, amount: 2 });
  check('Send USDT (to A demo address)', send.http === 201 && send.simulated === true, send);
  const tr = await call(B, 'POST', '/wallet/transfer', { asset: 'NGN', toUsername: `usera_${tag}`, amount: 1000 });
  check('Internal transfer', tr.http === 201, tr);
  const dep = await call(B, 'POST', '/wallet/deposit', { amount: 5000, method: 'Paystack' });
  check('Deposit', dep.http === 201, dep);
  const tooMuch = await call(B, 'POST', '/wallet/swap', { from: 'ETH', to: 'USDT', amount: 1 });
  check('Insufficient swap rejected', tooMuch.http === 422, tooMuch);

  console.log('25. Persistence in PostgreSQL');
  const counts = await Promise.all([
    prisma.walletTransaction.count({ where: { userId: { in: [aId, bId] } } }),
    prisma.swap.count({ where: { userId: bId } }), prisma.buyTransaction.count({ where: { userId: bId } }),
    prisma.sellTransaction.count({ where: { userId: bId } }), prisma.withdrawal.count({ where: { userId: aId } }),
  ]);
  check('Records persisted', counts.every(c => c > 0), counts);
  const neg = await prisma.walletAsset.count({ where: { balance: { lt: 0 } } });
  check('No negative balances anywhere', neg === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
