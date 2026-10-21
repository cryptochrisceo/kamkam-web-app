/**
 * KAMKAM data client — Supabase edition.
 * Same `api.*` surface the UI has always used; implemented with supabase-js.
 *  • Reads: Postgres RPCs that return UI-shaped JSON (RLS enforced)
 *  • Simple writes: table inserts/deletes guarded by RLS
 *  • Money: trusted Postgres functions (server-side maths, atomic, idempotent)
 *  • Media: Supabase Storage (public avatars/post media, private DM attachments)
 */
import type { PostgrestError } from '@supabase/supabase-js';
import type {
  ChainBalances, Comment, Conversation, CryptoSend, Earnings, GiftQuote, GiftRecord, LiveSession, LiveView, Me, Message, Notification, Post, Profile,
  PublicUser, ServerConfig, Wallet, WalletTx,
} from '@/types';
import { supabase, SUPABASE_URL } from './supabase';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export type PostCounts = { likeCount: number; repostCount: number; commentCount: number; giftCount: number; superLikeCount: number };
export type WalletAction = 'buy' | 'sell' | 'swap' | 'send' | 'transfer' | 'deposit' | 'withdraw';
export type MediaItem = { url: string; type: 'IMAGE' | 'VIDEO' };

// ── Error handling ────────────────────────────────────────────────
function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const err = e as Partial<PostgrestError> & { status?: number; name?: string };
  const msg = String(err?.message ?? e ?? 'Something went wrong.');
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg)) return new ApiError(0, 'Network unavailable. Check your connection and try again.', 'NETWORK');
  if (err.code === 'P0001' && err.hint) return new ApiError(400, msg, err.hint);
  if (err.code === 'PGRST301' || /JWT expired|invalid JWT/i.test(msg)) return new ApiError(401, 'Your session has expired. Please log in again.', 'UNAUTHENTICATED');
  if (err.code === '42501' || /row-level security|permission denied/i.test(msg)) return new ApiError(403, 'You are not allowed to do that.', 'FORBIDDEN');
  if (err.code === '23505') return new ApiError(409, 'That already exists.', 'CONFLICT');
  if (err.code === '23514') return new ApiError(400, 'Some of the details are not valid.', 'VALIDATION');
  if (err.code === '23503') return new ApiError(404, 'That item no longer exists.', 'NOT_FOUND');
  if (err.code === 'PGRST116') return new ApiError(404, 'Not found, or you are not allowed to change it.', 'NOT_FOUND');
  return new ApiError(err.status ?? 500, msg, err.code);
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const { data, error } = await supabase().rpc(fn, args ?? {});
    if (error) throw error;
    return data as T;
  } catch (e) { throw await withSessionHint(toApiError(e)); }
}

/** A "permission denied" while signed out really means "please log in". */
async function withSessionHint(e: ApiError): Promise<ApiError> {
  if (e.code !== 'FORBIDDEN') return e;
  const { data } = await supabase().auth.getSession().catch(() => ({ data: { session: null } }));
  return data.session ? e : new ApiError(401, 'You need to log in to do that.', 'UNAUTHENTICATED');
}

async function run<T>(p: PromiseLike<{ data: T; error: unknown }>, opts: { ignoreDuplicate?: boolean } = {}): Promise<T> {
  try {
    const { data, error } = await p;
    if (error) {
      if (opts.ignoreDuplicate && (error as PostgrestError).code === '23505') return data;
      throw error;
    }
    return data;
  } catch (e) { throw toApiError(e); }
}

async function need<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const d = await run(p);
  if (d === null || d === undefined) throw new ApiError(404, 'Not found.', 'NOT_FOUND');
  return d as NonNullable<T>;
}

async function uid(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new ApiError(401, 'You need to log in to do that.', 'UNAUTHENTICATED');
  return id;
}

export const newIdempotencyKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

// ── Storage ───────────────────────────────────────────────────────
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'];
const MB = 1024 * 1024;
const extOf = (f: File) => (f.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? f.type.split('/')[1]?.split(';')[0] ?? 'bin').toLowerCase();
const rand = () => Math.random().toString(36).slice(2, 10);

