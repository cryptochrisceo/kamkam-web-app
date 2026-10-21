// ════════════════════════════════════════════════════════════════════
// LOCAL SUPABASE-COMPATIBLE STACK — FOR TESTING ONLY
// Lets the real frontend (supabase-js) run end-to-end on a machine without
// Docker / Supabase CLI:
//   /rest/v1/*     → real PostgREST 16 (same server Supabase runs)
//   /auth/v1/*     → minimal GoTrue-compatible auth (signup, password login,
//                    refresh, user, logout, recover, admin/users) issuing HS256 JWTs
//   /storage/v1/*  → minimal Storage API; enforces bucket limits AND the
//                    storage.objects RLS policies by writing rows as the user
// Production uses real Supabase. Nothing here is deployed.
//
//   node local-stack.mjs [--fresh]       (PostgreSQL must be running on :5432)
// ════════════════════════════════════════════════════════════════════
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createFreshDb, ADMIN_URL } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.E2E_DB || 'kamkam_e2e';
const PORT = Number(process.env.GATEWAY_PORT || 54321);
const PGRST_PORT = 54322;
export const JWT_SECRET = 'local-test-secret-local-test-secret-0123456789';
const STORE = path.join(here, '.local-storage');

// ── JWT (HS256) ───────────────────────────────────────────────────
const b64u = b => Buffer.from(b).toString('base64url');
export function sign(payload, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttl, iss: 'kamkam-local', ...payload };
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(body));
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function verify(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    return c.exp > Date.now() / 1000 ? c : null;
  } catch { return null; }
}
export const ANON_KEY = sign({ role: 'anon' }, 10 * 365 * 86400);
export const SERVICE_KEY = sign({ role: 'service_role' }, 10 * 365 * 86400);

// ── Setup ─────────────────────────────────────────────────────────
const fresh = process.argv.includes('--fresh');
let url = ADMIN_URL.replace(/\/[^/]*$/, '/' + DB);
if (fresh) { url = await createFreshDb(DB); fs.rmSync(STORE, { recursive: true, force: true }); }
const pool = new pg.Pool({ connectionString: url, max: 8 });

const pgrst = spawn(path.join(here, '.bin', 'postgrest.exe'), [], {
  env: { ...process.env, PGRST_DB_URI: url.replace('postgres:postgres@', 'authenticator:authenticator@'), PGRST_DB_SCHEMAS: 'public',
         PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: String(PGRST_PORT), PGRST_LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
pgrst.stdout.on('data', d => process.stdout.write('[postgrest] ' + d));
pgrst.stderr.on('data', d => process.stderr.write('[postgrest] ' + d));
pgrst.on('exit', code => console.error('[postgrest] exited with code', code));
process.on('exit', () => pgrst.kill());
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { pgrst.kill(); process.exit(0); }));

// ── Helpers ───────────────────────────────────────────────────────
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-upsert, prefer, range, accept-profile, content-profile, x-supabase-api-version, cache-control, x-retry-count',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, x-supabase-api-version',
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...headers });
  res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const authErr = (res, status, code, message) => send(res, status, { code: status, error_code: code, msg: message, message, error: code, error_description: message });

async function asUser(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : claims.role === 'service_role' ? 'service_role' : 'anon'}`);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

// ── Auth (GoTrue-compatible subset) ───────────────────────────────
const refreshTokens = new Map();
const hash = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, stored) => { const [, salt, h] = String(stored).split('$'); return !!salt && crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32)); };
const userJson = u => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, phone: '',
  email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at, last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.raw_user_meta_data || {}, identities: [],
  created_at: u.created_at, updated_at: u.updated_at,
});
function session(u) {
  const access_token = sign({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, user_metadata: u.raw_user_meta_data || {} });
  const refresh_token = crypto.randomBytes(24).toString('hex');
  refreshTokens.set(refresh_token, u.id);
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token, user: userJson(u) };
}
const getUser = async id => (await pool.query('select * from auth.users where id = $1', [id])).rows[0];

async function createUser(email, password, data, confirmed = true) {
  try {
    const r = await pool.query(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, case when $4 then now() end) returning *`,
      [email.toLowerCase(), hash(password), data || {}, confirmed]);
    return { user: r.rows[0] };
  } catch (e) {
    if (e.code === '23505' && /users_email/.test(e.constraint || e.detail || '')) return { error: [422, 'user_already_exists', 'User already registered'] };
    return { error: [500, 'unexpected_failure', 'Database error saving new user'] };
  }
}

