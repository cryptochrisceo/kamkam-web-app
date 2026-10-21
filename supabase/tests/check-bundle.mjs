// Verifies the SQL Editor bundles apply in a single run:
//   1. APPLY_ALL_MIGRATIONS.sql on a fresh Supabase-like DB
//   2. UPGRADE_20261018_REAL_FINANCE.sql on a DB that already has the 20261016* migrations
//      AND legacy demo data (to prove the upgrade archives it instead of failing or deleting it).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const root = new URL('..', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
async function freshDb(name) {
  const a = new pg.Client('postgresql://postgres:postgres@localhost:5432/postgres');
  await a.connect();
  await a.query(`drop database if exists ${name} with (force)`);
  await a.query(`create database ${name} encoding 'UTF8' template template0`);
  await a.end();
  const c = new pg.Client(`postgresql://postgres:postgres@localhost:5432/${name}`);
  await c.connect();
  await c.query(fs.readFileSync(new URL('./shim.sql', import.meta.url), 'utf8'));
  return c;
}
const summary = c => c.query(`select (select count(*) from public.communities)::int as communities,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity)::int as tables_without_rls,
  (select count(*) from pg_proc where proname = 'activate_wallet')::int as demo_functions_left`).then(r => r.rows[0]);
let failed = false;

const c1 = await freshDb('kamkam_bundle_check');
try { await c1.query(read('APPLY_ALL_MIGRATIONS.sql')); console.log('FULL BUNDLE OK', await summary(c1)); }
catch (e) { console.log('FULL BUNDLE FAILED:', e.message); failed = true; }
await c1.end();

const c2 = await freshDb('kamkam_upgrade_check');
try {
  const dir = new URL('migrations/', root);
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('20261016')).sort()) await c2.query(fs.readFileSync(new URL(f, dir), 'utf8'));
  // A legacy user with demo money (the old signup trigger granted ₦50,000)
  await c2.query(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'legacy@x.test', '{"username":"legacy_user","display_name":"Legacy"}')`);
  const before = (await c2.query(`select count(*)::int n from public.wallet_assets`)).rows[0].n;
  await c2.query(read('UPGRADE_20261018_REAL_FINANCE.sql'));
  const s = await summary(c2);
  const archived = (await c2.query(`select count(*)::int n from demo_archive.wallet_assets`)).rows[0].n;
  const bal = (await c2.query(`select balance::text from public.ngn_wallets w join public.profiles p on p.id = w.user_id where p.username = 'legacy_user'`)).rows[0]?.balance;
  console.log('UPGRADE BUNDLE OK', { ...s, legacyDemoRowsBefore: before, archivedDemoRows: archived, legacyUserNewBalance: bal });
  if (archived !== before || bal !== '0.00' || s.demo_functions_left !== 0) { console.log('UPGRADE CHECK FAILED: archive/balance mismatch'); failed = true; }
  try { await c2.query(read('UPGRADE_20261018_REAL_FINANCE.sql')); console.log('RERUN CHECK FAILED: second run did not stop'); failed = true; }
  catch (e) { await c2.query('rollback').catch(() => {}); console.log('RERUN SAFE:', e.message.slice(0, 80)); }
} catch (e) { console.log('UPGRADE BUNDLE FAILED:', e.message); failed = true; }
await c2.end();
process.exitCode = failed ? 1 : 0;
