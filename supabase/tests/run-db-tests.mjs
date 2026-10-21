// KAMKAM database security & behaviour tests.
// Applies supabase/migrations to a fresh local PostgreSQL (with shim.sql) and
// exercises RLS, triggers and money functions as separate signed-in users.
//
// Money tests call svc_* functions as service_role — exactly what the Next.js
// server does AFTER verifying a payment/transfer with Paystack. They test
// KAMKAM's ledger logic; they do not (and cannot) test Paystack itself.
//   cd supabase/tests && npm install && npm run db:test
import crypto from 'node:crypto';
import { applyMigrations, createFreshDb, Db, check, rejects, summary } from './harness.mjs';

const uuid = () => crypto.randomUUID();
const num = v => Number(v);
const LEGACY_LAST = '20261016000900_grants_fixups.sql';

// ── Phase 1: a database at the OLD (demo-wallet) schema with legacy users ──
const url = await createFreshDb('kamkam_sb_test', { upTo: LEGACY_LAST });
const db = new Db(url);
console.log('\nLegacy demo-wallet schema applied. Creating legacy users…');
const L1 = await db.signUp('legacy1@test.local', { username: 'legacy_one', display_name: 'Legacy One' });
const L2 = await db.signUp('legacy2@test.local', { username: 'legacy_two', display_name: 'Legacy Two' });
const legacyNgn = num((await db.admin(`select balance from wallet_assets where user_id = $1 and symbol = 'NGN'`, [L1.id]))[0].balance);
await db.rpc(L1, 'activate_wallet');
const lpost = await db.rpc(L2, 'create_post', { p_text: 'legacy post', p_media: [], p_reply_policy: 'Everyone', p_poll: null });
await db.rpc(L1, 'send_gift', { p_params: { postId: lpost.id, amountNgn: 2000, payAsset: 'USDT' }, p_idempotency_key: uuid() });
const legacyTotalBefore = num((await db.admin(`select sum(balance * a.rate_ngn) v from wallet_assets wa join assets a on a.symbol = wa.symbol where user_id = $1`, [L1.id]))[0].v);

// ── Phase 2: apply the real-money migrations ──
await applyMigrations(url, { after: LEGACY_LAST });
console.log('Real-money migrations applied.\n');

console.log('Demo money archived (root cause of ₦50,000 / ₦750k-style balances)');
check(`legacy sign-up had received demo ₦${legacyNgn.toLocaleString()} (the bug)`, legacyNgn === 50000);
check(`legacy wallet showed ₦${legacyTotalBefore.toLocaleString()} of demo value`, legacyTotalBefore > 700000);
const snap = await db.admin(`select * from demo_archive.balances_snapshot where user_id = $1`, [L1.id]);
check('demo balances preserved in demo_archive (not deleted)', snap.length === 5 && snap.some(r => r.symbol === 'NGN'));
check('demo tables removed from the public API', (await db.admin(`select to_regclass('public.wallet_assets') t, to_regclass('public.wallet_transactions') u`))[0].t === null);
check('legacy user now has a ₦0 real wallet', (await db.admin(`select balance, earnings, held from ngn_wallets where user_id = $1`, [L1.id])).every(w => num(w.balance) === 0 && num(w.earnings) === 0 && num(w.held) === 0));
check('legacy creator earnings from demo gifts reset to ₦0', num((await db.admin(`select earnings from ngn_wallets where user_id = $1`, [L2.id]))[0].earnings) === 0);
check('demo gift counters / Super Likes reset', (await db.admin(`select gift_count, super_like_count, earned_ngn from posts where id = $1`, [lpost.id]))
  .every(p => p.gift_count === 0 && p.super_like_count === 0 && num(p.earned_ngn) === 0));
check('demo gift notifications archived', (await db.admin(`select count(*)::int n from notifications where type = 'GIFT_RECEIVED'`))[0].n === 0
  && (await db.admin(`select count(*)::int n from demo_archive.notifications`))[0].n >= 1);
await rejects('archive schema is not readable by users', db.sql(L1, `select * from demo_archive.balances_snapshot`), /permission denied/);
check('legacy user\'s wallet activity is empty (no fabricated history)', (await db.rpc(L1, 'wallet_activity', { p_filter: 'all', p_limit: 50 })).transactions.length === 0);

// ── Accounts ──────────────────────────────────────────────────────
console.log('Accounts & profiles');
const A = await db.signUp('a@test.local', { username: 'creator_a', display_name: 'Creator A' });
const B = await db.signUp('b@test.local', { username: 'fan_b', display_name: 'Fan B' });
const C = await db.signUp('c@test.local', { username: 'stranger_c', display_name: 'Stranger C' });
const [pa] = await db.admin(`select * from profiles where id = $1`, [A.id]);
check('sign-up creates profile with chosen username', pa?.username === 'creator_a');
const [wa] = await db.admin(`select balance, earnings, held from ngn_wallets where user_id = $1`, [A.id]);
check('sign-up creates an EMPTY NGN wallet (₦0 — no starter money)', num(wa.balance) === 0 && num(wa.earnings) === 0 && num(wa.held) === 0);
await rejects('duplicate username is rejected at sign-up', db.signUp('dup@test.local', { username: 'creator_a' }), /taken|23505/);
check('username_available works for anon', (await db.rpc(null, 'username_available', { p_username: 'creator_a' })) === false && (await db.rpc(null, 'username_available', { p_username: 'brand_new' })) === true);
await rejects('anon cannot read profiles', db.sql(null, `select * from profiles`), /permission denied/);
const me = await db.rpc(A, 'me');
check('me() returns profile + email', me.username === 'creator_a' && me.email === 'a@test.local');