async function uploadTo(bucket: string, folder: string, file: File): Promise<string> {
  const objectPath = `${folder}/${Date.now()}-${rand()}.${extOf(file)}`;
  try {
    const { error } = await supabase().storage.from(bucket).upload(objectPath, file, { contentType: file.type.split(';')[0], upsert: false, cacheControl: '31536000' });
    if (error) throw error;
  } catch (e) {
    const m = String((e as Error)?.message ?? '');
    if (/exceeded|too large|413/i.test(m)) throw new ApiError(413, 'That file is too large.', 'UPLOAD');
    if (/mime|type/i.test(m)) throw new ApiError(415, 'That file type is not supported.', 'UPLOAD');
    throw toApiError(e);
  }
  return `${bucket}/${objectPath}`;
}

async function removeStored(paths: (string | null | undefined)[]) {
  const byBucket = new Map<string, string[]>();
  for (const p of paths) {
    if (!p) continue;
    const i = p.indexOf('/');
    if (i < 0) continue;
    const b = p.slice(0, i);
    byBucket.set(b, [...(byBucket.get(b) ?? []), p.slice(i + 1)]);
  }
  await Promise.all([...byBucket].map(([b, list]) => supabase().storage.from(b).remove(list).catch(() => null)));
}

/** Public URL for stored media ("avatars/…" or "post-media/…"). */
export const mediaUrl = (u: string | null | undefined) => {
  if (!u) return '';
  if (/^(https?:|blob:|data:)/.test(u)) return u;
  if (u.startsWith('avatars/') || u.startsWith('post-media/')) return `${SUPABASE_URL}/storage/v1/object/public/${u.split('/').map(encodeURIComponent).join('/')}`;
  return '';
};

function nestComments(flat: Comment[]): Comment[] {
  const byId = new Map<string, Comment>();
  flat.forEach(c => byId.set(c.id, { ...c, replies: [] }));
  const roots: Comment[] = [];
  byId.forEach(c => { const p = c.parentId ? byId.get(c.parentId) : null; if (p) p.replies.push(c); else roots.push(c); });
  return roots;
}

const counts = (id: string) => rpc<PostCounts>('post_counts', { p_id: id });

type GiftBody = { postId?: string; recipientId?: string; liveSessionId?: string; amountNgn: number };
export type Story = { id: string; text: string | null; mediaPath: string | null; mediaKind: 'IMAGE' | 'VIDEO' | null; createdAt: string };
export type StoryAuthor = PublicUser & { stories: Story[] };
export type Community = { id: string; name: string; description: string; color: string; members: number; joined: boolean; isOwner: boolean };

