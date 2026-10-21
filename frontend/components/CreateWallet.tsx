'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { shortAddr } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useViewport } from '@/hooks/useViewport';
import { useApp } from './AppProvider';
import { Badge, CloseBtn, I, Icon, Modal, Spinner } from './ui';

/**
 * Crypto wallet creation = provisioning real accounts with Coinbase Developer Platform
 * (CDP) Server Wallets via the KAMKAM server. Keys are generated and held inside CDP's
 * secure enclave — KAMKAM stores only the public addresses. No phrase is shown because
 * none exists on this device; we say so plainly instead of imitating a self-custody flow.
 */
export function CreateWalletModal() {
  const { createWalletOpen, setCreateWalletOpen, bumpWallet } = useApp();
  if (!createWalletOpen) return null;
  return <Inner onClose={() => setCreateWalletOpen(false)} onDone={() => bumpWallet()} />;
}

function Inner({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { isMobile } = useViewport();
  const { config } = useApp();
  const [step, setStep] = useState<'intro' | 'done'>('intro');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addr, setAddr] = useState<{ evm: string; sol: string } | null>(null);
  const enabled = !!config?.crypto.enabled;
  const testnet = config?.crypto.mode !== 'mainnet';
  const nets = config?.crypto.networks ?? [];

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const w = await api.provisionWallet();
      if (w.status !== 'ready' || !w.evmAddress || !w.solanaAddress) throw new Error(w.lastError || 'The wallet provider did not finish creating your wallet. Please try again.');
      setAddr({ evm: w.evmAddress, sol: w.solanaAddress });
      setStep('done');
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} isMobile={isMobile} label="Create wallet" z={92}>
      {step === 'intro' && (
        <div>
          <div style={s('display:flex;align-items:flex-start;justify-content:space-between;gap:12px')}>
            <div>
              <h2 style={s('margin:0;font-size:20px;font-weight:800;letter-spacing:-.02em;display:flex;align-items:center;gap:9px')}>Create Your Crypto Wallet {enabled && testnet && <Badge text="Testnet" title="Test networks — tokens have no real value" />}</h2>
              <p style={s('margin:6px 0 0;font-size:13.5px;color:#5A6358;line-height:1.6;max-width:46ch;text-wrap:pretty')}>KAMKAM creates real on-chain accounts for you with Coinbase Developer Platform.</p>
            </div>
            <CloseBtn onClick={onClose} />
          </div>

          {!config && <div className="kk-skel" style={{ height: 120, marginTop: 16, borderRadius: 18 }} />}
          {config && !enabled && (
            <div style={s('margin-top:16px;padding:14px;border-radius:16px;background:#FFFCF4;border:1px solid rgba(201,138,18,.3)')}>
              <div style={s('font-size:14px;font-weight:800;color:#8A5E08')}>Not available yet</div>
              <div style={s('margin-top:5px;font-size:13px;color:#8A5E08;line-height:1.55')}>Crypto wallets are not configured on this server. Your Naira balance, gifts and earnings work without it.</div>
            </div>
          )}
          {config && enabled && (
            <>
              <div style={s('display:flex;flex-direction:column;gap:8px;margin-top:16px')}>
                {[
                  ['Provider-managed keys', 'Private keys are generated and stored in Coinbase’s secure enclave. They never reach KAMKAM, this device or your browser.'],
                  ['Networks', nets.map(n => `${n.label} (${n.assets.join(', ')})`).join(' · ')],
                  ['Real transactions', 'Sends are signed by the provider and broadcast on-chain. You get a transaction hash and explorer link for every one.'],
                ].map(([t, d]) => (
                  <div key={t} style={s('padding:12px 14px;border-radius:14px;background:#F5F7F4')}>
                    <div style={s('font-size:13.5px;font-weight:750')}>{t}</div>
                    <div style={s('margin-top:3px;font-size:12.5px;color:#6B7268;line-height:1.55')}>{d}</div>
                  </div>
                ))}
              </div>
              {testnet && <p style={s('margin:12px 0 0;font-size:13px;color:#8A5E08;background:#FFFCF4;border:1px solid rgba(201,138,18,.3);border-radius:13px;padding:12px 14px;line-height:1.6;font-weight:700')}>This server runs on test networks. Testnet tokens have no monetary value — never send real funds to these addresses.</p>}
              <button onClick={() => setAgreed(a => !a)} style={s('display:flex;align-items:center;gap:11px;width:100%;margin-top:12px;padding:12px 4px;text-align:left')} role="checkbox" aria-checked={agreed}>
                <span style={{ width: 21, height: 21, borderRadius: 6, flex: 'none', border: agreed ? 'none' : '2px solid rgba(16,20,16,.25)', background: agreed ? '#14975C' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                  <Icon d={I.check} size={13} sw={3} />
                </span>
                <span style={s('font-size:13.5px;font-weight:650;line-height:1.5')}>I understand this wallet is custodied by KAMKAM’s wallet provider, and that blockchain transfers cannot be reversed.</span>
              </button>
              {err && <div role="alert" style={s('margin-top:10px;font-size:13px;font-weight:700;color:#A8331F')}>{err}</div>}
              <button onClick={create} disabled={!agreed || busy}
                style={{ marginTop: 14, width: '100%', padding: 15, borderRadius: 15, fontSize: 15, fontWeight: 800, color: '#fff', background: !agreed ? 'rgba(16,20,16,.16)' : '#14975C', cursor: !agreed ? 'not-allowed' : 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 9 }}>
                {busy && <Spinner size={16} color="#fff" />}{busy ? 'Creating wallet…' : 'Create Wallet'}
              </button>
              <p style={s('margin:12px 0 0;font-size:12px;color:#9AA197;text-align:center;line-height:1.5')}>KAMKAM will never ask you for a password, phrase or key to move your funds.</p>
            </>
          )}
        </div>
      )}

      {step === 'done' && addr && (
        <div style={s('text-align:center;padding:10px 4px 4px')}>
          <div style={s('width:74px;height:74px;margin:0 auto;border-radius:50%;background:#14975C;color:#fff;display:flex;align-items:center;justify-content:center;animation:kkPop .5s cubic-bezier(.2,1.4,.4,1) both')}><Icon d={I.check} size={34} sw={2.4} /></div>
          <h2 style={s('margin:18px 0 0;font-size:21px;font-weight:800;letter-spacing:-.02em')}>Wallet Created Successfully</h2>
          <p style={s('margin:8px auto 0;font-size:14px;color:#5A6358;line-height:1.6;max-width:38ch')}>Your accounts were created by the wallet provider. They start empty — balances appear once funds arrive on-chain.</p>
          <div style={s('margin-top:14px;padding:12px 14px;border-radius:14px;background:#F5F7F4;text-align:left;font-size:13px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px')}>
            <span style={s('color:#6B7268;font-weight:600')}>Ethereum &amp; Base</span><span style={s('font-family:ui-monospace,Menlo,monospace;font-weight:700;text-align:right')} title={addr.evm}>{shortAddr(addr.evm)}</span>
            <span style={s('color:#6B7268;font-weight:600')}>Solana</span><span style={s('font-family:ui-monospace,Menlo,monospace;font-weight:700;text-align:right')} title={addr.sol}>{shortAddr(addr.sol)}</span>
          </div>
          <button onClick={onClose} className={H.green} style={s('margin-top:20px;width:100%;background:#14975C;color:#fff;font-weight:800;font-size:15px;padding:15px;border-radius:15px')}>Open My Wallet</button>
        </div>
      )}
    </Modal>
  );
}