await db.sql(A, `update profiles set display_name = 'Creator A+', bio = 'hi' where id = $1`, [A.id]);
check('user can update own profile', (await db.admin(`select display_name from profiles where id = $1`, [A.id]))[0].display_name === 'Creator A+');
await db.sql(B, `update profiles set display_name = 'hacked' where id = $1`, [A.id]);
check('user cannot update another profile (0 rows)', (await db.admin(`select display_name from profiles where id = $1`, [A.id]))[0].display_name === 'Creator A+');
await rejects('user cannot set verified=true on own profile', db.sql(A, `update profiles set verified = true where id = $1`, [A.id]), /permission denied/);
await rejects('user cannot edit follower_count', db.sql(A, `update profiles set follower_count = 9999 where id = $1`, [A.id]), /permission denied/);
await rejects('avatar must live in own storage folder', db.sql(A, `update profiles set avatar_path = $2 where id = $1`, [A.id, `avatars/${B.id}/x.jpg`]), /profiles_avatar_path/);
await db.sql(A, `update profiles set avatar_path = $2, cover_path = $3 where id = $1`, [A.id, `avatars/${A.id}/a.jpg`, `avatars/${A.id}/c.jpg`]);
check('avatar + cover in own folder accepted', (await db.admin(`select cover_path from profiles where id = $1`, [A.id]))[0].cover_path.endsWith('/c.jpg'));

// ── Storage ───────────────────────────────────────────────────────
console.log('\nStorage policies');
await db.sql(A, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${A.id}/a.jpg`]);
check('upload to own avatar folder allowed', true);
await rejects('upload into another user\'s folder blocked', db.sql(A, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${B.id}/evil.jpg`]), /row-level security/);
await rejects('upload to post-media of another user blocked', db.sql(B, `insert into storage.objects (bucket_id, name) values ('post-media', $1)`, [`${A.id}/x.png`]), /row-level security/);
const delOther = await db.sql(B, `delete from storage.objects where bucket_id = 'avatars' and name = $1 returning id`, [`${A.id}/a.jpg`]);
check('cannot delete another user\'s file', delOther.length === 0);
const buckets = await db.admin(`select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id`);
check('buckets: avatars public 5MB images', buckets.find(b => b.id === 'avatars')?.public === true && Number(buckets.find(b => b.id === 'avatars').file_size_limit) === 5242880);
check('buckets: message-attachments is PRIVATE', buckets.find(b => b.id === 'message-attachments')?.public === false);

// ── Posts ─────────────────────────────────────────────────────────
console.log('\nPosts, media, polls');
const post = await db.rpc(A, 'create_post', { p_text: 'Hello KAMKAM #launch', p_media: [], p_reply_policy: 'Everyone', p_poll: null });
check('create_post returns post JSON', post.id && post.isMine === true && post.author.username === 'creator_a');
const feedB = await db.rpc(B, 'feed', { p_tab: 'foryou', p_offset: 0, p_limit: 20 });
check('other user sees post in feed', feedB.posts.some(p => p.id === post.id) && feedB.posts.find(p => p.id === post.id).isMine === false);
await db.sql(B, `update posts set text = 'pwned' where id = $1`, [post.id]);
await db.sql(B, `delete from posts where id = $1`, [post.id]);
check('cannot edit or delete another user\'s post', (await db.admin(`select text from posts where id = $1`, [post.id]))[0]?.text === 'Hello KAMKAM #launch');
await rejects('cannot forge counters on own post', db.sql(A, `update posts set like_count = 999 where id = $1`, [post.id]), /permission denied/);
await rejects('cannot create a post as someone else', db.sql(B, `insert into posts (author_id, text) values ($1, 'fake')`, [A.id]), /row-level security/);
await db.sql(A, `update posts set text = 'Hello KAMKAM (edited) #launch' where id = $1`, [post.id]);
check('author can edit own post (edited_at set)', !!(await db.admin(`select edited_at from posts where id = $1`, [post.id]))[0].edited_at);
const mpost = await db.rpc(A, 'create_post', { p_text: 'pic', p_media: [{ path: `post-media/${A.id}/p.jpg`, kind: 'IMAGE' }], p_reply_policy: 'Everyone', p_poll: null });
check('post with own media', mpost.mediaUrls[0] === `post-media/${A.id}/p.jpg` && mpost.mediaType === 'IMAGE');
await rejects('cannot attach media from another user\'s folder', db.rpc(B, 'create_post', { p_text: 'x', p_media: [{ path: `post-media/${A.id}/p.jpg`, kind: 'IMAGE' }], p_reply_policy: 'Everyone', p_poll: null }), /row-level security/);
await rejects('empty post rejected', db.rpc(A, 'create_post', { p_text: '  ', p_media: [], p_reply_policy: 'Everyone', p_poll: null }), /EMPTY_POST|Write something/);
const poll = await db.rpc(A, 'create_post', { p_text: 'Which feature?', p_media: [], p_reply_policy: 'Everyone', p_poll: ['Gifts', 'Search', 'Feed'] });
check('poll created with 3 options', poll.poll?.options.length === 3);
await db.sql(B, `insert into poll_votes (post_id, option_id, user_id) values ($1, $2, $3)`, [poll.id, poll.poll.options[0].id, B.id]);
await rejects('cannot vote twice', db.sql(B, `insert into poll_votes (post_id, option_id, user_id) values ($1, $2, $3)`, [poll.id, poll.poll.options[1].id, B.id]), /duplicate key/);
await rejects('cannot vote as someone else', db.sql(B, `insert into poll_votes (post_id, option_id, user_id) values ($1, $2, $3)`, [poll.id, poll.poll.options[1].id, C.id]), /row-level security/);
const pollA = await db.rpc(A, 'post_detail', { p_id: poll.id });
check('poll totals visible, voter identity private', pollA.poll.total === 1 && pollA.poll.myVote === null && (await db.sql(A, `select * from poll_votes`)).length === 0);

