/**
 * End-to-end test of the REAL frontend data layer (lib/api.ts → supabase-js → PostgREST/Auth/Storage → Postgres RLS).
 * Run against a Supabase project or the local test stack (supabase/tests/local-stack.mjs):
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... npx tsx tests/api-client.test.ts
 * Creates fresh users each run (unique emails).
 */
(globalThis as unknown as { window: unknown }).window = { location: { origin: 'http://localhost:3000' } };

const { api, mediaUrl } = await import('../lib/api');
const { supabase } = await import('../lib/supabase');

let passed = 0, failed = 0;
const check = (name: string, ok: unknown, extra?: unknown) => {
  if (ok) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
};
const rejects = async (name: string, p: Promise<unknown>, re: RegExp) => {
  try { await p; check(name, false, 'expected error'); } catch (e) { check(name, re.test((e as Error).message + ' ' + ((e as { code?: string }).code ?? '')), (e as Error).message); }
};
const tag = Date.now().toString(36).slice(-6);
const A = { username: `ua_${tag}`, displayName: 'User A', email: `a_${tag}@test.local`, password: 'password123' };
const B = { username: `ub_${tag}`, displayName: 'User B', email: `b_${tag}@test.local`, password: 'password123' };
const as = async (u: typeof A) => { await api.logout(); return api.login({ identifier: u.email, password: u.password }); };
const png = () => new File([Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))], 'dot.png', { type: 'image/png' });

