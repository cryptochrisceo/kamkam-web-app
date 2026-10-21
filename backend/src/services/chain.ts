import crypto from 'node:crypto';
import { NetworkName, NETWORKS, NETWORK_NAMES } from './assets';

/**
 * Blockchain abstraction.
 *
 * IMPORTANT: this MVP never touches a real blockchain. `SimulatedChainProvider`
 * only validates address formats and returns `{ simulated: true }`. It does NOT
 * fabricate transaction hashes. A real integration (e.g. an RPC/wallet SDK that
 * signs client-side) would implement ChainProvider and return a real txHash.
 *
 * Private keys / seed phrases are never handled by the backend.
 */
export interface ChainSubmitResult {
  simulated: boolean;
  txHash: string | null;
}

export interface ChainProvider {
  readonly mode: 'simulated' | 'live';
  validateAddress(network: NetworkName, address: string): boolean;
  submitTransfer(p: { network: NetworkName; asset: string; to: string; amount: string }): Promise<ChainSubmitResult>;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export class SimulatedChainProvider implements ChainProvider {
  readonly mode = 'simulated' as const;

  validateAddress(network: NetworkName, address: string) {
    const a = address.trim();
    switch (NETWORKS[network].family) {
      case 'evm':
        return /^0x[0-9a-fA-F]{40}$/.test(a);
      case 'solana':
        return a.length >= 32 && a.length <= 44 && B58_RE.test(a);
      case 'tron':
        return /^T/.test(a) && a.length === 34 && B58_RE.test(a);
    }
  }

  async submitTransfer(): Promise<ChainSubmitResult> {
    // Nothing is broadcast. No hash is invented.
    return { simulated: true, txHash: null };
  }
}

export const chainProvider: ChainProvider = new SimulatedChainProvider();

/**
 * Deterministic DEMO receive addresses for a user. They have a valid *format*
 * for each network but are NOT derived from any key — funds sent there on a
 * real chain would be lost. The UI labels them as demo addresses.
 */
export function demoAddressesFor(userId: string): Record<NetworkName, string> {
  const h = (salt: string) => crypto.createHash('sha256').update(`kamkam-demo:${userId}:${salt}`).digest();
  const b58 = (buf: Buffer, len: number) => {
    let s = '';
    for (let i = 0; s.length < len; i++) s += B58[buf[i % buf.length] % 58];
    return s;
  };
  const out = {} as Record<NetworkName, string>;
  for (const n of NETWORK_NAMES) {
    const fam = NETWORKS[n].family;
    if (fam === 'evm') out[n] = '0x' + h('evm').toString('hex').slice(0, 40);
    else if (fam === 'solana') out[n] = b58(Buffer.concat([h('sol'), h('sol2')]), 44);
    else out[n] = 'T' + b58(h('tron'), 33);
  }
  return out;
}
