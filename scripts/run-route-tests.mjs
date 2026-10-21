// End-to-end tests of KAMKAM's money API routes (Next.js route handlers) against:
//   • the local Supabase test stack (npm run local:supabase -- --fresh), and
//   • a MOCK Paystack server started here.
//
// IMPORTANT: these tests verify KAMKAM's own logic — signature checks, verify-before-credit,
// idempotency, the withdrawal state machine, auth and ownership. They do NOT prove that the
// real Paystack or Coinbase integrations work; that needs real (test-mode) credentials.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgFile = path.join(root, 'supabase', 'tests', '.local-stack.json');
if (!fs.existsSync(cfgFile)) { console.error('Start the local stack first: npm run local:supabase -- --fresh'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const SECRET = 'sk_test_mock_' + crypto.randomBytes(8).toString('hex');
const CRON = 'cron_' + crypto.randomBytes(8).toString('hex');
const MOCK_PORT = 54400, APP_PORT = 3100;
const APP = `http://localhost:${APP_PORT}`;

// ── Mock Paystack ─────────────────────────────────────────────────
const txs = new Map();        // reference → { amount, status, currency }
const transfers = new Map();  // reference → { status }
let nextTransfer = 'pending'; // what POST /transfer returns next ('pending' | 'otp' | 'error')
const mock = http.createServer(async (req, res) => {
  const body = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(c.length ? JSON.parse(Buffer.concat(c)) : {})); });
  const out = (status, data, ok = status < 400, message = ok ? 'ok' : 'error') => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: ok, message, data })); };
  if (req.headers.authorization !== `Bearer ${SECRET}`) return out(401, null, false, 'Invalid key');
  const u = new URL(req.url, 'http://x');
  let m;
  if (u.pathname === '/transaction/initialize') { txs.set(body.reference, { amount: body.amount, status: 'ongoing', currency: 'NGN' }); return out(200, { authorization_url: 'https://checkout.mock/' + body.reference, access_code: 'ac', reference: body.reference }); }
  if ((m = u.pathname.match(/^\/transaction\/verify\/(.+)$/))) {
    const t = txs.get(decodeURIComponent(m[1]));
    if (!t) return out(400, null, false, 'Transaction reference not found');
    return out(200, { status: t.status, reference: m[1], amount: t.amount, currency: t.currency, channel: 'card', paid_at: t.status === 'success' ? new Date().toISOString() : null });
  }
  if (u.pathname === '/bank') return out(200, [{ name: 'Guaranty Trust Bank', code: '058', active: true }, { name: 'Kuda Bank', code: '50211', active: true }]);
  if (u.pathname === '/bank/resolve') return u.searchParams.get('account_number') === '0123456789' ? out(200, { account_number: '0123456789', account_name: 'CREATOR ONE' }) : out(422, null, false, 'Could not resolve account name');
  if (u.pathname === '/transferrecipient') return out(201, { recipient_code: 'RCP_' + body.account_number });
  if (u.pathname === '/transfer') {
    if (nextTransfer === 'error') return out(400, null, false, 'Your balance is not enough to fulfil this request');
    transfers.set(body.reference, { status: nextTransfer, amount: body.amount });
    return out(200, { status: nextTransfer, transfer_code: 'TRF_' + body.reference.slice(-6), reference: body.reference });
  }
  if ((m = u.pathname.match(/^\/transfer\/verify\/(.+)$/))) {
    const t = transfers.get(decodeURIComponent(m[1]));
    if (!t) return out(404, null, false, 'Transfer not found');
    return out(200, { status: t.status, transfer_code: 'TRF_x', reference: m[1] });
  }
  out(404, null, false, 'Not found');
});
await new Promise(r => mock.listen(MOCK_PORT, r));

// ── Next.js server under test ─────────────────────────────────────
const env = {
  ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-routetest',
  NEXT_PUBLIC_SUPABASE_URL: cfg.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: cfg.anonKey, SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey,
  PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_BASE_URL: `http://localhost:${MOCK_PORT}`, APP_URL: APP, CRON_SECRET: CRON,
  CDP_API_KEY_ID: '', CDP_API_KEY_SECRET: '', CDP_WALLET_SECRET: '',
};
const next = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], { cwd: path.join(root, 'frontend'), env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
next.stdout.on('data', d => { log += d; }); next.stderr.on('data', d => { log += d; });
const cleanup = () => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(next.pid), '/T', '/F']); else next.kill(); } catch { /* ignore */ } mock.close(); };
process.on('exit', cleanup);
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(APP + '/api/config'); if (r.ok) break; } catch { /* starting */ }
  await new Promise(r => setTimeout(r, 1000));
  if (i === 119) { console.error('Next.js did not start\n' + log.slice(-3000)); process.exit(1); }
}