// ── Likes, comments, reposts, bookmarks, follows ──────────────────
console.log('\nSocial interactions & notifications');
await db.sql(B, `insert into likes (user_id, post_id) values ($1, $2)`, [B.id, post.id]);
check('like increments counter', (await db.rpc(B, 'post_counts', { p_id: post.id })).likeCount === 1);
await rejects('duplicate like blocked by constraint', db.sql(B, `insert into likes (user_id, post_id) values ($1, $2)`, [B.id, post.id]), /duplicate key/);
await rejects('cannot like as another user', db.sql(B, `insert into likes (user_id, post_id) values ($1, $2)`, [C.id, post.id]), /row-level security/);
await rejects('cannot self-award a Super Like', db.sql(C, `insert into likes (user_id, post_id, super_like) values ($1, $2, true)`, [C.id, post.id]), /permission denied/);
check('likes of others are private', (await db.sql(C, `select * from likes`)).length === 0);
const nA1 = await db.rpc(A, 'notifications_list', { p_filter: 'likes' });
check('creator notified of like', nA1.notifications.some(n => n.type === 'LIKE' && n.actor.username === 'fan_b'));

await db.sql(B, `insert into comments (post_id, author_id, text) values ($1, $2, 'Great post!')`, [post.id, B.id]);
const [cm] = await db.admin(`select id from comments where post_id = $1`, [post.id]);
await db.sql(B, `update profiles set settings = settings || '{"mentions": false}'::jsonb where id = $1`, [B.id]); // B: replies from anyone
await db.sql(A, `insert into comments (post_id, author_id, parent_id, text) values ($1, $2, $3, 'Thanks!')`, [post.id, A.id, cm.id]);
check('comment + reply counted', (await db.rpc(A, 'post_counts', { p_id: post.id })).commentCount === 2);
check('reply notifies the parent commenter', (await db.rpc(B, 'notifications_list', { p_filter: 'comments' })).notifications.some(n => n.title.includes('replied to your comment')));
check('comments_list returns thread', (await db.rpc(C, 'comments_list', { p_post: post.id })).length === 2);
const fpost = await db.rpc(A, 'create_post', { p_text: 'followers only', p_media: [], p_reply_policy: 'Followers', p_poll: null });
await rejects('reply policy "Followers" enforced', db.sql(C, `insert into comments (post_id, author_id, text) values ($1, $2, 'hi')`, [fpost.id, C.id]), /followers/i);

await db.sql(B, `insert into reposts (user_id, post_id) values ($1, $2)`, [B.id, post.id]);
await db.sql(B, `insert into bookmarks (user_id, post_id) values ($1, $2)`, [B.id, post.id]);
check('bookmarks are private', (await db.sql(A, `select * from bookmarks`)).length === 0 && (await db.rpc(B, 'bookmarks_list')).posts.length === 1);

await db.sql(B, `insert into follows (follower_id, following_id) values ($1, $2)`, [B.id, A.id]);
await rejects('duplicate follow blocked', db.sql(B, `insert into follows (follower_id, following_id) values ($1, $2)`, [B.id, A.id]), /duplicate key/);
await rejects('cannot follow on behalf of another user', db.sql(B, `insert into follows (follower_id, following_id) values ($1, $2)`, [C.id, A.id]), /row-level security/);
await rejects('cannot follow yourself', db.sql(A, `insert into follows (follower_id, following_id) values ($1, $1)`, [A.id]), /follows_not_self/);
const profA = await db.rpc(B, 'profile_view', { p_key: 'creator_a' });
check('follower counts + isFollowing', profA.stats.followers === 1 && profA.isFollowing === true && profA.isMe === false);
check('follow notification created', (await db.rpc(A, 'notifications_list', { p_filter: 'followers' })).notifications.length === 1);
check('following feed shows followed creator', (await db.rpc(B, 'feed', { p_tab: 'following', p_offset: 0, p_limit: 20 })).posts.some(p => p.id === post.id));

await rejects('clients cannot create notifications', db.sql(B, `insert into notifications (user_id, type, title) values ($1, 'GIFT_RECEIVED', 'fake gift')`, [A.id]), /permission denied/);
check('cannot read another user\'s notifications', (await db.sql(B, `select * from notifications where user_id = $1`, [A.id])).length === 0);
await db.sql(A, `update notifications set read = true where user_id = $1`, [A.id]);
check('mark own notifications read', (await db.rpc(A, 'me')).unreadNotifications === 0);
await rejects('cannot rewrite notification text', db.sql(A, `update notifications set title = 'x'`), /permission denied/);

const s = await db.rpc(C, 'search', { p_q: 'creator' });
check('search finds users', s.users.some(u => u.username === 'creator_a'));
check('search finds posts', (await db.rpc(C, 'search', { p_q: 'KAMKAM' })).posts.length >= 1);
check('trending hashtags', (await db.rpc(C, 'trending', { p_limit: 5 })).topics.some(t => t.tag.toLowerCase() === '#launch'));

// ── Stories & communities ─────────────────────────────────────────
console.log('\nStories & communities');
await db.sql(A, `insert into stories (author_id, text) values ($1, 'My first story')`, [A.id]);
check('follower sees story', (await db.rpc(B, 'stories_feed')).some(x => x.username === 'creator_a' && x.stories.length === 1));
check('non-follower does not get it in their story row', !(await db.rpc(C, 'stories_feed')).some(x => x.username === 'creator_a'));
await db.admin(`update stories set expires_at = now() - interval '1 minute' where author_id = $1`, [A.id]);
check('expired stories disappear', (await db.rpc(B, 'stories_feed')).length === 0);
const comms = await db.rpc(B, 'communities_list');
check('default communities seeded', comms.length === 6);
await db.sql(B, `insert into community_members (community_id, user_id) values ($1, $2)`, [comms[0].id, B.id]);
await rejects('cannot join on behalf of another user', db.sql(B, `insert into community_members (community_id, user_id) values ($1, $2)`, [comms[1].id, C.id]), /row-level security/);
await db.sql(C, `insert into communities (name, description, created_by) values ('Lagos Devs', 'Builders', $1)`, [C.id]);
check('create community auto-joins creator', (await db.rpc(C, 'communities_list')).find(c => c.name === 'Lagos Devs')?.joined === true);

