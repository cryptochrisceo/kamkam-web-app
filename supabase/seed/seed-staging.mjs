// ════════════════════════════════════════════════════════════════════
// KAMKAM · STAGING demo seed. DO NOT RUN AGAINST PRODUCTION.
// Creates demo creators via the Supabase Admin API (service_role key, used
// only here on your machine — never in the frontend), then signs in as each
// user and creates content through the normal RLS-protected API, so the
// seed exercises exactly the same rules as real users. It never creates balances or gifts.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node seed-staging.mjs --yes
// Every demo account uses the password: password123
// ════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) { console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }
if (!process.argv.includes('--yes')) { console.error(`This creates demo users and posts in ${URL}.\nRe-run with --yes to confirm (staging/development projects only).`); process.exit(1); }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const PASSWORD = 'password123';
const USERS = [
  ['amaka', 'Amaka James', 'Product designer. Writing about craft and Lagos tech. Gifts keep the essays coming.', [
    'Design note: monetization should be one tap away from the content, never a separate app. #KAMKAM',
    'If your product only pays people with audiences, you built a billboard, not a platform.']],
  ['davidokoro', 'David Okoro', 'Building tools for creators.', [
    'Creators should not need 10K followers to earn their first ₦1,000. #KAMKAM',
    'Payments UX in Nigeria is 80% trust, 20% tech. #Technology']],
  ['sarahw', 'Sarah Williams', 'Photographer. Lagos light, every morning.', [
    'Lekki at 6:40am. Three years of shooting this city and the light still surprises me.']],
  ['danielade', 'Daniel Ade', 'Engineering lead. Offline-first everything.', [
    'Idempotency keys are the most underrated feature in any payments API. #Technology']],
  ['michaeljohnson', 'Michael Johnson', 'Producer. Studio sessions & late night beats.', [
    'Track is mastered. Listening party this weekend. #Music']],
  ['ifynwosu', 'Ifeoma Nwosu', 'Short stories about Enugu on weekends.', [
    'First thing I have ever posted here. I write short stories about Enugu on the weekends.']],
];

async function signedIn(username) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${username}@kamkam.demo`, password: PASSWORD });
  if (error) throw new Error(`${username}: ${error.message}`);
  return c;
}
const must = r => { if (r.error) throw new Error(r.error.message); return r.data; };

console.log(`Seeding demo data into ${URL}`);
const ids = {};
for (const [username, display_name] of USERS) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${username}@kamkam.demo`, password: PASSWORD, email_confirm: true, user_metadata: { username, display_name },
  });
  if (error && !/already/i.test(error.message)) throw error;
  ids[username] = data?.user?.id;
  console.log(`  ✓ ${username}${error ? ' (exists)' : ''}`);
}

const clients = {};
for (const [username, , bio, posts] of USERS) {
  const c = await signedIn(username);
  clients[username] = c;
  const { data: { user } } = await c.auth.getUser();
  ids[username] = user.id;
  must(await c.from('profiles').update({ bio, location: 'Lagos, Nigeria' }).eq('id', user.id).select('id'));
  for (const text of posts) must(await c.rpc('create_post', { p_text: text, p_media: [], p_reply_policy: 'Everyone', p_poll: null }));
}
console.log('  ✓ profiles, posts (wallets start at ₦0 — the seed creates no money)');

const names = Object.keys(clients);
for (const a of names) for (const b of names) {
  if (a !== b && (a.length + b.length) % 3 !== 0) await clients[a].from('follows').insert({ follower_id: ids[a], following_id: ids[b] });
}
console.log('  ✓ follows');

const { posts } = must(await clients.amaka.rpc('feed', { p_tab: 'foryou', p_offset: 0, p_limit: 20 }));
for (const p of posts) {
  for (const u of names.filter(n => ids[n] !== p.author.id).slice(0, 3)) {
    await clients[u].from('likes').insert({ user_id: ids[u], post_id: p.id });
  }
}
const amakaPost = posts.find(p => p.author.username === 'amaka');
await clients.davidokoro.from('comments').insert({ post_id: amakaPost.id, author_id: ids.davidokoro, text: 'The part about discovery over follower count is the whole thing.' });
// No gifts are seeded: gifts move real money, and staging accounts have none unless funded
// through a (test-mode) Paystack deposit.
console.log('  ✓ likes, comments');
console.log(`\nDone. Log in with amaka@kamkam.demo / ${PASSWORD} (set NEXT_PUBLIC_SHOW_DEMO_LOGIN only on staging).`);
