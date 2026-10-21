import 'server-only';
import { createPublicClient, erc20Abi, http, isAddress, type Address, type Chain } from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { env } from './env';

/**
 * Networks & assets KAMKAM can ACTUALLY move with Coinbase Developer Platform
 * server wallets (verified against @coinbase/cdp-sdk network capabilities):
 *   EVM transfer: ethereum, base (+ sepolia testnets) · Solana: mainnet, devnet.
 * BNB Chain and TRON are NOT supported by CDP and are therefore not offered.
 * Balances are read straight from each chain's RPC — never stored or assumed.
 */
export type NetworkId = 'ethereum' | 'base' | 'solana';
export type AssetSymbol = 'ETH' | 'USDC' | 'USDT' | 'SOL';

export interface AssetCfg {
  symbol: AssetSymbol;
  decimals: number;
  kind: 'native' | 'erc20' | 'spl';
  address?: string;           // ERC-20 contract or SPL mint
  cdpToken: string;           // value passed to CDP transfer()
  coingeckoId: string;
}
export interface NetworkCfg {
  id: NetworkId;
  label: string;
  family: 'evm' | 'solana';
  testnet: boolean;
  cdpNetwork: string;         // CDP network identifier
  chain?: Chain;
  rpcUrl: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
  color: string;
  assets: AssetCfg[];
}

const ETH: Omit<AssetCfg, 'address'> = { symbol: 'ETH', decimals: 18, kind: 'native', cdpToken: 'eth', coingeckoId: 'ethereum' };
const SOL: Omit<AssetCfg, 'address'> = { symbol: 'SOL', decimals: 9, kind: 'native', cdpToken: 'sol', coingeckoId: 'solana' };

function networks(mode: 'mainnet' | 'testnet'): NetworkCfg[] {
  const t = mode === 'testnet';
  return [
    {
      id: 'ethereum', label: t ? 'Ethereum Sepolia' : 'Ethereum', family: 'evm', testnet: t,
      cdpNetwork: t ? 'ethereum-sepolia' : 'ethereum', chain: t ? sepolia : mainnet,
      rpcUrl: env.rpc.ethereum || (t ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com'),
      explorerTx: h => `https://${t ? 'sepolia.' : ''}etherscan.io/tx/${h}`,
      explorerAddress: a => `https://${t ? 'sepolia.' : ''}etherscan.io/address/${a}`,
      color: '#5B6BD6',
      assets: [
        { ...ETH },
        { symbol: 'USDC', decimals: 6, kind: 'erc20', cdpToken: 'usdc', coingeckoId: 'usd-coin',
          address: t ? '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' : '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        ...(t ? [] : [{ symbol: 'USDT' as const, decimals: 6, kind: 'erc20' as const, coingeckoId: 'tether',
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', cdpToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }]),
      ],
    },
    {
      id: 'base', label: t ? 'Base Sepolia' : 'Base', family: 'evm', testnet: t,
      cdpNetwork: t ? 'base-sepolia' : 'base', chain: t ? baseSepolia : base,
      rpcUrl: env.rpc.base || (t ? 'https://sepolia.base.org' : 'https://mainnet.base.org'),
      explorerTx: h => `https://${t ? 'sepolia.' : ''}basescan.org/tx/${h}`,
      explorerAddress: a => `https://${t ? 'sepolia.' : ''}basescan.org/address/${a}`,
      color: '#2F5BD6',
      assets: [
        { ...ETH },
        { symbol: 'USDC', decimals: 6, kind: 'erc20', cdpToken: 'usdc', coingeckoId: 'usd-coin',
          address: t ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e' : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      ],
    },
    {
      id: 'solana', label: t ? 'Solana Devnet' : 'Solana', family: 'solana', testnet: t,
      cdpNetwork: t ? 'devnet' : 'mainnet',
      rpcUrl: env.rpc.solana || (t ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'),
      explorerTx: h => `https://explorer.solana.com/tx/${h}${t ? '?cluster=devnet' : ''}`,
      explorerAddress: a => `https://explorer.solana.com/address/${a}${t ? '?cluster=devnet' : ''}`,
      color: '#3E9E7A',
      assets: [
        { ...SOL },
        { symbol: 'USDC', decimals: 6, kind: 'spl', cdpToken: 'usdc', coingeckoId: 'usd-coin',
          address: t ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        ...(t ? [] : [{ symbol: 'USDT' as const, decimals: 6, kind: 'spl' as const, coingeckoId: 'tether',
          address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', cdpToken: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }]),
      ],
    },
  ];
}

export const NETWORKS = () => networks(env.cryptoMode);
export const getNetwork = (id: string) => NETWORKS().find(n => n.id === id);
export const getAsset = (net: NetworkCfg, sym: string) => net.assets.find(a => a.symbol === sym);

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function validAddress(net: NetworkCfg, addr: string) {
  return net.family === 'evm' ? isAddress(addr, { strict: false }) : SOL_ADDR.test(addr);
}

const clients = new Map<string, ReturnType<typeof createPublicClient>>();
export function evmClient(net: NetworkCfg) {
  let c = clients.get(net.id);
  if (!c) { c = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl, { timeout: 15000 }) }); clients.set(net.id, c); }
  return c;
}

async function solanaRpc<T>(net: NetworkCfg, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(net.rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Solana RPC error');
  return json.result as T;
}

/** On-chain balance in atomic units, or null when the chain could not be reached (never a guessed 0). */
export async function readBalance(net: NetworkCfg, asset: AssetCfg, owner: string): Promise<bigint | null> {
  try {
    if (net.family === 'evm') {
      const c = evmClient(net);
      if (asset.kind === 'native') return await c.getBalance({ address: owner as Address });
      return await c.readContract({ address: asset.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] });
    }
    if (asset.kind === 'native') {
      const r = await solanaRpc<{ value: number }>(net, 'getBalance', [owner, { commitment: 'confirmed' }]);
      return BigInt(r.value);
    }
    const r = await solanaRpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
      net, 'getTokenAccountsByOwner', [owner, { mint: asset.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return r.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  } catch {
    return null;
  }
}

export type ChainTxState = 'confirmed' | 'failed' | 'pending' | 'unknown';
/** Confirmation is decided by the chain itself, never by the button click. */
export async function readTxState(net: NetworkCfg, hash: string): Promise<ChainTxState> {
  try {
    if (net.family === 'evm') {
      const receipt = await evmClient(net).getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
      if (!receipt) return 'pending';
      return receipt.status === 'success' ? 'confirmed' : 'failed';
    }
    const r = await solanaRpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>(net, 'getSignatureStatuses', [[hash], { searchTransactionHistory: true }]);
    const s = r.value[0];
    if (!s) return 'pending';
    if (s.err) return 'failed';
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending';
  } catch {
    return 'unknown';
  }
}
