import crypto from 'node:crypto';

/** Human-readable reference IDs, e.g. KK-GFT-7Q2M9XH4. */
export function makeRef(prefix: string) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `KK-${prefix}-${s}`;
}
