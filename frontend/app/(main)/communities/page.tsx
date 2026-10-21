'use client';
import { useState } from 'react';
import { api, type Community } from '@/lib/api';
import { compact } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useViewport } from '@/hooks/useViewport';
import { useApp } from '@/components/AppProvider';
import { CloseBtn, Empty, ErrorBox, Modal, Spinner } from '@/components/ui';

const HUES = ['#2F6F4E', '#B0553C', '#6B4E8C', '#1F6E7A', '#8C6A2F', '#8C3F5C'];

export default function CommunitiesPage() {
  const { showToast } = useApp();
  const list = useAsync(() => api.communities(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const toggle = async (c: Community) => {
    if (busy) return;
    setBusy(c.id);
    // optimistic, reverted on failure
    list.setData(d => d && d.map(x => (x.id === c.id ? { ...x, joined: !c.joined, members: x.members + (c.joined ? -1 : 1) } : x)));
    try {
      if (c.joined) await api.leaveCommunity(c.id); else await api.joinCommunity(c.id);
      showToast(c.joined ? `Left ${c.name}` : `Joined ${c.name}`);
    } catch (e) {
      list.setData(d => d && d.map(x => (x.id === c.id ? c : x)));
      showToast((e as Error).message);
    } finally { setBusy(null); }
  };

  return (
    <div>
      <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px')}>
        <div><h1 style={s('margin:0;font-size:26px;font-weight:800;letter-spacing:-.02em')}>Communities</h1><p style={s('margin:4px 0 0;font-size:14px;color:#6B7268')}>Spaces where gifts go further.</p></div>
        <button onClick={() => setCreating(true)} className={H.green} style={s('margin-left:auto;background:#14975C;color:#fff;font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:99px')}>Create community</button>
      </div>
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <div style={s('display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px')}>{[0, 1, 2, 3].map(i => <div key={i} className="kk-skel" style={{ height: 210, borderRadius: 18 }} />)}</div>}
      {list.data && list.data.length === 0 && <Empty title="No communities yet" body="Create the first one." />}
      <div style={s('display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px')}>
        {list.data?.map((c, i) => (
          <div key={c.id} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:18px;overflow:hidden')}>
            <div style={s('height:78px;background:repeating-linear-gradient(115deg,#EDF1EC 0 12px,#E4EAE3 12px 24px)')} />
            <div style={s('padding:0 16px 16px')}>
              <div style={{ width: 46, height: 46, borderRadius: 14, background: c.color || HUES[i % HUES.length], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, border: '3px solid #fff', marginTop: -25 }}>{c.name.slice(0, 2).toUpperCase()}</div>
              <div style={s('font-size:15.5px;font-weight:800;margin-top:10px')}>{c.name}</div>
              <div style={s('margin-top:4px;font-size:13px;color:#6B7268;line-height:1.5;min-height:39px;text-wrap:pretty')}>{c.description}</div>
              <div style={s('display:flex;align-items:center;gap:10px;margin-top:12px')}>
                <span style={s('font-size:12.5px;color:#6B7268;font-weight:600')}>{compact(c.members)} member{c.members === 1 ? '' : 's'}</span>
                <button onClick={() => toggle(c)} disabled={busy === c.id} style={c.joined ? s('margin-left:auto;font-size:13px;font-weight:700;border:1px solid rgba(16,20,16,.14);padding:8px 16px;border-radius:99px') : s('margin-left:auto;font-size:13px;font-weight:700;background:#14975C;color:#fff;padding:8px 18px;border-radius:99px')}>{c.joined ? 'Joined' : 'Join'}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateCommunity onClose={() => setCreating(false)} onCreated={() => { setCreating(false); list.reload(); }} />}
    </div>
  );
}

function CreateCommunity({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { isMobile } = useViewport();
  const { showToast } = useApp();
  const [f, setF] = useState({ name: '', description: '', color: HUES[0] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = s('margin-top:6px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:12px 14px;outline:none;font-size:14.5px;font-weight:600');
  const lab = s('display:block;margin-top:12px;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7268');
  const save = async () => {
    if (busy) return;
    if (f.name.trim().length < 3) { setErr('Name must be at least 3 characters.'); return; }
    setBusy(true); setErr(null);
    try { await api.createCommunity(f); showToast(`${f.name.trim()} created`); onCreated(); }
    catch (e) { setErr((e as { code?: string }).code === 'CONFLICT' ? 'A community with that name already exists.' : (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} isMobile={isMobile} label="Create community">
      <div style={s('display:flex;align-items:center;justify-content:space-between')}><h2 style={s('margin:0;font-size:19px;font-weight:800')}>Create community</h2><CloseBtn onClick={onClose} /></div>
      <label style={lab}>Name<input style={input} value={f.name} maxLength={40} onChange={e => setF({ ...f, name: e.target.value })} autoFocus /></label>
      <label style={lab}>Description<textarea style={{ ...input, resize: 'none' }} rows={3} maxLength={200} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      <div style={lab}>Colour</div>
      <div style={s('display:flex;gap:8px;margin-top:8px')}>
        {HUES.map(h => <button key={h} onClick={() => setF({ ...f, color: h })} aria-label={'Colour ' + h} style={{ width: 32, height: 32, borderRadius: 10, background: h, border: f.color === h ? '3px solid #101410' : '3px solid transparent' }} />)}
      </div>
      {err && <div role="alert" style={s('margin-top:12px;font-size:13px;font-weight:700;color:#A8331F')}>{err}</div>}
      <button onClick={save} disabled={busy} className={H.green} style={s('margin-top:18px;width:100%;background:#14975C;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px;display:flex;justify-content:center;gap:8px;align-items:center')}>{busy && <Spinner size={15} color="#fff" />}Create</button>
    </Modal>
  );
}