async function handleAuth(req, res, p, q) {
  const body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}');
  if (p === '/signup' && req.method === 'POST') {
    if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email)) return authErr(res, 400, 'validation_failed', 'Unable to validate email address: invalid format');
    if (!body.password || body.password.length < 6) return authErr(res, 422, 'weak_password', 'Password should be at least 6 characters.');
    const r = await createUser(body.email, body.password, body.data);
    if (r.error) return authErr(res, ...r.error);
    return send(res, 200, session(r.user));
  }
  if (p === '/token') {
    if (q.get('grant_type') === 'password') {
      const u = (await pool.query('select * from auth.users where email = $1', [String(body.email || '').toLowerCase()])).rows[0];
      if (!u || !checkPw(body.password || '', u.encrypted_password)) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
      if (!u.email_confirmed_at) return authErr(res, 400, 'email_not_confirmed', 'Email not confirmed');
      return send(res, 200, session(u));
    }
    if (q.get('grant_type') === 'refresh_token') {
      const id = refreshTokens.get(body.refresh_token);
      if (!id) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      refreshTokens.delete(body.refresh_token);
      return send(res, 200, session(await getUser(id)));
    }
  }
  if (p === '/user') {
    const c = verify(bearer(req));
    if (!c?.sub) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    if (req.method === 'PUT' && body.password) await pool.query('update auth.users set encrypted_password = $2 where id = $1', [c.sub, hash(body.password)]);
    return send(res, 200, userJson(await getUser(c.sub)));
  }
  if (p === '/logout') return send(res, 204);
  if (p === '/recover') return send(res, 200, {});
  if (p === '/admin/users' && req.method === 'POST') {
    if (verify(bearer(req))?.role !== 'service_role') return authErr(res, 403, 'not_admin', 'User not allowed');
    const r = await createUser(body.email, body.password, body.user_metadata, body.email_confirm !== false);
    if (r.error) return authErr(res, ...r.error);
    return send(res, 200, userJson(r.user));
  }
  return authErr(res, 404, 'not_found', 'Not found');
}

// ── Storage (subset) ──────────────────────────────────────────────
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' };
const storageErr = (res, status, error, message) => send(res, status, { statusCode: String(status), error, message });
const claimsOf = req => verify(bearer(req)) || { role: 'anon' };

