// Creates backend/.env and frontend/.env.local from the examples (only if missing).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['backend/.env.example', 'backend/.env'],
  ['frontend/.env.example', 'frontend/.env.local'],
];
for (const [from, to] of copies) {
  const dest = path.join(root, to);
  if (fs.existsSync(dest)) { console.log(`• ${to} already exists — left unchanged`); continue; }
  let text = fs.readFileSync(path.join(root, from), 'utf8');
  if (to === 'backend/.env') text = text.replace('change-me-to-a-long-random-string', crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(dest, text);
  console.log(`✓ created ${to}`);
}
console.log('\nCheck DATABASE_URL in backend/.env matches your PostgreSQL user/password.\n');