// ── Messaging ─────────────────────────────────────────────────────
console.log('\nMessaging privacy');
const conv = await db.rpc(B, 'start_conversation', { p_user: A.id });
check('start_conversation is find-or-create', (await db.rpc(A, 'start_conversation', { p_user: B.id })) === conv);
await db.sql(B, `insert into messages (conversation_id, sender_id, body) values ($1, $2, 'Hi creator!')`, [conv, B.id]);
check('recipient sees message + unread count', (await db.rpc(A, 'conversation_view', { p_conversation: conv })).messages.length === 1 && (await db.rpc(A, 'me')).unreadMessages === 1);
await db.rpc(A, 'mark_conversation_read', { p_conversation: conv });
check('mark read clears unread + shows read receipt', (await db.rpc(A, 'me')).unreadMessages === 0 && (await db.rpc(B, 'conversation_view', { p_conversation: conv })).messages[0].read === true);
await rejects('outsider cannot open the conversation', db.rpc(C, 'conversation_view', { p_conversation: conv }), /not part of this conversation/);
check('outsider cannot read messages directly', (await db.sql(C, `select * from messages where conversation_id = $1`, [conv])).length === 0);
await rejects('outsider cannot post into the conversation', db.sql(C, `insert into messages (conversation_id, sender_id, body) values ($1, $2, 'spam')`, [conv, C.id]), /row-level security/);
await rejects('cannot send a message as someone else', db.sql(B, `insert into messages (conversation_id, sender_id, body) values ($1, $2, 'fake')`, [conv, A.id]), /row-level security/);
await rejects('cannot add members to a conversation', db.sql(C, `insert into conversation_members (conversation_id, user_id) values ($1, $2)`, [conv, C.id]), /permission denied/);
await rejects('cannot forge gift messages', db.sql(B, `insert into messages (conversation_id, sender_id, kind, body) values ($1, $2, 'GIFT', 'Gift sent · ₦1,000,000')`, [conv, B.id]), /row-level security/);
await db.sql(B, `insert into storage.objects (bucket_id, name) values ('message-attachments', $1)`, [`${conv}/${B.id}/photo.jpg`]);
check('member can read private attachment', (await db.sql(A, `select id from storage.objects where bucket_id = 'message-attachments'`)).length === 1);
check('outsider cannot read private attachment', (await db.sql(C, `select id from storage.objects where bucket_id = 'message-attachments'`)).length === 0);
await rejects('outsider cannot upload into the conversation', db.sql(C, `insert into storage.objects (bucket_id, name) values ('message-attachments', $1)`, [`${conv}/${C.id}/x.jpg`]), /row-level security/);
await db.sql(B, `insert into messages (conversation_id, sender_id, kind, attachment_path) values ($1, $2, 'IMAGE', $3)`, [conv, B.id, `message-attachments/${conv}/${B.id}/photo.jpg`]);
check('image message with own attachment', (await db.rpc(A, 'conversation_view', { p_conversation: conv })).messages.length === 2);

console.log('\nSettings enforcement');
await rejects('DMs restricted to followers by default', db.rpc(C, 'start_conversation', { p_user: A.id }), /only accepts messages from their followers/);
await db.sql(A, `update profiles set settings = settings || '{"dms": true}'::jsonb where id = $1`, [A.id]);
check('"Direct messages from anyone" opens DMs', typeof (await db.rpc(C, 'start_conversation', { p_user: A.id })) === 'string');
await db.sql(A, `update profiles set settings = settings || '{"dms": false}'::jsonb where id = $1`, [A.id]);
const countN = async (u, like) => (await db.admin(`select count(*)::int n from notifications where user_id = $1 and type = 'COMMENT' and title like $2`, [u.id, like]))[0].n;
const aPostN = await countN(A, '%replied to your post');
await db.sql(C, `insert into comments (post_id, author_id, text) values ($1, $2, 'from a stranger')`, [post.id, C.id]);
check('comments on your own post always notify (even from strangers)', (await countN(A, '%replied to your post')) === aPostN + 1);
await db.sql(B, `update profiles set settings = settings || '{"mentions": true}'::jsonb where id = $1`, [B.id]);
const bReplyN = await countN(B, '%replied to your comment');
await db.sql(C, `insert into comments (post_id, author_id, parent_id, text) values ($1, $2, $3, 'stranger reply')`, [post.id, C.id, cm.id]);
check('"Mentions and replies: only from people I follow" filters comment replies', (await countN(B, '%replied to your comment')) === bReplyN);


// ── New accounts start at zero ────────────────────────────────────
console.log('\nNew accounts: no money, no fabricated history');
const ov = await db.rpc(B, 'wallet_overview');
check('new user NGN balance ₦0 / earnings ₦0 / held ₦0', num(ov.ngn.balance) === 0 && num(ov.ngn.earnings) === 0 && num(ov.ngn.held) === 0);
check('no crypto wallet until provisioned (no fake addresses)', ov.crypto === null && (await db.rpc(B, 'me')).walletActivated === false);
check('no fabricated transaction history', (await db.rpc(B, 'wallet_activity', { p_filter: 'all', p_limit: 50 })).transactions.length === 0);
check('no fabricated earnings', num((await db.rpc(A, 'earnings_summary')).totalEarnedNgn) === 0);