// ── Test helpers ──────────────────────────────────────────────────
let passed = 0, failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); } };
const call = async (method, p, { token, body, headers = {}, raw } = {}) => {
  const r = await fetch(APP + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body || raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const rest = (p, token, init = {}) => fetch(cfg.url + '/rest/v1' + p, { ...init, headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } }).then(r => r.json());
const rpc = (fn, args, token) => rest('/rpc/' + fn, token, { method: 'POST', body: JSON.stringify(args || {}) });
const signup = async name => {
  const r = await fetch(cfg.url + '/auth/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json', apikey: cfg.anonKey },
    body: JSON.stringify({ email: `${name}@routes.test`, password: 'password123', data: { username: name, display_name: name } }) }).then(r => r.json());
  return { id: r.user.id, token: r.access_token };
};
const overview = async u => (await rpc('wallet_overview', {}, u.token)).ngn;
const sign = raw => crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
const webhook = (evt, sig) => { const raw = JSON.stringify(evt); return call('POST', '/api/payments/webhook', { raw, headers: { 'x-paystack-signature': sig ?? sign(raw) } }); };
const sfx = crypto.randomBytes(3).toString('hex');

console.log('\nKAMKAM money routes — against a MOCK Paystack (tests KAMKAM logic, not the provider)');
const A = await signup('route_a_' + sfx), B = await signup('route_b_' + sfx);

console.log('\nConfig & auth');
const conf = await call('GET', '/api/config');
check('config reports payments enabled (test mode) and crypto NOT configured', conf.json?.payments.enabled && conf.json.payments.mode === 'test' && conf.json.crypto.enabled === false, conf.json);
check('config exposes no secrets', !JSON.stringify(conf.json).includes(SECRET) && !JSON.stringify(conf.json).includes(cfg.serviceKey));
check('deposit without login → 401', (await call('POST', '/api/payments/deposit', { body: { amount: 5000 } })).status === 401);
check('forged token → 401', (await call('POST', '/api/payments/deposit', { token: 'x.y.z', body: { amount: 5000 } })).status === 401);

console.log('\nDeposits');
const dep = await call('POST', '/api/payments/deposit', { token: A.token, body: { amount: 5000 } });
check('deposit starts a Paystack checkout', dep.status === 201 && dep.json.authorizationUrl.startsWith('https://checkout.mock/'), dep.json);
const ref = dep.json?.reference;
check('starting checkout credits nothing', Number((await overview(A)).balance) === 0);
const st0 = await call('GET', '/api/payments/deposit/' + ref, { token: A.token });
check('status while Paystack says "ongoing" → not credited', st0.json?.credited === false, st0.json);
check('below-minimum deposit refused', (await call('POST', '/api/payments/deposit', { token: A.token, body: { amount: 10 } })).status === 400);
const evt = { event: 'charge.success', data: { id: 1, reference: ref, amount: 99999999, currency: 'NGN', status: 'success' } };
check('webhook with a bad signature → 401', (await webhook(evt, 'deadbeef')).status === 401);
check('…and credits nothing', Number((await overview(A)).balance) === 0);
await webhook(evt);
check('signed webhook whose payload LIES (Paystack verify still "ongoing") → not credited', Number((await overview(A)).balance) === 0);
txs.get(ref).status = 'success';
const wh = await webhook(evt);
check('signed webhook + Paystack verify success → credited the VERIFIED amount (₦5,000, not the payload’s)', wh.status === 200 && Number((await overview(A)).balance) === 5000, await overview(A));
await webhook(evt); await webhook({ ...evt, data: { ...evt.data, id: 2 } });
check('duplicate webhook deliveries credit once', Number((await overview(A)).balance) === 5000);
const st1 = await call('GET', '/api/payments/deposit/' + ref, { token: A.token });
check('callback status → credited', st1.json?.credited === true && st1.json.status === 'success', st1.json);
check('another user cannot read this payment', (await call('GET', '/api/payments/deposit/' + ref, { token: B.token })).status === 404);
const dep2 = await call('POST', '/api/payments/deposit', { token: B.token, body: { amount: 3000 } });
txs.set(dep2.json.reference, { amount: 1000, status: 'success', currency: 'NGN' });
await call('GET', '/api/payments/deposit/' + dep2.json.reference, { token: B.token });
check('underpaid charge (verify amount < expected) is not credited', Number((await overview(B)).balance) === 0);