export const api = {
  // ── Auth ────────────────────────────────────────────────────────
  usernameAvailable: (username: string) => rpc<boolean>('username_available', { p_username: username }),

  register: async (b: { username: string; displayName: string; email: string; password: string }) => {
    const username = b.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new ApiError(400, 'Username must be 3–20 letters, numbers or underscores.', 'VALIDATION');
    if (!(await api.usernameAvailable(username))) throw new ApiError(409, 'That username is taken.', 'ACCOUNT_EXISTS');
    const { data, error } = await supabase().auth.signUp({
      email: b.email.trim().toLowerCase(),
      password: b.password,
      options: { data: { username, display_name: b.displayName.trim() }, emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      if (/already registered|already been registered/i.test(error.message)) throw new ApiError(409, 'An account with that email already exists.', 'ACCOUNT_EXISTS');
      if (/Database error/i.test(error.message)) throw new ApiError(409, 'That username was just taken. Please choose another.', 'ACCOUNT_EXISTS');
      throw new ApiError(error.status ?? 400, error.message, 'AUTH');
    }
    // With email confirmation enabled there is no session until the email link is opened.
    if (!data.session) return { user: null as Me | null, needsConfirmation: true };
    return { user: (await api.me()).user as Me | null, needsConfirmation: false };
  },

  login: async (b: { identifier: string; password: string }) => {
    const email = b.identifier.trim().toLowerCase();
    if (!email.includes('@')) throw new ApiError(400, 'Enter the email address you signed up with.', 'VALIDATION');
    const { error } = await supabase().auth.signInWithPassword({ email, password: b.password });
    if (error) {
      if (/not confirmed/i.test(error.message)) throw new ApiError(403, 'Please confirm your email first — check your inbox for the link.', 'EMAIL_NOT_CONFIRMED');
      if (/invalid/i.test(error.message)) throw new ApiError(401, 'Incorrect email or password.', 'UNAUTHENTICATED');
      throw new ApiError(error.status ?? 400, error.message, 'AUTH');
    }
    return api.me();
  },

  logout: async () => { await supabase().auth.signOut(); return { ok: true as const }; },

  requestPasswordReset: async (email: string) => {
    const { error } = await supabase().auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${window.location.origin}/reset-password` });
    if (error) throw new ApiError(error.status ?? 400, error.message, 'AUTH');
    return { ok: true as const };
  },

  updatePassword: async (password: string) => {
    if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.', 'VALIDATION');
    const { error } = await supabase().auth.updateUser({ password });
    if (error) throw new ApiError(error.status ?? 400, error.message, 'AUTH');
    return { ok: true as const };
  },

  me: async () => {
    const { data } = await supabase().auth.getSession();
    if (!data.session) throw new ApiError(401, 'You need to log in to do that.', 'UNAUTHENTICATED');
    return { user: await rpc<Me>('me') };
  },

  updateMe: async (b: Partial<{ displayName: string; bio: string | null; avatar: string | null; coverImage: string | null; location: string | null; website: string | null; settings: Record<string, boolean> }>) => {
    const id = await uid();
    const patch: Record<string, unknown> = {};
    if (b.displayName !== undefined) patch.display_name = b.displayName.trim();
    if (b.bio !== undefined) patch.bio = b.bio;
    if (b.avatar !== undefined) patch.avatar_path = b.avatar;
    if (b.coverImage !== undefined) patch.cover_path = b.coverImage;
    if (b.location !== undefined) patch.location = b.location;
    if (b.website !== undefined) patch.website = b.website;
    if (b.settings !== undefined) patch.settings = b.settings;
    const before = await need(supabase().from('profiles').select('avatar_path, cover_path').eq('id', id).single());
    await run(supabase().from('profiles').update(patch).eq('id', id).select('id').single());
    // Remove replaced/removed images from storage (best effort)
    const stale = [b.avatar !== undefined && before.avatar_path !== b.avatar ? before.avatar_path : null,
                   b.coverImage !== undefined && before.cover_path !== b.coverImage ? before.cover_path : null];
    removeStored(stale);
    return api.me();
  },

  uploadProfileImage: async (file: File) => {
    if (!IMAGE_TYPES.includes(file.type)) throw new ApiError(415, 'Choose a JPG, PNG, WEBP or GIF image.', 'UPLOAD');
    if (file.size > 5 * MB) throw new ApiError(413, 'Profile and cover images must be 5 MB or smaller.', 'UPLOAD');
    return uploadTo('avatars', await uid(), file);
  },

  // ── Users ───────────────────────────────────────────────────────
  profile: async (idOrUsername: string) => ({ user: await rpc<Profile>('profile_view', { p_key: idOrUsername }) }),
  userPosts: (id: string, tab = 'posts') =>
    rpc<{ posts?: Post[]; replies?: { id: string; text: string; createdAt: string; author: PublicUser; post: { id: string; text: string; username: string } }[] }>('user_posts', { p_user: id, p_tab: tab }),
  giftWall: (id: string) => rpc<{ hidden?: boolean; gifts: { id: string; sender: PublicUser; tier: string; note: string; createdAt: string }[] }>('gift_wall', { p_user: id }),
  suggested: async (limit = 4) => ({ users: await rpc<PublicUser[]>('suggested_users', { p_limit: limit }) }),
  follow: async (id: string) => {
    await run(supabase().from('follows').insert({ follower_id: await uid(), following_id: id }), { ignoreDuplicate: true });
    const p = await need(supabase().from('profiles').select('follower_count').eq('id', id).single());
    return { following: true, followers: p.follower_count as number };
  },
  unfollow: async (id: string) => {
    await run(supabase().from('follows').delete().eq('follower_id', await uid()).eq('following_id', id));
    const p = await need(supabase().from('profiles').select('follower_count').eq('id', id).single());
    return { following: false, followers: p.follower_count as number };
  },
  followers: async (id: string) => ({ users: await rpc<PublicUser[]>('follow_list', { p_user: id, p_kind: 'followers' }) }),
  following: async (id: string) => ({ users: await rpc<PublicUser[]>('follow_list', { p_user: id, p_kind: 'following' }) }),

  // ── Posts ───────────────────────────────────────────────────────
  posts: (tab: string, offset = 0) => rpc<{ posts: Post[]; nextOffset: number | null }>('feed', { p_tab: tab, p_offset: offset, p_limit: 20 }),
  post: async (id: string) => ({ post: await rpc<Post>('post_detail', { p_id: id }) }),
  createPost: async (b: { text: string; media?: MediaItem[]; mediaUrls?: string[]; mediaType?: 'IMAGE' | 'VIDEO'; replyPolicy?: string; poll?: string[] }) => {
    const media = b.media ?? (b.mediaUrls ?? []).map(url => ({ url, type: b.mediaType ?? 'IMAGE' }));
    const post = await rpc<Post>('create_post', {
      p_text: b.text, p_media: media.map(m => ({ path: m.url, kind: m.type })),
      p_reply_policy: b.replyPolicy ?? 'Everyone', p_poll: b.poll && b.poll.length ? b.poll : null,
    });
    return { post };
  },
  updatePost: async (id: string, text: string) => {
    const rows = await need(supabase().from('posts').update({ text }).eq('id', id).select('id'));
    if (!rows.length) throw new ApiError(403, 'You can only edit your own posts.', 'FORBIDDEN');
    return api.post(id);
  },
  deletePost: async (id: string) => {
    const media = await need(supabase().from('post_media').select('path').eq('post_id', id));
    const deleted = await need(supabase().from('posts').delete().eq('id', id).select('id'));
    if (!deleted.length) throw new ApiError(403, 'You can only delete your own posts.', 'FORBIDDEN');
    removeStored(media.map(m => m.path as string));
    return { ok: true as const };
  },
  like: async (id: string) => {
    await run(supabase().from('likes').insert({ user_id: await uid(), post_id: id }), { ignoreDuplicate: true });
    return { liked: true, ...(await counts(id)) };
  },
  unlike: async (id: string) => {
    await run(supabase().from('likes').delete().eq('user_id', await uid()).eq('post_id', id));
    return { liked: false, superLiked: false, ...(await counts(id)) };
  },
  repost: async (id: string) => {
    await run(supabase().from('reposts').insert({ user_id: await uid(), post_id: id }), { ignoreDuplicate: true });
    return { reposted: true, ...(await counts(id)) };
  },
  unrepost: async (id: string) => {
    await run(supabase().from('reposts').delete().eq('user_id', await uid()).eq('post_id', id));
    return { reposted: false, ...(await counts(id)) };
  },
  bookmark: async (id: string) => {
    await run(supabase().from('bookmarks').insert({ user_id: await uid(), post_id: id }), { ignoreDuplicate: true });
    return { bookmarked: true };
  },
  unbookmark: async (id: string) => {
    await run(supabase().from('bookmarks').delete().eq('user_id', await uid()).eq('post_id', id));
    return { bookmarked: false };
  },
  bookmarks: () => rpc<{ posts: Post[] }>('bookmarks_list'),
  comments: async (id: string) => ({ comments: nestComments(await rpc<Comment[]>('comments_list', { p_post: id })) }),
  comment: async (id: string, text: string, parentId?: string) => {
    const me = await uid();
    const c = await need(supabase().from('comments').insert({ post_id: id, author_id: me, text, parent_id: parentId ?? null }).select('id, text, created_at, parent_id').single());
    const author = (await api.me()).user;
    return { comment: { id: c.id, text: c.text, createdAt: c.created_at, parentId: c.parent_id, author, replies: [] } as Comment, ...(await counts(id)) };
  },
  votePoll: async (postId: string, optionId: string) => {
    await run(supabase().from('poll_votes').insert({ post_id: postId, option_id: optionId, user_id: await uid() }), { ignoreDuplicate: true });
    return api.post(postId);
  },
  upload: async (files: File[]) => {
    const folder = await uid();
    const out: MediaItem[] = [];
    for (const f of files) {
      const isVideo = VIDEO_TYPES.includes(f.type);
      if (!isVideo && !IMAGE_TYPES.includes(f.type)) throw new ApiError(415, 'Only JPG, PNG, WEBP, GIF images or MP4/WEBM/MOV videos are allowed.', 'UPLOAD');
      if (f.size > (isVideo ? 50 : 10) * MB) throw new ApiError(413, isVideo ? 'Videos must be 50 MB or smaller.' : 'Images must be 10 MB or smaller.', 'UPLOAD');
      out.push({ url: await uploadTo('post-media', folder, f), type: isVideo ? 'VIDEO' : 'IMAGE' });
    }
    return { files: out };
  },

  // ── Stories ─────────────────────────────────────────────────────
  stories: () => rpc<StoryAuthor[]>('stories_feed'),
  createStory: async (b: { text?: string; media?: MediaItem | null }) => {
    const row = await need(supabase().from('stories').insert({
      author_id: await uid(), text: b.text?.trim() || null, media_path: b.media?.url ?? null, media_kind: b.media?.type ?? null,
    }).select('id').single());
    return { id: row.id as string };
  },
  deleteStory: async (id: string) => { await run(supabase().from('stories').delete().eq('id', id)); return { ok: true as const }; },

  // ── Communities ─────────────────────────────────────────────────
  communities: () => rpc<Community[]>('communities_list'),
  joinCommunity: async (id: string) => { await run(supabase().from('community_members').insert({ community_id: id, user_id: await uid() }), { ignoreDuplicate: true }); return { ok: true as const }; },
  leaveCommunity: async (id: string) => { await run(supabase().from('community_members').delete().eq('community_id', id).eq('user_id', await uid())); return { ok: true as const }; },
  createCommunity: async (b: { name: string; description: string; color: string }) => {
    await run(supabase().from('communities').insert({ name: b.name.trim(), description: b.description.trim(), color: b.color, created_by: await uid() }));
    return { ok: true as const };
  },

  // ── Discovery ───────────────────────────────────────────────────
  search: (qs: string) => rpc<{ q: string; users: PublicUser[]; posts: Post[] }>('search', { p_q: qs }),
  trending: () => rpc<{ topics: { tag: string; count: number; rise: string }[]; posts: Post[] }>('trending', { p_limit: 5 }),

  // ── Notifications ───────────────────────────────────────────────
  notifications: (filter = 'all') => rpc<{ unread: number; notifications: Notification[] }>('notifications_list', { p_filter: filter }),
  readNotifications: async () => { await run(supabase().from('notifications').update({ read: true }).eq('read', false)); return { ok: true as const }; },

  // ── Messages ────────────────────────────────────────────────────
  conversations: () => rpc<{ conversations: Conversation[] }>('conversations_list'),
  startConversation: async (userId: string) => ({ id: await rpc<string>('start_conversation', { p_user: userId }) }),
  messages: (id: string) => rpc<{ id: string; user: PublicUser | null; messages: Message[] }>('conversation_view', { p_conversation: id }),
  sendMessage: async (id: string, text: string) => {
    const m = await need(supabase().from('messages').insert({ conversation_id: id, sender_id: await uid(), body: text, kind: 'TEXT' }).select('id, body, kind, created_at').single());
    return { message: { id: m.id, text: m.body, kind: m.kind, createdAt: m.created_at, mine: true, read: false } as Message };
  },
  sendAttachment: async (id: string, file: File, kind: 'IMAGE' | 'AUDIO') => {
    const allowed = kind === 'IMAGE' ? IMAGE_TYPES : AUDIO_TYPES;
    if (!allowed.includes(file.type.split(';')[0])) throw new ApiError(415, kind === 'IMAGE' ? 'Choose a JPG, PNG, WEBP or GIF image.' : 'Unsupported audio format.', 'UPLOAD');
    if (file.size > 10 * MB) throw new ApiError(413, 'Attachments must be 10 MB or smaller.', 'UPLOAD');
    const me = await uid();
    const path = await uploadTo('message-attachments', `${id}/${me}`, file);
    const m = await need(supabase().from('messages').insert({ conversation_id: id, sender_id: me, kind, attachment_path: path }).select('id, body, kind, created_at, attachment_path').single());
    return { message: { id: m.id, text: m.body, kind: m.kind, attachment: m.attachment_path, createdAt: m.created_at, mine: true, read: false } as Message };
  },
  /** Short-lived signed URL for a private DM attachment (members only). */
  attachmentUrl: async (path: string) => {
    const objectPath = path.replace(/^message-attachments\//, '');
    const { data, error } = await supabase().storage.from('message-attachments').createSignedUrl(objectPath, 3600);
    if (error) throw toApiError(error);
    return data.signedUrl;
  },
  readConversation: async (id: string) => { await rpc('mark_conversation_read', { p_conversation: id }); return { ok: true as const }; },

  // ── Wallet ──────────────────────────────────────────────────────
  // Naira balances live in a server-side ledger; they change only through verified
  // Paystack events or atomic database functions. Crypto lives on-chain (CDP accounts).
  config: () => server<ServerConfig>('GET', '/api/config', undefined, { auth: false }),
  wallet: async (): Promise<{ wallet: Wallet }> => {
    const o = await rpc<{ ngn: Wallet['ngn']; limits: Wallet['limits']; crypto: Wallet['crypto'] }>('wallet_overview');
    return { wallet: { ...o, cryptoActivated: o.crypto?.status === 'ready' } };
  },
  transactions: async (filter = 'all') => rpc<{ transactions: WalletTx[] }>('wallet_activity', { p_filter: filter, p_limit: 60 }),
  updateWalletSecurity: (key: 'biometric' | 'txConfirm' | 'pin', value: boolean) => rpc<Record<string, boolean>>('update_wallet_security', { p_key: key, p_value: value }),

  /** Create the caller's Coinbase CDP accounts (EVM + Solana). Idempotent. */
  provisionWallet: () => server<NonNullable<Wallet['crypto']>>('POST', '/api/wallet/provision'),
  /** Live on-chain balances (read from each chain's RPC by the server). */
  chainBalances: () => server<ChainBalances>('GET', '/api/wallet/balances'),
  sendCrypto: (b: { network: string; asset: string; to: string; amount: string }, idempotencyKey: string = newIdempotencyKey()) =>
    server<CryptoSend>('POST', '/api/wallet/send', { ...b, idempotencyKey }),
  cryptoSendStatus: (id: string) => server<CryptoSend>('GET', '/api/wallet/send/' + encodeURIComponent(id)),

  /** Starts a Paystack checkout; the balance is credited only after Paystack confirms. */
  startDeposit: (amount: number) => server<{ reference: string; authorizationUrl: string }>('POST', '/api/payments/deposit', { amount }),
  depositStatus: (reference: string) =>
    server<{ reference: string; status: string; credited: boolean; amount: string }>('GET', '/api/payments/deposit/' + encodeURIComponent(reference)),
  banks: () => server<{ banks: { name: string; code: string }[] }>('GET', '/api/payments/banks'),
  resolveAccount: (accountNumber: string, bankCode: string) =>
    server<{ accountName: string; accountNumber: string }>('POST', '/api/payments/resolve', { accountNumber, bankCode }),
  withdrawToBank: (b: { source: 'balance' | 'earnings'; amount: number; accountNumber: string; bankCode: string }, idempotencyKey: string = newIdempotencyKey()) =>
    server<WithdrawalView>('POST', '/api/payments/withdraw', { ...b, idempotencyKey }),
  withdrawalStatus: (reference: string) => server<WithdrawalView>('GET', '/api/payments/withdraw/' + encodeURIComponent(reference)),

  /** Instant KAMKAM-to-KAMKAM Naira transfer (atomic, idempotent). */
  transfer: (b: { toUsername: string; amount: string; note?: string }, idempotencyKey: string = newIdempotencyKey()) =>
    rpc<{ reference: string; status: 'COMPLETED'; amount: string; to: string }>('transfer_ngn', { p_to_username: b.toUsername, p_amount: b.amount, p_note: b.note ?? null, p_idempotency_key: idempotencyKey }),
  /** Move creator earnings into the spendable balance (internal ledger move). */
  moveEarnings: (amount: string, idempotencyKey: string = newIdempotencyKey()) =>
    rpc<{ reference: string; status: 'COMPLETED'; amount: string }>('move_earnings_to_balance', { p_amount: amount, p_idempotency_key: idempotencyKey }),

  // ── Gifts & earnings (Naira only, paid from the verified balance) ──
  giftConfig: () => rpc<{ tiers: number[]; creatorShare: string; min: number; max: number }>('gift_config'),
  giftQuote: async (b: GiftBody) => ({ quote: await rpc<GiftQuote>('gift_quote', { p_params: b }) }),
  sendGift: async (b: GiftBody, idempotencyKey: string = newIdempotencyKey()) => {
    const r = await rpc<{ gift: { id: string; reference: string; amountNgn: string; payAsset: 'NGN'; payLabel: string; creatorAmountNgn: string; platformFeeNgn: string; recipient: string }; postId: string | null }>(
      'send_gift', { p_params: b, p_idempotency_key: idempotencyKey });
    const post = r.postId ? (await api.post(r.postId).catch(() => null))?.post ?? null : null;
    return { gift: r.gift, post };
  },
  gifts: (direction: 'sent' | 'received') => rpc<{ gifts: GiftRecord[] }>('gifts_list', { p_direction: direction }),
  earnings: async () => ({ earnings: await rpc<Earnings>('earnings_summary') }),

  // ── Live sessions (real rows + Supabase Realtime) ───────────────
  lives: () => rpc<LiveSession[]>('live_list'),
  live: (id: string) => rpc<LiveView>('live_view', { p_session: id }),
  startLive: (title: string) => rpc<LiveSession>('start_live', { p_title: title }),
  endLive: (id: string) => rpc<LiveSession>('end_live', { p_session: id }),
  liveHeartbeat: (id: string) => rpc<LiveView>('live_heartbeat', { p_session: id }),
  liveLeave: async (id: string) => { await rpc('live_leave', { p_session: id }); return { ok: true as const }; },
  liveChat: async (id: string, text: string) => {
    const body = text.trim();
    if (!body) throw new ApiError(400, 'Write a message first.', 'VALIDATION');
    if (body.length > 300) throw new ApiError(400, 'Messages can be up to 300 characters.', 'VALIDATION');
    await run(supabase().from('live_messages').insert({ session_id: id, user_id: await uid(), body }));
    return { ok: true as const };
  },
};

export type WithdrawalView = { reference: string; status: 'pending' | 'processing' | 'success' | 'failed' | 'reversed'; amount: string; fee: string; payout: string; failureReason: string | null };

/** Call a KAMKAM server route (Next.js) with the caller's Supabase access token. */
async function server<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false) {
    const { data } = await supabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ApiError(401, 'You need to log in to do that.', 'UNAUTHENTICATED');
    headers.authorization = 'Bearer ' + token;
  }
  let res: Response;
  try {
    const base = typeof window === 'undefined' ? (process.env.KAMKAM_APP_URL || 'http://localhost:3000') : '';
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Network unavailable. Check your connection and try again.', 'NETWORK');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: string } } | null)?.error;
    // Some routes return a body with details alongside a non-2xx status (e.g. provisioning failed).
    if (!err && json) throw Object.assign(new ApiError(res.status, (json as { lastError?: string }).lastError || 'Request failed.', 'ERROR'), { data: json });
    throw new ApiError(res.status, err?.message || 'Request failed.', err?.code);
  }
  return json as T;
}