console.log(`\nAPI client E2E → ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

console.log('Auth & profile');
check('username available before sign-up', await api.usernameAvailable(A.username));
const ra = await api.register(A);
check('register A → signed in, profile created', ra.user?.username === A.username && ra.user.email === A.email);
await rejects('duplicate username rejected', api.register({ ...B, username: A.username }), /taken/i);
await api.logout();
check('logout clears session', !(await supabase().auth.getSession()).data.session);
await rejects('wrong password rejected', api.login({ identifier: A.email, password: 'nope-nope' }), /Incorrect email or password/);
await rejects('username login gives a clear message', api.login({ identifier: A.username, password: A.password }), /email address/i);
const rb = await api.register(B);
check('register B', rb.user?.username === B.username);
await rejects('session-less access is refused', (async () => { await api.logout(); return api.me(); })(), /log in|expired/i);

await as(A);
const avatar = await api.uploadProfileImage(png());
const cover = await api.uploadProfileImage(png());
const meA = (await api.updateMe({ bio: 'Hello', avatar, coverImage: cover, displayName: 'Creator A' })).user;
check('profile update with avatar + cover persisted', meA.displayName === 'Creator A' && meA.avatar === avatar && meA.coverImage === cover);
const pub = await fetch(mediaUrl(avatar));
check('avatar served from public URL', pub.ok && (pub.headers.get('content-type') ?? '').startsWith('image/'));
await rejects('profile image type validated', api.uploadProfileImage(new File(['x'], 'x.txt', { type: 'text/plain' })), /JPG, PNG/);
await rejects('profile image size validated', api.uploadProfileImage(new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })), /5 MB/);

console.log('\nPosts, media, polls');
const media = (await api.upload([png()])).files;
const { post } = await api.createPost({ text: `Launch post ${tag} #kamkam`, media });
check('create post with uploaded image', post.mediaUrls[0] === media[0].url && post.isMine);
const { post: pollPost } = await api.createPost({ text: 'Pick one', poll: ['Gifts', 'Search'] });
check('create poll post', pollPost.poll?.options.length === 2);
const edited = await api.updatePost(post.id, `Launch post ${tag} (edited) #kamkam`);
check('edit own post', !!edited.post.editedAt);
await api.createStory({ text: 'First story' });
check('story created', (await api.stories()).some(s => s.isMe && s.stories.length === 1));

await as(B);
const feed = await api.posts('foryou');
check('B sees A\'s post in feed', feed.posts.some(p => p.id === post.id));
await rejects('B cannot edit A\'s post', api.updatePost(post.id, 'hacked'), /only edit your own posts/);
await rejects('B cannot delete A\'s post', api.deletePost(post.id), /only delete your own/);
const liked = await api.like(post.id);
check('like', liked.likeCount === 1);
check('like is idempotent from the UI', (await api.like(post.id)).likeCount === 1);
const cm = await api.comment(post.id, 'Nice!');
check('comment', cm.commentCount === 1 && cm.comment.author.username === B.username);
check('repost + bookmark', (await api.repost(post.id)).repostCount === 1 && (await api.bookmark(post.id)).bookmarked);
check('vote in poll', (await api.votePoll(pollPost.id, pollPost.poll!.options[0].id)).post.poll?.myVote === pollPost.poll!.options[0].id);
const f = await api.follow(ra.user!.id);
check('follow', f.following && f.followers === 1);
check('B sees A\'s story after following', (await api.stories()).some(s => s.username === A.username));
check('search users + posts', (await api.search(A.username)).users.length === 1 && (await api.search(tag)).posts.length >= 1);
const comms = await api.communities();
await api.joinCommunity(comms[0].id);
check('join community persists', (await api.communities()).find(c => c.id === comms[0].id)?.joined === true);

console.log('\nMessaging');
const conv = await api.startConversation(ra.user!.id);
await api.sendMessage(conv.id, 'Hi A!');
const att = await api.sendAttachment(conv.id, png(), 'IMAGE');
check('send text + private image attachment', att.message.kind === 'IMAGE');
const signed = await api.attachmentUrl(att.message.attachment!);
check('member gets a working signed URL', (await fetch(signed)).ok);
const publicTry = await fetch(mediaUrl('post-media/' + att.message.attachment!.split('/').slice(1).join('/')));
check('attachment is NOT publicly readable', !publicTry.ok);

console.log('\nWallet: new accounts are empty');
const w0 = (await api.wallet()).wallet;
check('new account starts at ₦0 (no starter money)', Number(w0.ngn.balance) === 0 && Number(w0.ngn.earnings) === 0 && Number(w0.ngn.held) === 0, w0.ngn);
check('no crypto wallet until provisioned by the provider', w0.crypto === null && w0.cryptoActivated === false);
check('no fabricated transactions', (await api.transactions('all')).transactions.length === 0);
await rejects('gift with ₦0 balance refused', api.sendGift({ postId: post.id, amountNgn: 2000 }), /Insufficient/);
await rejects('crypto-paid gifts not offered', (async () => { const { error } = await supabase().rpc('send_gift', { p_params: { postId: post.id, amountNgn: 2000, payAsset: 'USDT' }, p_idempotency_key: crypto.randomUUID() }); if (error) throw error; })(), /Naira balance/);

// Funding: the client cannot credit itself (checked below). On the LOCAL stack only, the test settles a
// payment through the same service-role function the verified Paystack webhook calls.
const serviceKey = process.env.KAMKAM_TEST_SERVICE_KEY;
if (serviceKey) {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } });
  const ref = 'kk_dep_test_' + tag;
  const { error: e1 } = await svc.rpc('svc_payment_create', { p_user: rb.user!.id, p_reference: ref, p_amount: 10000, p_channel: 'card' });
  const { data: settled, error: e2 } = await svc.rpc('svc_payment_settle', { p_reference: ref, p_status: 'success', p_amount_kobo: 1000000, p_currency: 'NGN', p_channel: 'card', p_paid_at: null });
  check('test deposit settled via the webhook settlement function', !e1 && !e2 && settled?.outcome === 'credited', e1 ?? e2 ?? settled);
}
check('client cannot credit itself', !!(await supabase().rpc('svc_payment_settle', { p_reference: 'x', p_status: 'success', p_amount_kobo: 1e9, p_currency: 'NGN' })).error);

