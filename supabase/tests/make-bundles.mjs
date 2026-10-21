// Generates the paste-into-SQL-Editor bundles from supabase/migrations/:
//   ../APPLY_ALL_MIGRATIONS.sql                — every migration, for a FRESH project
//   ../UPGRADE_20261018_REAL_FINANCE.sql       — only 20261018*, for projects that already ran 001–009
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const join = list => list.map(f => `-- ===== ${f} =====\n` + fs.readFileSync(path.join(dir, f), 'utf8').trimEnd() + '\n').join('\n');

fs.writeFileSync(path.join(dir, '..', 'APPLY_ALL_MIGRATIONS.sql'),
  `-- KAMKAM: all migrations in order, for pasting into Supabase → SQL Editor → Run.
-- Generated from supabase/migrations/. Run ONCE on a FRESH project. Do not run on a project that already has these tables
-- (use UPGRADE_20261018_REAL_FINANCE.sql for a project that already ran the 20261016* migrations).

` + join(files));

const upgrade = files.filter(f => f.startsWith('20261018'));
fs.writeFileSync(path.join(dir, '..', 'UPGRADE_20261018_REAL_FINANCE.sql'),
  `-- KAMKAM upgrade: real finance + live sessions. Paste into Supabase → SQL Editor → Run, ONCE.
-- For a project that already applied the 20261016* migrations (APPLY_ALL_MIGRATIONS.sql from before 2026-10-18).
--
-- WHAT THIS DOES (review before running):
--   • Moves the old DEMO wallet tables (simulated balances, demo transactions, demo gifts) into a private
--     "demo_archive" schema — nothing is deleted; it is no longer readable by app users.
--   • Removes the demo wallet functions (starter money, simulated swaps/buys/sends).
--   • Every user starts at ₦0 in the new ledger-backed Naira wallet. Demo balances are NOT carried over,
--     because they were never backed by real money.
--   • Adds Paystack payments/withdrawals, Coinbase CDP crypto wallet records, live sessions.
-- It runs in a single transaction: if any statement fails, nothing changes.

begin;
` + join(upgrade) + '\ncommit;\n');

console.log('Wrote APPLY_ALL_MIGRATIONS.sql (%d files) and UPGRADE_20261018_REAL_FINANCE.sql (%d files)', files.length, upgrade.length);
