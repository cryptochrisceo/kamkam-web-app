/* eslint-disable no-console */
/**
 * KAMKAM demo seed. WIPES the local database and fills it with demo data.
 *   npm run db:seed
 *
 * Every demo account uses the password:  password123
 * Main demo login:  amaka@kamkam.local  /  password123
 *
 * Gifts, transfers and swaps are created through the real services so balances,
 * earnings, the 80/20 split and transaction history are all consistent.
 */
import bcrypt from 'bcryptjs';
import { NotificationType } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { ensureWallet } from '../services/ledger';
import { grantStarter, STARTER_CRYPTO } from '../services/accounts';
import { sendGift } from '../services/gifts';
import { execute } from '../services/walletActions';
import { notify } from '../services/notifications';

// Deterministic PRNG so every seed run looks the same
let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

const USERS = [
  { u: 'amaka', n: 'Amaka James', c: '#14975C', v: true, bio: 'Product designer. Writing about craft, Lagos tech and building for the next hundred million. Gifts keep the essays coming.', loc: 'Lagos, Nigeria', web: 'amakajames.co' },
  { u: 'davidokoro', n: 'David Okoro', c: '#2F6F4E', v: true, bio: 'Building tools for creators. Ex-fintech. Opinions are loud.', loc: 'Abuja' },
  { u: 'sarahw', n: 'Sarah Williams', c: '#B0553C', v: false, bio: 'Photographer. Lagos light, every morning.', loc: 'Lekki, Lagos' },
  { u: 'danielade', n: 'Daniel Ade', c: '#3A5C8C', v: true, bio: 'Engineering lead. Offline-first everything. Threads on payments.', loc: 'Lagos' },
  { u: 'chrismorgan', n: 'Chris Morgan', c: '#6B4E8C', v: false, bio: 'Asking the questions product teams avoid.', loc: 'Accra' },
  { u: 'michaeljohnson', n: 'Michael Johnson', c: '#1F6E7A', v: true, bio: 'Producer. Studio sessions & late night beats.', loc: 'Surulere' },
  { u: 'ifynwosu', n: 'Ifeoma Nwosu', c: '#8C6A2F', v: false, bio: 'Short stories about Enugu on weekends.', loc: 'Enugu' },
  { u: 'tundeb', n: 'Tunde Balogun', c: '#8C3F5C', v: false, bio: 'Football tactics nerd. Super Eagles forever.', loc: 'Ibadan' },
  { u: 'zainabbello', n: 'Zainab Bello', c: '#2F6F4E', v: false, bio: 'Crypto research, stablecoin rails, African markets.', loc: 'Kano' },
  { u: 'kelechiobi', n: 'Kelechi Obi', c: '#B0553C', v: false, bio: 'Nollywood critic. Weekend culture.', loc: 'Owerri' },
  { u: 'funkeadeyemi', n: 'Funke Adeyemi', c: '#3A5C8C', v: true, bio: 'Chef. Jollof diplomacy. Recipes every Sunday.', loc: 'Lagos' },
  { u: 'emekannamdi', n: 'Emeka Nnamdi', c: '#6B4E8C', v: false, bio: 'Startup operator sharing numbers, not vibes.', loc: 'Yaba' },
  { u: 'halimamusa', n: 'Halima Musa', c: '#1F6E7A', v: false, bio: 'Illustrator. Commissions open.', loc: 'Kaduna' },
  { u: 'seunoladipo', n: 'Seun Oladipo', c: '#8C6A2F', v: false, bio: 'Afrobeats & alté playlists. DJ on Fridays.', loc: 'Lagos' },
  { u: 'ngozieze', n: 'Ngozi Eze', c: '#8C3F5C', v: false, bio: 'Teacher. Explaining science one thread at a time.', loc: 'Port Harcourt' },
  { u: 'bayoadekunle', n: 'Bayo Adekunle', c: '#14975C', v: false, bio: 'Fitness coach. 5am club.', loc: 'Abeokuta' },
];