async function handleStorage(req, res, p, q) {
  // public read
  let m = p.match(/^\/object\/public\/([^/]+)\/(.+)$/);
  if (m && req.method === 'GET') {
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const b = (await pool.query('select * from storage.buckets where id = $1', [bucket])).rows[0];
    const file = path.join(STORE, bucket, name);
    if (!b?.public || !fs.existsSync(file)) return storageErr(res, 400, 'not_found', 'Object not found');
    const obj = (await pool.query('select metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rows[0];
    res.writeHead(200, { ...CORS, 'content-type': obj?.metadata?.mimetype || MIME[name.split('.').pop()] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  // signed URL create / read
  m = p.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
  if (m && req.method === 'POST') {
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const { expiresIn = 60 } = JSON.parse((await readBody(req)).toString() || '{}');
    const rows = await asUser(claimsOf(req), c => c.query('select id from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).catch(() => ({ rows: [] }));
    if (!rows.rows.length) return storageErr(res, 400, 'not_found', 'Object not found');
    const token = sign({ url: `${bucket}/${name}` }, Number(expiresIn));
    return send(res, 200, { signedURL: `/object/sign/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}?token=${token}` });
  }
  if (m && req.method === 'GET') {
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const c = verify(q.get('token'));
    if (!c || c.url !== `${bucket}/${name}`) return storageErr(res, 400, 'InvalidSignature', 'Invalid signature');
    const obj = (await pool.query('select metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rows[0];
    res.writeHead(200, { ...CORS, 'content-type': obj?.metadata?.mimetype || 'application/octet-stream' });
    return fs.createReadStream(path.join(STORE, bucket, name)).pipe(res);
  }
  // delete many
  m = p.match(/^\/object\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const bucket = m[1];
    const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = await asUser(claimsOf(req), c => c.query('delete from storage.objects where bucket_id = $1 and name = any($2) returning name', [bucket, prefixes]));
    r.rows.forEach(x => fs.rmSync(path.join(STORE, bucket, x.name), { force: true }));
    return send(res, 200, r.rows.map(x => ({ name: x.name, bucket_id: bucket })));
  }
  // upload
  m = p.match(/^\/object\/([^/]+)\/(.+)$/);
  if (m && (req.method === 'POST' || req.method === 'PUT')) {
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const raw = await readBody(req);
    let data = raw, type = (req.headers['content-type'] || '').split(';')[0];
    if (type === 'multipart/form-data') {
      const fd = await new Request('http://local', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
      const file = [...fd.values()].find(v => typeof v === 'object');
      data = Buffer.from(await file.arrayBuffer()); type = file.type;
    }
    const b = (await pool.query('select * from storage.buckets where id = $1', [bucket])).rows[0];
    if (!b) return storageErr(res, 404, 'Bucket not found', 'Bucket not found');
    if (b.file_size_limit && data.length > Number(b.file_size_limit)) return storageErr(res, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
    if (b.allowed_mime_types?.length && !b.allowed_mime_types.includes(type)) return storageErr(res, 415, 'invalid_mime_type', `mime type ${type} is not supported`);
    try {
      await asUser(claimsOf(req), c => c.query(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)`, [bucket, name, { mimetype: type, size: data.length }]));
    } catch (e) {
      if (/row-level security/.test(e.message)) return storageErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
      if (e.code === '23505') return storageErr(res, 409, 'Duplicate', 'The resource already exists');
      throw e;
    }
    fs.mkdirSync(path.dirname(path.join(STORE, bucket, name)), { recursive: true });
    fs.writeFileSync(path.join(STORE, bucket, name), data);
    return send(res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
  }
  return storageErr(res, 404, 'not_found', 'Not found');
}

// ── Gateway ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const u = new URL(req.url, 'http://local');
    if (u.pathname.startsWith('/auth/v1')) return await handleAuth(req, res, u.pathname.slice(8), u.searchParams);
    if (u.pathname.startsWith('/storage/v1')) return await handleStorage(req, res, u.pathname.slice(11), u.searchParams);
    if (u.pathname.startsWith('/rest/v1')) {
      const headers = { ...req.headers }; delete headers.host; delete headers.apikey;
      const up = http.request({ host: '127.0.0.1', port: PGRST_PORT, path: u.pathname.slice(8) + u.search, method: req.method, headers }, r => {
        res.writeHead(r.statusCode, { ...r.headers, ...CORS }); r.pipe(res);
      });
      up.on('error', e => send(res, 502, { message: 'PostgREST unavailable: ' + e.message }));
      return req.pipe(up);
    }
    if (u.pathname.startsWith('/realtime')) return send(res, 404, { message: 'Realtime is not emulated locally' });
    send(res, 404, { message: 'Not found' });
  } catch (e) {
    console.error('[gateway]', e);
    send(res, 500, { message: e.message });
  }
});

await new Promise(r => setTimeout(r, 1500)); // let PostgREST connect
server.listen(PORT, () => {
  fs.writeFileSync(path.join(here, '.local-stack.json'), JSON.stringify({ url: `http://localhost:${PORT}`, anonKey: ANON_KEY, serviceKey: SERVICE_KEY }, null, 2));
  console.log(`[local-supabase] ready on http://localhost:${PORT}  (db: ${DB}${fresh ? ', fresh' : ''})`);
  console.log(`[local-supabase] anon key written to supabase/tests/.local-stack.json`);
});
