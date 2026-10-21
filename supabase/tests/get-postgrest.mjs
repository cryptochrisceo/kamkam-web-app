// Downloads the PostgREST binary used by the local test stack into supabase/tests/.bin
// (Windows also gets libpq + VC++ runtime DLLs copied from the bundled PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '.bin');
const VERSION = 'v16.4';
const asset = { win32: `postgrest-${VERSION}-windows-x86-64.zip`, darwin: `postgrest-${VERSION}-macos-${process.arch === 'arm64' ? 'aarch64' : 'x86-64'}.tar.xz`, linux: `postgrest-${VERSION}-linux-static-${process.arch === 'arm64' ? 'aarch64' : 'x86-64'}.tar.xz` }[process.platform];
if (!asset) throw new Error('Unsupported platform ' + process.platform);
fs.mkdirSync(bin, { recursive: true });
const file = path.join(bin, asset);
console.log('Downloading', asset);
const res = await fetch(`https://github.com/PostgREST/postgrest/releases/download/${VERSION}/${asset}`);
if (!res.ok) throw new Error('Download failed: ' + res.status);
fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
execSync(`tar -xf "${file}" -C "${bin}"`, { stdio: 'inherit' });
fs.rmSync(file);
if (process.platform === 'win32') {
  const pgBin = path.join(here, '..', '..', 'database', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
  if (fs.existsSync(pgBin)) for (const f of fs.readdirSync(pgBin).filter(x => x.endsWith('.dll'))) fs.copyFileSync(path.join(pgBin, f), path.join(bin, f));
  else console.warn('Run `npm run db:server` once first so the PostgreSQL DLLs exist, then re-run this script.');
}
console.log('PostgREST ready in', bin);