if (serviceKey) {
  console.log('\nGift (₦2,000 from the verified Naira balance)');
  const gq = await api.giftQuote({ postId: post.id, amountNgn: 2000 });
  check('server quote: creator ₦1,600, KAMKAM ₦400', Number(gq.quote.creatorAmountNgn) === 1600 && Number(gq.quote.platformFeeNgn) === 400 && gq.quote.sufficient);
  const key = crypto.randomUUID();
  const g = await api.sendGift({ postId: post.id, amountNgn: 2000 }, key);
  check('gift sent; post updated (liked + Super Like + boost)', g.post?.giftCount === 1 && g.post.superLiked && g.post.boosted);
  const again = await api.sendGift({ postId: post.id, amountNgn: 2000 }, key);
  check('retrying with the same key does not charge twice', again.gift.id === g.gift.id && Number((await api.wallet()).wallet.ngn.balance) === 8000);

  console.log('\nTransfers');
  const tr = await api.transfer({ toUsername: '@' + A.username, amount: '1000', note: 'thanks' });
  check('transfer to @A completes instantly', tr.status === 'COMPLETED' && Number((await api.wallet()).wallet.ngn.balance) === 7000);
  await rejects('transfer beyond balance refused', api.transfer({ toUsername: A.username, amount: '999999' }), /Insufficient|Maximum/);
  const hist = (await api.transactions('all')).transactions;
  check('history = real deposit, gift and transfer only (none simulated)', ['DEPOSIT', 'GIFT_SENT', 'TRANSFER'].every(t => hist.some(x => x.type === t)) && hist.every(x => x.simulated === false), hist.map(x => x.type));
}

console.log('\nLive sessions');
await as(A);
check('live list starts empty (no sample streams)', (await api.lives()).filter(l => l.host.username === A.username).length === 0);
const lv = await api.startLive('Launch Q&A ' + tag);
await as(B);
const hb = await api.liveHeartbeat(lv.id);
check('viewer presence is real (host + B)', hb.viewers === 2);
await api.liveChat(lv.id, 'Hello from B');
check('chat message stored and visible', (await api.live(lv.id)).messages.some(m => m.body === 'Hello from B' && m.user.username === B.username));
await rejects('only the host can end the live', api.endLive(lv.id), /host|not allowed|FORBIDDEN/i);
await as(A);
check('host ends the live', (await api.endLive(lv.id)).status === 'ended');

const n = await api.notifications('all');
check('A notified: follow, like, comment' + (serviceKey ? ', gift, transfer' : ''), ['FOLLOW', 'LIKE', 'COMMENT', ...(serviceKey ? ['GIFT_RECEIVED', 'TRANSACTION_COMPLETED'] : [])].every(t => n.notifications.some(x => x.type === t)));
const thread = (await api.messages(conv.id)).messages;
check('A sees B\'s DM and attachment' + (serviceKey ? ' and gift receipt' : ''), ['TEXT', 'IMAGE', ...(serviceKey ? ['GIFT'] : [])].every(k => thread.some(m => m.kind === k)));
if (serviceKey) {
  const e = await api.earnings();
  check('creator earnings ₦1,600 (80%)', Number(e.earnings.availableNgn) === 1600 && e.earnings.totalGifts === 1);
  await api.moveEarnings('600');
  const wa = (await api.wallet()).wallet;
  check('earnings → balance (₦1,000 transfer + ₦600)', Number(wa.ngn.balance) === 1600 && Number(wa.ngn.earnings) === 1000);
}
check('A cannot read B\'s Naira wallet', (await supabase().from('ngn_wallets').select('user_id')).data!.every(r => r.user_id === ra.user!.id));
check('A cannot read platform revenue entries', ((await supabase().from('ledger_entries').select('*').is('user_id', null)).data ?? []).length === 0);
check('the old demo tables are gone from the API', !!(await supabase().from('wallet_assets').select('*')).error);

await api.deletePost(pollPost.id);
check('delete own post', !(await api.posts('foryou')).posts.some(p => p.id === pollPost.id));
await api.logout();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