// ── Tamper resistance ─────────────────────────────────────────────
console.log('\nWallet tamper-resistance');
await rejects('cannot credit own balance', db.sql(B, `update ngn_wallets set balance = 1e9 where user_id = $1`, [B.id]), /permission denied/);
await rejects('cannot insert ledger entries', db.sql(B, `insert into ledger_entries (user_id, account, amount, entry_type, reference, description) values ($1, 'balance', 1e9, 'DEPOSIT', 'x', 'x')`, [B.id]), /permission denied/);
await rejects('cannot mark a payment as paid', db.sql(B, `update payments set status = 'success'`), /permission denied/);
await rejects('cannot call svc_payment_settle', db.sql(B, `select public.svc_payment_settle('x', 'success', 100000000, 'NGN')`), /permission denied/);
await rejects('cannot call internal _ledger()', db.sql(B, `select public._ledger($1, 'balance', 1000000, 'DEPOSIT', 'x', 'x')`, [B.id]), /permission denied/);
await rejects('cannot forge a gift row', db.sql(B, `insert into gifts (sender_id, recipient_id, amount_ngn, creator_amount_ngn, platform_fee_ngn, reference, idempotency_key) values ($1, $2, 1, 1, 0, 'x', gen_random_uuid())`, [B.id, A.id]), /permission denied/);
await rejects('cannot read webhook events', db.sql(B, `select * from webhook_events`), /permission denied/);
await rejects('cannot record a fake crypto send', db.sql(B, `insert into crypto_transactions (user_id, network, asset, amount, amount_atomic, from_address, to_address, idempotency_key) values ($1,'base','ETH','1','1','0x','0x',gen_random_uuid())`, [B.id]), /permission denied/);
await rejects('cannot attach a wallet address to self', db.sql(B, `insert into crypto_wallets (user_id, network_mode, evm_account_name, solana_account_name, evm_address, status) values ($1, 'mainnet', 'x', 'y', '0x${'ab'.repeat(20)}', 'ready')`, [B.id]), /permission denied/);
await rejects('a gift with ₦0 balance is refused', db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 200 }, p_idempotency_key: uuid() }), /Insufficient balance/);
check('…and leaves no partial records', (await db.admin(`select count(*)::int n from gifts`))[0].n === 0 && (await db.admin(`select count(*)::int n from ledger_entries`))[0].n === 0);

// ── Deposits (Paystack settlement logic) ──────────────────────────
console.log('\nDeposits — credited only after verified settlement');
const pay = async (u, amount) => (await db.svc('svc_payment_create', { p_user: u.id, p_reference: 'KK-DEP-' + uuid().slice(0, 8), p_amount: amount, p_channel: 'card' }));
const ngnOf = async u => (await db.admin(`select balance, earnings, held from ngn_wallets where user_id = $1`, [u.id]))[0];
const p1 = await pay(B, 10000);
check('initialized payment does not credit anything', num((await ngnOf(B)).balance) === 0);
const s1 = await db.svc('svc_payment_settle', { p_reference: p1.reference, p_status: 'success', p_amount_kobo: 1000000, p_currency: 'NGN', p_channel: 'card' });
check('verified success credits exactly once', s1.outcome === 'credited' && num((await ngnOf(B)).balance) === 10000);
const s1dup = await db.svc('svc_payment_settle', { p_reference: p1.reference, p_status: 'success', p_amount_kobo: 1000000, p_currency: 'NGN', p_channel: 'card' });
check('duplicate webhook/verify does not credit twice', s1dup.outcome === 'already_credited' && num((await ngnOf(B)).balance) === 10000);
const p2 = await pay(B, 5000);
const s2 = await db.svc('svc_payment_settle', { p_reference: p2.reference, p_status: 'success', p_amount_kobo: 100, p_currency: 'NGN' });
check('amount mismatch is refused and flagged for review', s2.outcome === 'mismatch' && num((await ngnOf(B)).balance) === 10000
  && (await db.admin(`select needs_review from payments where reference = $1`, [p2.reference]))[0].needs_review === true);
const p3 = await pay(B, 3000);
const s3 = await db.svc('svc_payment_settle', { p_reference: p3.reference, p_status: 'failed', p_amount_kobo: 300000, p_currency: 'NGN' });
check('failed payment never credits', s3.outcome === 'failed' && num((await ngnOf(B)).balance) === 10000);
check('wrong currency refused', (await db.svc('svc_payment_settle', { p_reference: (await pay(B, 1000)).reference, p_status: 'success', p_amount_kobo: 100000, p_currency: 'USD' })).outcome === 'mismatch');
check('unknown reference ignored', (await db.svc('svc_payment_settle', { p_reference: 'KK-NOPE', p_status: 'success', p_amount_kobo: 1, p_currency: 'NGN' })).outcome === 'unknown_reference');
await rejects('deposit limits enforced', pay(B, 50), /between/);
const ev = 'evt-' + uuid();
check('webhook event processed at most once', (await db.svc('svc_webhook_seen', { p_provider: 'paystack', p_event: 'charge.success', p_key: ev, p_reference: 'x' })) === false
  && (await db.svc('svc_webhook_seen', { p_provider: 'paystack', p_event: 'charge.success', p_key: ev, p_reference: 'x' })) === true);
const p4 = await pay(C, 50000);
await db.svc('svc_payment_settle', { p_reference: p4.reference, p_status: 'success', p_amount_kobo: 5000000, p_currency: 'NGN' });
const act0 = await db.rpc(B, 'wallet_activity', { p_filter: 'deposits', p_limit: 20 });
check('activity shows the real deposit + the failed attempt, none simulated', act0.transactions.some(t => t.status === 'COMPLETED' && t.amount === '10000.00')
  && act0.transactions.some(t => t.status === 'FAILED') && act0.transactions.every(t => t.simulated === false));
check('deposit notification', (await db.rpc(B, 'notifications_list', { p_filter: 'wallet' })).notifications.some(n => n.title === 'Wallet funded'));
check('cannot see another user\'s payments', (await db.sql(A, `select * from payments where user_id = $1`, [B.id])).length === 0);

