// Shared harness: fresh database + shim + migrations, and "act as user" helpers
// that reproduce how PostgREST executes requests (SET LOCAL ROLE + JWT claims).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_URL = process.env.TEST_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

/** Apply migrations whose filename is > `after` and <= `upTo` (lexicographic). */
export async function applyMigrations(url, { after = '', upTo = '￿' } = {}) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const dir = path.join(here, '..', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    if (f <= after || f > upTo) continue;
    try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { await c.end(); throw new Error(`Migration ${f} failed: ${e.message}${e.where ? '\n' + e.where : ''}`); }
  }
  await c.end();
}

export async function createFreshDb(name, { upTo } = {}) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} encoding 'UTF8' template template0`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(fs.readFileSync(path.join(here, 'shim.sql'), 'utf8'));
  await c.end();
  await applyMigrations(url, { upTo: upTo ?? '￿' });
  return url;
}

export class Db {
  constructor(url) { this.pool = new pg.Pool({ connectionString: url, max: 6 }); }
  async close() { await this.pool.end(); }

  /** Run fn(query) inside a transaction as `role` with JWT claims, exactly like PostgREST. */
  async as(claims, fn) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
      await c.query(`set local role ${claims?.role ?? 'anon'}`);
      const r = await fn((sql, params) => c.query(sql, params));
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  user(u) { return { role: 'authenticated', sub: u.id, email: u.email, aud: 'authenticated' }; }

  /** Calls a function as service_role (what the Next.js server does after provider verification). */
  svc(fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`;
    const vals = keys.map(k => (args[k] !== null && typeof args[k] === 'object' && !(args[k] instanceof Date) ? JSON.stringify(args[k]) : args[k]));
    return this.as({ role: 'service_role' }, q => q(sql, vals).then(r => r.rows[0].r));
  }

  /** Calls an RPC as a user; returns the JSON result. */
  rpc(u, fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const vals = keys.map(k => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    return this.as(u ? this.user(u) : { role: 'anon' }, q => q(sql, vals).then(r => r.rows[0].r));
  }

  sql(u, text, params) {
    return this.as(u ? this.user(u) : { role: 'anon' }, q => q(text, params).then(r => r.rows));
  }

  /** Superuser access (like the dashboard / service role). */
  async admin(text, params) {
    const r = await this.pool.query(text, params);
    return r.rows;
  }

  async signUp(email, meta = {}) {
    const [u] = await this.admin(`insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1, $2, now()) returning id, email`, [email, meta]);
    return u;
  }
}

let passed = 0, failed = 0;
const failures = [];
export function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
export async function rejects(name, promise, match) {
  try { await promise; check(name, false, 'expected an error'); }
  catch (e) {
    const ok = !match || (match instanceof RegExp ? match.test(e.message + ' ' + (e.hint ?? '') + ' ' + (e.code ?? '')) : (e.message + (e.hint ?? '')).includes(match));
    check(name, ok, ok ? undefined : e.message);
  }
}
export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  return failed;
}
