// OPTIONAL local PostgreSQL for KAMKAM — for machines without a PostgreSQL install.
// Starts a real PostgreSQL server on localhost:5432 (user/password: postgres/postgres)
// with data stored in ./database/data, and creates the `kamkam` database.
//
//   npm run db:server          (from the project root)
//   npm run db:server:reset    (wipe the data folder and start fresh)
//
// Keep this terminal open while using KAMKAM. Ctrl+C stops the server.

import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const port = Number(process.env.PGPORT || 5432);
const DB = process.env.PGDATABASE || 'kamkam';

// Windows: PostgreSQL needs the Microsoft Visual C++ 2015-2022 runtime. If it is
// not installed system-wide, copy an app-local copy (shipped with Edge/OneDrive)
// next to the Postgres binaries. Installing the official "VC++ Redistributable
// x64" from Microsoft also fixes this permanently.
function ensureVcRuntime() {
  if (process.platform !== 'win32') return;
  const dlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  if (dlls.every(d => fs.existsSync(path.join(sys, d)))) return;
  const bin = path.join(here, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
  if (!fs.existsSync(bin) || dlls.every(d => fs.existsSync(path.join(bin, d)))) return;
  const candidates = [];
  const scan = (root, depth = 2) => {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, e.name);
        if (e.isDirectory() && depth > 0) scan(p, depth - 1);
        else if (e.name.toLowerCase() === 'vcruntime140_1.dll') candidates.push(root);
      }
    } catch { /* ignore */ }
  };
  scan(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application'));
  scan(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'OneDrive'));
  const src = candidates.find(d => dlls.every(x => fs.existsSync(path.join(d, x))));
  if (!src) {
    console.error('[db] The Microsoft Visual C++ runtime is missing. Install "Microsoft Visual C++ Redistributable (x64)" from https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.');
    return;
  }
  for (const d of dlls) fs.copyFileSync(path.join(src, d), path.join(bin, d));
  console.log('[db] Copied Visual C++ runtime DLLs next to PostgreSQL (app-local).');
}
ensureVcRuntime();

if (process.argv.includes('--reset') && fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('[db] Removed existing data folder.');
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  // UTF-8 is required: KAMKAM stores ₦ and emoji. (Windows would default to WIN1252.)
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (e) => console.error('[db]', String(e).trim()),
});

const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (fresh) {
  console.log('[db] Initialising a new PostgreSQL data folder…');
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase(DB);
  console.log(`[db] Created database "${DB}".`);
} catch {
  // already exists
}
console.log(`[db] PostgreSQL running on localhost:${port}  →  postgresql://postgres:postgres@localhost:${port}/${DB}`);
console.log('[db] Leave this running. Press Ctrl+C to stop.');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n[db] Stopping PostgreSQL…');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
