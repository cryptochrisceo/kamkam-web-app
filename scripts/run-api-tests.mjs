// Runs frontend/tests/api-client.test.mts against:
//   • the Supabase project in frontend/.env.local (if TEST_AGAINST_ENV=1), or
//   • the local test stack (supabase/tests/.local-stack.json, started by `npm run local:supabase`)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
if (!process.env.TEST_AGAINST_ENV) {
  const cfgFile = path.join(root, 'supabase', 'tests', '.local-stack.json');
  if (!fs.existsSync(cfgFile)) { console.error('Start the local stack first: npm run local:supabase'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  // Local stack only: lets the test settle a deposit through svc_payment_settle (the webhook's path).
  env.KAMKAM_TEST_SERVICE_KEY = cfg.serviceKey;
} else {
  delete env.KAMKAM_TEST_SERVICE_KEY; // never use a service key against a real project from tests
}
const r = spawnSync('npx', ['--yes', 'tsx', 'tests/api-client.test.mts'], { cwd: path.join(root, 'frontend'), env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