// ── Gifts ─────────────────────────────────────────────────────────
console.log('\nGifts · 80/20 · idempotency · double spend');
await rejects('crypto-paid gifts are not offered (no fabricated conversion)', db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 2000, payAsset: 'USDT' }, p_idempotency_key: uuid() }), /Naira balance/);
const gq = await db.rpc(B, 'gift_quote', { p_params: { postId: post.id, amountNgn: 2000 } });
check('quote: ₦2,000 → creator ₦1,600, fee ₦400, sufficient', num(gq.creatorAmountNgn) === 1600 && num(gq.platformFeeNgn) === 400 && gq.sufficient === true);
const gkey = uuid();
const g1 = await db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 2000, creatorAmountNgn: 999999 }, p_idempotency_key: gkey });
check('gift processed; client-supplied split ignored', num(g1.gift.creatorAmountNgn) === 1600);
check('sender debited ₦2,000 from verified balance', num((await ngnOf(B)).balance) === 8000);
const g1dup = await db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 2000 }, p_idempotency_key: gkey });
check('repeated click with same key = same gift, no double charge', g1dup.gift.id === g1.gift.id && num((await ngnOf(B)).balance) === 8000
  && (await db.admin(`select count(*)::int n from gifts`))[0].n === 1);
check('creator earnings +₦1,600 (80%)', num((await ngnOf(A)).earnings) === 1600);
check('KAMKAM platform revenue +₦400 (20%)', num((await db.admin(`select sum(amount) s from ledger_entries where account = 'platform_revenue' and entry_type = 'PLATFORM_FEE'`))[0].s) === 400);
const pv = await db.rpc(B, 'post_detail', { p_id: post.id });
check('gift auto-likes once + Super Like + count + boost', pv.liked && pv.superLiked && pv.likeCount === 1 && pv.superLikeCount === 1 && pv.giftCount === 1 && pv.boosted);
check('creator notified with the real amounts', (await db.rpc(A, 'notifications_list', { p_filter: 'gifts' })).notifications.some(n => n.title.includes('₦2,000 Gift') && n.body.includes('₦1,600')));
check('gift receipt appears in the DM thread', (await db.rpc(A, 'conversation_view', { p_conversation: conv })).messages.some(m => m.kind === 'GIFT'));
check('outsider cannot see the gift', (await db.sql(C, `select * from gifts`)).length === 0);
await db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 1000 }, p_idempotency_key: uuid() });
await db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: 333 }, p_idempotency_key: uuid() });
const splits = await db.admin(`select amount_ngn, creator_amount_ngn, platform_fee_ngn from gifts`);
check('₦1,000 → ₦800 creator / ₦200 KAMKAM', splits.some(x => num(x.amount_ngn) === 1000 && num(x.creator_amount_ngn) === 800 && num(x.platform_fee_ngn) === 200));
check('₦333 → ₦266.40 / ₦66.60 (exact)', splits.some(x => num(x.amount_ngn) === 333 && num(x.creator_amount_ngn) === 266.4 && num(x.platform_fee_ngn) === 66.6));
await rejects('cannot gift yourself (no money creation)', db.rpc(A, 'send_gift', { p_params: { postId: post.id, amountNgn: 500 }, p_idempotency_key: uuid() }), /yourself/);
await rejects('non-integer gift rejected', db.rpc(B, 'send_gift', { p_params: { postId: post.id, amountNgn: '10.5' }, p_idempotency_key: uuid() }), /whole Naira/);
const race = await Promise.allSettled([
  db.rpc(C, 'send_gift', { p_params: { postId: post.id, amountNgn: 30000 }, p_idempotency_key: uuid() }),
  db.rpc(C, 'send_gift', { p_params: { postId: post.id, amountNgn: 30000 }, p_idempotency_key: uuid() }),
]);
check('concurrent double-spend: exactly one succeeds', race.filter(r => r.status === 'fulfilled').length === 1 && num((await ngnOf(C)).balance) === 20000);

// ── Transfers & earnings → balance ────────────────────────────────
console.log('\nTransfers');
const tkey = uuid();
await db.rpc(B, 'transfer_ngn', { p_to_username: '@creator_a', p_amount: '1000', p_note: 'thanks', p_idempotency_key: tkey });
await db.rpc(B, 'transfer_ngn', { p_to_username: '@creator_a', p_amount: '1000', p_note: 'thanks', p_idempotency_key: tkey });
check('transfer moves ₦1,000 once (idempotent)', num((await ngnOf(A)).balance) === 1000 && num((await ngnOf(B)).balance) === 8000 - 1000 - 333 - 1000);
await rejects('transfer beyond balance refused', db.rpc(B, 'transfer_ngn', { p_to_username: 'creator_a', p_amount: '999999', p_note: null, p_idempotency_key: uuid() }), /Insufficient/);
await rejects('transfer to self refused', db.rpc(B, 'transfer_ngn', { p_to_username: 'fan_b', p_amount: '10', p_note: null, p_idempotency_key: uuid() }), /yourself/);
await db.rpc(A, 'move_earnings_to_balance', { p_amount: '500', p_idempotency_key: uuid() });
check('earnings → KAMKAM balance (internal)', num((await ngnOf(A)).balance) === 1500);