const POSTS: Record<string, string[]> = {
  amaka: [
    'Design note: monetization should be one tap away from the content, never a separate app. #KAMKAM',
    'Spent the morning rewriting a settings screen down to four rows. Best work of the week.',
    'If your product only pays people with audiences, you built a billboard, not a platform.',
    'Hot take: the best onboarding is the one you never notice. #Technology',
  ],
  davidokoro: [
    'Building something new for creators. The future of social media is going to be very different. #KAMKAM',
    'Creators should not need 10K followers to earn their first ₦1,000. Discovery > follower count.',
    'Shipping > planning. Every single time.',
    'Payments UX in Nigeria is 80% trust, 20% tech. #Technology',
  ],
  sarahw: [
    'Lekki at 6:40am. Three years of shooting this city and the light still surprises me.',
    'New print series drops next week. Gifts from this post go straight into film stock.',
    'Golden hour on Third Mainland Bridge. No filter needed.',
    'Photography tip: walk slower. The picture is usually behind you.',
  ],
  danielade: [
    'Breaking down how we shipped offline-first payments in 6 weeks. Full thread below, no fluff. #Technology',
    'Idempotency keys are the most underrated feature in any payments API.',
    'Stablecoin rails for creator payouts are finally boring. That is the goal. #Crypto',
    'Your queue is not a database. Stop treating it like one.',
  ],
  chrismorgan: [
    'Which one actually changes how you use a social app: creator payouts, better search, or a chronological feed?',
    'Every product team says they are user-obsessed. Few ship like it.',
    'Unpopular opinion: likes are cheap, gifts are signal.',
  ],
  michaeljohnson: [
    'Studio session from last night. Full track drops Friday. #Music',
    'Track is mastered. Listening party this weekend. #Music',
    'Sampled my grandmother humming. Best hook I have ever made.',
    'Producers, stop mixing at 2am. Your ears are lying to you. #Music',
  ],
  ifynwosu: [
    'First thing I have ever posted here. I write short stories about Enugu on the weekends. Thought I would try somewhere new.',
    'New story: "The Coal Camp Radio". 900 words, one sitting.',
    'I have one follower and made ₦1,200 this week. Still processing that. #KAMKAM',
  ],
  tundeb: [
    'Why the Super Eagles midfield finally clicked: it is all about the double pivot. #Football',
    'That goal last night was a coaching masterclass. Watch the third man run. #Football',
    'Fantasy football tip: never captain a defender. Ever. #Football',
    'Local league attendance is up 30%. People want to watch football in person again. #Football',
  ],
  zainabbello: [
    'What 200 Nigerian creators earned last month, visualised. Thread. #Crypto',
    'USDT on multiple networks is great until someone picks the wrong one. Always double-check. #Crypto',
    'Self-custody is freedom and responsibility. Back up your recovery phrase. Offline. #Crypto',
  ],
  kelechiobi: [
    'Nollywood is quietly having its best year in a decade.',
    'Weekend watchlist: three films, zero regrets.',
    'Cinema snacks should not cost more than the ticket. I said what I said.',
  ],
  funkeadeyemi: [
    'Sunday jollof, the smoky way. Recipe in replies.',
    'Party rice is a state of mind.',
    'Pepper soup season is here. #Food',
    'If your plantain is not almost black, you are frying it too early.',
  ],
  emekannamdi: [
    'Operators sharing numbers, not vibes: our CAC dropped 40% after we stopped paying influencers upfront.',
    'Hiring your first 5 people is the whole company. Take your time.',
    'Revenue is a vanity metric until it is collected.',
  ],
  halimamusa: [
    'New illustration: Kaduna market at dusk. Commissions open.',
    'Drew 30 faces in 30 days. Here is day 30.',
    'Art tip: squint at your drawing. If it still reads, it works.',
  ],
  seunoladipo: [
    'Friday set list is ready. Alté to Afrobeats in 90 minutes. #Music',
    'Playlist: 25 songs for a Lagos traffic jam. #Music',
    'Vinyl is back in Lagos and I am not complaining.',
  ],
  ngozieze: [
    'Thread: why the sky is blue, explained with a garden hose.',
    'My students built a rain gauge from a plastic bottle. Science is everywhere.',
    'Teachers deserve gifts too. Just saying. #KAMKAM',
  ],
  bayoadekunle: [
    '5am run done. 10km. Who is joining tomorrow?',
    'You do not need a gym. You need a plan.',
    'Hydrate. Then hydrate again.',
  ],
};

const COMMENTS = [
  'The part about discovery over follower count is the whole thing. Gifted.',
  'Been saying this. Reach should follow the work, not the account age.',
  'This is so good. Saving it.',
  'Needed to read this today.',
  'Facts. 100%.',
  'Can you share more on this?',
  'Where can I learn more?',
  'This deserves more reach 🔥',
  'Genuinely useful, thank you.',
  'Following for part two.',
  'The light in this one 😍',
  'Tried this and it worked!',
];