console.log('\nWithdrawals');
check('bank list from provider', (await call('GET', '/api/payments/banks', { token: A.token })).json?.banks.length === 2);
const rs = await call('POST', '/api/payments/resolve', { token: A.token, body: { accountNumber: '0123456789', bankCode: '058' } });
check('account name resolved by provider', rs.json?.accountName === 'CREATOR ONE', rs.json);
check('unknown account → 422', (await call('POST', '/api/payments/resolve', { token: A.token, body: { accountNumber: '9999999999', bankCode: '058' } })).status === 422);
const wkey = crypto.randomUUID();
const w1 = await call('POST', '/api/payments/withdraw', { token: A.token, body: { source: 'balance', amount: 2000, accountNumber: '0123456789', bankCode: '058', idempotencyKey: wkey } });
check('withdrawal submitted → processing, funds held', w1.status === 201 && w1.json.status === 'processing' && Number((await overview(A)).held) === 2000 && Number((await overview(A)).balance) === 3000, w1.json);
const w1dup = await call('POST', '/api/payments/withdraw', { token: A.token, body: { source: 'balance', amount: 2000, accountNumber: '0123456789', bankCode: '058', idempotencyKey: wkey } });
check('retried request = same withdrawal, no second hold', w1dup.json?.reference === w1.json.reference && Number((await overview(A)).held) === 2000);
check('not marked paid before the provider confirms', (await call('GET', '/api/payments/withdraw/' + w1.json.reference, { token: A.token })).json?.status === 'processing');
transfers.get(w1.json.reference).status = 'success';
await webhook({ event: 'transfer.success', data: { id: 9, reference: w1.json.reference } });
const w1s = await call('GET', '/api/payments/withdraw/' + w1.json.reference, { token: A.token });
check('verified transfer.success → success, hold released', w1s.json?.status === 'success' && Number((await overview(A)).held) === 0, w1s.json);
check('another user cannot read this withdrawal', (await call('GET', '/api/payments/withdraw/' + w1.json.reference, { token: B.token })).status === 404);
nextTransfer = 'error';
const w2 = await call('POST', '/api/payments/withdraw', { token: A.token, body: { source: 'balance', amount: 1000, accountNumber: '0123456789', bankCode: '058', idempotencyKey: crypto.randomUUID() } });
check('provider refuses the transfer → failed, money returned', w2.json?.status === 'failed' && Number((await overview(A)).balance) === 3000 && Number((await overview(A)).held) === 0, w2.json);
nextTransfer = 'pending';
const w3 = await call('POST', '/api/payments/withdraw', { token: A.token, body: { source: 'balance', amount: 1000, accountNumber: '0123456789', bankCode: '058', idempotencyKey: crypto.randomUUID() } });
transfers.get(w3.json.reference).status = 'failed';
await webhook({ event: 'transfer.failed', data: { id: 10, reference: w3.json.reference } });
check('transfer.failed (verified) → funds returned', Number((await overview(A)).balance) === 3000 && Number((await overview(A)).held) === 0);
const over = await call('POST', '/api/payments/withdraw', { token: A.token, body: { source: 'balance', amount: 50000, accountNumber: '0123456789', bankCode: '058', idempotencyKey: crypto.randomUUID() } });
check('cannot withdraw more than the balance', over.status === 422 && Number((await overview(A)).balance) === 3000, over);

console.log('\nCrypto routes without provider credentials');
const prov = await call('POST', '/api/wallet/provision', { token: A.token });
check('provision → 503 not configured (no fake wallet)', prov.json?.error?.code === 'CRYPTO_NOT_CONFIGURED', prov);
const balr = await call('GET', '/api/wallet/balances', { token: A.token });
check('balances → 503 not configured', balr.status === 503, balr);
check('no crypto wallet record was created', (await rpc('wallet_overview', {}, A.token)).crypto === null);

console.log('\nReconciliation job');
check('cron without secret → 401', (await call('GET', '/api/cron/reconcile')).status === 401);
const rc = await call('GET', '/api/cron/reconcile', { headers: { authorization: 'Bearer ' + CRON } });
check('cron with secret runs; ledger has 0 mismatches', rc.status === 200 && rc.json.ledgerMismatches === 0, rc.json);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('\n── Next.js log (tail) ──\n' + log.slice(-4000));
cleanup();
process.exit(failed ? 1 : 0);