// ── Withdrawals (Paystack transfer state machine) ─────────────────
console.log('\nWithdrawals');
const bank = await db.svc('svc_bank_account_upsert', { p_user: A.id, p_bank_code: '058', p_bank_name: 'GTBank', p_account_name: 'Creator A', p_last4: '1234', p_recipient_code: 'RCP_test_a' });
const earnBefore = num((await ngnOf(A)).earnings);
const wkey = uuid();
const wd = await db.svc('svc_withdrawal_create', { p_user: A.id, p_source: 'earnings', p_amount: 1000, p_bank_account: bank, p_reference: 'KK-WDR-1', p_key: wkey });
check('withdrawal holds funds (earnings → held)', num((await ngnOf(A)).earnings) === earnBefore - 1000 && num((await ngnOf(A)).held) === 1000 && wd.status === 'pending');
const wdDup = await db.svc('svc_withdrawal_create', { p_user: A.id, p_source: 'earnings', p_amount: 1000, p_bank_account: bank, p_reference: 'KK-WDR-1b', p_key: wkey });
check('duplicate withdrawal request returns the same payout', wdDup.id === wd.id && num((await ngnOf(A)).held) === 1000);
await rejects('cannot withdraw more than available', db.svc('svc_withdrawal_create', { p_user: A.id, p_source: 'earnings', p_amount: 999999, p_bank_account: bank, p_reference: 'KK-WDR-X', p_key: uuid() }), /Insufficient|limit/i);
await rejects('minimum withdrawal enforced', db.svc('svc_withdrawal_create', { p_user: A.id, p_source: 'balance', p_amount: 100, p_bank_account: bank, p_reference: 'KK-WDR-Y', p_key: uuid() }), /Minimum/);
await rejects('cannot use another user\'s bank account', db.svc('svc_withdrawal_create', { p_user: B.id, p_source: 'balance', p_amount: 600, p_bank_account: bank, p_reference: 'KK-WDR-Z', p_key: uuid() }), /Unknown bank account/);
await db.svc('svc_withdrawal_update', { p_reference: 'KK-WDR-1', p_status: 'processing', p_transfer_code: 'TRF_1', p_reason: null });
const wsuc = await db.svc('svc_withdrawal_update', { p_reference: 'KK-WDR-1', p_status: 'success', p_transfer_code: 'TRF_1', p_reason: null });
check('verified transfer success releases the hold; fee recorded', wsuc.outcome === 'success' && num((await ngnOf(A)).held) === 0
  && num((await db.admin(`select sum(amount) s from ledger_entries where entry_type = 'WITHDRAWAL_FEE'`))[0].s) === 50);
check('replayed success webhook changes nothing', (await db.svc('svc_withdrawal_update', { p_reference: 'KK-WDR-1', p_status: 'success', p_transfer_code: null, p_reason: null })).outcome === 'no_change');
await db.svc('svc_withdrawal_create', { p_user: A.id, p_source: 'balance', p_amount: 600, p_bank_account: bank, p_reference: 'KK-WDR-2', p_key: uuid() });
const balMid = num((await ngnOf(A)).balance);
await db.svc('svc_withdrawal_update', { p_reference: 'KK-WDR-2', p_status: 'failed', p_transfer_code: null, p_reason: 'Account closed' });
check('failed transfer returns the money (no false deduction)', num((await ngnOf(A)).balance) === balMid + 600 && num((await ngnOf(A)).held) === 0);
await db.svc('svc_withdrawal_update', { p_reference: 'KK-WDR-1', p_status: 'reversed', p_transfer_code: null, p_reason: 'Reversed by bank' });
check('reversal after success returns funds and refunds the fee', num((await ngnOf(A)).earnings) === earnBefore
  && num((await db.admin(`select sum(amount) s from ledger_entries where entry_type = 'WITHDRAWAL_FEE'`))[0].s) === 0);
check('withdrawal visible to its owner only', (await db.rpc(A, 'withdrawal_status', { p_reference: 'KK-WDR-2' })).status === 'failed'
  && (await db.rpc(B, 'withdrawal_status', { p_reference: 'KK-WDR-2' })) === null);

// ── Crypto wallet records ─────────────────────────────────────────
console.log('\nCrypto wallet records (addresses come only from the provider)');
const evm = '0x' + 'cd'.repeat(20), sol = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
await db.svc('svc_crypto_wallet_upsert', { p_user: B.id, p_mode: 'testnet', p_evm_name: 'kk-b', p_sol_name: 'kk-b', p_evm: evm, p_sol: sol, p_status: 'ready', p_error: null });
const ovB = await db.rpc(B, 'wallet_overview');
check('owner sees their provisioned addresses', ovB.crypto.evmAddress === evm && ovB.crypto.solanaAddress === sol && (await db.rpc(B, 'me')).walletActivated === true);
check('others cannot read the wallet', (await db.sql(A, `select * from crypto_wallets where user_id = $1`, [B.id])).length === 0);
await rejects('an address can belong to only one user', db.svc('svc_crypto_wallet_upsert', { p_user: C.id, p_mode: 'testnet', p_evm_name: 'kk-c', p_sol_name: 'kk-c', p_evm: evm, p_sol: null, p_status: 'ready', p_error: null }), /duplicate key/);
const ckey = uuid();
const tx = await db.svc('svc_crypto_tx_begin', { p_user: B.id, p_key: ckey, p_network: 'base-sepolia', p_asset: 'ETH', p_amount: '0.001', p_atomic: '1000000000000000', p_from: evm, p_to: '0x' + 'ef'.repeat(20) });
const txDup = await db.svc('svc_crypto_tx_begin', { p_user: B.id, p_key: ckey, p_network: 'base-sepolia', p_asset: 'ETH', p_amount: '0.001', p_atomic: '1000000000000000', p_from: evm, p_to: '0x' + 'ef'.repeat(20) });
check('send request is idempotent (same key → same record)', txDup.id === tx.id && txDup.duplicate === true);
await rejects('second concurrent send blocked while one is submitting', db.svc('svc_crypto_tx_begin', { p_user: B.id, p_key: uuid(), p_network: 'base-sepolia', p_asset: 'ETH', p_amount: '1', p_atomic: '1', p_from: evm, p_to: evm }), /still being submitted/);
await db.svc('svc_crypto_tx_update', { p_id: tx.id, p_status: 'submitted', p_hash: '0x' + '12'.repeat(32), p_explorer: 'https://sepolia.basescan.org/tx/0x', p_error: null });
await db.svc('svc_crypto_tx_update', { p_id: tx.id, p_status: 'confirmed', p_hash: null, p_explorer: null, p_error: null });
await db.svc('svc_crypto_tx_update', { p_id: tx.id, p_status: 'failed', p_hash: null, p_explorer: null, p_error: 'late' });
check('confirmed sends are final', (await db.admin(`select status from crypto_transactions where id = $1`, [tx.id]))[0].status === 'confirmed');
check('send appears in activity with its real hash', (await db.rpc(B, 'wallet_activity', { p_filter: 'sent', p_limit: 20 })).transactions.some(t => t.txHash === '0x' + '12'.repeat(32)));
check('server lookup returns the wallet only for its owner', (await db.svc('svc_crypto_wallet_get', { p_user: B.id })).evm_address === evm
  && (await db.svc('svc_crypto_wallet_get', { p_user: A.id })) === null);