const DMS: [string, string, string[]][] = [
  ['davidokoro', 'amaka', ['That thread on creator payouts was excellent.', 'Thank you! Took three rewrites to get the tone right.', 'Sending a little something for it.']],
  ['sarahw', 'amaka', ['The Lekki shots are ready', 'Amazing, can you send the high-res?', 'Uploading now.']],
  ['danielade', 'amaka', ['Let me know when the draft is up', 'Tonight, promise.']],
  ['chrismorgan', 'amaka', ['Quick question about your settings redesign', 'Sure, ask away!']],
  ['michaeljohnson', 'amaka', ['Track is mastered 🔊', 'Cannot wait to hear it']],
];

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

async function main() {
  console.log('Seeding KAMKAM demo data… (this wipes the local database)');
  await wipe();
  const passwordHash = await bcrypt.hash('password123', 10);

  // Users, profiles, wallets
  const ids: Record<string, string> = {};
  for (const [i, u] of USERS.entries()) {
    const user = await prisma.user.create({
      data: {
        username: u.u, displayName: u.n, email: `${u.u}@kamkam.local`, passwordHash, avatarColor: u.c, verified: u.v, bio: u.bio,
        createdAt: ago(60 * 24 * (200 - i * 7)),
        profile: { create: { location: u.loc, website: u.web ?? null } },
      },
    });
    ids[u.u] = user.id;
    await prisma.$transaction(async tx => {
      await ensureWallet(tx, user.id);
      await tx.wallet.update({ where: { userId: user.id }, data: { cryptoActivated: true } });
      await grantStarter(tx, user.id, { NGN: u.u === 'amaka' ? '150000' : String(int(40, 120) * 1000), ...STARTER_CRYPTO });
    }, { timeout: 20000 });
  }
  const U = (name: string) => ids[name];
  console.log(`  ✓ ${USERS.length} users (password: password123)`);

  // Follows
  let follows = 0;
  for (const a of USERS) for (const b of USERS) {
    if (a.u === b.u) continue;
    const popular = ['davidokoro', 'danielade', 'michaeljohnson', 'amaka', 'sarahw'].includes(b.u);
    if (rnd() < (popular ? 0.7 : 0.3)) {
      await prisma.follow.create({ data: { followerId: U(a.u), followingId: U(b.u), createdAt: ago(int(60, 60 * 24 * 30)) } });
      follows++;
    }
  }
  // Ensure Amaka's key relationships exist for the demo
  for (const f of ['davidokoro', 'sarahw', 'danielade', 'michaeljohnson']) {
    await prisma.follow.upsert({ where: { followerId_followingId: { followerId: U('amaka'), followingId: U(f) } }, create: { followerId: U('amaka'), followingId: U(f) }, update: {} });
  }
  console.log(`  ✓ ${follows} follows`);

  // Posts
  const postIds: { id: string; author: string; text: string }[] = [];
  for (const [author, texts] of Object.entries(POSTS)) {
    for (const text of texts) {
      const media = /Lekki|Golden hour|illustration|Studio session|jollof|Kaduna/.test(text);
      const p = await prisma.post.create({
        data: {
          authorId: U(author), text, createdAt: ago(int(20, 60 * 24 * 7)),
          mediaType: media ? (text.includes('Studio') ? 'VIDEO' : 'IMAGE') : null,
        },
      });
      postIds.push({ id: p.id, author, text });
    }
  }
  console.log(`  ✓ ${postIds.length} posts`);

  // Likes, comments, reposts, bookmarks
  let likes = 0, comments = 0;
  for (const p of postIds) {
    const likers = USERS.filter(u => u.u !== p.author && rnd() < 0.45);
    for (const l of likers) {
      await prisma.like.create({ data: { userId: U(l.u), postId: p.id, createdAt: ago(int(5, 60 * 24 * 6)) } });
      likes++;
    }
    const nC = int(0, 4);
    for (let k = 0; k < nC; k++) {
      const by = pick(USERS.filter(u => u.u !== p.author));
      const c = await prisma.comment.create({ data: { postId: p.id, authorId: U(by.u), text: pick(COMMENTS), createdAt: ago(int(5, 60 * 24 * 5)) } });
      comments++;
      if (rnd() < 0.3) {
        await prisma.comment.create({ data: { postId: p.id, authorId: U(p.author), parentId: c.id, text: 'Thank you! 🙏', createdAt: ago(int(1, 60 * 24 * 4)) } });
        comments++;
      }
    }
    const reposters = USERS.filter(u => u.u !== p.author && rnd() < 0.12);
    for (const r of reposters) await prisma.repost.create({ data: { userId: U(r.u), postId: p.id } });
    const [lc, cc, rc] = await Promise.all([
      prisma.like.count({ where: { postId: p.id } }), prisma.comment.count({ where: { postId: p.id } }), prisma.repost.count({ where: { postId: p.id } }),
    ]);
    await prisma.post.update({ where: { id: p.id }, data: { likeCount: lc, commentCount: cc, repostCount: rc } });
  }
  for (const p of postIds.filter(() => rnd() < 0.1)) {
    if (p.author !== 'amaka') await prisma.bookmark.create({ data: { userId: U('amaka'), postId: p.id } }).catch(() => null);
  }
  console.log(`  ✓ ${likes} likes, ${comments} comments`);

  // DMs (before gifts so gift receipts land in threads)
  for (const [a, b, lines] of DMS) {
    const conv = await prisma.conversation.create({ data: { members: { create: [{ userId: U(a) }, { userId: U(b), lastReadAt: ago(30) }] } } });
    for (const [k, line] of lines.entries()) {
      await prisma.message.create({ data: { conversationId: conv.id, senderId: k % 2 === 0 ? U(a) : U(b), text: line, createdAt: ago(200 - k * 20) } });
    }
  }
  console.log(`  ✓ ${DMS.length} conversations`);

  // Gifts through the real service (atomic, 80/20, notifications, wallet txs)
  const tiers = [200, 500, 2000, 3000];
  const assets = ['NGN', 'NGN', 'USDT', 'BNB', 'ETH', 'SOL'] as const;
  const giftTargets = [
    ...postIds.filter(p => p.author === 'amaka'),
    ...postIds.filter(p => ['davidokoro', 'danielade', 'michaeljohnson', 'sarahw', 'ifynwosu'].includes(p.author)),
  ];
  let gifts = 0;
  for (const p of giftTargets) {
    const n = p.author === 'amaka' ? int(2, 4) : int(0, 3);
    for (let k = 0; k < n; k++) {
      const sender = pick(USERS.filter(u => u.u !== p.author));
      try {
        const r = await sendGift(U(sender.u), { postId: p.id, amountNgn: pick(tiers), payAsset: pick([...assets]), network: 'BNB Chain' });
        const when = ago(int(10, 60 * 24 * 6));
        await prisma.gift.update({ where: { id: r.gift.id }, data: { createdAt: when } });
        await prisma.creatorEarning.updateMany({ where: { giftId: r.gift.id }, data: { createdAt: when } });
        await prisma.walletTransaction.updateMany({ where: { reference: r.gift.reference }, data: { createdAt: when, completedAt: when } });
        await prisma.notification.updateMany({ where: { type: 'GIFT_RECEIVED', title: { contains: `@${sender.u}` }, createdAt: { gt: ago(1) } }, data: { createdAt: when } });
        gifts++;
      } catch (e) {
        console.warn('    gift skipped:', (e as Error).message);
      }
    }
  }
  console.log(`  ✓ ${gifts} gifts (80% creator / 20% KAMKAM)`);

  // A few wallet actions for history
  await execute(U('amaka'), 'swap', { from: 'BNB', to: 'USDT', amount: '0.05' });
  await execute(U('amaka'), 'deposit', { amount: '20000', method: 'Paystack' });
  await execute(U('davidokoro'), 'transfer', { asset: 'USDT', toUsername: 'amaka', amount: '15', note: 'For the design review 🙏' });
  await execute(U('amaka'), 'buy', { asset: 'SOL', amountNgn: '25000', payWith: 'NGN' });

  // Social notifications for the main demo user
  const actors = ['davidokoro', 'sarahw', 'danielade', 'chrismorgan', 'michaeljohnson', 'ifynwosu'];
  const amakaPost = postIds.find(p => p.author === 'amaka')!;
  for (const [k, a] of actors.entries()) {
    const actor = USERS.find(u => u.u === a)!;
    const n1 = await notify({ userId: U('amaka'), actorId: U(a), type: NotificationType.LIKE, postId: amakaPost.id, title: `${actor.n} liked your post`, body: `"${amakaPost.text.slice(0, 60)}…"` });
    const n2 = k % 2 === 0
      ? await notify({ userId: U('amaka'), actorId: U(a), type: NotificationType.FOLLOW, title: `${actor.n} followed you`, body: 'You have 3 mutual connections.' })
      : await notify({ userId: U('amaka'), actorId: U(a), type: NotificationType.COMMENT, postId: amakaPost.id, title: `${actor.n} replied to your post`, body: `"${pick(COMMENTS)}"` });
    for (const n of [n1, n2]) if (n) await prisma.notification.update({ where: { id: n.id }, data: { createdAt: ago(int(30, 60 * 24 * 3)), read: rnd() < 0.4 } });
  }
  console.log('  ✓ notifications, wallet history');

  console.log('\nDone. Log in with  amaka@kamkam.local / password123  (or any @username with the same password).');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
