'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Me, Post, PublicUser, ServerConfig, Wallet } from '@/types';
import type { WalletAction } from '@/lib/api';

export type GiftTarget = { post?: Post; user: PublicUser; liveSessionId?: string };
export type FlowName = WalletAction | 'receive';

interface Ctx {
  me: Me | null;
  authLoading: boolean;
  setMe: (u: Me | null) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;

  wallet: Wallet | null;
  walletError: string | null;
  refreshWallet: () => Promise<void>;
  /** Which money integrations the server actually has configured (null while loading / unreachable). */
  config: ServerConfig | null;

  posts: Record<string, Post>;
  upsertPosts: (list: Post[]) => void;
  patchPost: (id: string, p: Partial<Post>) => void;
  removePost: (id: string) => void;

  toast: string | null;
  showToast: (msg: string) => void;

  composerOpen: boolean | 'story';
  setComposerOpen: (v: boolean | 'story') => void;
  giftTarget: GiftTarget | null;
  openGift: (t: GiftTarget) => void;
  closeGift: () => void;
  flow: { name: FlowName; preset?: Record<string, string> } | null;
  openFlow: (name: FlowName, preset?: Record<string, string>) => void;
  closeFlow: () => void;
  createWalletOpen: boolean;
  setCreateWalletOpen: (v: boolean) => void;
  walletVersion: number;
  bumpWallet: () => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp() {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [posts, setPosts] = useState<Record<string, Post>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState<boolean | 'story'>(false);
  const [giftTarget, setGiftTarget] = useState<GiftTarget | null>(null);
  const [flow, setFlow] = useState<Ctx['flow']>(null);
  const [createWalletOpen, setCreateWalletOpen] = useState(false);
  const [walletVersion, setWalletVersion] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refreshMe = useCallback(async () => {
    if (!supabaseConfigured) { setMe(null); return; }
    const { data } = await supabase().auth.getSession();
    if (!data.session) { setMe(null); return; }
    try { setMe((await api.me()).user); }
    catch (e) {
      // Only drop the user on auth failures; keep them signed in through network blips.
      if (e instanceof ApiError && (e.status === 401 || e.code === 'UNAUTHENTICATED')) { await supabase().auth.signOut().catch(() => null); setMe(null); }
    }
  }, []);

  const refreshWallet = useCallback(async () => {
    try { setWallet((await api.wallet()).wallet); setWalletError(null); }
    catch (e) { setWalletError((e as Error).message); }
  }, []);

  useEffect(() => { api.config().then(setConfig).catch(() => setConfig(null)); }, []);

  // Session bootstrap + Supabase Auth events (sign-in, token refresh, sign-out, expiry)
  useEffect(() => {
    refreshMe().finally(() => setAuthLoading(false));
    if (!supabaseConfigured) return;
    const { data: sub } = supabase().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { setMe(null); setPosts({}); }
      else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') { setTimeout(refreshMe, 0); }
    });
    return () => sub.subscription.unsubscribe();
  }, [refreshMe]);

  // Realtime: new notifications/messages update badges instantly (RLS-filtered).
  // Wallet notifications (deposit credited, withdrawal settled, gift received) also refresh balances.
  useEffect(() => {
    if (!me?.id || !supabaseConfigured) return;
    const ch = supabase().channel('me-' + me.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me.id}` }, () => { refreshMe(); refreshWallet(); setWalletVersion(v => v + 1); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => refreshMe())
      .subscribe();
    return () => { supabase().removeChannel(ch); };
  }, [me?.id, refreshMe, refreshWallet]);
  useEffect(() => { if (me) refreshWallet(); else setWallet(null); }, [me?.id, refreshWallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep unread badges fresh
  useEffect(() => {
    if (!me) return;
    const t = setInterval(refreshMe, 30000); // fallback when Realtime is unavailable
    return () => clearInterval(t);
  }, [me?.id, refreshMe]); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = useCallback((msg: string) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const value = useMemo<Ctx>(() => ({
    me, authLoading, setMe, refreshMe,
    logout: async () => { await api.logout().catch(() => null); setMe(null); setPosts({}); },
    wallet, walletError, refreshWallet, config,
    posts,
    upsertPosts: list => setPosts(p => { const n = { ...p }; list.forEach(x => { n[x.id] = x; }); return n; }),
    patchPost: (id, patch) => setPosts(p => (p[id] ? { ...p, [id]: { ...p[id], ...patch } } : p)),
    removePost: id => setPosts(p => { const n = { ...p }; delete n[id]; return n; }),
    toast, showToast,
    composerOpen, setComposerOpen,
    giftTarget, openGift: t => { setFlow(null); setGiftTarget(t); }, closeGift: () => setGiftTarget(null),
    flow, openFlow: (name, preset) => { setGiftTarget(null); setFlow({ name, preset }); }, closeFlow: () => setFlow(null),
    createWalletOpen, setCreateWalletOpen,
    walletVersion, bumpWallet: () => { setWalletVersion(v => v + 1); refreshWallet(); refreshMe(); },
  }), [me, authLoading, refreshMe, wallet, walletError, refreshWallet, config, posts, toast, showToast, composerOpen, giftTarget, flow, createWalletOpen, walletVersion]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