check('server tx lookup is scoped to the owner', (await db.svc('svc_crypto_tx_get', { p_id: tx.id, p_user: B.id })).id === tx.id
  && (await db.svc('svc_crypto_tx_get', { p_id: tx.id, p_user: A.id })) === null);
await rejects('users cannot call server lookups', db.rpc(B, 'svc_crypto_wallet_get', { p_user: B.id }), /permission denied/);
const pend = await db.svc('svc_crypto_tx_begin', { p_user: C.id, p_key: uuid(), p_network: 'solana', p_asset: 'SOL', p_amount: '0.1', p_atomic: '100000000', p_from: sol, p_to: sol });
const rc = await db.svc('svc_reconcile_candidates', {});
check('reconciliation lists unfinished sends, not final ones', rc.cryptoTxs.some(t => t.id === pend.id) && !rc.cryptoTxs.some(t => t.id === tx.id)
  && Array.isArray(rc.payments) && Array.isArray(rc.withdrawals));
await db.svc('svc_crypto_tx_update', { p_id: pend.id, p_status: 'dropped', p_hash: null, p_explorer: null, p_error: 'test' });
const lim = (await db.rpc(B, 'wallet_overview')).limits;
check('overview exposes real limits (fee ₦50, min deposit ₦100)', num(lim.withdrawFee) === 50 && num(lim.depositMin) === 100);

// ── Live sessions ─────────────────────────────────────────────────
console.log('\nLive sessions (real data only)');
check('empty state: nobody live', (await db.rpc(B, 'live_list')).length === 0);
const live = await db.rpc(A, 'start_live', { p_title: 'Launch Q&A' });
await rejects('one live session per host', db.rpc(A, 'start_live', { p_title: 'Again' }), /already have a live session/);
const lv = await db.rpc(B, 'live_heartbeat', { p_session: live.id });
check('viewers = real heartbeats (host + B = 2)', lv.viewers === 2 && lv.viewerList.length === 2);
await db.sql(C, `insert into live_messages (session_id, user_id, body) values ($1, $2, 'Hello from C')`, [live.id, C.id]);
await rejects('cannot fake a gift event in chat', db.sql(C, `insert into live_messages (session_id, user_id, kind, body) values ($1, $2, 'GIFT', 'sent ₦1,000,000')`, [live.id, C.id]), /permission denied/);
await rejects('cannot chat as someone else', db.sql(C, `insert into live_messages (session_id, user_id, body) values ($1, $2, 'fake')`, [live.id, B.id]), /row-level security/);
await db.rpc(C, 'send_gift', { p_params: { recipientId: A.id, liveSessionId: live.id, amountNgn: 500 }, p_idempotency_key: uuid() });
const lv2 = await db.rpc(B, 'live_view', { p_session: live.id });
check('chat + successful gift appear in the session', lv2.messages.some(m => m.kind === 'TEXT' && m.body === 'Hello from C') && lv2.messages.some(m => m.kind === 'GIFT' && m.giftAmount === '500.00') && num(lv2.giftTotal) === 500);
await rejects('gift to a non-host in the session refused', db.rpc(C, 'send_gift', { p_params: { recipientId: B.id, liveSessionId: live.id, amountNgn: 200 }, p_idempotency_key: uuid() }), /ended/);
await db.admin(`update live_viewers set last_seen_at = now() - interval '2 minutes' where user_id = $1`, [B.id]);
check('viewers who leave stop being counted', (await db.rpc(A, 'live_view', { p_session: live.id })).viewers === 1);
await rejects('only the host can end the session', db.rpc(B, 'end_live', { p_session: live.id }), /Only the host/);
await db.rpc(A, 'end_live', { p_session: live.id });
await rejects('no chat after the session ended', db.sql(C, `insert into live_messages (session_id, user_id, body) values ($1, $2, 'late')`, [live.id, C.id]), /row-level security/);
check('ended session leaves the live list', (await db.rpc(B, 'live_list')).length === 0);

// ── Ledger integrity ──────────────────────────────────────────────
console.log('\nLedger integrity');
check('every wallet bucket equals the sum of its ledger entries', (await db.as({ role: 'service_role' }, q => q('select count(*)::int n from public.svc_ledger_check()'))).rows[0].n === 0);
await rejects('ledger entries are append-only', db.admin(`update ledger_entries set amount = 1 where entry_type = 'DEPOSIT'`), /append-only/);
await rejects('ledger entries cannot be deleted', db.admin(`delete from ledger_entries`), /append-only/);
check('no negative balances', (await db.admin(`select count(*)::int n from ngn_wallets where balance < 0 or earnings < 0 or held < 0`))[0].n === 0);
const totals = (await db.admin(`select (select coalesce(sum(amount), 0) from payments where credited) dep,
  (select coalesce(sum(payout), 0) from withdrawals where status = 'success') paid,
  (select coalesce(sum(balance + earnings + held), 0) from ngn_wallets) wallets,
  (select coalesce(sum(amount), 0) from ledger_entries where account = 'platform_revenue') plat`))[0];
check('money is conserved: deposits = user wallets + platform revenue + paid out', num(totals.dep) === num(totals.wallets) + num(totals.plat) + num(totals.paid), totals);

// ── Deletion keeps the money trail ────────────────────────────────
console.log('\nDeletion');
await db.sql(A, `delete from posts where id = $1`, [post.id]);
check('author can delete own post; gifts keep their record', (await db.admin(`select count(*)::int n from gifts where post_id is null`))[0].n >= 3);

await db.close();
process.exit(summary() ? 1 : 0);
