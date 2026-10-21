-- KAMKAM: all migrations in order, for pasting into Supabase → SQL Editor → Run.
-- Generated from supabase/migrations/. Run ONCE on a FRESH project. Do not run on a project that already has these tables
-- (use UPGRADE_20261018_REAL_FINANCE.sql for a project that already ran the 20261016* migrations).

-- ===== 20261016000100_core_schema.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 001 · Core social schema
-- Profiles, posts (+media, polls), comments, likes, reposts, bookmarks,
-- follows, stories, communities, conversations, messages, notifications.
-- RLS policies live in 20261016000500_rls.sql.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm with schema extensions;

-- ── Profiles (1:1 with auth.users) ─────────────────────────────────
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  username             text not null,
  display_name         text not null,
  bio                  text,
  avatar_path          text,
  cover_path           text,
  avatar_color         text not null default '#14975C',
  verified             boolean not null default false,
  location             text,
  website              text,
  settings             jsonb not null default '{}'::jsonb,
  wallet_security      jsonb not null default '{"biometric": true, "txConfirm": true, "pin": true}'::jsonb,
  post_count           integer not null default 0 check (post_count >= 0),
  follower_count       integer not null default 0 check (follower_count >= 0),
  following_count      integer not null default 0 check (following_count >= 0),
  gifts_received_count integer not null default 0 check (gifts_received_count >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(btrim(display_name)) between 1 and 50),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 280),
  constraint profiles_location_len check (location is null or char_length(location) <= 60),
  constraint profiles_website_len check (website is null or char_length(website) <= 100),
  -- Media must live in the owner's own storage folder
  constraint profiles_avatar_path check (avatar_path is null or avatar_path like 'avatars/' || id::text || '/%'),
  constraint profiles_cover_path check (cover_path is null or cover_path like 'avatars/' || id::text || '/%'),
  constraint profiles_settings_obj check (jsonb_typeof(settings) = 'object'),
  constraint profiles_wallet_security_obj check (jsonb_typeof(wallet_security) = 'object')
);
create unique index profiles_username_key on public.profiles (username);
create index profiles_display_name_trgm on public.profiles using gin (lower(display_name) extensions.gin_trgm_ops);
create index profiles_username_trgm on public.profiles using gin (username extensions.gin_trgm_ops);
create index profiles_follower_count_idx on public.profiles (follower_count desc);

-- ── Posts ───────────────────────────────────────────────────────────
create table public.posts (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text             text not null default '',
  -- Legacy/placeholder media hint (used when a post has no uploaded files)
  media_type       text check (media_type in ('IMAGE', 'VIDEO')),
  reply_policy     text not null default 'Everyone' check (reply_policy in ('Everyone', 'Followers', 'Mentioned')),
  has_poll         boolean not null default false,
  like_count       integer not null default 0 check (like_count >= 0),
  comment_count    integer not null default 0 check (comment_count >= 0),
  repost_count     integer not null default 0 check (repost_count >= 0),
  gift_count       integer not null default 0 check (gift_count >= 0),
  super_like_count integer not null default 0 check (super_like_count >= 0),
  earned_ngn       numeric(20, 2) not null default 0 check (earned_ngn >= 0),
  boosted_until    timestamptz,
  edited_at        timestamptz,
  created_at       timestamptz not null default now(),
  constraint posts_text_len check (char_length(text) <= 1000)
);
create index posts_created_idx on public.posts (created_at desc);
create index posts_author_created_idx on public.posts (author_id, created_at desc);
create index posts_text_trgm on public.posts using gin (text extensions.gin_trgm_ops);

create table public.post_media (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  path       text not null check (path like 'post-media/%'),
  kind       text not null check (kind in ('IMAGE', 'VIDEO')),
  position   smallint not null default 0 check (position between 0 and 3),
  created_at timestamptz not null default now(),
  unique (post_id, position)
);
create index post_media_post_idx on public.post_media (post_id);

-- Polls (rendered by the original kam-kam-ui post design)
create table public.poll_options (
  id       uuid primary key default gen_random_uuid(),
  post_id  uuid not null references public.posts (id) on delete cascade,
  position smallint not null check (position between 0 and 3),
  label    text not null check (char_length(btrim(label)) between 1 and 80),
  unique (post_id, position),
  unique (id, post_id)
);
create table public.poll_votes (
  post_id    uuid not null,
  option_id  uuid not null,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id),
  foreign key (option_id, post_id) references public.poll_options (id, post_id) on delete cascade
);
create index poll_votes_option_idx on public.poll_votes (option_id);

-- ── Comments / replies ─────────────────────────────────────────────
create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  author_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  parent_id  uuid references public.comments (id) on delete cascade,
  text       text not null check (char_length(btrim(text)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index comments_post_created_idx on public.comments (post_id, created_at);
create index comments_author_idx on public.comments (author_id, created_at desc);
create index comments_parent_idx on public.comments (parent_id);

-- ── Likes / reposts / bookmarks (one per user per post) ────────────
create table public.likes (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  super_like boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index likes_post_idx on public.likes (post_id);

create table public.reposts (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index reposts_post_idx on public.reposts (post_id);

create table public.bookmarks (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index bookmarks_user_created_idx on public.bookmarks (user_id, created_at desc);

-- ── Follows ────────────────────────────────────────────────────────
create table public.follows (
  follower_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_not_self check (follower_id <> following_id)
);
create index follows_following_idx on public.follows (following_id, created_at desc);

-- ── Stories (24h) ──────────────────────────────────────────────────
create table public.stories (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text       text check (text is null or char_length(text) <= 280),
  media_path text check (media_path is null or media_path like 'post-media/%'),
  media_kind text check (media_kind in ('IMAGE', 'VIDEO')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint stories_has_content check (coalesce(char_length(btrim(text)), 0) > 0 or media_path is not null),
  constraint stories_media_kind check ((media_path is null) = (media_kind is null))
);
create index stories_author_active_idx on public.stories (author_id, expires_at desc);

-- ── Communities ────────────────────────────────────────────────────
create table public.communities (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 3 and 40),
  description  text not null default '' check (char_length(description) <= 200),
  color        text not null default '#2F6F4E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  member_count integer not null default 0 check (member_count >= 0),
  created_at   timestamptz not null default now()
);
create unique index communities_name_key on public.communities (lower(name));

create table public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (community_id, user_id)
);
create index community_members_user_idx on public.community_members (user_id);

-- ── Direct messages ────────────────────────────────────────────────
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind            text not null default 'TEXT' check (kind in ('TEXT', 'IMAGE', 'AUDIO', 'GIFT')),
  body            text not null default '' check (char_length(body) <= 2000),
  attachment_path text check (attachment_path is null or attachment_path like 'message-attachments/%'),
  meta            jsonb,
  created_at      timestamptz not null default now(),
  constraint messages_content check (
    (kind = 'TEXT' and char_length(btrim(body)) > 0 and attachment_path is null) or
    (kind in ('IMAGE', 'AUDIO') and attachment_path is not null) or
    (kind = 'GIFT')
  )
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ── Notifications ──────────────────────────────────────────────────
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  actor_id     uuid references public.profiles (id) on delete set null,
  type         text not null check (type in ('FOLLOW', 'LIKE', 'COMMENT', 'REPOST', 'MESSAGE', 'GIFT_RECEIVED', 'WITHDRAWAL_COMPLETED', 'TRANSACTION_COMPLETED')),
  title        text not null,
  body         text not null default '',
  amount_label text,
  post_id      uuid references public.posts (id) on delete set null,
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id) where not read;

-- ===== 20261016000200_wallet_schema.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 002 · Wallet, gifts & ledger schema
--
-- IMPORTANT: KAMKAM's wallet runs in DEMO MODE. Balances are demo units,
-- rates are fixed, and no bank, card or blockchain is ever contacted.
-- Every ledger row is flagged simulated = true. Real-money mode is
-- intentionally not implemented (see app_config.wallet_mode).
-- ════════════════════════════════════════════════════════════════════

-- ── Configuration (read-only to clients) ───────────────────────────
create table public.app_config (
  key   text primary key,
  value jsonb not null
);

insert into public.app_config (key, value) values
  ('wallet_mode', '"demo"'),                       -- only 'demo' is supported
  ('creator_share', '0.8'),                        -- 80% creator / 20% KAMKAM
  ('gift_min_ngn', '50'),
  ('gift_max_ngn', '1000000'),
  ('gift_tiers_ngn', '[200, 500, 2000, 3000]'),
  ('starter_ngn', '50000'),
  ('starter_crypto', '{"USDT": "100", "BNB": "0.25", "ETH": "0.05", "SOL": "3"}'),
  ('fees', '{"buy_pct": "0.015", "sell_pct": "0.01", "swap_pct": "0.005", "bank_withdraw_ngn": "50", "min_ngn": "100", "max_tx_ngn": "50000000"}'),
  ('demo_deposit_daily_cap_ngn', '1000000'),
  ('settlement', '{"processing_after_s": 4, "complete_after_s": 6}');

-- ── Assets, networks, demo rates ───────────────────────────────────
create table public.assets (
  symbol     text primary key check (symbol ~ '^[A-Z]{2,6}$'),
  name       text not null,
  precision  smallint not null check (precision between 0 and 18),
  display_dp smallint not null,
  is_crypto  boolean not null,
  rate_ngn   numeric(30, 8) not null check (rate_ngn > 0),   -- DEMO rate (NGN per unit)
  color      text not null,
  sort       smallint not null default 0
);
insert into public.assets (symbol, name, precision, display_dp, is_crypto, rate_ngn, color, sort) values
  ('NGN',  'Nigerian Naira', 2, 2, false, 1,       '#14975C', 0),
  ('USDT', 'Tether USD',     6, 2, true,  1600,    '#1F6E7A', 1),
  ('BNB',  'BNB',            8, 4, true,  980000,  '#C98A12', 2),
  ('ETH',  'Ethereum',       8, 5, true,  6200000, '#5B6BD6', 3),
  ('SOL',  'Solana',         8, 3, true,  240000,  '#3E9E7A', 4);

create table public.networks (
  name    text primary key,
  family  text not null check (family in ('evm', 'solana', 'tron')),
  fee_ngn numeric(20, 2) not null check (fee_ngn >= 0),            -- simulated flat fee
  color   text not null,
  sort    smallint not null default 0
);
insert into public.networks (name, family, fee_ngn, color, sort) values
  ('Ethereum',  'evm',    1800, '#5B6BD6', 0),
  ('BNB Chain', 'evm',    90,   '#C98A12', 1),
  ('Polygon',   'evm',    30,   '#7B4DD6', 2),
  ('Arbitrum',  'evm',    120,  '#2F7FB8', 3),
  ('Base',      'evm',    60,   '#2F5BD6', 4),
  ('Solana',    'solana', 15,   '#3E9E7A', 5),
  ('TRON',      'tron',   1700, '#B0553C', 6);

create table public.asset_networks (
  asset      text not null references public.assets (symbol),
  network    text not null references public.networks (name),
  is_default boolean not null default false,
  primary key (asset, network)
);
insert into public.asset_networks (asset, network, is_default) values
  ('USDT', 'Ethereum', false), ('USDT', 'BNB Chain', true), ('USDT', 'Polygon', false), ('USDT', 'Arbitrum', false),
  ('USDT', 'Base', false), ('USDT', 'Solana', false), ('USDT', 'TRON', false),
  ('BNB', 'BNB Chain', true),
  ('ETH', 'Ethereum', true), ('ETH', 'Arbitrum', false), ('ETH', 'Base', false),
  ('SOL', 'Solana', true);

-- ── Wallets & balances ─────────────────────────────────────────────
create table public.wallets (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  crypto_activated   boolean not null default false,
  earnings_available numeric(20, 2) not null default 0 check (earnings_available >= 0),
  demo_addresses     jsonb not null default '{}'::jsonb,   -- demo addresses, NOT derived from keys
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.wallet_assets (
  user_id    uuid not null references public.wallets (user_id) on delete cascade,
  symbol     text not null references public.assets (symbol),
  balance    numeric(38, 18) not null default 0 check (balance >= 0),   -- can never go negative
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- Append-only ledger. Only status / completion fields may change after insert.
create table public.wallet_transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  type              text not null check (type in ('DEPOSIT', 'WITHDRAWAL', 'GIFT_SENT', 'GIFT_RECEIVED', 'BUY', 'SELL', 'SWAP', 'TRANSFER')),
  direction         text not null check (direction in ('IN', 'OUT')),
  asset             text not null references public.assets (symbol),
  amount            numeric(38, 18) not null check (amount > 0),
  value_ngn         numeric(20, 2) not null default 0 check (value_ngn >= 0),
  fee               numeric(38, 18) not null default 0 check (fee >= 0),
  fee_asset         text references public.assets (symbol),
  status            text not null default 'COMPLETED' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reference         text not null,
  network           text,
  counterparty      text,
  description       text not null,
  simulated         boolean not null default true check (simulated),   -- demo mode only
  auto_settle       boolean not null default false,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  completed_at      timestamptz
);
create index wallet_tx_user_created_idx on public.wallet_transactions (user_id, created_at desc);
create index wallet_tx_reference_idx on public.wallet_transactions (reference);
create index wallet_tx_settle_idx on public.wallet_transactions (status, status_changed_at) where auto_settle and status in ('PENDING', 'PROCESSING');

-- ── Gifts, creator earnings, platform fees ─────────────────────────
create table public.gifts (
  id                 uuid primary key default gen_random_uuid(),
  sender_id          uuid not null references public.profiles (id) on delete cascade,
  recipient_id       uuid not null references public.profiles (id) on delete cascade,
  post_id            uuid references public.posts (id) on delete set null,
  amount_ngn         numeric(20, 2) not null check (amount_ngn > 0),
  pay_asset          text not null references public.assets (symbol),
  pay_amount         numeric(38, 18) not null check (pay_amount > 0),
  rate_ngn           numeric(30, 8) not null check (rate_ngn > 0),
  creator_amount_ngn numeric(20, 2) not null check (creator_amount_ngn >= 0),
  platform_fee_ngn   numeric(20, 2) not null check (platform_fee_ngn >= 0),
  network            text,
  reference          text not null unique,
  idempotency_key    uuid not null,
  created_at         timestamptz not null default now(),
  constraint gifts_split_exact check (creator_amount_ngn + platform_fee_ngn = amount_ngn),
  constraint gifts_not_self check (sender_id <> recipient_id),
  unique (sender_id, idempotency_key)
);
create index gifts_recipient_created_idx on public.gifts (recipient_id, created_at desc);
create index gifts_sender_created_idx on public.gifts (sender_id, created_at desc);
create index gifts_post_idx on public.gifts (post_id);

create table public.creator_earnings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  gift_id      uuid not null unique references public.gifts (id) on delete cascade,
  amount_ngn   numeric(20, 2) not null check (amount_ngn >= 0),
  source_asset text not null references public.assets (symbol),
  created_at   timestamptz not null default now()
);
create index creator_earnings_user_created_idx on public.creator_earnings (user_id, created_at desc);

-- KAMKAM's revenue. Never readable or writable by clients.
create table public.platform_fees (
  id         uuid primary key default gen_random_uuid(),
  source     text not null check (source in ('GIFT', 'BUY', 'SELL', 'SWAP', 'WITHDRAWAL')),
  amount_ngn numeric(20, 2) not null check (amount_ngn >= 0),
  reference  text not null,
  gift_id    uuid unique references public.gifts (id) on delete set null,
  created_at timestamptz not null default now()
);
create index platform_fees_source_created_idx on public.platform_fees (source, created_at);

-- ── Operation records ──────────────────────────────────────────────
create table public.withdrawals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  source         text not null check (source in ('EARNINGS', 'WALLET')),
  method         text not null check (method in ('KAMKAM_WALLET', 'EXTERNAL_WALLET', 'BANK')),
  asset          text not null references public.assets (symbol),
  amount         numeric(38, 18) not null check (amount > 0),
  value_ngn      numeric(20, 2) not null,
  fee            numeric(38, 18) not null default 0,
  network        text,
  address        text,
  bank_name      text,
  account_number text check (account_number is null or account_number ~ '^\d{10}$'),
  account_name   text,
  status         text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reference      text not null unique,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index withdrawals_user_created_idx on public.withdrawals (user_id, created_at desc);

create table public.deposits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  asset      text not null references public.assets (symbol),
  amount     numeric(38, 18) not null check (amount > 0),
  method     text not null,
  status     text not null default 'COMPLETED',
  reference  text not null unique,
  created_at timestamptz not null default now()
);
create index deposits_user_created_idx on public.deposits (user_id, created_at desc);

create table public.swaps (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  from_asset   text not null references public.assets (symbol),
  to_asset     text not null references public.assets (symbol),
  from_amount  numeric(38, 18) not null check (from_amount > 0),
  to_amount    numeric(38, 18) not null check (to_amount > 0),
  rate         numeric(38, 18) not null,
  network_fee  numeric(38, 18) not null,
  platform_fee numeric(38, 18) not null,
  network      text,
  status       text not null default 'COMPLETED',
  reference    text not null unique,
  created_at   timestamptz not null default now()
);
create index swaps_user_created_idx on public.swaps (user_id, created_at desc);

create table public.buy_transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  asset          text not null references public.assets (symbol),
  amount         numeric(38, 18) not null check (amount > 0),
  pay_asset      text not null references public.assets (symbol),
  pay_amount     numeric(38, 18) not null check (pay_amount > 0),
  rate           numeric(38, 18) not null,
  fee            numeric(38, 18) not null,
  payment_method text not null,
  status         text not null default 'COMPLETED',
  reference      text not null unique,
  created_at     timestamptz not null default now()
);
create index buys_user_created_idx on public.buy_transactions (user_id, created_at desc);

create table public.sell_transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  asset          text not null references public.assets (symbol),
  amount         numeric(38, 18) not null check (amount > 0),
  receive_method text not null check (receive_method in ('NAIRA_BALANCE', 'BANK', 'WALLET_ASSET')),
  receive_asset  text not null references public.assets (symbol),
  receive_amount numeric(38, 18) not null check (receive_amount > 0),
  rate           numeric(38, 18) not null,
  fee            numeric(38, 18) not null,
  bank_name      text,
  account_number text,
  account_name   text,
  status         text not null default 'COMPLETED' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reference      text not null unique,
  created_at     timestamptz not null default now()
);
create index sells_user_created_idx on public.sell_transactions (user_id, created_at desc);

-- Duplicate-submission protection for every money-moving RPC
create table public.idempotency_keys (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  key        uuid not null,
  action     text not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ===== 20261016000300_social_functions.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 003 · Social functions & triggers
--  • Read RPCs return camelCase JSON matching frontend/types/index.ts
--  • Read RPCs are SECURITY INVOKER  → Row Level Security still applies
--  • Triggers that write on behalf of the system (counters, notifications)
--    are SECURITY DEFINER with a fixed search_path
-- ════════════════════════════════════════════════════════════════════

-- ── Small helpers ──────────────────────────────────────────────────
create or replace function public.raise_app_error(p_code text, p_message text)
returns void language plpgsql as $$
begin
  raise exception using message = p_message, errcode = 'P0001', hint = p_code;
end $$;

create or replace function public.author_json(p public.profiles)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'displayName', p.display_name,
    'avatar', p.avatar_path, 'avatarColor', p.avatar_color, 'verified', p.verified,
    'followers', p.follower_count)
$$;

create or replace function public.excerpt(p_text text, p_len int default 70)
returns text language sql immutable as $$
  select case when char_length(p_text) > p_len then left(p_text, p_len) || '…' else p_text end
$$;

-- Notifications are only ever created by trusted code (never by clients).
create or replace function public._notify(p_user uuid, p_actor uuid, p_type text, p_title text, p_body text,
                                          p_amount text default null, p_post uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or (p_actor is not null and p_actor = p_user) then return; end if;
  insert into notifications (user_id, actor_id, type, title, body, amount_label, post_id)
  values (p_user, p_actor, p_type, p_title, coalesce(p_body, ''), p_amount, p_post);
end $$;

-- Poll results are aggregated by a definer function so individual votes stay private.
create or replace function public.poll_json(p_post uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with opts as (
    select o.id, o.label, o.position, (select count(*) from poll_votes v where v.option_id = o.id) as votes
    from poll_options o where o.post_id = p_post
  )
  select jsonb_build_object(
    'options', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'votes', votes) order by position) from opts), '[]'::jsonb),
    'total', coalesce((select sum(votes) from opts), 0),
    'myVote', (select v.option_id from poll_votes v where v.post_id = p_post and v.user_id = auth.uid()))
$$;

create or replace function public.post_json(p public.posts)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p.id,
    'text', p.text,
    'mediaUrls', coalesce((select jsonb_agg(m.path order by m.position) from post_media m where m.post_id = p.id), '[]'::jsonb),
    'mediaType', coalesce((select m.kind from post_media m where m.post_id = p.id order by m.position limit 1), p.media_type),
    'replyPolicy', p.reply_policy,
    'createdAt', p.created_at,
    'editedAt', p.edited_at,
    'author', (select author_json(a) from profiles a where a.id = p.author_id),
    'likeCount', p.like_count,
    'commentCount', p.comment_count,
    'repostCount', p.repost_count,
    'giftCount', p.gift_count,
    'superLikeCount', p.super_like_count,
    'earnedNgn', p.earned_ngn::text,
    'boosted', coalesce(p.boosted_until > now(), false),
    'liked', exists (select 1 from likes l where l.post_id = p.id and l.user_id = auth.uid()),
    'superLiked', exists (select 1 from likes l where l.post_id = p.id and l.user_id = auth.uid() and l.super_like),
    'reposted', exists (select 1 from reposts r where r.post_id = p.id and r.user_id = auth.uid()),
    'bookmarked', exists (select 1 from bookmarks b where b.post_id = p.id and b.user_id = auth.uid()),
    'gifted', exists (select 1 from gifts g where g.post_id = p.id and g.sender_id = auth.uid()),
    'isMine', p.author_id = auth.uid(),
    'poll', case when p.has_poll then poll_json(p.id) else null end)
$$;

-- ── Username availability (used before sign-up) ────────────────────
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public as $$
  select lower(p_username) ~ '^[a-z0-9_]{3,20}$'
     and not exists (select 1 from profiles where username = lower(p_username))
$$;

-- ── Feed & posts ───────────────────────────────────────────────────
create or replace function public.feed(p_tab text default 'foryou', p_offset int default 0, p_limit int default 20)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  lim int := least(greatest(coalesce(p_limit, 20), 1), 50);
  off int := greatest(coalesce(p_offset, 0), 0);
  res jsonb; n int;
begin
  if auth.uid() is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  if p_tab = 'following' then
    select coalesce(jsonb_agg(post_json(x.p) order by x.rn), '[]'::jsonb), count(*) into res, n from (
      select p, row_number() over (order by p.created_at desc) rn from posts p
      where p.author_id = auth.uid() or p.author_id in (select following_id from follows where follower_id = auth.uid())
      order by p.created_at desc offset off limit lim) x;
  elsif p_tab = 'trending' then
    select coalesce(jsonb_agg(post_json(x.p) order by x.rn), '[]'::jsonb), count(*) into res, n from (
      select p, row_number() over (order by (p.gift_count * 6 + p.like_count + p.repost_count * 2 + p.comment_count * 2) desc, p.created_at desc) rn
      from posts p where p.created_at > now() - interval '14 days'
      order by (p.gift_count * 6 + p.like_count + p.repost_count * 2 + p.comment_count * 2) desc, p.created_at desc offset off limit lim) x;
  else
    -- For You: recency, plus an active gift boost (+6h) and engagement
    select coalesce(jsonb_agg(post_json(x.p) order by x.rn), '[]'::jsonb), count(*) into res, n from (
      select p, row_number() over (order by s.score desc) rn from posts p
      cross join lateral (select extract(epoch from p.created_at)
        + case when p.boosted_until > now() then 21600 else 0 end
        + least(p.gift_count, 30) * 900 + least(p.like_count, 500) * 20 as score) s
      order by s.score desc offset off limit lim) x;
  end if;
  return jsonb_build_object('posts', res, 'nextOffset', case when n = lim then off + lim else null end);
end $$;

create or replace function public.post_detail(p_id uuid)
returns jsonb language plpgsql stable set search_path = public as $$
declare r jsonb;
begin
  select post_json(p) into r from posts p where p.id = p_id;
  if r is null then perform raise_app_error('POST_NOT_FOUND', 'Post not found.'); end if;
  return r;
end $$;

create or replace function public.user_posts(p_user uuid, p_tab text default 'posts')
returns jsonb language plpgsql stable set search_path = public as $$
begin
  if p_tab = 'replies' then
    return jsonb_build_object('replies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'text', c.text, 'createdAt', c.created_at,
        'author', (select author_json(a) from profiles a where a.id = c.author_id),
        'post', jsonb_build_object('id', p.id, 'text', p.text, 'username', pa.username)) order by c.created_at desc)
      from (select * from comments where author_id = p_user order by created_at desc limit 50) c
      join posts p on p.id = c.post_id join profiles pa on pa.id = p.author_id), '[]'::jsonb));
  end if;
  return jsonb_build_object('posts', coalesce((
    select jsonb_agg(post_json(x.p) order by x.created_at desc) from (
      select p, p.created_at from posts p
      where p.author_id = p_user
        and (p_tab <> 'media' or p.media_type is not null or exists (select 1 from post_media m where m.post_id = p.id))
      order by p.created_at desc limit 50) x), '[]'::jsonb));
end $$;

create or replace function public.comments_list(p_post uuid)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'text', c.text, 'createdAt', c.created_at, 'parentId', c.parent_id,
    'author', author_json(a)) order by c.created_at), '[]'::jsonb)
  from (select * from comments where post_id = p_post order by created_at limit 500) c
  join profiles a on a.id = c.author_id
$$;

-- Creates a post with media and an optional poll in one transaction (RLS applies).
create or replace function public.create_post(p_text text, p_media jsonb default '[]'::jsonb,
                                              p_reply_policy text default 'Everyone', p_poll jsonb default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_post posts; v_item jsonb; i int := 0; v_opts int;
begin
  if auth.uid() is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  p_text := btrim(coalesce(p_text, ''));
  if p_text = '' and jsonb_array_length(coalesce(p_media, '[]')) = 0 then
    perform raise_app_error('EMPTY_POST', 'Write something or attach media.');
  end if;
  if jsonb_array_length(coalesce(p_media, '[]')) > 4 then perform raise_app_error('TOO_MANY_MEDIA', 'A post can have up to 4 images or 1 video.'); end if;
  if p_poll is not null then
    v_opts := jsonb_array_length(p_poll);
    if v_opts < 2 or v_opts > 4 then perform raise_app_error('INVALID_POLL', 'A poll needs 2 to 4 options.'); end if;
  end if;

  insert into posts (author_id, text, reply_policy, has_poll)
  values (auth.uid(), p_text, coalesce(p_reply_policy, 'Everyone'), p_poll is not null)
  returning * into v_post;

  for v_item in select * from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    insert into post_media (post_id, path, kind, position) values (v_post.id, v_item->>'path', v_item->>'kind', i);
    i := i + 1;
  end loop;

  if p_poll is not null then
    i := 0;
    for v_item in select * from jsonb_array_elements(p_poll) loop
      insert into poll_options (post_id, position, label) values (v_post.id, i, btrim(v_item #>> '{}'));
      i := i + 1;
    end loop;
  end if;
  return post_json(v_post);
end $$;

create or replace function public.post_counts(p_id uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('likeCount', like_count, 'repostCount', repost_count, 'commentCount', comment_count,
                            'giftCount', gift_count, 'superLikeCount', super_like_count)
  from posts where id = p_id
$$;

-- ── Profiles, follows, discovery ───────────────────────────────────
create or replace function public.profile_view(p_key text)
returns jsonb language plpgsql stable set search_path = public as $$
declare pr profiles; me uuid := auth.uid();
begin
  select * into pr from profiles
  where username = lower(ltrim(p_key, '@')) or (p_key ~* '^[0-9a-f-]{36}$' and id = p_key::uuid) limit 1;
  if pr.id is null then perform raise_app_error('USER_NOT_FOUND', 'User not found.'); end if;
  return author_json(pr) || jsonb_build_object(
    'bio', pr.bio, 'createdAt', pr.created_at, 'location', pr.location, 'website', pr.website, 'coverImage', pr.cover_path,
    'stats', jsonb_build_object('posts', pr.post_count, 'followers', pr.follower_count, 'following', pr.following_count, 'giftsReceived', pr.gifts_received_count),
    'isFollowing', exists (select 1 from follows where follower_id = me and following_id = pr.id),
    'followsYou', exists (select 1 from follows where follower_id = pr.id and following_id = me),
    'isMe', pr.id = me);
end $$;

create or replace function public.follow_list(p_user uuid, p_kind text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(author_json(pr) || jsonb_build_object(
      'isFollowing', exists (select 1 from follows x where x.follower_id = auth.uid() and x.following_id = pr.id),
      'isMe', pr.id = auth.uid()) order by f.created_at desc), '[]'::jsonb)
  from (select * from follows
        where (p_kind = 'followers' and following_id = p_user) or (p_kind = 'following' and follower_id = p_user)
        order by created_at desc limit 200) f
  join profiles pr on pr.id = case when p_kind = 'followers' then f.follower_id else f.following_id end
$$;

create or replace function public.suggested_users(p_limit int default 4)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(author_json(pr) || jsonb_build_object('isFollowing', false) order by pr.follower_count desc, pr.created_at desc), '[]'::jsonb)
  from (select * from profiles p
        where p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000')
          and not exists (select 1 from follows f where f.follower_id = auth.uid() and f.following_id = p.id)
        order by p.follower_count desc, p.created_at desc
        limit least(greatest(p_limit, 1), 20)) pr
$$;

create or replace function public.search(p_q text)
returns jsonb language plpgsql stable set search_path = public as $$
declare q text := btrim(left(coalesce(p_q, ''), 80)); term text; pat text;
begin
  if q = '' then return jsonb_build_object('q', q, 'users', '[]'::jsonb, 'posts', '[]'::jsonb); end if;
  term := ltrim(q, '@');
  pat := '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'q', q,
    'users', coalesce((select jsonb_agg(author_json(pr) || jsonb_build_object(
        'isFollowing', exists (select 1 from follows f where f.follower_id = auth.uid() and f.following_id = pr.id),
        'isMe', pr.id = auth.uid()) order by pr.follower_count desc)
      from (select * from profiles where username ilike pat or display_name ilike pat order by follower_count desc limit 10) pr), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(post_json(x.p) order by x.created_at desc)
      from (select p, p.created_at from posts p
            where p.text ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
            order by p.created_at desc limit 30) x), '[]'::jsonb));
end $$;

create or replace function public.trending(p_limit int default 5)
returns jsonb language sql stable set search_path = public as $$
  with recent as (select id, text, created_at from posts where created_at > now() - interval '14 days' order by created_at desc limit 2000),
  tags as (
    select distinct on (r.id, lower(m[1])) lower(m[1]) as key, m[1] as tag, r.created_at
    from recent r cross join lateral regexp_matches(r.text, '(#[[:alnum:]_]{2,40})', 'g') m
  ),
  agg as (
    select key, min(tag) as tag, count(*) as total, count(*) filter (where created_at > now() - interval '24 hours') as today
    from tags group by key order by count(*) desc, key limit least(greatest(p_limit, 1), 20)
  )
  select jsonb_build_object(
    'topics', coalesce((select jsonb_agg(jsonb_build_object('tag', tag, 'count', total,
                 'rise', '+' || round(today::numeric * 100 / total) || '%') order by total desc, key) from agg), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(post_json(x.p) order by x.score desc) from (
        select p, (p.gift_count * 6 + p.like_count + p.repost_count * 2 + p.comment_count * 2) as score
        from posts p where p.created_at > now() - interval '14 days'
        order by score desc, p.created_at desc limit 6) x), '[]'::jsonb))
$$;

create or replace function public.bookmarks_list()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('posts', coalesce(jsonb_agg(post_json(p) order by b.created_at desc), '[]'::jsonb))
  from (select * from bookmarks where user_id = auth.uid() order by created_at desc limit 100) b
  join posts p on p.id = b.post_id
$$;

-- Public supporter wall. Amounts are shown only to the profile owner;
-- the owner can hide the wall with settings.tips = false.
create or replace function public.gift_wall(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare owner boolean := auth.uid() = p_user; visible boolean;
begin
  if auth.uid() is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  select coalesce((settings->>'tips')::boolean, true) into visible from profiles where id = p_user;
  if not owner and not coalesce(visible, true) then return jsonb_build_object('gifts', '[]'::jsonb, 'hidden', true); end if;
  return jsonb_build_object('hidden', false, 'gifts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'createdAt', g.created_at,
      'sender', (select author_json(s) from profiles s where s.id = g.sender_id),
      'tier', case when owner then '₦' || to_char(g.amount_ngn, 'FM999,999,999,990') else 'Gift' end,
      'note', case when p.id is null then 'Profile gift' else 'on "' || excerpt(p.text, 32) || '"' end) order by g.created_at desc)
    from (select * from gifts where recipient_id = p_user order by created_at desc limit 30) g
    left join posts p on p.id = g.post_id), '[]'::jsonb));
end $$;

-- ── Stories ────────────────────────────────────────────────────────
create or replace function public.stories_feed()
returns jsonb language sql stable set search_path = public as $$
  with authors as (
    select s.author_id, max(s.created_at) as latest
    from stories s
    where s.expires_at > now()
      and (s.author_id = auth.uid() or s.author_id in (select following_id from follows where follower_id = auth.uid()))
    group by s.author_id
  )
  select coalesce(jsonb_agg(author_json(pr) || jsonb_build_object(
      'isMe', pr.id = auth.uid(),
      'stories', (select jsonb_agg(jsonb_build_object('id', s.id, 'text', s.text, 'mediaPath', s.media_path,
                    'mediaKind', s.media_kind, 'createdAt', s.created_at) order by s.created_at)
                  from stories s where s.author_id = pr.id and s.expires_at > now()))
    order by (pr.id = auth.uid()) desc, a.latest desc), '[]'::jsonb)
  from authors a join profiles pr on pr.id = a.author_id
$$;

-- ── Communities ────────────────────────────────────────────────────
create or replace function public.communities_list()
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'description', c.description, 'color', c.color, 'members', c.member_count,
      'joined', exists (select 1 from community_members m where m.community_id = c.id and m.user_id = auth.uid()),
      'isOwner', c.created_by = auth.uid()) order by c.member_count desc, c.created_at), '[]'::jsonb)
  from communities c
$$;

-- ── Notifications & "me" ───────────────────────────────────────────
create or replace function public.notifications_list(p_filter text default 'all')
returns jsonb language plpgsql stable set search_path = public as $$
declare f text := lower(coalesce(p_filter, 'all')); uname text;
begin
  select username into uname from profiles where id = auth.uid();
  return jsonb_build_object(
    'unread', (select count(*) from notifications where user_id = auth.uid() and not read),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'type', n.type, 'title', n.title, 'body', n.body, 'amountLabel', n.amount_label,
        'postId', n.post_id, 'read', n.read, 'createdAt', n.created_at,
        'actor', (select author_json(a) from profiles a where a.id = n.actor_id)) order by n.created_at desc)
      from (select * from notifications n
            where n.user_id = auth.uid()
              and case f
                when 'gifts' then n.type = 'GIFT_RECEIVED'
                when 'likes' then n.type in ('LIKE', 'REPOST')
                when 'comments' then n.type = 'COMMENT'
                when 'followers' then n.type = 'FOLLOW'
                when 'messages' then n.type = 'MESSAGE'
                when 'wallet' then n.type in ('WITHDRAWAL_COMPLETED', 'TRANSACTION_COMPLETED')
                when 'mentions' then n.type = 'COMMENT' and n.body ilike '%@' || uname || '%'
                else true end
            order by n.created_at desc limit 100) n), '[]'::jsonb));
end $$;

create or replace function public.unread_message_count()
returns integer language sql stable set search_path = public as $$
  select count(*)::int from conversation_members cm
  join messages m on m.conversation_id = cm.conversation_id and m.sender_id <> cm.user_id and m.created_at > cm.last_read_at
  where cm.user_id = auth.uid()
$$;

create or replace function public.me()
returns jsonb language plpgsql stable set search_path = public as $$
declare pr profiles;
begin
  select * into pr from profiles where id = auth.uid();
  if pr.id is null then perform raise_app_error('UNAUTHENTICATED', 'Your session has expired. Please log in again.'); end if;
  return author_json(pr) || jsonb_build_object(
    'email', auth.jwt() ->> 'email',
    'bio', pr.bio, 'createdAt', pr.created_at, 'location', pr.location, 'website', pr.website,
    'coverImage', pr.cover_path, 'settings', pr.settings, 'walletSecurity', pr.wallet_security,
    'followers', pr.follower_count, 'following', pr.following_count, 'posts', pr.post_count,
    'walletActivated', coalesce((select crypto_activated from wallets where user_id = pr.id), false),
    'unreadNotifications', (select count(*) from notifications where user_id = pr.id and not read),
    'unreadMessages', unread_message_count());
end $$;

-- ── Messaging ──────────────────────────────────────────────────────
create or replace function public.is_conversation_member(p_conversation uuid, p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversation_members where conversation_id = p_conversation and user_id = p_user)
$$;

-- Find-or-create a 1:1 conversation. Definer so the caller can add exactly
-- one other member — clients cannot insert membership rows themselves.
create or replace function public.start_conversation(p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); conv uuid;
begin
  if me is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  if p_user = me then perform raise_app_error('INVALID_RECIPIENT', 'You cannot message yourself.'); end if;
  if not exists (select 1 from profiles where id = p_user) then perform raise_app_error('USER_NOT_FOUND', 'User not found.'); end if;
  select a.conversation_id into conv
  from conversation_members a join conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = me and b.user_id = p_user
    and (select count(*) from conversation_members c where c.conversation_id = a.conversation_id) = 2
  limit 1;
  if conv is null then
    insert into conversations default values returning id into conv;
    insert into conversation_members (conversation_id, user_id) values (conv, me), (conv, p_user);
  end if;
  return conv;
end $$;

create or replace function public.conversations_list()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('conversations', coalesce(jsonb_agg(row_to_json order by last_message_at desc), '[]'::jsonb))
  from (
    select c.last_message_at, jsonb_build_object(
      'id', c.id,
      'user', (select author_json(p) from conversation_members o join profiles p on p.id = o.user_id
               where o.conversation_id = c.id and o.user_id <> auth.uid() limit 1),
      'unread', (select count(*) from messages m where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.created_at > me.last_read_at),
      'updatedAt', c.last_message_at,
      'lastMessage', (select jsonb_build_object('text', case when m.kind = 'IMAGE' then '📷 Photo' when m.kind = 'AUDIO' then '🎤 Voice note' else m.body end,
                                                 'kind', m.kind, 'createdAt', m.created_at, 'mine', m.sender_id = auth.uid())
                      from messages m where m.conversation_id = c.id order by m.created_at desc limit 1)) as row_to_json
    from conversation_members me join conversations c on c.id = me.conversation_id
    where me.user_id = auth.uid()
    order by c.last_message_at desc limit 50) t
$$;

create or replace function public.conversation_view(p_conversation uuid)
returns jsonb language plpgsql stable set search_path = public as $$
declare other_read timestamptz; other profiles;
begin
  if not is_conversation_member(p_conversation) then
    perform raise_app_error('FORBIDDEN', 'You are not part of this conversation.');
  end if;
  select p.* into other from conversation_members o join profiles p on p.id = o.user_id
  where o.conversation_id = p_conversation and o.user_id <> auth.uid() limit 1;
  select o.last_read_at into other_read from conversation_members o
  where o.conversation_id = p_conversation and o.user_id <> auth.uid() limit 1;
  return jsonb_build_object(
    'id', p_conversation,
    'user', case when other.id is null then null else author_json(other) end,
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'text', m.body, 'kind', m.kind, 'meta', m.meta, 'attachment', m.attachment_path,
        'createdAt', m.created_at, 'mine', m.sender_id = auth.uid(),
        'read', m.sender_id = auth.uid() and other_read is not null and other_read >= m.created_at) order by m.created_at)
      from (select * from messages where conversation_id = p_conversation order by created_at desc limit 300) m), '[]'::jsonb));
end $$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void language sql set search_path = public as $$
  update conversation_members set last_read_at = now()
  where conversation_id = p_conversation and user_id = auth.uid()
$$;

-- ════════════════════════════ TRIGGERS ═════════════════════════════

create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.tg_touch_updated_at();
create trigger wallets_touch before update on public.wallets for each row execute function public.tg_touch_updated_at();

-- Post edits: stamp edited_at when the text changes
create or replace function public.tg_posts_edit()
returns trigger language plpgsql as $$
begin
  if new.text is distinct from old.text then new.edited_at := now(); end if;
  return new;
end $$;
create trigger posts_edit before update on public.posts for each row execute function public.tg_posts_edit();

-- Simple per-user write rate limits (anti-spam). Skipped for trusted contexts.
create or replace function public.tg_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int; lim int := tg_argv[1]::int; win interval := tg_argv[2]::interval; col text := tg_argv[0];
begin
  if uid is null then return new; end if;
  execute format('select count(*) from %I.%I where %I = $1 and created_at > now() - $2', tg_table_schema, tg_table_name, col)
    into n using uid, win;
  if n >= lim then perform raise_app_error('RATE_LIMITED', 'You are doing that too often. Please wait a moment.'); end if;
  return new;
end $$;
create trigger posts_rate before insert on public.posts for each row execute function public.tg_rate_limit('author_id', '30', '1 hour');
create trigger comments_rate before insert on public.comments for each row execute function public.tg_rate_limit('author_id', '60', '10 minutes');
create trigger messages_rate before insert on public.messages for each row execute function public.tg_rate_limit('sender_id', '60', '1 minute');
create trigger stories_rate before insert on public.stories for each row execute function public.tg_rate_limit('author_id', '20', '1 hour');
create trigger follows_rate before insert on public.follows for each row execute function public.tg_rate_limit('follower_id', '100', '1 hour');

-- Profile post counter
create or replace function public.tg_posts_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update profiles set post_count = post_count + 1 where id = new.author_id;
  else update profiles set post_count = greatest(post_count - 1, 0) where id = old.author_id; end if;
  return null;
end $$;
create trigger posts_count after insert or delete on public.posts for each row execute function public.tg_posts_count();

-- Media limit
create or replace function public.tg_post_media_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from post_media where post_id = new.post_id) >= 4 then
    perform raise_app_error('TOO_MANY_MEDIA', 'A post can have up to 4 media files.');
  end if;
  if new.kind = 'VIDEO' and exists (select 1 from post_media where post_id = new.post_id) then
    perform raise_app_error('TOO_MANY_MEDIA', 'A post can have up to 4 images or 1 video.');
  end if;
  return new;
end $$;
create trigger post_media_limit before insert on public.post_media for each row execute function public.tg_post_media_limit();

-- Likes → counters + notification (gift super-likes notify via the gift itself)
create or replace function public.tg_likes()
returns trigger language plpgsql security definer set search_path = public as $$
declare p posts; actor text;
begin
  if tg_op = 'INSERT' then
    update posts set like_count = like_count + 1, super_like_count = super_like_count + (case when new.super_like then 1 else 0 end)
    where id = new.post_id returning * into p;
    if not new.super_like then
      select display_name into actor from profiles where id = new.user_id;
      perform _notify(p.author_id, new.user_id, 'LIKE', actor || ' liked your post', '"' || excerpt(p.text) || '"', null, p.id);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.super_like and not old.super_like then update posts set super_like_count = super_like_count + 1 where id = new.post_id; end if;
  else
    update posts set like_count = greatest(like_count - 1, 0),
                     super_like_count = greatest(super_like_count - (case when old.super_like then 1 else 0 end), 0)
    where id = old.post_id;
  end if;
  return null;
end $$;
create trigger likes_after after insert or update or delete on public.likes for each row execute function public.tg_likes();

create or replace function public.tg_reposts()
returns trigger language plpgsql security definer set search_path = public as $$
declare p posts; actor text;
begin
  if tg_op = 'INSERT' then
    update posts set repost_count = repost_count + 1 where id = new.post_id returning * into p;
    select display_name into actor from profiles where id = new.user_id;
    perform _notify(p.author_id, new.user_id, 'REPOST', actor || ' reposted your post', '"' || excerpt(p.text) || '"', null, p.id);
  else
    update posts set repost_count = greatest(repost_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end $$;
create trigger reposts_after after insert or delete on public.reposts for each row execute function public.tg_reposts();

-- Comments: reply policy check (before), counters + notifications (after)
create or replace function public.tg_comments_before()
returns trigger language plpgsql security definer set search_path = public as $$
declare p posts;
begin
  select * into p from posts where id = new.post_id;
  if new.parent_id is not null and not exists (select 1 from comments where id = new.parent_id and post_id = new.post_id) then
    perform raise_app_error('NOT_FOUND', 'The comment you are replying to no longer exists.');
  end if;
  if p.author_id <> new.author_id then
    if p.reply_policy = 'Followers' and not exists (select 1 from follows where follower_id = new.author_id and following_id = p.author_id) then
      perform raise_app_error('FORBIDDEN', 'Only followers of this creator can reply to this post.');
    elsif p.reply_policy = 'Mentioned' and p.text not ilike '%@' || (select username from profiles where id = new.author_id) || '%' then
      perform raise_app_error('FORBIDDEN', 'Only people mentioned in this post can reply.');
    end if;
  end if;
  return new;
end $$;
create trigger comments_before before insert on public.comments for each row execute function public.tg_comments_before();

create or replace function public.tg_comments_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare p posts; actor text; parent_author uuid;
begin
  if tg_op = 'INSERT' then
    update posts set comment_count = comment_count + 1 where id = new.post_id returning * into p;
    select display_name into actor from profiles where id = new.author_id;
    perform _notify(p.author_id, new.author_id, 'COMMENT', actor || ' replied to your post', '"' || excerpt(new.text) || '"', null, p.id);
    if new.parent_id is not null then
      select author_id into parent_author from comments where id = new.parent_id;
      if parent_author <> p.author_id then
        perform _notify(parent_author, new.author_id, 'COMMENT', actor || ' replied to your comment', '"' || excerpt(new.text) || '"', null, p.id);
      end if;
    end if;
  else
    -- replies are removed by cascade; recount keeps the counter exact
    update posts set comment_count = (select count(*) from comments where post_id = old.post_id) where id = old.post_id;
  end if;
  return null;
end $$;
create trigger comments_after after insert or delete on public.comments for each row execute function public.tg_comments_after();

-- Follows → counters + notification
create or replace function public.tg_follows()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor text; mutuals int;
begin
  if tg_op = 'INSERT' then
    update profiles set following_count = following_count + 1 where id = new.follower_id;
    update profiles set follower_count = follower_count + 1 where id = new.following_id;
    select display_name into actor from profiles where id = new.follower_id;
    select count(*) into mutuals from follows a join follows b on b.following_id = a.following_id
      where a.follower_id = new.following_id and b.follower_id = new.follower_id;
    perform _notify(new.following_id, new.follower_id, 'FOLLOW', actor || ' followed you',
      case when mutuals > 0 then 'You have ' || mutuals || ' mutual connection' || case when mutuals = 1 then '' else 's' end || '.' else 'Say hello or follow back.' end);
  else
    update profiles set following_count = greatest(following_count - 1, 0) where id = old.follower_id;
    update profiles set follower_count = greatest(follower_count - 1, 0) where id = old.following_id;
  end if;
  return null;
end $$;
create trigger follows_after after insert or delete on public.follows for each row execute function public.tg_follows();

-- Messages → conversation ordering + one unread "message" notification per sender
create or replace function public.tg_messages()
returns trigger language plpgsql security definer set search_path = public as $$
declare o uuid; actor text;
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  update conversation_members set last_read_at = greatest(last_read_at, new.created_at)
  where conversation_id = new.conversation_id and user_id = new.sender_id;
  if new.kind <> 'GIFT' then
    select display_name into actor from profiles where id = new.sender_id;
    for o in select user_id from conversation_members where conversation_id = new.conversation_id and user_id <> new.sender_id loop
      if not exists (select 1 from notifications where user_id = o and actor_id = new.sender_id and type = 'MESSAGE' and not read) then
        perform _notify(o, new.sender_id, 'MESSAGE', 'New message from ' || actor,
          case new.kind when 'IMAGE' then '📷 Photo' when 'AUDIO' then '🎤 Voice note' else '"' || excerpt(new.body, 120) || '"' end);
      end if;
    end loop;
  end if;
  return null;
end $$;
create trigger messages_after after insert on public.messages for each row execute function public.tg_messages();

-- Communities: creator auto-joins; member counters
create or replace function public.tg_communities_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into community_members (community_id, user_id) values (new.id, new.created_by) on conflict do nothing;
  end if;
  return null;
end $$;
create trigger communities_after after insert on public.communities for each row execute function public.tg_communities_after();

create or replace function public.tg_community_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update communities set member_count = member_count + 1 where id = new.community_id;
  else update communities set member_count = greatest(member_count - 1, 0) where id = old.community_id; end if;
  return null;
end $$;
create trigger community_members_after after insert or delete on public.community_members for each row execute function public.tg_community_members();

-- Default communities from the original design
insert into public.communities (name, description, color, created_by) values
  ('Crypto', 'Rails, stablecoins and payouts for African builders.', '#2F6F4E', null),
  ('Football', 'Match threads, transfers and very bad takes.', '#B0553C', null),
  ('Music', 'Afrobeats, alté and everything in between.', '#6B4E8C', null),
  ('Technology', 'Product, engineering and the Lagos startup scene.', '#1F6E7A', null),
  ('Business', 'Operators sharing numbers, not vibes.', '#8C6A2F', null),
  ('Entertainment', 'Film, Nollywood and weekend culture.', '#8C3F5C', null);

-- ===== 20261016000400_wallet_functions.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 004 · Wallet, gifts & ledger functions (trusted, server-side)
--
-- All money movement happens ONLY inside these SECURITY DEFINER functions.
-- Clients have no INSERT/UPDATE/DELETE rights on any wallet table.
-- Every public entry point:
--   • takes the user from auth.uid() (never from a parameter)
--   • recomputes every amount server-side (client numbers are ignored)
--   • runs in one transaction → all-or-nothing
--   • is idempotent via (user_id, idempotency_key)
--   • refuses to run unless app_config.wallet_mode = 'demo'
-- ════════════════════════════════════════════════════════════════════

-- ── Internal helpers (EXECUTE revoked from clients in migration 005) ──
create or replace function public._cfg(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from app_config where key = p_key
$$;

create or replace function public._fee(p_key text)
returns numeric language sql stable security definer set search_path = public as $$
  select (value ->> p_key)::numeric from app_config where key = 'fees'
$$;

create or replace function public._require_demo_mode()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(_cfg('wallet_mode') #>> '{}', '') <> 'demo' then
    perform raise_app_error('WALLET_UNAVAILABLE', 'Wallet operations are unavailable. Real-money mode is not enabled for KAMKAM yet.');
  end if;
end $$;

create or replace function public._uid()
returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  return u;
end $$;

create or replace function public._asset(p_symbol text, p_crypto_only boolean default false)
returns public.assets language plpgsql stable security definer set search_path = public as $$
declare a assets;
begin
  select * into a from assets where symbol = upper(coalesce(p_symbol, ''));
  if a.symbol is null then perform raise_app_error('INVALID_ASSET', 'Unsupported asset.'); end if;
  if p_crypto_only and not a.is_crypto then perform raise_app_error('INVALID_ASSET', 'Choose a crypto asset (USDT, BNB, ETH or SOL).'); end if;
  return a;
end $$;

create or replace function public._round_up(v numeric, dp int)
returns numeric language sql immutable as $$ select ceil(v * power(10::numeric, dp)) / power(10::numeric, dp) $$;
create or replace function public._round_down(v numeric, dp int)
returns numeric language sql immutable as $$ select trunc(v, dp) $$;
create or replace function public._ngn(v numeric)
returns numeric language sql immutable as $$ select round(v, 2) $$;

-- "₦2,000" / "₦1,600.5"
create or replace function public._fmt_ngn(v numeric)
returns text language sql immutable as $$
  select '₦' || rtrim(to_char(round(v, 2), 'FM999,999,999,999,990.99'), '.')
$$;

-- "1.25 USDT" / "0.0020 BNB" / tiny values keep 3 significant digits
create or replace function public._fmt_qty(p_asset text, v numeric)
returns text language plpgsql stable security definer set search_path = public as $$
declare dp int; s text; sig int;
begin
  if p_asset = 'NGN' then return _fmt_ngn(v); end if;
  select display_dp into dp from assets where symbol = p_asset;
  dp := coalesce(dp, 4);
  if v <> 0 and abs(v) < power(10::numeric, -dp) * 10 then
    sig := 2 - floor(log(abs(v)))::int;
    s := rtrim(rtrim(round(v, sig)::text, '0'), '.');
  elsif p_asset = 'USDT' then
    s := to_char(round(v, 2), 'FM999,999,999,990.00');
  else
    s := rtrim(to_char(round(v, dp), 'FM999,999,999,990.' || repeat('9', dp)), '.');
  end if;
  return s || ' ' || p_asset;
end $$;

create or replace function public._label(p_asset text)
returns text language sql immutable as $$ select case when p_asset = 'NGN' then 'Naira' else p_asset end $$;

-- KK-GFT-7Q2M9XH4 (references are identifiers, not secrets)
create or replace function public._ref(p_prefix text)
returns text language plpgsql volatile as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; s text := '';
begin
  for i in 1..8 loop s := s || substr(alphabet, 1 + floor(random() * 32)::int, 1); end loop;
  return 'KK-' || p_prefix || '-' || s;
end $$;

create or replace function public._amount(p jsonb, p_key text)
returns numeric language plpgsql immutable as $$
declare raw text := replace(btrim(coalesce(p ->> p_key, '')), ',', ''); v numeric;
begin
  if raw !~ '^\d+(\.\d+)?$' then perform raise_app_error('VALIDATION', 'Enter a valid amount greater than 0.'); end if;
  v := raw::numeric;
  if v <= 0 then perform raise_app_error('VALIDATION', 'Enter a valid amount greater than 0.'); end if;
  return v;
end $$;

create or replace function public._b58(p_bytes bytea, p_len int)
returns text language plpgsql immutable as $$
declare a text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; s text := ''; i int := 0;
begin
  while length(s) < p_len loop
    s := s || substr(a, 1 + get_byte(p_bytes, i % length(p_bytes)) % 58, 1);
    i := i + 1;
  end loop;
  return s;
end $$;

-- Deterministic DEMO addresses: valid format, NOT derived from any key.
create or replace function public._demo_addresses(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  h_evm bytea := sha256(convert_to('kamkam-demo:' || p_user || ':evm', 'UTF8'));
  h_sol bytea := sha256(convert_to('kamkam-demo:' || p_user || ':sol', 'UTF8')) || sha256(convert_to('kamkam-demo:' || p_user || ':sol2', 'UTF8'));
  h_trx bytea := sha256(convert_to('kamkam-demo:' || p_user || ':tron', 'UTF8'));
  r jsonb := '{}'::jsonb; n networks;
begin
  for n in select * from networks loop
    r := r || jsonb_build_object(n.name, case n.family
      when 'evm' then '0x' || substr(encode(h_evm, 'hex'), 1, 40)
      when 'solana' then _b58(h_sol, 44)
      else 'T' || _b58(h_trx, 33) end);
  end loop;
  return r;
end $$;

create or replace function public._valid_address(p_network text, p_address text)
returns boolean language sql stable security definer set search_path = public as $$
  select case (select family from networks where name = p_network)
    when 'evm' then p_address ~ '^0x[0-9a-fA-F]{40}$'
    when 'solana' then p_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    when 'tron' then p_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'
    else false end
$$;

create or replace function public._ensure_wallet(p_user uuid)
returns public.wallets language plpgsql security definer set search_path = public as $$
declare w wallets;
begin
  insert into wallets (user_id, demo_addresses) values (p_user, _demo_addresses(p_user)) on conflict (user_id) do nothing;
  insert into wallet_assets (user_id, symbol) select p_user, symbol from assets on conflict do nothing;
  select * into w from wallets where user_id = p_user;
  return w;
end $$;

create or replace function public._balance(p_user uuid, p_symbol text)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select balance from wallet_assets where user_id = p_user and symbol = p_symbol), 0)
$$;

create or replace function public._credit(p_user uuid, p_symbol text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Invalid credit amount.'); end if;
  insert into wallet_assets (user_id, symbol, balance) values (p_user, p_symbol, p_amount)
  on conflict (user_id, symbol) do update set balance = wallet_assets.balance + excluded.balance, updated_at = now();
end $$;

-- Conditional debit: matches only when balance >= amount, so concurrent
-- requests can never overdraw (also guarded by CHECK balance >= 0).
create or replace function public._debit(p_user uuid, p_symbol text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
declare have numeric;
begin
  update wallet_assets set balance = balance - p_amount, updated_at = now()
  where user_id = p_user and symbol = p_symbol and balance >= p_amount;
  if not found then
    have := _balance(p_user, p_symbol);
    perform raise_app_error('INSUFFICIENT_BALANCE',
      format('Insufficient %s balance. You need %s, you have %s.', _label(p_symbol), _fmt_qty(p_symbol, p_amount), _fmt_qty(p_symbol, have)));
  end if;
end $$;

create or replace function public._debit_earnings(p_user uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  update wallets set earnings_available = earnings_available - p_amount
  where user_id = p_user and earnings_available >= p_amount;
  if not found then perform raise_app_error('INSUFFICIENT_BALANCE', 'Insufficient creator earnings for this withdrawal.'); end if;
end $$;

create or replace function public._record_tx(
  p_user uuid, p_type text, p_direction text, p_asset text, p_amount numeric, p_value_ngn numeric,
  p_reference text, p_description text, p_status text default 'COMPLETED', p_network text default null,
  p_counterparty text default null, p_fee numeric default 0, p_fee_asset text default null,
  p_auto_settle boolean default false, p_metadata jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into wallet_transactions (user_id, type, direction, asset, amount, value_ngn, fee, fee_asset, status, reference,
                                   network, counterparty, description, simulated, auto_settle, metadata, completed_at)
  values (p_user, p_type, p_direction, p_asset, p_amount, round(coalesce(p_value_ngn, 0), 2), coalesce(p_fee, 0), p_fee_asset,
          p_status, p_reference, p_network, p_counterparty, p_description, true, p_auto_settle, coalesce(p_metadata, '{}'::jsonb),
          case when p_status = 'COMPLETED' then now() end)
  returning id into v_id;
  return v_id;
end $$;

-- Demo starter credit (clearly labelled; only in demo mode)
create or replace function public._grant_starter(p_user uuid, p_assets jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v text; ref text; a assets;
begin
  if coalesce(_cfg('wallet_mode') #>> '{}', '') <> 'demo' then return; end if;
  perform _ensure_wallet(p_user);
  for k, v in select * from jsonb_each_text(p_assets) loop
    select * into a from assets where symbol = k;
    ref := _ref('DEP');
    perform _credit(p_user, k, v::numeric);
    insert into deposits (user_id, asset, amount, method, reference) values (p_user, k, v::numeric, 'Demo starter credit', ref);
    perform _record_tx(p_user, 'DEPOSIT', 'IN', k, v::numeric, v::numeric * a.rate_ngn, ref,
      'Demo starter credit (not real money)', 'COMPLETED', case when k = 'NGN' then 'Naira' else 'Demo' end);
  end loop;
end $$;

-- New auth user → profile + wallet + demo starter Naira
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  dname text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', ''));
  base text;
  colors text[] := array['#2F6F4E', '#B0553C', '#3A5C8C', '#6B4E8C', '#1F6E7A', '#8C6A2F', '#14975C', '#8C3F5C'];
begin
  if uname <> '' then
    if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'Invalid username' using errcode = '23514'; end if;
    if exists (select 1 from profiles where username = uname) then raise exception 'Username already taken' using errcode = '23505'; end if;
  else
    base := left(regexp_replace(lower(split_part(coalesce(new.email, 'user'), '@', 1)), '[^a-z0-9_]', '', 'g'), 14);
    if length(base) < 3 then base := 'user'; end if;
    loop
      uname := base || '_' || substr(md5(random()::text), 1, 5);
      exit when not exists (select 1 from profiles where username = uname);
    end loop;
  end if;
  if dname = '' then dname := uname; end if;

  insert into profiles (id, username, display_name, avatar_color)
  values (new.id, uname, left(dname, 50), colors[1 + (abs(hashtext(uname)) % 8)]);
  perform _ensure_wallet(new.id);
  perform _grant_starter(new.id, jsonb_build_object('NGN', _cfg('starter_ngn') #>> '{}'));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Ledger rows are immutable except for status progression.
create or replace function public.tg_wallet_tx_immutable()
returns trigger language plpgsql as $$
begin
  if (new.user_id, new.type, new.direction, new.asset, new.amount, new.value_ngn, new.fee, new.reference, new.simulated)
     is distinct from (old.user_id, old.type, old.direction, old.asset, old.amount, old.value_ngn, old.fee, old.reference, old.simulated) then
    raise exception 'wallet_transactions are append-only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger wallet_tx_immutable before update on public.wallet_transactions
  for each row execute function public.tg_wallet_tx_immutable();

-- Idempotency: returns the stored result if this key was already used.
create or replace function public._idempotent_begin(p_user uuid, p_key uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prev idempotency_keys;
begin
  if p_key is null then perform raise_app_error('VALIDATION', 'Missing idempotency key.'); end if;
  insert into idempotency_keys (user_id, key, action) values (p_user, p_key, p_action) on conflict do nothing;
  if found then return null; end if;
  select * into prev from idempotency_keys where user_id = p_user and key = p_key;
  if prev.action <> p_action then perform raise_app_error('VALIDATION', 'This request key was already used for a different action.'); end if;
  return coalesce(prev.result, jsonb_build_object('duplicate', true));
end $$;

create or replace function public._rate_limit_money(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from idempotency_keys where user_id = p_user and created_at > now() - interval '1 minute') >= 30 then
    perform raise_app_error('RATE_LIMITED', 'Too many wallet actions. Slow down a little.');
  end if;
end $$;

-- ═════════════════════════════ QUOTES ══════════════════════════════
create or replace function public._row(k text, v text, tone text default null)
returns jsonb language sql immutable as $$
  select case when tone is null then jsonb_build_object('k', k, 'v', v) else jsonb_build_object('k', k, 'v', v, 'tone', tone) end
$$;

create or replace function public._mask(acct text)
returns text language sql immutable as $$ select case when acct is null then '' else '••••' || right(acct, 4) end $$;

create or replace function public._bank(p jsonb)
returns jsonb language plpgsql immutable as $$
declare b jsonb := jsonb_build_object('bankName', btrim(coalesce(p ->> 'bankName', '')), 'accountNumber', btrim(coalesce(p ->> 'accountNumber', '')), 'accountName', btrim(coalesce(p ->> 'accountName', '')));
begin
  if char_length(b ->> 'bankName') < 2 or char_length(b ->> 'accountName') < 2 or char_length(b ->> 'accountNumber') = 0 then
    perform raise_app_error('BANK_DETAILS', 'Enter bank, account number and account name.');
  end if;
  if (b ->> 'accountNumber') !~ '^\d{10}$' then perform raise_app_error('BANK_DETAILS', 'Account number must be 10 digits.'); end if;
  return b;
end $$;

-- Returns the full quote incl. internal fields under "_" (stripped before returning to clients)
create or replace function public._wallet_quote(p_user uuid, p_action text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w wallets; a assets; b assets; n networks;
  v_amount numeric; v_value numeric; v_fee numeric; v_recv numeric; v_pay numeric; v_avail numeric; v_total numeric;
  v_net_fee_ngn numeric; v_plat_fee_ngn numeric; v_out numeric; v_cross numeric; v_net_fee numeric; v_plat_fee numeric;
  v_rows jsonb := '[]'::jsonb; v_warn jsonb := '[]'::jsonb; v_status text := 'COMPLETED';
  v_source text := 'WALLET'; v_debit_asset text; v_recv_asset text; v_dest text; v_net text; v_addr text;
  v_bank jsonb; v_to profiles; v_internal jsonb; v_method text; v_from_earnings boolean; v_pay_label text;
  min_ngn numeric := _fee('min_ngn'); max_ngn numeric := _fee('max_tx_ngn');
  demo_row jsonb := _row('Settlement', 'Demo transaction · simulated', 'muted');
begin
  w := _ensure_wallet(p_user);
  p := coalesce(p, '{}'::jsonb);

  if p_action = 'deposit' then
    v_amount := _ngn(_amount(p, 'amount'));
    if coalesce(p ->> 'method', '') not in ('Bank card', 'Paystack', 'Bank transfer') then perform raise_app_error('VALIDATION', 'Choose a payment method.'); end if;
    if v_amount < min_ngn then perform raise_app_error('INVALID_AMOUNT', 'Minimum deposit is ' || _fmt_ngn(min_ngn) || '.'); end if;
    if v_amount > 5000000 then perform raise_app_error('INVALID_AMOUNT', 'Maximum demo deposit is ₦5,000,000.'); end if;
    v_avail := _balance(p_user, 'NGN');
    return jsonb_build_object('action', 'deposit',
      'debit', jsonb_build_object('source', 'EXTERNAL', 'asset', 'NGN', 'amount', v_amount::text, 'label', _fmt_ngn(v_amount)),
      'receive', jsonb_build_object('asset', 'NGN', 'amount', v_amount::text, 'label', _fmt_ngn(v_amount)),
      'valueNgn', v_amount::text, 'available', v_avail::text, 'availableLabel', _fmt_ngn(v_avail),
      'rows', jsonb_build_array(_row('Amount', _fmt_ngn(v_amount), 'strong'), _row('Payment method', p ->> 'method'), _row('Fee', '₦0'),
                                _row('New Naira balance', _fmt_ngn(v_avail + v_amount), 'green'), demo_row),
      'sufficient', true, 'status', 'COMPLETED', 'warnings', jsonb_build_array('Demo only — no real payment is processed.'),
      'simulated', true, '_', jsonb_build_object('method', p ->> 'method'));
  end if;

  if p_action = 'buy' then
    if not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;
    a := _asset(p ->> 'asset', true);
    v_amount := _ngn(_amount(p, 'amountNgn'));
    if v_amount < min_ngn then perform raise_app_error('INVALID_AMOUNT', 'Minimum purchase is ' || _fmt_ngn(min_ngn) || '.'); end if;
    if v_amount > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    if upper(coalesce(p ->> 'payWith', '')) = a.symbol then perform raise_app_error('INVALID_ASSET', 'Choose a different asset to pay with.'); end if;
    v_fee := _ngn(v_amount * _fee('buy_pct'));
    v_recv := _round_down((v_amount - v_fee) / a.rate_ngn, a.precision);
    v_rows := jsonb_build_array(_row('You buy', _fmt_qty(a.symbol, v_recv), 'green'), _row('Amount', _fmt_ngn(v_amount), 'strong'),
                                _row('Exchange rate', '1 ' || a.symbol || ' ≈ ' || _fmt_ngn(a.rate_ngn)));
    if upper(coalesce(p ->> 'payWith', 'CARD')) = 'CARD' then
      v_source := 'EXTERNAL'; v_debit_asset := 'NGN'; v_pay := v_amount; v_avail := 0; v_pay_label := 'Naira · card / bank (simulated)';
    else
      b := _asset(p ->> 'payWith');
      v_debit_asset := b.symbol;
      v_pay := case when b.symbol = 'NGN' then v_amount else _round_up(v_amount / b.rate_ngn, b.precision) end;
      v_avail := _balance(p_user, b.symbol);
      v_pay_label := case when b.symbol = 'NGN' then 'Naira wallet balance' else b.symbol || ' wallet balance' end;
      if b.symbol <> 'NGN' then v_rows := v_rows || _row(b.symbol || ' rate', '1 ' || b.symbol || ' ≈ ' || _fmt_ngn(b.rate_ngn)); end if;
    end if;
    v_rows := v_rows || _row('Pay with', v_pay_label) || _row(case when v_debit_asset = 'NGN' then 'You pay' else 'Estimated cost' end, _fmt_qty(v_debit_asset, v_pay), 'gold')
              || _row('Fee (' || (_fee('buy_pct') * 100)::float || '%)', _fmt_ngn(v_fee)) || demo_row;
    return jsonb_build_object('action', 'buy',
      'debit', jsonb_build_object('source', v_source, 'asset', v_debit_asset, 'amount', v_pay::text, 'label', _fmt_qty(v_debit_asset, v_pay)),
      'receive', jsonb_build_object('asset', a.symbol, 'amount', v_recv::text, 'label', _fmt_qty(a.symbol, v_recv)),
      'valueNgn', v_amount::text, 'rows', v_rows, 'available', v_avail::text,
      'availableLabel', case when v_source = 'EXTERNAL' then 'Paid externally' else _fmt_qty(v_debit_asset, v_avail) end,
      'sufficient', v_source = 'EXTERNAL' or v_avail >= v_pay, 'status', 'COMPLETED', 'warnings', '[]'::jsonb, 'simulated', true,
      '_', jsonb_build_object('fee', v_fee, 'rate', a.rate_ngn, 'payMethod', case when v_source = 'EXTERNAL' then 'Naira (card/bank)' else v_debit_asset || ' balance' end));
  end if;

  if p_action = 'sell' then
    if not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;
    a := _asset(p ->> 'asset', true);
    v_amount := _round_down(_amount(p, 'amount'), a.precision);
    if v_amount <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small.'); end if;
    v_value := _ngn(v_amount * a.rate_ngn);
    if v_value > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    v_fee := _ngn(v_value * _fee('sell_pct'));
    v_out := v_value - v_fee;
    if v_out <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small to cover the fee.'); end if;
    v_avail := _balance(p_user, a.symbol);
    v_method := coalesce(p ->> 'receiveMethod', 'NAIRA_BALANCE');
    v_recv_asset := 'NGN'; v_recv := v_out; v_dest := 'Naira balance';
    if v_method = 'WALLET_ASSET' then
      b := _asset(p ->> 'receiveAsset', true);
      if b.symbol = a.symbol then perform raise_app_error('INVALID_ASSET', 'Choose a different asset to receive.'); end if;
      v_recv_asset := b.symbol; v_recv := _round_down(v_out / b.rate_ngn, b.precision); v_dest := b.symbol || ' wallet balance';
    elsif v_method = 'BANK' then
      v_bank := _bank(p); v_dest := (v_bank ->> 'bankName') || ' ' || _mask(v_bank ->> 'accountNumber'); v_status := 'PENDING';
    elsif v_method <> 'NAIRA_BALANCE' then perform raise_app_error('VALIDATION', 'Choose where to receive the proceeds.');
    end if;
    return jsonb_build_object('action', 'sell',
      'debit', jsonb_build_object('source', 'WALLET', 'asset', a.symbol, 'amount', v_amount::text, 'label', _fmt_qty(a.symbol, v_amount)),
      'receive', jsonb_build_object('asset', v_recv_asset, 'amount', v_recv::text, 'label', _fmt_qty(v_recv_asset, v_recv)),
      'valueNgn', v_value::text, 'available', v_avail::text, 'availableLabel', _fmt_qty(a.symbol, v_avail),
      'rows', jsonb_build_array(_row('Selling', _fmt_qty(a.symbol, v_amount), 'strong'), _row('Exchange rate', '1 ' || a.symbol || ' ≈ ' || _fmt_ngn(a.rate_ngn)),
        _row('Estimated value', _fmt_ngn(v_value)), _row('Fee (' || (_fee('sell_pct') * 100)::float || '%)', _fmt_ngn(v_fee)),
        _row('You receive', _fmt_qty(v_recv_asset, v_recv), 'green'), _row('Destination', v_dest), demo_row),
      'sufficient', v_avail >= v_amount, 'status', v_status,
      'warnings', case when v_method = 'BANK' then jsonb_build_array('Bank payouts are simulated — no real bank transfer happens.') else '[]'::jsonb end,
      'simulated', true, '_', jsonb_build_object('fee', v_fee, 'rate', a.rate_ngn, 'dest', v_dest, 'method', v_method, 'bank', v_bank));
  end if;

  if p_action = 'swap' then
    if not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;
    a := _asset(p ->> 'from', true); b := _asset(p ->> 'to', true);
    if a.symbol = b.symbol then perform raise_app_error('INVALID_ASSET', 'Choose two different assets.'); end if;
    v_amount := _round_down(_amount(p, 'amount'), a.precision);
    v_value := _ngn(v_amount * a.rate_ngn);
    if v_value > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    select n2.* into n from asset_networks an join networks n2 on n2.name = an.network where an.asset = a.symbol and an.is_default;
    v_net_fee_ngn := n.fee_ngn;
    v_plat_fee_ngn := _ngn(v_value * _fee('swap_pct'));
    v_out := v_value - v_net_fee_ngn - v_plat_fee_ngn;
    if v_out <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small to cover swap fees.'); end if;
    v_recv := _round_down(v_out / b.rate_ngn, b.precision);
    v_avail := _balance(p_user, a.symbol);
    v_net_fee := _round_up(v_net_fee_ngn / a.rate_ngn, a.precision);
    v_plat_fee := _round_up(v_plat_fee_ngn / a.rate_ngn, a.precision);
    v_cross := a.rate_ngn / b.rate_ngn;
    return jsonb_build_object('action', 'swap',
      'debit', jsonb_build_object('source', 'WALLET', 'asset', a.symbol, 'amount', v_amount::text, 'label', _fmt_qty(a.symbol, v_amount)),
      'receive', jsonb_build_object('asset', b.symbol, 'amount', v_recv::text, 'label', _fmt_qty(b.symbol, v_recv)),
      'valueNgn', v_value::text, 'available', v_avail::text, 'availableLabel', _fmt_qty(a.symbol, v_avail),
      'rows', jsonb_build_array(_row('From', _fmt_qty(a.symbol, v_amount), 'strong'), _row('To', b.symbol),
        _row('Estimated receive', _fmt_qty(b.symbol, v_recv), 'green'), _row('Exchange rate', '1 ' || a.symbol || ' ≈ ' || _fmt_qty(b.symbol, v_cross)),
        _row('Network fee', _fmt_qty(a.symbol, v_net_fee) || ' (' || n.name || ')'), _row('Platform fee (' || (_fee('swap_pct') * 100)::float || '%)', _fmt_qty(a.symbol, v_plat_fee)), demo_row),
      'sufficient', v_avail >= v_amount, 'status', 'COMPLETED', 'warnings', '[]'::jsonb, 'simulated', true,
      '_', jsonb_build_object('rate', v_cross, 'netFee', v_net_fee, 'platFee', v_plat_fee, 'platFeeNgn', v_plat_fee_ngn, 'network', n.name));
  end if;

  if p_action = 'send' then
    if not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;
    a := _asset(p ->> 'asset', true);
    v_net := p ->> 'network';
    if not exists (select 1 from asset_networks where asset = a.symbol and network = v_net) then
      perform raise_app_error('INVALID_NETWORK', a.symbol || ' is not supported on ' || coalesce(v_net, 'that network') || '.');
    end if;
    select * into n from networks where name = v_net;
    v_addr := btrim(coalesce(p ->> 'address', ''));
    if v_addr = '' then perform raise_app_error('INVALID_ADDRESS', 'Enter a recipient address.'); end if;
    if not _valid_address(v_net, v_addr) then
      perform raise_app_error('INVALID_ADDRESS', 'Invalid ' || v_net || ' address. Expected ' ||
        case n.family when 'evm' then 'a 0x… address (42 characters)' when 'solana' then 'a Solana base58 address' else 'a TRON address starting with T' end || '.');
    end if;
    v_amount := _round_down(_amount(p, 'amount'), a.precision);
    v_value := _ngn(v_amount * a.rate_ngn);
    if v_value > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    v_fee := _round_up(n.fee_ngn / a.rate_ngn, a.precision);
    v_total := v_amount + v_fee;
    v_avail := _balance(p_user, a.symbol);
    select jsonb_build_object('userId', wl.user_id, 'username', pr.username) into v_internal
    from wallets wl join profiles pr on pr.id = wl.user_id where wl.demo_addresses ->> v_net = v_addr limit 1;
    if (v_internal ->> 'userId')::uuid = p_user then perform raise_app_error('INVALID_ADDRESS', 'That is your own address.'); end if;
    return jsonb_build_object('action', 'send',
      'debit', jsonb_build_object('source', 'WALLET', 'asset', a.symbol, 'amount', v_total::text, 'label', _fmt_qty(a.symbol, v_total)),
      'receive', jsonb_build_object('asset', a.symbol, 'amount', v_amount::text, 'label', _fmt_qty(a.symbol, v_amount)),
      'valueNgn', v_value::text, 'available', v_avail::text, 'availableLabel', _fmt_qty(a.symbol, v_avail),
      'rows', jsonb_build_array(_row('Asset', a.symbol), _row('Network', v_net),
        _row('Recipient', left(v_addr, 10) || '…' || right(v_addr, 4) || coalesce(' (@' || (v_internal ->> 'username') || ')', '')),
        _row('Amount', _fmt_qty(a.symbol, v_amount), 'strong'), _row('Network fee', '≈ ' || _fmt_qty(a.symbol, v_fee)),
        _row('Total deducted', _fmt_qty(a.symbol, v_total), 'gold'), demo_row),
      'sufficient', v_avail >= v_total, 'status', 'PENDING',
      'warnings', jsonb_build_array('Make sure you are sending ' || a.symbol || ' on ' || v_net || '. Assets sent on the wrong network cannot be recovered.',
        case when v_internal is not null then 'This is a KAMKAM demo address — it will settle internally to @' || (v_internal ->> 'username') || '.'
             else 'Demo transaction: nothing is broadcast to a real blockchain.' end),
      'simulated', true, '_', jsonb_build_object('fee', v_fee, 'amount', v_amount, 'address', v_addr, 'network', v_net, 'internal', v_internal));
  end if;

  if p_action = 'transfer' then
    a := _asset(p ->> 'asset');
    if a.is_crypto and not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;
    select * into v_to from profiles where username = lower(ltrim(btrim(coalesce(p ->> 'toUsername', '')), '@'));
    if v_to.id is null then perform raise_app_error('USER_NOT_FOUND', 'No KAMKAM user @' || lower(ltrim(btrim(coalesce(p ->> 'toUsername', '')), '@')) || '.'); end if;
    if v_to.id = p_user then perform raise_app_error('INVALID_RECIPIENT', 'You cannot transfer to yourself.'); end if;
    if char_length(coalesce(p ->> 'note', '')) > 140 then perform raise_app_error('VALIDATION', 'Note is too long (max 140 characters).'); end if;
    v_amount := _round_down(_amount(p, 'amount'), a.precision);
    if v_amount <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small.'); end if;
    v_value := _ngn(v_amount * a.rate_ngn);
    if v_value > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    v_avail := _balance(p_user, a.symbol);
    return jsonb_build_object('action', 'transfer',
      'debit', jsonb_build_object('source', 'WALLET', 'asset', a.symbol, 'amount', v_amount::text, 'label', _fmt_qty(a.symbol, v_amount)),
      'receive', jsonb_build_object('asset', a.symbol, 'amount', v_amount::text, 'label', _fmt_qty(a.symbol, v_amount)),
      'valueNgn', v_value::text, 'available', v_avail::text, 'availableLabel', _fmt_qty(a.symbol, v_avail),
      'rows', jsonb_build_array(_row('To', v_to.display_name || ' (@' || v_to.username || ')'), _row('Amount', _fmt_qty(a.symbol, v_amount), 'strong'),
        _row('Value', _fmt_ngn(v_value)), _row('Fee', 'Free · KAMKAM to KAMKAM'), _row('Arrives', 'Instantly')),
      'sufficient', v_avail >= v_amount, 'status', 'COMPLETED', 'warnings', '[]'::jsonb, 'simulated', true,
      '_', jsonb_build_object('toId', v_to.id, 'toUsername', v_to.username, 'note', nullif(btrim(coalesce(p ->> 'note', '')), '')));
  end if;

  if p_action = 'withdraw' then
    v_from_earnings := coalesce(p ->> 'source', '') = 'EARNINGS';
    if coalesce(p ->> 'source', '') not in ('EARNINGS', 'WALLET') then perform raise_app_error('VALIDATION', 'Choose where to withdraw from.'); end if;
    v_method := coalesce(p ->> 'method', '');
    if v_method not in ('KAMKAM_WALLET', 'EXTERNAL_WALLET', 'BANK') then perform raise_app_error('VALIDATION', 'Choose a withdrawal method.'); end if;
    a := _asset(p ->> 'asset');
    if v_method = 'KAMKAM_WALLET' and not v_from_earnings then perform raise_app_error('INVALID_METHOD', 'Wallet balances are already in your KAMKAM wallet.'); end if;
    if v_method = 'BANK' and a.symbol <> 'NGN' then perform raise_app_error('INVALID_ASSET', 'Bank withdrawals are in Naira. Sell crypto first or choose another method.'); end if;
    if v_method = 'EXTERNAL_WALLET' and not a.is_crypto then perform raise_app_error('INVALID_ASSET', 'Choose a crypto asset for external wallet withdrawals.'); end if;
    if a.is_crypto and not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first to use crypto assets.'); end if;

    v_avail := case when v_from_earnings then w.earnings_available else _balance(p_user, a.symbol) end;
    if v_from_earnings then
      v_debit_asset := 'NGN'; v_amount := _ngn(_amount(p, 'amount'));
      if v_amount < min_ngn then perform raise_app_error('INVALID_AMOUNT', 'Minimum withdrawal is ' || _fmt_ngn(min_ngn) || '.'); end if;
      v_value := v_amount;
    else
      v_debit_asset := a.symbol; v_amount := _round_down(_amount(p, 'amount'), a.precision);
      v_value := _ngn(v_amount * a.rate_ngn);
    end if;
    if v_value > max_ngn then perform raise_app_error('INVALID_AMOUNT', 'Amount is too large for this demo.'); end if;
    v_rows := jsonb_build_array(_row('From', case when v_from_earnings then 'Creator earnings' else _label(a.symbol) || ' wallet balance' end),
                                _row('Amount', _fmt_qty(v_debit_asset, v_amount), 'strong'));
    v_fee := 0; v_recv_asset := a.symbol;

    if v_method = 'KAMKAM_WALLET' then
      v_recv := case when a.symbol = 'NGN' then v_amount else _round_down(v_amount / a.rate_ngn, a.precision) end;
      v_dest := 'KAMKAM Wallet · ' || _label(a.symbol);
      if a.symbol <> 'NGN' then v_rows := v_rows || _row('Exchange rate', '1 ' || a.symbol || ' ≈ ' || _fmt_ngn(a.rate_ngn)); end if;
      v_rows := v_rows || _row('Fee', '₦0');
      v_net := 'KAMKAM';
    elsif v_method = 'EXTERNAL_WALLET' then
      v_net := p ->> 'network';
      if v_net is null then perform raise_app_error('INVALID_NETWORK', 'Choose a network.'); end if;
      if not exists (select 1 from asset_networks where asset = a.symbol and network = v_net) then
        perform raise_app_error('INVALID_NETWORK', a.symbol || ' is not supported on ' || v_net || '.');
      end if;
      select * into n from networks where name = v_net;
      v_addr := btrim(coalesce(p ->> 'address', ''));
      if v_addr = '' then perform raise_app_error('INVALID_ADDRESS', 'Enter the external wallet address.'); end if;
      if not _valid_address(v_net, v_addr) then perform raise_app_error('INVALID_ADDRESS', 'Invalid ' || v_net || ' address.'); end if;
      v_fee := _round_up(n.fee_ngn / a.rate_ngn, a.precision);
      v_recv := (case when v_from_earnings then _round_down(v_amount / a.rate_ngn, a.precision) else v_amount end) - v_fee;
      if v_recv <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small to cover the network fee.'); end if;
      v_dest := left(v_addr, 10) || '…' || right(v_addr, 4);
      if v_from_earnings then v_rows := v_rows || _row('Exchange rate', '1 ' || a.symbol || ' ≈ ' || _fmt_ngn(a.rate_ngn)); end if;
      v_rows := v_rows || _row('Network', v_net) || _row('Network fee', '≈ ' || _fmt_qty(a.symbol, v_fee));
    else
      v_bank := _bank(p);
      v_fee := _fee('bank_withdraw_ngn');
      v_recv_asset := 'NGN'; v_recv := v_amount - v_fee;
      if v_recv <= 0 then perform raise_app_error('INVALID_AMOUNT', 'Amount is too small to cover the transfer fee.'); end if;
      v_dest := (v_bank ->> 'bankName') || ' ' || _mask(v_bank ->> 'accountNumber');
      v_rows := v_rows || _row('Account name', v_bank ->> 'accountName') || _row('Transfer fee', _fmt_ngn(v_fee));
      v_net := 'Naira';
    end if;
    v_rows := v_rows || _row('Destination', v_dest) || _row('You receive', _fmt_qty(v_recv_asset, v_recv), 'green')
              || _row('Arrives', 'Pending → Processing → Completed (~10s demo)') || demo_row;
    return jsonb_build_object('action', 'withdraw',
      'debit', jsonb_build_object('source', case when v_from_earnings then 'EARNINGS' else 'WALLET' end, 'asset', v_debit_asset,
                                  'amount', v_amount::text, 'label', _fmt_qty(v_debit_asset, v_amount)),
      'receive', jsonb_build_object('asset', v_recv_asset, 'amount', v_recv::text, 'label', _fmt_qty(v_recv_asset, v_recv)),
      'valueNgn', v_value::text, 'rows', v_rows, 'available', v_avail::text,
      'availableLabel', case when v_from_earnings then _fmt_ngn(v_avail) else _fmt_qty(a.symbol, v_avail) end,
      'sufficient', v_avail >= v_amount, 'status', 'PENDING',
      'warnings', case v_method when 'BANK' then jsonb_build_array('Bank payouts are simulated — no real bank transfer happens.')
                                when 'EXTERNAL_WALLET' then jsonb_build_array('Demo transaction: nothing is broadcast to a real blockchain.') else '[]'::jsonb end,
      'simulated', true,
      '_', jsonb_build_object('fee', v_fee, 'feeAsset', case when v_method = 'EXTERNAL_WALLET' then a.symbol else 'NGN' end, 'dest', v_dest,
                              'network', v_net, 'method', v_method, 'fromEarnings', v_from_earnings, 'address', v_addr, 'bank', v_bank));
  end if;

  perform raise_app_error('NOT_FOUND', 'Unknown wallet action.');
  return null;
end $$;

-- Public: price/fee preview. Never changes state.
create or replace function public.wallet_quote(p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_demo_mode();
  return _wallet_quote(_uid(), p_action, p_params) - '_';
end $$;

-- ═════════════════════════════ EXECUTE ═════════════════════════════
create or replace function public.wallet_execute(p_action text, p_params jsonb, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := _uid(); prev jsonb; q jsonb; i jsonb; ref text; v_status text := 'COMPLETED';
  v_debit numeric; v_recv numeric; v_value numeric; v_debit_asset text; v_recv_asset text; me_name text; v_result jsonb;
  v_to uuid; v_to_name text;
begin
  perform _require_demo_mode();
  prev := _idempotent_begin(me, p_idempotency_key, 'wallet:' || p_action);
  if prev is not null then return prev; end if;
  perform _rate_limit_money(me);

  q := _wallet_quote(me, p_action, p_params);            -- recomputed inside the transaction
  if not (q ->> 'sufficient')::boolean then
    perform raise_app_error('INSUFFICIENT_BALANCE', format('Insufficient %s balance. You need %s, you have %s.',
      _label(q #>> '{debit,asset}'), q #>> '{debit,label}', q ->> 'availableLabel'));
  end if;
  i := q -> '_';
  v_debit := (q #>> '{debit,amount}')::numeric; v_debit_asset := q #>> '{debit,asset}';
  v_recv := (q #>> '{receive,amount}')::numeric; v_recv_asset := q #>> '{receive,asset}';
  v_value := (q ->> 'valueNgn')::numeric;
  select username into me_name from profiles where id = me;

  if p_action = 'deposit' then
    if (select coalesce(sum(amount), 0) from deposits where user_id = me and method <> 'Demo starter credit' and created_at > now() - interval '24 hours') + v_recv
       > (_cfg('demo_deposit_daily_cap_ngn') #>> '{}')::numeric then
      perform raise_app_error('LIMIT_REACHED', 'Daily demo funding limit reached (' || _fmt_ngn((_cfg('demo_deposit_daily_cap_ngn') #>> '{}')::numeric) || ').');
    end if;
    ref := _ref('DEP');
    perform _credit(me, 'NGN', v_recv);
    insert into deposits (user_id, asset, amount, method, reference) values (me, 'NGN', v_recv, i ->> 'method', ref);
    perform _record_tx(me, 'DEPOSIT', 'IN', 'NGN', v_recv, v_value, ref, 'Wallet funded · ' || (i ->> 'method'), 'COMPLETED', 'Naira');

  elsif p_action = 'buy' then
    ref := _ref('BUY');
    if q #>> '{debit,source}' = 'WALLET' then
      perform _debit(me, v_debit_asset, v_debit);
      perform _record_tx(me, 'BUY', 'OUT', v_debit_asset, v_debit, v_value, ref, 'Paid for ' || v_recv_asset || ' purchase');
    end if;
    perform _credit(me, v_recv_asset, v_recv);
    perform _record_tx(me, 'BUY', 'IN', v_recv_asset, v_recv, v_value, ref, 'Bought ' || v_recv_asset || ' · ' || (i ->> 'payMethod'),
                       'COMPLETED', null, null, (i ->> 'fee')::numeric, 'NGN');
    insert into buy_transactions (user_id, asset, amount, pay_asset, pay_amount, rate, fee, payment_method, reference)
    values (me, v_recv_asset, v_recv, v_debit_asset, v_debit, (i ->> 'rate')::numeric, (i ->> 'fee')::numeric, i ->> 'payMethod', ref);
    insert into platform_fees (source, amount_ngn, reference) values ('BUY', (i ->> 'fee')::numeric, ref);

  elsif p_action = 'sell' then
    ref := _ref('SEL');
    v_status := case when i ->> 'method' = 'BANK' then 'PENDING' else 'COMPLETED' end;
    perform _debit(me, v_debit_asset, v_debit);
    perform _record_tx(me, 'SELL', 'OUT', v_debit_asset, v_debit, v_value, ref, 'Sold ' || v_debit_asset || ' → ' || (i ->> 'dest'),
                       v_status, null, null, (i ->> 'fee')::numeric, 'NGN', v_status = 'PENDING', jsonb_build_object('receive', q #>> '{receive,label}'));
    if v_status = 'COMPLETED' then
      perform _credit(me, v_recv_asset, v_recv);
      perform _record_tx(me, 'SELL', 'IN', v_recv_asset, v_recv, v_value - (i ->> 'fee')::numeric, ref, 'Proceeds from ' || v_debit_asset || ' sale');
    end if;
    insert into sell_transactions (user_id, asset, amount, receive_method, receive_asset, receive_amount, rate, fee, bank_name, account_number, account_name, status, reference)
    values (me, v_debit_asset, v_debit, i ->> 'method', v_recv_asset, v_recv, (i ->> 'rate')::numeric, (i ->> 'fee')::numeric,
            i #>> '{bank,bankName}', i #>> '{bank,accountNumber}', i #>> '{bank,accountName}', v_status, ref);
    insert into platform_fees (source, amount_ngn, reference) values ('SELL', (i ->> 'fee')::numeric, ref);

  elsif p_action = 'swap' then
    ref := _ref('SWP');
    perform _debit(me, v_debit_asset, v_debit);
    perform _credit(me, v_recv_asset, v_recv);
    perform _record_tx(me, 'SWAP', 'OUT', v_debit_asset, v_debit, v_value, ref, 'Swapped ' || v_debit_asset || ' → ' || v_recv_asset,
                       'COMPLETED', i ->> 'network', null, (i ->> 'netFee')::numeric + (i ->> 'platFee')::numeric, v_debit_asset);
    perform _record_tx(me, 'SWAP', 'IN', v_recv_asset, v_recv, v_value, ref, 'Swapped ' || v_debit_asset || ' → ' || v_recv_asset, 'COMPLETED', i ->> 'network');
    insert into swaps (user_id, from_asset, to_asset, from_amount, to_amount, rate, network_fee, platform_fee, network, reference)
    values (me, v_debit_asset, v_recv_asset, v_debit, v_recv, (i ->> 'rate')::numeric, (i ->> 'netFee')::numeric, (i ->> 'platFee')::numeric, i ->> 'network', ref);
    insert into platform_fees (source, amount_ngn, reference) values ('SWAP', (i ->> 'platFeeNgn')::numeric, ref);

  elsif p_action = 'send' then
    ref := _ref('SND'); v_status := 'PENDING';
    perform _debit(me, v_debit_asset, v_debit);                 -- amount + network fee
    perform _record_tx(me, 'TRANSFER', 'OUT', v_debit_asset, v_recv, v_value, ref,
      'Sent ' || v_debit_asset || coalesce(' to @' || (i #>> '{internal,username}'), ''), 'PENDING', i ->> 'network',
      coalesce('@' || (i #>> '{internal,username}'), i ->> 'address'), (i ->> 'fee')::numeric, v_debit_asset, true,
      jsonb_build_object('address', i ->> 'address', 'simulated', true, 'txHash', null,
                         'internalRecipientId', i #>> '{internal,userId}', 'sender', me_name));

  elsif p_action = 'transfer' then
    ref := _ref('TRF');
    v_to := (i ->> 'toId')::uuid; v_to_name := i ->> 'toUsername';
    perform _ensure_wallet(v_to);
    perform _debit(me, v_debit_asset, v_debit);
    perform _credit(v_to, v_debit_asset, v_debit);
    perform _record_tx(me, 'TRANSFER', 'OUT', v_debit_asset, v_debit, v_value, ref, 'Transfer to @' || v_to_name, 'COMPLETED', 'KAMKAM',
                       '@' || v_to_name, 0, null, false, jsonb_build_object('note', i ->> 'note'));
    perform _record_tx(v_to, 'TRANSFER', 'IN', v_debit_asset, v_debit, v_value, ref, 'Transfer from @' || me_name, 'COMPLETED', 'KAMKAM',
                       '@' || me_name, 0, null, false, jsonb_build_object('note', i ->> 'note'));
    perform _notify(v_to, me, 'TRANSACTION_COMPLETED', '@' || me_name || ' sent you ' || _fmt_qty(v_debit_asset, v_debit),
      coalesce('"' || (i ->> 'note') || '"', 'The transfer has been added to your KAMKAM wallet.'), '+' || _fmt_qty(v_debit_asset, v_debit));

  elsif p_action = 'withdraw' then
    ref := _ref('WDR'); v_status := 'PENDING';
    if (i ->> 'fromEarnings')::boolean then perform _debit_earnings(me, v_debit); else perform _debit(me, v_debit_asset, v_debit); end if;
    insert into withdrawals (user_id, source, method, asset, amount, value_ngn, fee, network, address, bank_name, account_number, account_name, reference)
    values (me, case when (i ->> 'fromEarnings')::boolean then 'EARNINGS' else 'WALLET' end, i ->> 'method', v_recv_asset, v_recv, v_value,
            (i ->> 'fee')::numeric, case when i ->> 'method' = 'EXTERNAL_WALLET' then i ->> 'network' end,
            case when i ->> 'method' = 'EXTERNAL_WALLET' then i ->> 'address' end,
            i #>> '{bank,bankName}', i #>> '{bank,accountNumber}', i #>> '{bank,accountName}', ref);
    perform _record_tx(me, 'WITHDRAWAL',
      case when i ->> 'method' = 'KAMKAM_WALLET' then 'IN' else 'OUT' end,
      case when i ->> 'method' = 'KAMKAM_WALLET' then v_recv_asset else v_debit_asset end,
      case when i ->> 'method' = 'KAMKAM_WALLET' then v_recv else v_debit end,
      v_value, ref,
      case when (i ->> 'fromEarnings')::boolean then 'Earnings withdrawal → ' else 'Withdrawal → ' end || (i ->> 'dest'),
      'PENDING', i ->> 'network', i ->> 'dest', (i ->> 'fee')::numeric, i ->> 'feeAsset', true,
      jsonb_build_object('method', i ->> 'method', 'source', case when (i ->> 'fromEarnings')::boolean then 'EARNINGS' else 'WALLET' end,
                         'receiveAsset', v_recv_asset, 'receiveAmount', v_recv::text));
  else
    perform raise_app_error('NOT_FOUND', 'Unknown wallet action.');
  end if;

  v_result := jsonb_build_object('reference', ref, 'status', v_status, 'quote', q - '_', 'simulated', true);
  update idempotency_keys set result = v_result where user_id = me and key = p_idempotency_key;
  return v_result;
end $$;

-- ═════════════════════════════ GIFTS ═══════════════════════════════
create or replace function public._gift_calc(p jsonb, p_sender uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric; v_raw text := replace(btrim(coalesce(p ->> 'amountNgn', '')), ',', ''); a assets; post posts; v_recipient uuid; w wallets;
  v_pay numeric; v_creator numeric; v_min numeric := (_cfg('gift_min_ngn') #>> '{}')::numeric; v_max numeric := (_cfg('gift_max_ngn') #>> '{}')::numeric;
begin
  if v_raw !~ '^\d+$' then perform raise_app_error('VALIDATION', 'Gift must be a whole Naira amount.'); end if;
  v_amount := v_raw::numeric;
  if v_amount < v_min or v_amount > v_max then
    perform raise_app_error('VALIDATION', 'Gift must be between ' || _fmt_ngn(v_min) || ' and ' || _fmt_ngn(v_max) || '.');
  end if;
  a := _asset(p ->> 'payAsset');
  if nullif(p ->> 'postId', '') is not null then
    select * into post from posts where id = (p ->> 'postId')::uuid;
    if post.id is null then perform raise_app_error('POST_NOT_FOUND', 'Post not found.'); end if;
    v_recipient := post.author_id;
  else
    select id into v_recipient from profiles where id = nullif(p ->> 'recipientId', '')::uuid;
    if v_recipient is null then perform raise_app_error('USER_NOT_FOUND', 'Creator not found.'); end if;
  end if;
  if v_recipient = p_sender then perform raise_app_error('SELF_GIFT', 'You can''t gift yourself.'); end if;
  w := _ensure_wallet(p_sender);
  if a.is_crypto and not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet to pay with crypto.'); end if;
  v_pay := case when a.symbol = 'NGN' then v_amount else _round_up(v_amount / a.rate_ngn, a.precision) end;
  v_creator := _ngn(v_amount * (_cfg('creator_share') #>> '{}')::numeric);
  return jsonb_build_object('amountNgn', v_amount, 'payAsset', a.symbol, 'rateNgn', a.rate_ngn, 'payAmount', v_pay,
    'creatorAmountNgn', v_creator, 'platformFeeNgn', v_amount - v_creator, 'recipientId', v_recipient, 'postId', post.id,
    'network', case when a.is_crypto then p ->> 'network' end);
end $$;

create or replace function public.gift_quote(p_params jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); c jsonb; bal numeric;
begin
  perform _require_demo_mode();
  c := _gift_calc(p_params, me);
  bal := _balance(me, c ->> 'payAsset');
  return jsonb_build_object(
    'amountNgn', (c ->> 'amountNgn'), 'payAsset', c ->> 'payAsset', 'rateNgn', c ->> 'rateNgn',
    'payAmount', c ->> 'payAmount', 'payLabel', _fmt_qty(c ->> 'payAsset', (c ->> 'payAmount')::numeric),
    'creatorAmountNgn', c ->> 'creatorAmountNgn', 'platformFeeNgn', c ->> 'platformFeeNgn',
    'balance', bal::text, 'balanceLabel', _fmt_qty(c ->> 'payAsset', bal),
    'sufficient', bal >= (c ->> 'payAmount')::numeric, 'simulated', true);
end $$;

-- Atomic gift: debit · gift · like + super like · counters & boost ·
-- 80% creator earning · 20% platform fee · ledger both sides · notification
create or replace function public.send_gift(p_params jsonb, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := _uid(); prev jsonb; c jsonb; v_gift gifts; ref text; v_post uuid; v_recipient uuid; v_like likes;
  v_amount numeric; v_pay numeric; v_creator numeric; v_fee numeric; v_asset text; me_name text; rcp_name text; conv uuid; v_result jsonb;
begin
  perform _require_demo_mode();
  prev := _idempotent_begin(me, p_idempotency_key, 'gift');
  if prev is not null then return prev; end if;
  perform _rate_limit_money(me);

  c := _gift_calc(p_params, me);
  v_amount := (c ->> 'amountNgn')::numeric; v_pay := (c ->> 'payAmount')::numeric; v_asset := c ->> 'payAsset';
  v_creator := (c ->> 'creatorAmountNgn')::numeric; v_fee := (c ->> 'platformFeeNgn')::numeric;
  v_post := nullif(c ->> 'postId', '')::uuid; v_recipient := (c ->> 'recipientId')::uuid;
  select username into me_name from profiles where id = me;
  select username into rcp_name from profiles where id = v_recipient;
  perform _ensure_wallet(v_recipient);
  ref := _ref('GFT');

  -- 1. debit sender (fails atomically if insufficient)
  perform _debit(me, v_asset, v_pay);

  -- 2. gift record
  insert into gifts (sender_id, recipient_id, post_id, amount_ngn, pay_asset, pay_amount, rate_ngn, creator_amount_ngn, platform_fee_ngn, network, reference, idempotency_key)
  values (me, v_recipient, v_post, v_amount, v_asset, v_pay, (c ->> 'rateNgn')::numeric, v_creator, v_fee, c ->> 'network', ref, p_idempotency_key)
  returning * into v_gift;

  -- 3-6. auto like + super like, gift count, earnings on post, 24h boost
  if v_post is not null then
    select * into v_like from likes where user_id = me and post_id = v_post;
    if v_like.user_id is null then insert into likes (user_id, post_id, super_like) values (me, v_post, true);
    elsif not v_like.super_like then update likes set super_like = true where user_id = me and post_id = v_post; end if;
    update posts set gift_count = gift_count + 1, earned_ngn = earned_ngn + v_creator, boosted_until = now() + interval '24 hours' where id = v_post;
  end if;
  update profiles set gifts_received_count = gifts_received_count + 1 where id = v_recipient;

  -- 7. creator earnings (80%)
  insert into creator_earnings (user_id, gift_id, amount_ngn, source_asset) values (v_recipient, v_gift.id, v_creator, v_asset);
  update wallets set earnings_available = earnings_available + v_creator where user_id = v_recipient;

  -- 8. platform fee (20%)
  insert into platform_fees (source, amount_ngn, reference, gift_id) values ('GIFT', v_fee, ref, v_gift.id);

  -- 10. ledger, both sides
  perform _record_tx(me, 'GIFT_SENT', 'OUT', v_asset, v_pay, v_amount, ref, 'Gift sent to @' || rcp_name, 'COMPLETED',
    case when v_asset = 'NGN' then 'Naira' else coalesce(c ->> 'network', 'KAMKAM') end, '@' || rcp_name, 0, null, false,
    jsonb_build_object('giftId', v_gift.id, 'postId', v_post, 'giftValueNgn', v_amount::text));
  perform _record_tx(v_recipient, 'GIFT_RECEIVED', 'IN', 'NGN', v_creator, v_creator, ref, 'Gift received from @' || me_name, 'COMPLETED',
    'Earnings', '@' || me_name, 0, null, false,
    jsonb_build_object('giftId', v_gift.id, 'postId', v_post, 'giftValueNgn', v_amount::text, 'paidWith', v_asset, 'toEarnings', true));

  -- 9. notify the creator
  perform _notify(v_recipient, me, 'GIFT_RECEIVED', '🎁 @' || me_name || ' sent you a ' || _fmt_ngn(v_amount) || ' Gift.',
    'You earned ' || _fmt_ngn(v_creator) || '.' || case when v_post is not null then ' Your post received a Super Like.' else '' end,
    '+' || _fmt_ngn(v_creator), v_post);

  -- Gift receipt inside an existing DM thread
  select a.conversation_id into conv from conversation_members a join conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = me and b.user_id = v_recipient limit 1;
  if conv is not null then
    insert into messages (conversation_id, sender_id, kind, body, meta)
    values (conv, me, 'GIFT', 'Gift sent · ' || _fmt_ngn(v_amount), jsonb_build_object('creatorAmountNgn', v_creator::text));
  end if;

  v_result := jsonb_build_object(
    'gift', jsonb_build_object('id', v_gift.id, 'reference', ref, 'amountNgn', v_amount::text, 'payAsset', v_asset, 'payAmount', v_pay::text,
      'payLabel', _fmt_qty(v_asset, v_pay), 'creatorAmountNgn', v_creator::text, 'platformFeeNgn', v_fee::text, 'recipient', '@' || rcp_name, 'simulated', true),
    'postId', v_post);
  update idempotency_keys set result = v_result where user_id = me and key = p_idempotency_key;
  return v_result;
end $$;

create or replace function public.gift_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('tiers', _cfg('gift_tiers_ngn'), 'creatorShare', _cfg('creator_share') #>> '{}',
                            'walletMode', _cfg('wallet_mode') #>> '{}')
$$;

-- ═══════════════════════════ ACTIVATION ════════════════════════════
-- The recovery phrase is generated in the browser and is NEVER sent here.
create or replace function public.activate_wallet()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); w wallets;
begin
  perform _require_demo_mode();
  w := _ensure_wallet(me);
  if not w.crypto_activated then
    update wallets set crypto_activated = true where user_id = me;
    perform _grant_starter(me, _cfg('starter_crypto'));
  end if;
  return wallet_summary();
end $$;

-- ═══════════════════════════ SETTLEMENT ════════════════════════════
-- Simulated settlement: PENDING → PROCESSING → COMPLETED based on age.
-- Called lazily by clients (settle_due) and, if pg_cron is enabled, every minute.
create or replace function public._settle(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  t wallet_transactions; wd withdrawals; n int := 0; meta jsonb; rid uuid;
  proc_s int := coalesce((_cfg('settlement') ->> 'processing_after_s')::int, 4);
  done_s int := coalesce((_cfg('settlement') ->> 'complete_after_s')::int, 6);
begin
  for t in select * from wallet_transactions
           where auto_settle and status = 'PENDING' and status_changed_at < now() - make_interval(secs => proc_s)
             and (p_user is null or user_id = p_user or metadata ->> 'internalRecipientId' = p_user::text)
           order by created_at for update skip locked loop
    update wallet_transactions set status = 'PROCESSING', status_changed_at = now() where id = t.id;
    update withdrawals set status = 'PROCESSING' where reference = t.reference and status = 'PENDING';
    update sell_transactions set status = 'PROCESSING' where reference = t.reference and status = 'PENDING';
    n := n + 1;
  end loop;

  for t in select * from wallet_transactions
           where auto_settle and status = 'PROCESSING' and status_changed_at < now() - make_interval(secs => done_s)
             and (p_user is null or user_id = p_user or metadata ->> 'internalRecipientId' = p_user::text)
           order by created_at for update skip locked loop
    update wallet_transactions set status = 'COMPLETED', status_changed_at = now(), completed_at = now() where id = t.id;
    meta := t.metadata;
    if t.type = 'WITHDRAWAL' then
      update withdrawals set status = 'COMPLETED', completed_at = now() where reference = t.reference returning * into wd;
      if wd.method = 'KAMKAM_WALLET' then perform _credit(t.user_id, wd.asset, wd.amount); end if;
      perform _notify(t.user_id, null, 'WITHDRAWAL_COMPLETED', 'Withdrawal completed',
        _fmt_qty(wd.asset, wd.amount) || case when wd.method = 'BANK' then ' sent to ' else ' delivered to ' end || coalesce(t.counterparty, '') || '. Demo transaction — simulated.',
        _fmt_qty(wd.asset, wd.amount));
    elsif t.type = 'SELL' then
      update sell_transactions set status = 'COMPLETED' where reference = t.reference;
      perform _notify(t.user_id, null, 'TRANSACTION_COMPLETED', 'Sale payout completed',
        coalesce(meta ->> 'receive', '') || ' paid out to your bank. Demo transaction — simulated.');
    elsif t.type = 'TRANSFER' and t.direction = 'OUT' then
      rid := nullif(meta ->> 'internalRecipientId', '')::uuid;
      if rid is not null then
        perform _ensure_wallet(rid);
        perform _credit(rid, t.asset, t.amount);
        perform _record_tx(rid, 'TRANSFER', 'IN', t.asset, t.amount, t.value_ngn, t.reference, 'Received ' || t.asset, 'COMPLETED',
                           t.network, '@' || coalesce(meta ->> 'sender', ''));
        perform _notify(rid, t.user_id, 'TRANSACTION_COMPLETED', 'You received ' || _fmt_qty(t.asset, t.amount),
          'From @' || coalesce(meta ->> 'sender', '') || ' on ' || coalesce(t.network, '') || '. Demo transaction — simulated.', '+' || _fmt_qty(t.asset, t.amount));
      end if;
      perform _notify(t.user_id, null, 'TRANSACTION_COMPLETED', 'Transaction completed',
        _fmt_qty(t.asset, t.amount) || ' sent on ' || coalesce(t.network, '') || '. Demo transaction — nothing was broadcast.');
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.settle_due()
returns int language plpgsql security definer set search_path = public as $$
begin
  return _settle(_uid());
end $$;

-- ═════════════════════════════ READS ═══════════════════════════════
create or replace function public.wallet_summary()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); w wallets; assets_json jsonb; avail numeric; pending numeric;
begin
  w := _ensure_wallet(me);
  select coalesce(jsonb_agg(jsonb_build_object(
      'symbol', a.symbol, 'name', a.name, 'crypto', a.is_crypto,
      'networks', coalesce((select jsonb_agg(network order by n.sort) from asset_networks an join networks n on n.name = an.network where an.asset = a.symbol), '[]'::jsonb),
      'balance', coalesce(wa.balance, 0)::text, 'balanceLabel', _fmt_qty(a.symbol, coalesce(wa.balance, 0)),
      'valueNgn', round(coalesce(wa.balance, 0) * a.rate_ngn, 2)::text, 'rateNgn', a.rate_ngn::text) order by a.sort), '[]'::jsonb),
         coalesce(sum(round(coalesce(wa.balance, 0) * a.rate_ngn, 2)), 0)
    into assets_json, avail
  from assets a left join wallet_assets wa on wa.symbol = a.symbol and wa.user_id = me;
  select coalesce(sum(value_ngn), 0) into pending from wallet_transactions
  where user_id = me and status in ('PENDING', 'PROCESSING') and direction = 'OUT';
  return jsonb_build_object(
    'cryptoActivated', w.crypto_activated, 'assets', assets_json,
    'availableNgn', avail::text, 'earningsAvailable', w.earnings_available::text, 'pendingNgn', pending::text,
    'totalNgn', (avail + w.earnings_available + pending)::text,
    'addresses', case when w.crypto_activated then w.demo_addresses else '{}'::jsonb end,
    'networks', (select jsonb_agg(jsonb_build_object('name', name, 'family', family, 'feeNgn', fee_ngn) order by sort) from networks),
    'priceSource', 'demo', 'chainMode', 'simulated', 'walletMode', _cfg('wallet_mode') #>> '{}');
end $$;

create or replace function public._tx_json(t public.wallet_transactions)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'type', t.type, 'direction', t.direction, 'asset', t.asset, 'amount', t.amount::text,
    'amountLabel', case when t.direction = 'IN' then '+' else '−' end || _fmt_qty(t.asset, t.amount),
    'valueNgn', t.value_ngn::text, 'valueLabel', _fmt_ngn(t.value_ngn), 'fee', t.fee::text,
    'feeLabel', case when t.fee > 0 and t.fee_asset is not null then _fmt_qty(t.fee_asset, t.fee) end,
    'status', t.status, 'reference', t.reference, 'network', t.network, 'counterparty', t.counterparty,
    'description', t.description, 'simulated', t.simulated, 'createdAt', t.created_at, 'completedAt', t.completed_at)
$$;

create or replace function public.wallet_transactions_list(p_filter text default 'all', p_limit int default 60)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('transactions', coalesce(jsonb_agg(_tx_json(t) order by t.created_at desc), '[]'::jsonb))
  from (select * from wallet_transactions t
        where t.user_id = _uid()
          and case lower(coalesce(p_filter, 'all'))
            when 'received' then t.type = 'TRANSFER' and t.direction = 'IN'
            when 'sent' then t.type = 'TRANSFER' and t.direction = 'OUT'
            when 'transfers' then t.type = 'TRANSFER'
            when 'swaps' then t.type = 'SWAP'
            when 'gifts' then t.type in ('GIFT_SENT', 'GIFT_RECEIVED')
            when 'deposits' then t.type = 'DEPOSIT'
            when 'withdrawals' then t.type = 'WITHDRAWAL'
            when 'buys' then t.type = 'BUY'
            when 'sells' then t.type = 'SELL'
            else true end
        order by t.created_at desc limit least(greatest(coalesce(p_limit, 60), 1), 200)) t
$$;

create or replace function public.transaction_by_reference(p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); r jsonb;
begin
  perform _settle(me);   -- advance simulated settlement for this user
  select jsonb_build_object('reference', p_reference, 'status', (array_agg(t.status order by t.created_at))[1],
                            'transactions', jsonb_agg(_tx_json(t) order by t.created_at))
    into r from wallet_transactions t where t.user_id = me and t.reference = p_reference;
  if r ->> 'status' is null then perform raise_app_error('TX_NOT_FOUND', 'Transaction not found.'); end if;
  return r;
end $$;

create or replace function public.receive_address(p_network text, p_asset text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); w wallets;
begin
  w := _ensure_wallet(me);
  if not w.crypto_activated then perform raise_app_error('WALLET_NOT_ACTIVATED', 'Create your KAMKAM wallet first.'); end if;
  if not exists (select 1 from asset_networks where asset = upper(p_asset) and network = p_network) then
    perform raise_app_error('INVALID_NETWORK', upper(p_asset) || ' is not supported on ' || p_network || '.');
  end if;
  return jsonb_build_object('network', p_network, 'asset', upper(p_asset), 'address', w.demo_addresses ->> p_network, 'demo', true,
                            'note', 'Demo address — not derived from a real key. Do not send real funds.');
end $$;

create or replace function public.gifts_list(p_direction text default 'sent')
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('gifts', coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'reference', g.reference, 'createdAt', g.created_at,
      'amountNgn', g.amount_ngn::text, 'valueLabel', _fmt_ngn(g.amount_ngn),
      'payAsset', g.pay_asset, 'payLabel', _fmt_qty(g.pay_asset, g.pay_amount),
      'creatorAmountNgn', g.creator_amount_ngn::text, 'creatorLabel', _fmt_ngn(g.creator_amount_ngn), 'platformFeeLabel', _fmt_ngn(g.platform_fee_ngn),
      'sender', (select author_json(p) from profiles p where p.id = g.sender_id),
      'recipient', (select author_json(p) from profiles p where p.id = g.recipient_id),
      'post', (select jsonb_build_object('id', p.id, 'text', p.text) from posts p where p.id = g.post_id),
      'status', 'COMPLETED') order by g.created_at desc), '[]'::jsonb))
  from (select * from gifts
        where (p_direction = 'received' and recipient_id = _uid()) or (p_direction <> 'received' and sender_id = _uid())
        order by created_at desc limit 100) g
$$;

create or replace function public.earnings_summary()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := _uid(); w wallets;
  month_start timestamptz := date_trunc('month', now()); prev_start timestamptz := date_trunc('month', now()) - interval '1 month';
  v_total numeric; v_month numeric; v_prev numeric; v_delta text;
begin
  w := _ensure_wallet(me);
  select coalesce(sum(amount_ngn), 0) into v_total from creator_earnings where user_id = me;
  select coalesce(sum(amount_ngn), 0) into v_month from creator_earnings where user_id = me and created_at >= month_start;
  select coalesce(sum(amount_ngn), 0) into v_prev from creator_earnings where user_id = me and created_at >= prev_start and created_at < month_start;
  v_delta := case when v_prev > 0 then
      case when v_month >= v_prev then '+' else '' end || round((v_month - v_prev) * 100 / v_prev) || '% vs last month'
    else 'This calendar month' end;
  return jsonb_build_object(
    'availableNgn', w.earnings_available::text, 'totalEarnedNgn', v_total::text, 'thisMonthNgn', v_month::text, 'monthDelta', v_delta,
    'totalGifts', (select count(*) from gifts where recipient_id = me),
    'supporters', (select count(distinct sender_id) from gifts where recipient_id = me),
    'byAsset', coalesce((select jsonb_agg(jsonb_build_object('asset', pay_asset, 'count', cnt, 'paidLabel', _fmt_qty(pay_asset, paid), 'creatorNgn', creator::text) order by cnt desc)
      from (select pay_asset, count(*) cnt, sum(pay_amount) paid, sum(creator_amount_ngn) creator from gifts where recipient_id = me group by pay_asset) x), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'createdAt', e.created_at, 'amountNgn', e.amount_ngn::text, 'amountLabel', '+' || _fmt_ngn(e.amount_ngn),
        'giftLabel', _fmt_ngn(g.amount_ngn), 'sourceAsset', e.source_asset, 'paidLabel', _fmt_qty(g.pay_asset, g.pay_amount),
        'from', (select author_json(p) from profiles p where p.id = g.sender_id),
        'post', (select jsonb_build_object('id', p.id, 'text', p.text) from posts p where p.id = g.post_id),
        'reference', g.reference) order by e.created_at desc)
      from (select * from creator_earnings where user_id = me order by created_at desc limit 50) e join gifts g on g.id = e.gift_id), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'method', x.method, 'asset', x.asset, 'amountLabel', _fmt_qty(x.asset, x.amount), 'valueLabel', _fmt_ngn(x.value_ngn),
        'status', x.status, 'reference', x.reference, 'createdAt', x.created_at, 'completedAt', x.completed_at) order by x.created_at desc)
      from (select * from withdrawals where user_id = me and source = 'EARNINGS' order by created_at desc limit 20) x), '[]'::jsonb));
end $$;

-- Wallet security preferences (stored on the profile; no secrets)
create or replace function public.update_wallet_security(p_key text, p_value boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); r jsonb;
begin
  if p_key not in ('biometric', 'txConfirm', 'pin') then perform raise_app_error('VALIDATION', 'Unknown setting.'); end if;
  update profiles set wallet_security = wallet_security || jsonb_build_object(p_key, p_value) where id = me returning wallet_security into r;
  return r;
end $$;

-- ===== 20261016000500_rls.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 005 · Privileges & Row Level Security
-- Principle: deny by default, then grant the minimum per table/column.
-- ════════════════════════════════════════════════════════════════════

-- 0. Start from zero (Supabase grants broad defaults to anon/authenticated)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Size guard for user-controlled JSON
alter table public.profiles add constraint profiles_settings_size check (pg_column_size(settings) < 4000);

-- 1. Enable RLS on every table
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ── Reference data (read-only) ─────────────────────────────────────
grant select on public.assets, public.networks, public.asset_networks to anon, authenticated;
create policy "reference: read" on public.assets for select using (true);
create policy "reference: read" on public.networks for select using (true);
create policy "reference: read" on public.asset_networks for select using (true);
-- app_config is read through gift_config()/wallet_summary() only.

-- ── Profiles ───────────────────────────────────────────────────────
grant select on public.profiles to authenticated;
grant update (display_name, bio, avatar_path, cover_path, location, website, settings) on public.profiles to authenticated;
create policy "profiles: read" on public.profiles for select to authenticated using (true);
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ── Posts & media & polls ──────────────────────────────────────────
grant select on public.posts to authenticated;
grant insert (author_id, text, reply_policy, has_poll) on public.posts to authenticated;
grant update (text, reply_policy) on public.posts to authenticated;
grant delete on public.posts to authenticated;
create policy "posts: read" on public.posts for select to authenticated using (true);
create policy "posts: create own" on public.posts for insert to authenticated with check (author_id = auth.uid());
create policy "posts: edit own" on public.posts for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "posts: delete own" on public.posts for delete to authenticated using (author_id = auth.uid());

grant select on public.post_media to authenticated;
grant insert (post_id, path, kind, position) on public.post_media to authenticated;
create policy "post_media: read" on public.post_media for select to authenticated using (true);
create policy "post_media: add to own post from own folder" on public.post_media for insert to authenticated
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
    and path like 'post-media/' || auth.uid()::text || '/%');

grant select on public.poll_options to authenticated;
grant insert (post_id, position, label) on public.poll_options to authenticated;
create policy "poll_options: read" on public.poll_options for select to authenticated using (true);
create policy "poll_options: add to own poll" on public.poll_options for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid() and p.has_poll));

grant select, insert (post_id, option_id, user_id) on public.poll_votes to authenticated;
create policy "poll_votes: read own" on public.poll_votes for select to authenticated using (user_id = auth.uid());
create policy "poll_votes: vote as self" on public.poll_votes for insert to authenticated with check (user_id = auth.uid());

-- ── Comments ───────────────────────────────────────────────────────
grant select, delete on public.comments to authenticated;
grant insert (post_id, parent_id, text, author_id) on public.comments to authenticated;
create policy "comments: read" on public.comments for select to authenticated using (true);
create policy "comments: create as self" on public.comments for insert to authenticated with check (author_id = auth.uid());
create policy "comments: delete own" on public.comments for delete to authenticated using (author_id = auth.uid());

-- ── Likes / reposts / bookmarks (super_like can only be set by send_gift) ──
grant select, delete on public.likes to authenticated;
grant insert (user_id, post_id) on public.likes to authenticated;
create policy "likes: read own" on public.likes for select to authenticated using (user_id = auth.uid());
create policy "likes: like as self" on public.likes for insert to authenticated with check (user_id = auth.uid() and super_like = false);
create policy "likes: unlike own" on public.likes for delete to authenticated using (user_id = auth.uid());

grant select, delete on public.reposts to authenticated;
grant insert (user_id, post_id) on public.reposts to authenticated;
create policy "reposts: read own" on public.reposts for select to authenticated using (user_id = auth.uid());
create policy "reposts: repost as self" on public.reposts for insert to authenticated with check (user_id = auth.uid());
create policy "reposts: undo own" on public.reposts for delete to authenticated using (user_id = auth.uid());

grant select, delete on public.bookmarks to authenticated;
grant insert (user_id, post_id) on public.bookmarks to authenticated;
create policy "bookmarks: own only" on public.bookmarks for select to authenticated using (user_id = auth.uid());
create policy "bookmarks: add own" on public.bookmarks for insert to authenticated with check (user_id = auth.uid());
create policy "bookmarks: remove own" on public.bookmarks for delete to authenticated using (user_id = auth.uid());

-- ── Follows (public graph) ─────────────────────────────────────────
grant select, delete on public.follows to authenticated;
grant insert (follower_id, following_id) on public.follows to authenticated;
create policy "follows: read" on public.follows for select to authenticated using (true);
create policy "follows: follow as self" on public.follows for insert to authenticated with check (follower_id = auth.uid());
create policy "follows: unfollow own" on public.follows for delete to authenticated using (follower_id = auth.uid());

-- ── Stories ────────────────────────────────────────────────────────
grant select, delete on public.stories to authenticated;
grant insert (author_id, text, media_path, media_kind) on public.stories to authenticated;
create policy "stories: read active" on public.stories for select to authenticated using (expires_at > now() or author_id = auth.uid());
create policy "stories: post own" on public.stories for insert to authenticated
  with check (author_id = auth.uid() and (media_path is null or media_path like 'post-media/' || auth.uid()::text || '/%'));
create policy "stories: delete own" on public.stories for delete to authenticated using (author_id = auth.uid());

-- ── Communities ────────────────────────────────────────────────────
grant select on public.communities to authenticated;
grant insert (name, description, color, created_by) on public.communities to authenticated;
grant delete on public.communities to authenticated;
create policy "communities: read" on public.communities for select to authenticated using (true);
create policy "communities: create as self" on public.communities for insert to authenticated with check (created_by = auth.uid());
create policy "communities: delete own" on public.communities for delete to authenticated using (created_by = auth.uid());

grant select, delete on public.community_members to authenticated;
grant insert (community_id, user_id) on public.community_members to authenticated;
create policy "community_members: read" on public.community_members for select to authenticated using (true);
create policy "community_members: join as self" on public.community_members for insert to authenticated with check (user_id = auth.uid());
create policy "community_members: leave own" on public.community_members for delete to authenticated using (user_id = auth.uid());

-- ── Messaging (members only) ───────────────────────────────────────
grant select on public.conversations to authenticated;
create policy "conversations: members read" on public.conversations for select to authenticated
  using (public.is_conversation_member(id));

grant select on public.conversation_members to authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;
create policy "conversation_members: members read" on public.conversation_members for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy "conversation_members: mark own read" on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.messages to authenticated;
grant insert (conversation_id, sender_id, kind, body, attachment_path) on public.messages to authenticated;
create policy "messages: members read" on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy "messages: send as self to own conversation" on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and kind in ('TEXT', 'IMAGE', 'AUDIO')
    and public.is_conversation_member(conversation_id)
    and (attachment_path is null or attachment_path like 'message-attachments/' || conversation_id::text || '/' || auth.uid()::text || '/%'));

-- ── Notifications (created only by trusted code) ───────────────────
grant select, delete on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;
create policy "notifications: read own" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notifications: mark own read" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notifications: delete own" on public.notifications for delete to authenticated using (user_id = auth.uid());

-- ── Wallet & money: READ OWN ONLY. No client writes, ever. ─────────
grant select on public.wallets, public.wallet_assets, public.wallet_transactions, public.gifts, public.creator_earnings,
                public.withdrawals, public.deposits, public.swaps, public.buy_transactions, public.sell_transactions to authenticated;
create policy "wallets: read own" on public.wallets for select to authenticated using (user_id = auth.uid());
create policy "wallet_assets: read own" on public.wallet_assets for select to authenticated using (user_id = auth.uid());
create policy "wallet_transactions: read own" on public.wallet_transactions for select to authenticated using (user_id = auth.uid());
create policy "gifts: sender or recipient" on public.gifts for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "creator_earnings: read own" on public.creator_earnings for select to authenticated using (user_id = auth.uid());
create policy "withdrawals: read own" on public.withdrawals for select to authenticated using (user_id = auth.uid());
create policy "deposits: read own" on public.deposits for select to authenticated using (user_id = auth.uid());
create policy "swaps: read own" on public.swaps for select to authenticated using (user_id = auth.uid());
create policy "buys: read own" on public.buy_transactions for select to authenticated using (user_id = auth.uid());
create policy "sells: read own" on public.sell_transactions for select to authenticated using (user_id = auth.uid());
-- platform_fees, idempotency_keys, app_config: RLS on, no policies, no grants → no client access.

-- ── Function privileges ────────────────────────────────────────────
-- Public API (signed-in users)
grant execute on function
  public.raise_app_error(text, text), public.author_json(public.profiles), public.excerpt(text, int),
  public.poll_json(uuid), public.post_json(public.posts), public.is_conversation_member(uuid, uuid),
  public.unread_message_count(),
  public.feed(text, int, int), public.post_detail(uuid), public.user_posts(uuid, text), public.comments_list(uuid),
  public.create_post(text, jsonb, text, jsonb), public.post_counts(uuid),
  public.profile_view(text), public.follow_list(uuid, text), public.suggested_users(int), public.search(text),
  public.trending(int), public.bookmarks_list(), public.gift_wall(uuid), public.stories_feed(), public.communities_list(),
  public.notifications_list(text), public.me(),
  public.start_conversation(uuid), public.conversations_list(), public.conversation_view(uuid), public.mark_conversation_read(uuid),
  public.wallet_quote(text, jsonb), public.wallet_execute(text, jsonb, uuid),
  public.gift_quote(jsonb), public.send_gift(jsonb, uuid), public.gift_config(),
  public.activate_wallet(), public.settle_due(), public.wallet_summary(), public.wallet_transactions_list(text, int),
  public.transaction_by_reference(text), public.receive_address(text, text), public.gifts_list(text), public.earnings_summary(),
  public.update_wallet_security(text, boolean)
to authenticated;

-- Anonymous: only what the sign-up / landing screens need
grant execute on function public.username_available(text), public.gift_config(), public.raise_app_error(text, text) to anon;

-- Everything prefixed with "_" (ledger, credit/debit, settlement internals) stays private.

-- ===== 20261016000600_storage.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 006 · Storage buckets & policies
--   avatars              public  · 5 MB  · images      · <uid>/...
--   post-media           public  · 50 MB · image/video · <uid>/...
--   message-attachments  PRIVATE · 10 MB · image/audio · <conversation_id>/<uid>/...
-- Database columns store "<bucket>/<object path>".
-- ════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('post-media', 'post-media', true, 52428800,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']),
  ('message-attachments', 'message-attachments', false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'])
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;
grant execute on function public.try_uuid(text) to authenticated;

-- Public buckets: anyone may read via the public URL; only the owner writes in their own folder.
create policy "kamkam public media: owner read" on storage.objects for select to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner update" on storage.objects for update to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner delete" on storage.objects for delete to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);

-- Private DM attachments: only conversation members can read (via signed URLs);
-- a member may upload only into <conversation>/<own uid>/.
create policy "kamkam dm attachments: members read" on storage.objects for select to authenticated
  using (bucket_id = 'message-attachments'
         and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1])));
create policy "kamkam dm attachments: member upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'message-attachments'
              and (storage.foldername(name))[2] = auth.uid()::text
              and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1])));
create policy "kamkam dm attachments: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'message-attachments' and (storage.foldername(name))[2] = auth.uid()::text);

-- ===== 20261016000700_realtime_cron.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 007 · Realtime + scheduled settlement
-- Realtime respects RLS: users only receive rows their SELECT policy allows.
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages;
    alter publication supabase_realtime add table public.notifications;
  else
    raise notice 'supabase_realtime publication not found (not running on Supabase?) — skipped';
  end if;
end $$;

-- Optional: settle simulated withdrawals/sends every minute even when users are offline.
-- (Clients also trigger settlement lazily via settle_due().)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('kamkam-settle-demo-transactions', '* * * * *', 'select public._settle(null)');
  else
    raise notice 'pg_cron not available — relying on client-triggered settlement';
  end if;
exception when others then
  raise notice 'pg_cron not enabled (%): enable it in Supabase → Database → Extensions to settle while users are offline', sqlerrm;
end $$;

-- ===== 20261016000800_privacy_settings.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 008 · Enforce the Settings screen's privacy & notification toggles
--   settings.dms      = false (default) → only your followers can start a DM with you
--   settings.gifts    = false           → no gift notifications (gifts still arrive)
--   settings.mentions = true  (default) → replies to your COMMENTS notify only from people you follow
--                                        (comments on your own posts always notify)
--   settings.tips     = false           → supporter wall hidden (already in gift_wall)
-- ════════════════════════════════════════════════════════════════════

create or replace function public._notify(p_user uuid, p_actor uuid, p_type text, p_title text, p_body text,
                                          p_amount text default null, p_post uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb;
begin
  if p_user is null or (p_actor is not null and p_actor = p_user) then return; end if;
  select settings into st from profiles where id = p_user;
  if p_type = 'GIFT_RECEIVED' and coalesce((st ->> 'gifts')::boolean, true) = false then return; end if;

  insert into notifications (user_id, actor_id, type, title, body, amount_label, post_id)
  values (p_user, p_actor, p_type, p_title, coalesce(p_body, ''), p_amount, p_post);
end $$;
revoke execute on function public._notify(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.start_conversation(p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); conv uuid; open_dms boolean; target text;
begin
  if me is null then perform raise_app_error('UNAUTHENTICATED', 'You need to log in to do that.'); end if;
  if p_user = me then perform raise_app_error('INVALID_RECIPIENT', 'You cannot message yourself.'); end if;
  select coalesce((settings ->> 'dms')::boolean, false), username into open_dms, target from profiles where id = p_user;
  if target is null then perform raise_app_error('USER_NOT_FOUND', 'User not found.'); end if;
  select a.conversation_id into conv
  from conversation_members a join conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = me and b.user_id = p_user
    and (select count(*) from conversation_members c where c.conversation_id = a.conversation_id) = 2
  limit 1;
  if conv is not null then return conv; end if;   -- existing threads always stay open
  if not open_dms and not exists (select 1 from follows where follower_id = me and following_id = p_user) then
    perform raise_app_error('DMS_RESTRICTED', '@' || target || ' only accepts messages from their followers. Follow them first.');
  end if;
  insert into conversations default values returning id into conv;
  insert into conversation_members (conversation_id, user_id) values (conv, me), (conv, p_user);
  return conv;
end $$;
revoke execute on function public.start_conversation(uuid) from public, anon;
grant execute on function public.start_conversation(uuid) to authenticated;

-- Replies to someone's comment respect their "Mentions and replies" setting.
create or replace function public.tg_comments_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare p posts; actor text; parent_author uuid; only_following boolean;
begin
  if tg_op = 'INSERT' then
    update posts set comment_count = comment_count + 1 where id = new.post_id returning * into p;
    select display_name into actor from profiles where id = new.author_id;
    perform _notify(p.author_id, new.author_id, 'COMMENT', actor || ' replied to your post', '"' || excerpt(new.text) || '"', null, p.id);
    if new.parent_id is not null then
      select author_id into parent_author from comments where id = new.parent_id;
      select coalesce((settings ->> 'mentions')::boolean, true) into only_following from profiles where id = parent_author;
      if parent_author <> p.author_id
         and (not only_following or exists (select 1 from follows where follower_id = parent_author and following_id = new.author_id)) then
        perform _notify(parent_author, new.author_id, 'COMMENT', actor || ' replied to your comment', '"' || excerpt(new.text) || '"', null, p.id);
      end if;
    end if;
  else
    update posts set comment_count = (select count(*) from comments where post_id = old.post_id) where id = old.post_id;
  end if;
  return null;
end $$;

-- ===== 20261016000900_grants_fixups.sql =====
-- KAMKAM · 009 · Signed-in users may also check username availability
-- (found by the API end-to-end tests: authenticated callers got "permission denied").
grant execute on function public.username_available(text) to authenticated;

-- ===== 20261018000100_archive_demo_finance.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 010 · Retire the demo wallet (ARCHIVE, not delete)
--
-- Why: the previous wallet credited every new account with demo money
--   • handle_new_user → _grant_starter('NGN' 50,000)          ← the ₦50,000
--   • activate_wallet → _grant_starter(100 USDT, 0.25 BNB, 0.05 ETH, 3 SOL)
--     valued at FIXED demo rates (3 SOL × ₦240,000 = ₦720,000 …) ← the ₦750k-style totals
-- and every wallet action only changed database numbers. No real payment
-- provider or blockchain was ever connected, so NO balance in these tables
-- represents real money.
--
-- What this does (reversible — data is moved, not dropped):
--   1. snapshots every demo balance into demo_archive.balances_snapshot
--   2. moves all demo wallet/ledger/gift tables into schema demo_archive
--      (not exposed by the API; no client access)
--   3. archives gift/wallet notifications and gift receipts in DMs
--   4. resets counters that were produced by demo-money gifts
--      (gift counts, Super Likes, "earned" amounts, boosts)
--   5. removes the demo money functions (incl. the sign-up credit)
--
-- Review before running on production:  see docs/REAL_MONEY_SETUP.md §1.
-- ════════════════════════════════════════════════════════════════════

create schema if not exists demo_archive;
revoke all on schema demo_archive from public;
do $$ begin
  execute 'revoke all on schema demo_archive from anon, authenticated';
exception when undefined_object then null; end $$;

-- 1. Snapshot (for audit/support questions: "where did my ₦50,000 go?")
create table demo_archive.balances_snapshot as
  select wa.user_id, wa.symbol, wa.balance, w.earnings_available, w.crypto_activated, now() as archived_at
  from public.wallet_assets wa join public.wallets w on w.user_id = wa.user_id;

create table demo_archive.archive_log as
  select now() as archived_at,
         (select count(*) from public.wallets) as wallets,
         (select count(*) from public.wallet_transactions) as ledger_rows,
         (select count(*) from public.gifts) as gifts,
         (select coalesce(sum(balance), 0) from public.wallet_assets where symbol = 'NGN') as demo_ngn_total;

-- 2. Stop the demo settlement job (if pg_cron was enabled)
do $$ begin
  perform cron.unschedule('kamkam-settle-demo-transactions');
exception when others then null; end $$;

-- 3. Remove demo money functions (all overloads). Formatting helpers are kept.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any (array[
      '_cfg', '_fee', '_require_demo_mode', '_asset', '_round_up', '_round_down', '_fmt_qty', '_label', '_amount',
      '_b58', '_demo_addresses', '_valid_address', '_ensure_wallet', '_balance', '_credit', '_debit', '_debit_earnings',
      '_record_tx', '_grant_starter', '_idempotent_begin', '_rate_limit_money', '_bank', '_wallet_quote', 'wallet_quote',
      'wallet_execute', '_gift_calc', 'gift_quote', 'send_gift', 'gift_config', 'activate_wallet', '_settle', 'settle_due',
      'wallet_summary', '_tx_json', 'wallet_transactions_list', 'transaction_by_reference', 'receive_address',
      'gifts_list', 'earnings_summary'])
  loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
end $$;

-- 4. Move demo tables out of the public API
alter table public.wallet_transactions set schema demo_archive;
alter table public.wallet_assets       set schema demo_archive;
alter table public.creator_earnings    set schema demo_archive;
alter table public.platform_fees       set schema demo_archive;
alter table public.withdrawals         set schema demo_archive;
alter table public.deposits            set schema demo_archive;
alter table public.swaps               set schema demo_archive;
alter table public.buy_transactions    set schema demo_archive;
alter table public.sell_transactions   set schema demo_archive;
alter table public.idempotency_keys    set schema demo_archive;
alter table public.gifts               set schema demo_archive;
alter table public.wallets             set schema demo_archive;
alter table public.asset_networks      set schema demo_archive;
alter table public.networks            set schema demo_archive;
alter table public.assets              set schema demo_archive;
alter table public.app_config          set schema demo_archive;

-- 5. Archive notifications/messages that describe demo money
create table demo_archive.notifications as
  select * from public.notifications where type in ('GIFT_RECEIVED', 'WITHDRAWAL_COMPLETED', 'TRANSACTION_COMPLETED');
delete from public.notifications where type in ('GIFT_RECEIVED', 'WITHDRAWAL_COMPLETED', 'TRANSACTION_COMPLETED');

create table demo_archive.gift_messages as select * from public.messages where kind = 'GIFT';
delete from public.messages where kind = 'GIFT';

-- 6. Reset social counters that were produced by demo-money gifts
update public.likes set super_like = false where super_like;
update public.posts set gift_count = 0, super_like_count = 0, earned_ngn = 0, boosted_until = null
  where gift_count > 0 or super_like_count > 0 or earned_ngn > 0 or boosted_until is not null;
update public.profiles set gifts_received_count = 0 where gifts_received_count > 0;

-- ===== 20261018000200_real_finance.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 011 · Real-money ledger (NGN via Paystack) + crypto wallet records (CDP)
--
-- Principles
--  • New users start at ₦0. Nothing is ever credited without a verified source.
--  • Every balance change = exactly one ledger entry written in the same
--    transaction by _ledger(); entries are append-only.
--  • NGN enters ONLY through svc_payment_settle(), which the server calls after
--    verifying the payment with Paystack (webhook signature + /transaction/verify).
--  • NGN leaves ONLY through Paystack transfers (svc_withdrawal_*), with funds held
--    until Paystack reports success/failure.
--  • svc_* functions are executable by service_role only (Next.js server routes).
--  • Crypto balances are NOT stored here — they are read from the blockchain.
-- ════════════════════════════════════════════════════════════════════

create table public.app_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.app_settings (key, value) values
  ('creator_share', '0.8'),
  ('gift_tiers_ngn', '[200, 500, 2000, 3000]'),
  ('gift_min_ngn', '50'),
  ('gift_max_ngn', '1000000'),
  ('deposit_min_ngn', '100'),
  ('deposit_max_ngn', '1000000'),
  ('withdraw_min_ngn', '500'),
  ('withdraw_fee_ngn', '50'),
  ('withdraw_daily_max_ngn', '1000000'),
  ('transfer_max_ngn', '1000000');

create or replace function public._setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from app_settings where key = p_key
$$;
create or replace function public._setting_num(p_key text)
returns numeric language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::numeric from app_settings where key = p_key
$$;

-- ── NGN wallets & ledger ───────────────────────────────────────────
create table public.ngn_wallets (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    numeric(20, 2) not null default 0 check (balance >= 0),   -- spendable
  earnings   numeric(20, 2) not null default 0 check (earnings >= 0),  -- creator earnings (80% of gifts)
  held       numeric(20, 2) not null default 0 check (held >= 0),      -- withdrawals in flight
  updated_at timestamptz not null default now()
);

create table public.ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles (id) on delete set null,   -- null = KAMKAM platform account
  account       text not null check (account in ('balance', 'earnings', 'held', 'platform_revenue')),
  amount        numeric(20, 2) not null check (amount <> 0),
  balance_after numeric(20, 2),
  entry_type    text not null check (entry_type in (
                  'DEPOSIT', 'DEPOSIT_REVERSAL', 'GIFT_SENT', 'GIFT_RECEIVED', 'PLATFORM_FEE',
                  'TRANSFER_OUT', 'TRANSFER_IN', 'EARNINGS_TO_BALANCE_OUT', 'EARNINGS_TO_BALANCE_IN',
                  'WITHDRAWAL_HOLD', 'WITHDRAWAL_FUNDED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FEE',
                  'WITHDRAWAL_RELEASED', 'WITHDRAWAL_RETURNED')),
  reference     text not null,
  description   text not null,
  counterparty  text,
  payment_id    uuid,
  gift_id       uuid,
  withdrawal_id uuid,
  created_at    timestamptz not null default now(),
  -- platform rows never belong to a user; user rows keep their history (user_id nulled) if the account is deleted
  constraint ledger_platform_account check (account <> 'platform_revenue' or user_id is null)
);
create index ledger_user_created_idx on public.ledger_entries (user_id, created_at desc);
create index ledger_reference_idx on public.ledger_entries (reference);

create or replace function public.tg_ledger_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.user_id is null and old.user_id is not null
     and (new.id, new.account, new.amount, new.entry_type, new.reference) = (old.id, old.account, old.amount, old.entry_type, old.reference) then
    return new;   -- allowed: account deletion nulls the user reference (on delete set null)
  end if;
  raise exception 'ledger_entries are append-only' using errcode = '42501';
end $$;
create trigger ledger_append_only before update or delete on public.ledger_entries
  for each row execute function public.tg_ledger_append_only();

-- ── Payments (Paystack collections) ────────────────────────────────
create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  provider       text not null default 'paystack',
  reference      text not null unique,
  amount         numeric(20, 2) not null check (amount > 0),
  currency       text not null default 'NGN' check (currency = 'NGN'),
  channel        text,
  status         text not null default 'initialized'
                 check (status in ('initialized', 'pending', 'success', 'failed', 'abandoned', 'reversed')),
  credited       boolean not null default false,
  needs_review   boolean not null default false,
  failure_reason text,
  paid_at        timestamptz,
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index payments_user_created_idx on public.payments (user_id, created_at desc);

-- Each provider event is processed at most once
create table public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  event        text not null,
  event_key    text not null unique,       -- sha256 of the raw body
  reference    text,
  outcome      text,
  received_at  timestamptz not null default now()
);

-- ── Payouts (Paystack transfers) ───────────────────────────────────
create table public.bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  bank_code      text not null,
  bank_name      text not null,
  account_name   text not null,
  account_last4  text not null check (account_last4 ~ '^\d{4}$'),
  recipient_code text not null,
  created_at     timestamptz not null default now(),
  unique (user_id, recipient_code)
);

create table public.withdrawals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  source          text not null check (source in ('balance', 'earnings')),
  amount          numeric(20, 2) not null check (amount > 0),     -- debited from the user
  fee             numeric(20, 2) not null default 0 check (fee >= 0),
  payout          numeric(20, 2) not null check (payout > 0),     -- sent to the bank (amount - fee)
  bank_account_id uuid not null references public.bank_accounts (id),
  reference       text not null unique,
  transfer_code   text,
  status          text not null default 'pending' check (status in ('pending', 'processing', 'success', 'failed', 'reversed')),
  failure_reason  text,
  idempotency_key uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (user_id, idempotency_key),
  constraint withdrawals_payout check (payout = amount - fee)
);
create index withdrawals_user_created_idx on public.withdrawals (user_id, created_at desc);

-- ── Gifts (paid from verified NGN balance) ─────────────────────────
create table public.gifts (
  id                 uuid primary key default gen_random_uuid(),
  sender_id          uuid not null references public.profiles (id) on delete cascade,
  recipient_id       uuid not null references public.profiles (id) on delete cascade,
  post_id            uuid references public.posts (id) on delete set null,
  live_session_id    uuid,
  amount_ngn         numeric(20, 2) not null check (amount_ngn > 0),
  creator_amount_ngn numeric(20, 2) not null check (creator_amount_ngn >= 0),
  platform_fee_ngn   numeric(20, 2) not null check (platform_fee_ngn >= 0),
  reference          text not null unique,
  idempotency_key    uuid not null,
  created_at         timestamptz not null default now(),
  constraint gifts_split_exact check (creator_amount_ngn + platform_fee_ngn = amount_ngn),
  constraint gifts_not_self check (sender_id <> recipient_id),
  unique (sender_id, idempotency_key)
);
create index gifts_recipient_created_idx on public.gifts (recipient_id, created_at desc);
create index gifts_sender_created_idx on public.gifts (sender_id, created_at desc);
create index gifts_post_idx on public.gifts (post_id);

create table public.idempotency_keys (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  key        uuid not null,
  action     text not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ── Crypto wallets (Coinbase Developer Platform server wallets) ────
-- Only public addresses + provider account names are stored. Keys live in CDP's
-- secure enclaves and never reach KAMKAM's database, logs or browser.
create table public.crypto_wallets (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  provider            text not null default 'cdp',
  network_mode        text not null check (network_mode in ('testnet', 'mainnet')),
  evm_account_name    text not null,
  solana_account_name text not null,
  evm_address         text unique check (evm_address is null or evm_address ~ '^0x[0-9a-fA-F]{40}$'),
  solana_address      text unique check (solana_address is null or solana_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  status              text not null default 'provisioning' check (status in ('provisioning', 'ready', 'failed')),
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.crypto_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  direction       text not null default 'OUT' check (direction in ('OUT')),
  network         text not null,
  asset           text not null,
  amount          text not null check (amount ~ '^\d+(\.\d+)?$'),
  amount_atomic   text not null check (amount_atomic ~ '^\d+$'),
  from_address    text not null,
  to_address      text not null,
  tx_hash         text unique,
  explorer_url    text,
  status          text not null default 'submitting' check (status in ('submitting', 'submitted', 'confirmed', 'failed', 'dropped')),
  error           text,
  idempotency_key uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  unique (user_id, idempotency_key)
);
create index crypto_tx_user_created_idx on public.crypto_transactions (user_id, created_at desc);

-- ════════════════════════════ CORE LEDGER ══════════════════════════
create or replace function public._ensure_ngn_wallet(p_user uuid)
returns void language sql security definer set search_path = public as $$
  insert into ngn_wallets (user_id) values (p_user) on conflict (user_id) do nothing
$$;

-- The ONLY way a balance changes. Conditional update ⇒ buckets can never go negative.
create or replace function public._ledger(
  p_user uuid, p_account text, p_amount numeric, p_type text, p_reference text, p_description text,
  p_counterparty text default null, p_payment uuid default null, p_gift uuid default null, p_withdrawal uuid default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_after numeric; v_have numeric;
begin
  if p_amount is null or p_amount = 0 then raise exception 'ledger amount must be non-zero'; end if;
  if p_account = 'platform_revenue' then
    insert into ledger_entries (user_id, account, amount, entry_type, reference, description, counterparty, payment_id, gift_id, withdrawal_id)
    values (null, 'platform_revenue', p_amount, p_type, p_reference, p_description, p_counterparty, p_payment, p_gift, p_withdrawal);
    return null;
  end if;
  perform _ensure_ngn_wallet(p_user);
  if p_account = 'balance' then
    update ngn_wallets set balance = balance + p_amount, updated_at = now() where user_id = p_user and balance + p_amount >= 0 returning balance into v_after;
  elsif p_account = 'earnings' then
    update ngn_wallets set earnings = earnings + p_amount, updated_at = now() where user_id = p_user and earnings + p_amount >= 0 returning earnings into v_after;
  elsif p_account = 'held' then
    update ngn_wallets set held = held + p_amount, updated_at = now() where user_id = p_user and held + p_amount >= 0 returning held into v_after;
  else
    raise exception 'unknown ledger account %', p_account;
  end if;
  if v_after is null then
    execute format('select %I from ngn_wallets where user_id = $1', p_account) into v_have using p_user;
    perform raise_app_error('INSUFFICIENT_BALANCE', format('Insufficient %s. You need %s; you have %s.',
      case p_account when 'earnings' then 'creator earnings' else 'balance' end, _fmt_ngn(abs(p_amount)), _fmt_ngn(coalesce(v_have, 0))));
  end if;
  insert into ledger_entries (user_id, account, amount, balance_after, entry_type, reference, description, counterparty, payment_id, gift_id, withdrawal_id)
  values (p_user, p_account, p_amount, v_after, p_type, p_reference, p_description, p_counterparty, p_payment, p_gift, p_withdrawal);
  return v_after;
end $$;

create or replace function public._idempotent_begin(p_user uuid, p_key uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prev idempotency_keys;
begin
  if p_key is null then perform raise_app_error('VALIDATION', 'Missing idempotency key.'); end if;
  if (select count(*) from idempotency_keys where user_id = p_user and created_at > now() - interval '1 minute') >= 30 then
    perform raise_app_error('RATE_LIMITED', 'Too many requests. Please wait a moment.');
  end if;
  insert into idempotency_keys (user_id, key, action) values (p_user, p_key, p_action) on conflict do nothing;
  if found then return null; end if;
  select * into prev from idempotency_keys where user_id = p_user and key = p_key;
  if prev.action <> p_action then perform raise_app_error('VALIDATION', 'This request key was already used for a different action.'); end if;
  return coalesce(prev.result, jsonb_build_object('duplicate', true));
end $$;

create or replace function public._idempotent_end(p_user uuid, p_key uuid, p_result jsonb)
returns jsonb language sql security definer set search_path = public as $$
  update idempotency_keys set result = p_result where user_id = p_user and key = p_key returning p_result
$$;

create or replace function public._whole_ngn(p jsonb, p_key text)
returns numeric language plpgsql immutable as $$
declare raw text := replace(btrim(coalesce(p ->> p_key, '')), ',', '');
begin
  if raw !~ '^\d+(\.\d{1,2})?$' or raw::numeric <= 0 then perform raise_app_error('VALIDATION', 'Enter a valid Naira amount.'); end if;
  return raw::numeric;
end $$;

-- New accounts: profile + an EMPTY NGN wallet. No starter money, ever.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  dname text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', ''));
  base text;
  colors text[] := array['#2F6F4E', '#B0553C', '#3A5C8C', '#6B4E8C', '#1F6E7A', '#8C6A2F', '#14975C', '#8C3F5C'];
begin
  if uname <> '' then
    if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'Invalid username' using errcode = '23514'; end if;
    if exists (select 1 from profiles where username = uname) then raise exception 'Username already taken' using errcode = '23505'; end if;
  else
    base := left(regexp_replace(lower(split_part(coalesce(new.email, 'user'), '@', 1)), '[^a-z0-9_]', '', 'g'), 14);
    if length(base) < 3 then base := 'user'; end if;
    loop
      uname := base || '_' || substr(md5(random()::text), 1, 5);
      exit when not exists (select 1 from profiles where username = uname);
    end loop;
  end if;
  if dname = '' then dname := uname; end if;
  insert into profiles (id, username, display_name, avatar_color)
  values (new.id, uname, left(dname, 50), colors[1 + (abs(hashtext(uname)) % 8)]);
  perform _ensure_ngn_wallet(new.id);   -- ₦0 / ₦0 / ₦0
  return new;
end $$;

-- Existing users get an empty NGN wallet (their demo balances were archived, not migrated).
insert into public.ngn_wallets (user_id) select id from public.profiles on conflict do nothing;

-- ════════════════ SERVER-ONLY (service_role) OPERATIONS ════════════════
-- Called by Next.js server routes AFTER provider verification.

create or replace function public.svc_payment_create(p_user uuid, p_reference text, p_amount numeric, p_channel text)
returns public.payments language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  if p_amount < _setting_num('deposit_min_ngn') or p_amount > _setting_num('deposit_max_ngn') then
    perform raise_app_error('INVALID_AMOUNT', 'Deposits must be between ' || _fmt_ngn(_setting_num('deposit_min_ngn')) || ' and ' || _fmt_ngn(_setting_num('deposit_max_ngn')) || '.');
  end if;
  if round(p_amount, 2) <> p_amount then perform raise_app_error('INVALID_AMOUNT', 'Use at most 2 decimal places.'); end if;
  if (select count(*) from payments where user_id = p_user and created_at > now() - interval '10 minutes') >= 10 then
    perform raise_app_error('RATE_LIMITED', 'Too many deposit attempts. Please wait a few minutes.');
  end if;
  insert into payments (user_id, reference, amount, channel) values (p_user, p_reference, p_amount, p_channel) returning * into p;
  return p;
end $$;

-- Idempotent settlement from a VERIFIED Paystack response.
-- p_amount_kobo / p_currency come from Paystack's verify response, never from the browser.
create or replace function public.svc_payment_settle(p_reference text, p_status text, p_amount_kobo bigint, p_currency text,
                                                     p_channel text default null, p_paid_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  select * into p from payments where reference = p_reference for update;
  if p.id is null then return jsonb_build_object('outcome', 'unknown_reference'); end if;

  if p_status = 'success' then
    if p.credited then return jsonb_build_object('outcome', 'already_credited', 'status', p.status); end if;
    if coalesce(p_currency, '') <> 'NGN' or p_amount_kobo is null or p_amount_kobo < (p.amount * 100)::bigint then
      update payments set status = 'failed', needs_review = true, failure_reason = 'amount_or_currency_mismatch', verified_at = now(), updated_at = now() where id = p.id;
      return jsonb_build_object('outcome', 'mismatch');
    end if;
    update payments set status = 'success', credited = true, channel = coalesce(p_channel, channel),
                        paid_at = coalesce(p_paid_at, now()), verified_at = now(), updated_at = now() where id = p.id;
    perform _ledger(p.user_id, 'balance', p.amount, 'DEPOSIT', p.reference, 'Wallet funded · Paystack' || coalesce(' · ' || p_channel, ''), null, p.id);
    perform _notify(p.user_id, null, 'TRANSACTION_COMPLETED', 'Wallet funded', _fmt_ngn(p.amount) || ' was added to your KAMKAM balance.', '+' || _fmt_ngn(p.amount));
    return jsonb_build_object('outcome', 'credited', 'amount', p.amount);
  elsif p_status in ('failed', 'abandoned') then
    if p.credited then return jsonb_build_object('outcome', 'already_credited', 'status', p.status); end if;
    update payments set status = p_status, verified_at = now(), updated_at = now() where id = p.id;
    return jsonb_build_object('outcome', p_status);
  elsif p_status = 'pending' then
    if not p.credited then update payments set status = 'pending', updated_at = now() where id = p.id; end if;
    return jsonb_build_object('outcome', 'pending');
  elsif p_status = 'reversed' then
    if p.credited and p.status <> 'reversed' then
      begin
        perform _ledger(p.user_id, 'balance', -p.amount, 'DEPOSIT_REVERSAL', p.reference, 'Deposit reversed by the bank');
        update payments set status = 'reversed', updated_at = now() where id = p.id;
      exception when others then
        update payments set status = 'reversed', needs_review = true, failure_reason = 'reversal_exceeds_balance', updated_at = now() where id = p.id;
      end;
    end if;
    return jsonb_build_object('outcome', 'reversed');
  end if;
  return jsonb_build_object('outcome', 'ignored');
end $$;

create or replace function public.svc_webhook_seen(p_provider text, p_event text, p_key text, p_reference text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into webhook_events (provider, event, event_key, reference) values (p_provider, p_event, p_key, p_reference)
  on conflict (event_key) do nothing;
  return not found;     -- true ⇒ duplicate delivery, skip
end $$;

create or replace function public.svc_bank_account_upsert(p_user uuid, p_bank_code text, p_bank_name text, p_account_name text,
                                                          p_last4 text, p_recipient_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  insert into bank_accounts (user_id, bank_code, bank_name, account_name, account_last4, recipient_code)
  values (p_user, p_bank_code, p_bank_name, p_account_name, p_last4, p_recipient_code)
  on conflict (user_id, recipient_code) do update set bank_name = excluded.bank_name, account_name = excluded.account_name
  returning id into v;
  return v;
end $$;

-- Reserve funds for a payout (idempotent by user + key). Returns the withdrawal row.
create or replace function public.svc_withdrawal_create(p_user uuid, p_source text, p_amount numeric, p_bank_account uuid,
                                                        p_reference text, p_key uuid)
returns public.withdrawals language plpgsql security definer set search_path = public as $$
declare w withdrawals; v_fee numeric := _setting_num('withdraw_fee_ngn'); v_today numeric;
begin
  select * into w from withdrawals where user_id = p_user and idempotency_key = p_key;
  if w.id is not null then return w; end if;
  if p_source not in ('balance', 'earnings') then perform raise_app_error('VALIDATION', 'Choose where to withdraw from.'); end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account and user_id = p_user) then perform raise_app_error('FORBIDDEN', 'Unknown bank account.'); end if;
  if round(p_amount, 2) <> p_amount or p_amount < _setting_num('withdraw_min_ngn') then
    perform raise_app_error('INVALID_AMOUNT', 'Minimum withdrawal is ' || _fmt_ngn(_setting_num('withdraw_min_ngn')) || '.');
  end if;
  select coalesce(sum(amount), 0) into v_today from withdrawals
  where user_id = p_user and status in ('pending', 'processing', 'success') and created_at > now() - interval '24 hours';
  if v_today + p_amount > _setting_num('withdraw_daily_max_ngn') then
    perform raise_app_error('LIMIT_REACHED', 'Daily withdrawal limit is ' || _fmt_ngn(_setting_num('withdraw_daily_max_ngn')) || '.');
  end if;
  insert into withdrawals (user_id, source, amount, fee, payout, bank_account_id, reference, idempotency_key)
  values (p_user, p_source, p_amount, v_fee, p_amount - v_fee, p_bank_account, p_reference, p_key) returning * into w;
  perform _ledger(p_user, p_source, -p_amount, 'WITHDRAWAL_HOLD', p_reference, 'Withdrawal to bank (in progress)', null, null, null, w.id);
  perform _ledger(p_user, 'held', p_amount, 'WITHDRAWAL_FUNDED', p_reference, 'Held for withdrawal', null, null, null, w.id);
  return w;
end $$;

-- State machine driven ONLY by verified Paystack transfer status.
create or replace function public.svc_withdrawal_update(p_reference text, p_status text, p_transfer_code text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w withdrawals;
begin
  select * into w from withdrawals where reference = p_reference for update;
  if w.id is null then return jsonb_build_object('outcome', 'unknown_reference'); end if;

  if p_status = 'processing' and w.status in ('pending', 'processing') then
    update withdrawals set status = 'processing', transfer_code = coalesce(p_transfer_code, transfer_code), updated_at = now() where id = w.id;
    return jsonb_build_object('outcome', 'processing');
  elsif p_status = 'success' and w.status in ('pending', 'processing') then
    perform _ledger(w.user_id, 'held', -w.amount, 'WITHDRAWAL_PAID', w.reference, 'Paid to bank', null, null, null, w.id);
    if w.fee > 0 then perform _ledger(null, 'platform_revenue', w.fee, 'WITHDRAWAL_FEE', w.reference, 'Withdrawal fee', null, null, null, w.id); end if;
    update withdrawals set status = 'success', transfer_code = coalesce(p_transfer_code, transfer_code), completed_at = now(), updated_at = now() where id = w.id;
    perform _notify(w.user_id, null, 'WITHDRAWAL_COMPLETED', 'Withdrawal completed', _fmt_ngn(w.payout) || ' was sent to your bank account.', _fmt_ngn(w.payout));
    return jsonb_build_object('outcome', 'success');
  elsif p_status in ('failed', 'reversed') and w.status in ('pending', 'processing') then
    perform _ledger(w.user_id, 'held', -w.amount, 'WITHDRAWAL_RELEASED', w.reference, 'Withdrawal ' || p_status, null, null, null, w.id);
    perform _ledger(w.user_id, w.source, w.amount, 'WITHDRAWAL_RETURNED', w.reference, 'Withdrawal ' || p_status || ' — funds returned', null, null, null, w.id);
    update withdrawals set status = p_status, failure_reason = p_reason, updated_at = now() where id = w.id;
    perform _notify(w.user_id, null, 'TRANSACTION_COMPLETED', 'Withdrawal ' || p_status, _fmt_ngn(w.amount) || ' has been returned to your ' || case w.source when 'earnings' then 'creator earnings' else 'balance' end || '.');
    return jsonb_build_object('outcome', p_status);
  elsif p_status = 'reversed' and w.status = 'success' then
    -- Paystack reversed a completed transfer: the money is back in KAMKAM's Paystack balance.
    perform _ledger(w.user_id, w.source, w.amount, 'WITHDRAWAL_RETURNED', w.reference, 'Withdrawal reversed by the bank — funds returned', null, null, null, w.id);
    if w.fee > 0 then perform _ledger(null, 'platform_revenue', -w.fee, 'WITHDRAWAL_FEE', w.reference, 'Withdrawal fee refunded', null, null, null, w.id); end if;
    update withdrawals set status = 'reversed', failure_reason = coalesce(p_reason, 'reversed'), updated_at = now() where id = w.id;
    return jsonb_build_object('outcome', 'reversed');
  end if;
  return jsonb_build_object('outcome', 'no_change', 'status', w.status);
end $$;

create or replace function public.svc_crypto_wallet_upsert(p_user uuid, p_mode text, p_evm_name text, p_sol_name text,
                                                           p_evm text, p_sol text, p_status text, p_error text)
returns public.crypto_wallets language plpgsql security definer set search_path = public as $$
declare w crypto_wallets;
begin
  insert into crypto_wallets (user_id, network_mode, evm_account_name, solana_account_name, evm_address, solana_address, status, last_error)
  values (p_user, p_mode, p_evm_name, p_sol_name, p_evm, p_sol, p_status, p_error)
  on conflict (user_id) do update set
    evm_address = coalesce(excluded.evm_address, crypto_wallets.evm_address),
    solana_address = coalesce(excluded.solana_address, crypto_wallets.solana_address),
    status = excluded.status, last_error = excluded.last_error, network_mode = excluded.network_mode, updated_at = now()
  returning * into w;
  return w;
end $$;

create or replace function public.svc_crypto_tx_begin(p_user uuid, p_key uuid, p_network text, p_asset text, p_amount text,
                                                       p_atomic text, p_from text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t crypto_transactions;
begin
  select * into t from crypto_transactions where user_id = p_user and idempotency_key = p_key;
  if t.id is not null then return to_jsonb(t) || jsonb_build_object('duplicate', true); end if;
  if (select count(*) from crypto_transactions where user_id = p_user and created_at > now() - interval '10 minutes') >= 10 then
    perform raise_app_error('RATE_LIMITED', 'Too many sends. Please wait a few minutes.');
  end if;
  if exists (select 1 from crypto_transactions where user_id = p_user and status = 'submitting' and created_at > now() - interval '2 minutes') then
    perform raise_app_error('IN_PROGRESS', 'Another send is still being submitted. Please wait.');
  end if;
  insert into crypto_transactions (user_id, network, asset, amount, amount_atomic, from_address, to_address, idempotency_key)
  values (p_user, p_network, p_asset, p_amount, p_atomic, p_from, p_to, p_key) returning * into t;
  return to_jsonb(t) || jsonb_build_object('duplicate', false);
end $$;

create or replace function public.svc_crypto_tx_update(p_id uuid, p_status text, p_hash text, p_explorer text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare t crypto_transactions;
begin
  update crypto_transactions set status = p_status, tx_hash = coalesce(p_hash, tx_hash), explorer_url = coalesce(p_explorer, explorer_url),
         error = p_error, updated_at = now(), confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end
  where id = p_id and status not in ('confirmed', 'failed', 'dropped') returning * into t;
  if t.id is not null and p_status = 'confirmed' then
    perform _notify(t.user_id, null, 'TRANSACTION_COMPLETED', 'Transaction confirmed', t.amount || ' ' || t.asset || ' sent on ' || t.network || '.');
  end if;
end $$;

-- Ledger integrity check (ops): rows where wallet buckets ≠ sum of ledger entries
create or replace function public.svc_ledger_check()
returns table (user_id uuid, account text, wallet_value numeric, ledger_sum numeric)
language sql stable security definer set search_path = public as $$
  with sums as (
    select l.user_id, l.account, sum(l.amount) s from ledger_entries l where l.user_id is not null group by 1, 2
  ), buckets as (
    select w.user_id, b.account, b.v from ngn_wallets w
    cross join lateral (values ('balance', w.balance), ('earnings', w.earnings), ('held', w.held)) b(account, v)
  )
  select b.user_id, b.account, b.v, coalesce(s.s, 0) from buckets b
  left join sums s on s.user_id = b.user_id and s.account = b.account
  where b.v <> coalesce(s.s, 0)
$$;

create or replace function public.svc_crypto_wallet_get(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(w) from crypto_wallets w where w.user_id = p_user
$$;

create or replace function public.svc_crypto_tx_get(p_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(t) from crypto_transactions t where t.id = p_id and t.user_id = p_user
$$;

-- Work list for the reconciliation job: anything not yet in a final state.
create or replace function public.svc_reconcile_candidates()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payments', coalesce((select jsonb_agg(reference) from (
        select reference from payments where not credited and status in ('initialized', 'pending')
          and created_at > now() - interval '7 days' and created_at < now() - interval '2 minutes'
        order by created_at limit 100) x), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(jsonb_build_object('reference', reference, 'transferCode', transfer_code, 'createdAt', created_at)) from (
        select reference, transfer_code, created_at from withdrawals where status in ('pending', 'processing')
          and created_at < now() - interval '2 minutes' order by created_at limit 100) x), '[]'::jsonb),
    'cryptoTxs', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'network', network, 'txHash', tx_hash, 'status', status, 'createdAt', created_at)) from (
        select id, network, tx_hash, status, created_at from crypto_transactions where status in ('submitting', 'submitted')
        order by created_at limit 100) x), '[]'::jsonb))
$$;

-- ═════════════════════ USER-FACING (authenticated) ═════════════════════

create or replace function public.gift_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('tiers', _setting('gift_tiers_ngn'), 'creatorShare', _setting('creator_share') #>> '{}',
                            'min', _setting_num('gift_min_ngn'), 'max', _setting_num('gift_max_ngn'))
$$;

create or replace function public._gift_calc(p jsonb, p_sender uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  raw text := replace(btrim(coalesce(p ->> 'amountNgn', '')), ',', ''); v_amount numeric; post posts; v_recipient uuid; v_live uuid; v_creator numeric;
begin
  if raw !~ '^\d+$' then perform raise_app_error('VALIDATION', 'Gift must be a whole Naira amount.'); end if;
  v_amount := raw::numeric;
  if v_amount < _setting_num('gift_min_ngn') or v_amount > _setting_num('gift_max_ngn') then
    perform raise_app_error('VALIDATION', 'Gift must be between ' || _fmt_ngn(_setting_num('gift_min_ngn')) || ' and ' || _fmt_ngn(_setting_num('gift_max_ngn')) || '.');
  end if;
  if coalesce(upper(p ->> 'payAsset'), 'NGN') <> 'NGN' then
    perform raise_app_error('UNSUPPORTED', 'Gifts can currently only be paid from your Naira balance.');
  end if;
  if nullif(p ->> 'postId', '') is not null then
    select * into post from posts where id = (p ->> 'postId')::uuid;
    if post.id is null then perform raise_app_error('POST_NOT_FOUND', 'Post not found.'); end if;
    v_recipient := post.author_id;
  else
    select id into v_recipient from profiles where id = nullif(p ->> 'recipientId', '')::uuid;
    if v_recipient is null then perform raise_app_error('USER_NOT_FOUND', 'Creator not found.'); end if;
  end if;
  if v_recipient = p_sender then perform raise_app_error('SELF_GIFT', 'You can''t gift yourself.'); end if;
  v_creator := round(v_amount * _setting_num('creator_share'), 2);
  return jsonb_build_object('amountNgn', v_amount, 'creatorAmountNgn', v_creator, 'platformFeeNgn', v_amount - v_creator,
                            'recipientId', v_recipient, 'postId', post.id, 'liveSessionId', nullif(p ->> 'liveSessionId', ''));
end $$;

create or replace function public.gift_quote(p_params jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); c jsonb; bal numeric;
begin
  c := _gift_calc(p_params, me);
  perform _ensure_ngn_wallet(me);
  select balance into bal from ngn_wallets where user_id = me;
  return jsonb_build_object(
    'amountNgn', c ->> 'amountNgn', 'payAsset', 'NGN', 'rateNgn', '1', 'payAmount', c ->> 'amountNgn', 'payLabel', _fmt_ngn((c ->> 'amountNgn')::numeric),
    'creatorAmountNgn', c ->> 'creatorAmountNgn', 'platformFeeNgn', c ->> 'platformFeeNgn',
    'balance', bal::text, 'balanceLabel', _fmt_ngn(bal), 'sufficient', bal >= (c ->> 'amountNgn')::numeric);
end $$;

-- Atomic gift from VERIFIED balance: debit · gift · likes/Super Like/boost ·
-- 80% creator earnings · 20% platform revenue · notification · live event
create or replace function public.send_gift(p_params jsonb, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := _uid(); prev jsonb; c jsonb; g gifts; ref text := _ref('GFT'); v_post uuid; v_rcp uuid; v_live uuid;
  v_amount numeric; v_creator numeric; v_fee numeric; me_name text; rcp_name text; v_like likes; v_result jsonb; conv uuid;
begin
  prev := _idempotent_begin(me, p_idempotency_key, 'gift');
  if prev is not null then return prev; end if;
  c := _gift_calc(p_params, me);
  v_amount := (c ->> 'amountNgn')::numeric; v_creator := (c ->> 'creatorAmountNgn')::numeric; v_fee := (c ->> 'platformFeeNgn')::numeric;
  v_post := nullif(c ->> 'postId', '')::uuid; v_rcp := (c ->> 'recipientId')::uuid; v_live := nullif(c ->> 'liveSessionId', '')::uuid;
  if v_live is not null and not exists (select 1 from live_sessions where id = v_live and host_id = v_rcp and status = 'live') then
    perform raise_app_error('VALIDATION', 'This live session has ended.');
  end if;
  select username into me_name from profiles where id = me;
  select username into rcp_name from profiles where id = v_rcp;

  insert into gifts (sender_id, recipient_id, post_id, live_session_id, amount_ngn, creator_amount_ngn, platform_fee_ngn, reference, idempotency_key)
  values (me, v_rcp, v_post, v_live, v_amount, v_creator, v_fee, ref, p_idempotency_key) returning * into g;

  perform _ledger(me, 'balance', -v_amount, 'GIFT_SENT', ref, 'Gift to @' || rcp_name, '@' || rcp_name, null, g.id);
  perform _ledger(v_rcp, 'earnings', v_creator, 'GIFT_RECEIVED', ref, 'Gift from @' || me_name, '@' || me_name, null, g.id);
  perform _ledger(null, 'platform_revenue', v_fee, 'PLATFORM_FEE', ref, 'KAMKAM 20% gift fee', null, null, g.id);

  if v_post is not null then
    select * into v_like from likes where user_id = me and post_id = v_post;
    if v_like.user_id is null then insert into likes (user_id, post_id, super_like) values (me, v_post, true);
    elsif not v_like.super_like then update likes set super_like = true where user_id = me and post_id = v_post; end if;
    update posts set gift_count = gift_count + 1, earned_ngn = earned_ngn + v_creator, boosted_until = now() + interval '24 hours' where id = v_post;
  end if;
  update profiles set gifts_received_count = gifts_received_count + 1 where id = v_rcp;
  if v_live is not null then
    update live_sessions set gift_total = gift_total + v_amount where id = v_live;
    insert into live_messages (session_id, user_id, kind, body, gift_id) values (v_live, me, 'GIFT', 'sent a ' || _fmt_ngn(v_amount) || ' gift', g.id);
  end if;

  perform _notify(v_rcp, me, 'GIFT_RECEIVED', '🎁 @' || me_name || ' sent you a ' || _fmt_ngn(v_amount) || ' Gift.',
    'You earned ' || _fmt_ngn(v_creator) || '.' || case when v_post is not null then ' Your post received a Super Like.' else '' end,
    '+' || _fmt_ngn(v_creator), v_post);

  select a.conversation_id into conv from conversation_members a join conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = me and b.user_id = v_rcp limit 1;
  if conv is not null then
    insert into messages (conversation_id, sender_id, kind, body, meta)
    values (conv, me, 'GIFT', 'Gift sent · ' || _fmt_ngn(v_amount), jsonb_build_object('creatorAmountNgn', v_creator::text));
  end if;

  v_result := jsonb_build_object('gift', jsonb_build_object('id', g.id, 'reference', ref, 'amountNgn', v_amount::text, 'payAsset', 'NGN',
    'payAmount', v_amount::text, 'payLabel', _fmt_ngn(v_amount), 'creatorAmountNgn', v_creator::text, 'platformFeeNgn', v_fee::text,
    'recipient', '@' || rcp_name), 'postId', v_post);
  return _idempotent_end(me, p_idempotency_key, v_result);
end $$;

-- Instant KAMKAM-to-KAMKAM transfer of verified NGN
create or replace function public.transfer_ngn(p_to_username text, p_amount text, p_note text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); prev jsonb; to_p profiles; v_amount numeric; ref text := _ref('TRF'); me_name text; v_result jsonb;
begin
  prev := _idempotent_begin(me, p_idempotency_key, 'transfer');
  if prev is not null then return prev; end if;
  v_amount := _whole_ngn(jsonb_build_object('a', p_amount), 'a');
  if v_amount > _setting_num('transfer_max_ngn') then perform raise_app_error('INVALID_AMOUNT', 'Maximum transfer is ' || _fmt_ngn(_setting_num('transfer_max_ngn')) || '.'); end if;
  if char_length(coalesce(p_note, '')) > 140 then perform raise_app_error('VALIDATION', 'Note is too long (max 140 characters).'); end if;
  select * into to_p from profiles where username = lower(ltrim(btrim(coalesce(p_to_username, '')), '@'));
  if to_p.id is null then perform raise_app_error('USER_NOT_FOUND', 'No KAMKAM user with that username.'); end if;
  if to_p.id = me then perform raise_app_error('INVALID_RECIPIENT', 'You cannot transfer to yourself.'); end if;
  select username into me_name from profiles where id = me;
  perform _ledger(me, 'balance', -v_amount, 'TRANSFER_OUT', ref, 'Transfer to @' || to_p.username || coalesce(' · ' || nullif(btrim(p_note), ''), ''), '@' || to_p.username);
  perform _ledger(to_p.id, 'balance', v_amount, 'TRANSFER_IN', ref, 'Transfer from @' || me_name || coalesce(' · ' || nullif(btrim(p_note), ''), ''), '@' || me_name);
  perform _notify(to_p.id, me, 'TRANSACTION_COMPLETED', '@' || me_name || ' sent you ' || _fmt_ngn(v_amount),
    coalesce('"' || nullif(btrim(p_note), '') || '"', 'Added to your KAMKAM balance.'), '+' || _fmt_ngn(v_amount));
  v_result := jsonb_build_object('reference', ref, 'status', 'COMPLETED', 'amount', v_amount::text, 'to', '@' || to_p.username);
  return _idempotent_end(me, p_idempotency_key, v_result);
end $$;

-- Withdraw creator earnings into the spendable KAMKAM balance (internal, instant)
create or replace function public.move_earnings_to_balance(p_amount text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); prev jsonb; v_amount numeric; ref text := _ref('ERN'); v_result jsonb;
begin
  prev := _idempotent_begin(me, p_idempotency_key, 'earnings_to_balance');
  if prev is not null then return prev; end if;
  v_amount := _whole_ngn(jsonb_build_object('a', p_amount), 'a');
  perform _ledger(me, 'earnings', -v_amount, 'EARNINGS_TO_BALANCE_OUT', ref, 'Earnings moved to KAMKAM balance');
  perform _ledger(me, 'balance', v_amount, 'EARNINGS_TO_BALANCE_IN', ref, 'Earnings moved to KAMKAM balance');
  v_result := jsonb_build_object('reference', ref, 'status', 'COMPLETED', 'amount', v_amount::text);
  return _idempotent_end(me, p_idempotency_key, v_result);
end $$;

create or replace function public.wallet_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); w ngn_wallets; c crypto_wallets;
begin
  perform _ensure_ngn_wallet(me);
  select * into w from ngn_wallets where user_id = me;
  select * into c from crypto_wallets where user_id = me;
  return jsonb_build_object(
    'ngn', jsonb_build_object('balance', w.balance::text, 'earnings', w.earnings::text, 'held', w.held::text),
    'limits', jsonb_build_object('depositMin', _setting_num('deposit_min_ngn'), 'depositMax', _setting_num('deposit_max_ngn'),
      'withdrawMin', _setting_num('withdraw_min_ngn'), 'withdrawFee', _setting_num('withdraw_fee_ngn'),
      'withdrawDailyMax', _setting_num('withdraw_daily_max_ngn'), 'transferMax', _setting_num('transfer_max_ngn')),
    'crypto', case when c.user_id is null then null else jsonb_build_object(
      'status', c.status, 'networkMode', c.network_mode, 'evmAddress', c.evm_address, 'solanaAddress', c.solana_address, 'lastError', c.last_error) end);
end $$;

-- Unified activity feed: verified ledger movements + withdrawals + deposits in flight/failed + crypto sends
create or replace function public.wallet_activity(p_filter text default 'all', p_limit int default 60)
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select _uid() as id),
  items as (
    select l.id, l.created_at,
      case when l.entry_type like 'DEPOSIT%' then 'DEPOSIT' when l.entry_type like 'GIFT%' then l.entry_type
           when l.entry_type like 'TRANSFER%' then 'TRANSFER' else 'EARNINGS' end as type,
      case when l.amount > 0 then 'IN' else 'OUT' end as direction, 'NGN' as asset, abs(l.amount) as amount,
      'COMPLETED' as status, l.reference, case l.account when 'earnings' then 'Earnings' else 'Naira' end as network,
      l.counterparty, l.description, null::text as tx_hash, null::text as explorer_url
    from ledger_entries l, me where l.user_id = me.id and l.account <> 'held' and l.entry_type not like 'WITHDRAWAL%'
    union all
    select w.id, w.created_at, 'WITHDRAWAL', 'OUT', 'NGN', w.amount, upper(w.status), w.reference, 'Bank',
      b.bank_name || ' ••••' || b.account_last4,
      'Withdrawal to ' || b.bank_name || ' ••••' || b.account_last4 || case when w.fee > 0 then ' (fee ' || _fmt_ngn(w.fee) || ')' else '' end,
      null, null
    from withdrawals w join bank_accounts b on b.id = w.bank_account_id, me where w.user_id = me.id
    union all
    select p.id, p.created_at, 'DEPOSIT', 'IN', 'NGN', p.amount, upper(p.status), p.reference, 'Naira', 'Paystack',
      'Wallet funding · Paystack', null, null
    from payments p, me where p.user_id = me.id and not p.credited and p.status <> 'initialized'
    union all
    select t.id, t.created_at, 'SEND', 'OUT', t.asset, t.amount::numeric, upper(case t.status when 'submitting' then 'pending' when 'submitted' then 'processing' when 'confirmed' then 'completed' else t.status end),
      coalesce(t.tx_hash, t.id::text), t.network, t.to_address, 'Sent ' || t.asset || ' on ' || t.network, t.tx_hash, t.explorer_url
    from crypto_transactions t, me where t.user_id = me.id
  )
  select jsonb_build_object('transactions', coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'type', i.type, 'direction', i.direction, 'asset', i.asset, 'amount', i.amount::text,
      'amountLabel', case when i.direction = 'IN' then '+' else '−' end || case when i.asset = 'NGN' then _fmt_ngn(i.amount) else i.amount::text || ' ' || i.asset end,
      'valueNgn', case when i.asset = 'NGN' then i.amount::text else null end,
      'valueLabel', case when i.asset = 'NGN' then _fmt_ngn(i.amount) else null end,
      'fee', '0', 'feeLabel', null, 'status', i.status, 'reference', i.reference, 'network', i.network,
      'counterparty', i.counterparty, 'description', i.description, 'simulated', false,
      'txHash', i.tx_hash, 'explorerUrl', i.explorer_url, 'createdAt', i.created_at, 'completedAt', null) order by i.created_at desc), '[]'::jsonb))
  from (select * from items
        where case lower(coalesce(p_filter, 'all'))
          when 'deposits' then type = 'DEPOSIT' when 'withdrawals' then type = 'WITHDRAWAL'
          when 'gifts' then type in ('GIFT_SENT', 'GIFT_RECEIVED') when 'transfers' then type = 'TRANSFER'
          when 'sent' then type in ('SEND', 'TRANSFER') and direction = 'OUT' when 'received' then direction = 'IN'
          when 'earnings' then type in ('GIFT_RECEIVED', 'EARNINGS') else true end
        order by created_at desc limit least(greatest(coalesce(p_limit, 60), 1), 200)) i
$$;

create or replace function public.withdrawal_status(p_reference text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('reference', w.reference, 'status', w.status, 'amount', w.amount::text, 'payout', w.payout::text,
                            'fee', w.fee::text, 'failureReason', w.failure_reason)
  from withdrawals w where w.reference = p_reference and w.user_id = _uid()
$$;

create or replace function public.payment_status(p_reference text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('reference', p.reference, 'status', p.status, 'credited', p.credited, 'amount', p.amount::text)
  from payments p where p.reference = p_reference and p.user_id = _uid()
$$;

create or replace function public.gifts_list(p_direction text default 'sent')
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('gifts', coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'reference', g.reference, 'createdAt', g.created_at,
      'amountNgn', g.amount_ngn::text, 'valueLabel', _fmt_ngn(g.amount_ngn), 'payAsset', 'NGN', 'payLabel', _fmt_ngn(g.amount_ngn),
      'creatorAmountNgn', g.creator_amount_ngn::text, 'creatorLabel', _fmt_ngn(g.creator_amount_ngn), 'platformFeeLabel', _fmt_ngn(g.platform_fee_ngn),
      'sender', (select author_json(p) from profiles p where p.id = g.sender_id),
      'recipient', (select author_json(p) from profiles p where p.id = g.recipient_id),
      'post', (select jsonb_build_object('id', p.id, 'text', p.text) from posts p where p.id = g.post_id),
      'status', 'COMPLETED') order by g.created_at desc), '[]'::jsonb))
  from (select * from gifts
        where (p_direction = 'received' and recipient_id = _uid()) or (p_direction <> 'received' and sender_id = _uid())
        order by created_at desc limit 100) g
$$;

create or replace function public.earnings_summary()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := _uid(); w ngn_wallets;
  month_start timestamptz := date_trunc('month', now()); prev_start timestamptz := date_trunc('month', now()) - interval '1 month';
  v_total numeric; v_month numeric; v_prev numeric;
begin
  perform _ensure_ngn_wallet(me);
  select * into w from ngn_wallets where user_id = me;
  select coalesce(sum(creator_amount_ngn), 0) into v_total from gifts where recipient_id = me;
  select coalesce(sum(creator_amount_ngn), 0) into v_month from gifts where recipient_id = me and created_at >= month_start;
  select coalesce(sum(creator_amount_ngn), 0) into v_prev from gifts where recipient_id = me and created_at >= prev_start and created_at < month_start;
  return jsonb_build_object(
    'availableNgn', w.earnings::text, 'totalEarnedNgn', v_total::text, 'thisMonthNgn', v_month::text,
    'monthDelta', case when v_prev > 0 then case when v_month >= v_prev then '+' else '' end || round((v_month - v_prev) * 100 / v_prev) || '% vs last month' else 'This calendar month' end,
    'totalGifts', (select count(*) from gifts where recipient_id = me),
    'supporters', (select count(distinct sender_id) from gifts where recipient_id = me),
    'byAsset', coalesce((select jsonb_agg(jsonb_build_object('asset', 'NGN', 'count', cnt, 'paidLabel', _fmt_ngn(paid), 'creatorNgn', creator::text))
      from (select count(*) cnt, sum(amount_ngn) paid, sum(creator_amount_ngn) creator from gifts where recipient_id = me having count(*) > 0) x), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'createdAt', g.created_at, 'amountNgn', g.creator_amount_ngn::text, 'amountLabel', '+' || _fmt_ngn(g.creator_amount_ngn),
        'giftLabel', _fmt_ngn(g.amount_ngn), 'sourceAsset', 'NGN', 'paidLabel', _fmt_ngn(g.amount_ngn),
        'from', (select author_json(p) from profiles p where p.id = g.sender_id),
        'post', (select jsonb_build_object('id', p.id, 'text', p.text) from posts p where p.id = g.post_id),
        'reference', g.reference) order by g.created_at desc)
      from (select * from gifts where recipient_id = me order by created_at desc limit 50) g), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'method', 'BANK', 'asset', 'NGN', 'amountLabel', _fmt_ngn(x.payout), 'valueLabel', _fmt_ngn(x.amount),
        'status', upper(x.status), 'reference', x.reference, 'createdAt', x.created_at, 'completedAt', x.completed_at) order by x.created_at desc)
      from (select * from withdrawals where user_id = me and source = 'earnings' order by created_at desc limit 20) x), '[]'::jsonb));
end $$;

-- "me" now reports whether the user has a real crypto wallet
create or replace function public.me()
returns jsonb language plpgsql stable set search_path = public as $$
declare pr profiles;
begin
  select * into pr from profiles where id = auth.uid();
  if pr.id is null then perform raise_app_error('UNAUTHENTICATED', 'Your session has expired. Please log in again.'); end if;
  return author_json(pr) || jsonb_build_object(
    'email', auth.jwt() ->> 'email',
    'bio', pr.bio, 'createdAt', pr.created_at, 'location', pr.location, 'website', pr.website,
    'coverImage', pr.cover_path, 'settings', pr.settings, 'walletSecurity', pr.wallet_security,
    'followers', pr.follower_count, 'following', pr.following_count, 'posts', pr.post_count,
    'walletActivated', exists (select 1 from crypto_wallets c where c.user_id = pr.id and c.status = 'ready'),
    'unreadNotifications', (select count(*) from notifications where user_id = pr.id and not read),
    'unreadMessages', unread_message_count());
end $$;

-- ════════════════════════════ PRIVILEGES ═══════════════════════════
alter table public.app_settings enable row level security;
alter table public.ngn_wallets enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.withdrawals enable row level security;
alter table public.gifts enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.crypto_wallets enable row level security;
alter table public.crypto_transactions enable row level security;

revoke all on public.app_settings, public.ngn_wallets, public.ledger_entries, public.payments, public.webhook_events,
              public.bank_accounts, public.withdrawals, public.gifts, public.idempotency_keys,
              public.crypto_wallets, public.crypto_transactions from anon, authenticated;

grant select on public.ngn_wallets, public.ledger_entries, public.payments, public.bank_accounts, public.withdrawals,
                public.gifts, public.crypto_wallets, public.crypto_transactions to authenticated;
create policy "ngn_wallets: own" on public.ngn_wallets for select to authenticated using (user_id = auth.uid());
create policy "ledger: own" on public.ledger_entries for select to authenticated using (user_id = auth.uid());
create policy "payments: own" on public.payments for select to authenticated using (user_id = auth.uid());
create policy "bank_accounts: own" on public.bank_accounts for select to authenticated using (user_id = auth.uid());
create policy "withdrawals: own" on public.withdrawals for select to authenticated using (user_id = auth.uid());
create policy "gifts: sender or recipient" on public.gifts for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "crypto_wallets: own" on public.crypto_wallets for select to authenticated using (user_id = auth.uid());
create policy "crypto_tx: own" on public.crypto_transactions for select to authenticated using (user_id = auth.uid());

-- Lock all functions, then open exactly what each role needs
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.raise_app_error(text, text), public.author_json(public.profiles), public.excerpt(text, int),
  public.poll_json(uuid), public.post_json(public.posts), public.is_conversation_member(uuid, uuid), public.unread_message_count(),
  public.try_uuid(text),
  public.feed(text, int, int), public.post_detail(uuid), public.user_posts(uuid, text), public.comments_list(uuid),
  public.create_post(text, jsonb, text, jsonb), public.post_counts(uuid),
  public.profile_view(text), public.follow_list(uuid, text), public.suggested_users(int), public.search(text),
  public.trending(int), public.bookmarks_list(), public.gift_wall(uuid), public.stories_feed(), public.communities_list(),
  public.notifications_list(text), public.me(), public.username_available(text),
  public.start_conversation(uuid), public.conversations_list(), public.conversation_view(uuid), public.mark_conversation_read(uuid),
  public.update_wallet_security(text, boolean),
  public.gift_config(), public.gift_quote(jsonb), public.send_gift(jsonb, uuid), public.transfer_ngn(text, text, text, uuid),
  public.move_earnings_to_balance(text, uuid), public.wallet_overview(), public.wallet_activity(text, int),
  public.withdrawal_status(text), public.payment_status(text), public.gifts_list(text), public.earnings_summary()
to authenticated;
grant execute on function public.username_available(text), public.gift_config(), public.raise_app_error(text, text) to anon;

grant execute on function
  public.svc_payment_create(uuid, text, numeric, text), public.svc_payment_settle(text, text, bigint, text, text, timestamptz),
  public.svc_webhook_seen(text, text, text, text), public.svc_bank_account_upsert(uuid, text, text, text, text, text),
  public.svc_withdrawal_create(uuid, text, numeric, uuid, text, uuid), public.svc_withdrawal_update(text, text, text, text),
  public.svc_crypto_wallet_upsert(uuid, text, text, text, text, text, text, text),
  public.svc_crypto_tx_begin(uuid, uuid, text, text, text, text, text, text), public.svc_crypto_tx_update(uuid, text, text, text, text),
  public.svc_ledger_check(), public.svc_crypto_wallet_get(uuid), public.svc_crypto_tx_get(uuid, uuid),
  public.svc_reconcile_candidates()
to service_role;

-- ===== 20261018000300_live_sessions.sql =====
-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 012 · Live sessions (real data only)
--  • sessions are created/ended by their host
--  • viewers = users whose client heartbeat is < 45 s old (presence)
--  • chat messages are persisted; gift events are inserted ONLY by send_gift()
--  • no counts are ever invented: everything is computed from rows
-- Video streaming needs a media provider (not part of this migration).
-- ════════════════════════════════════════════════════════════════════

create table public.live_sessions (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 3 and 100),
  status      text not null default 'live' check (status in ('live', 'ended')),
  viewer_peak integer not null default 0 check (viewer_peak >= 0),
  gift_total  numeric(20, 2) not null default 0 check (gift_total >= 0),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create unique index live_one_per_host on public.live_sessions (host_id) where status = 'live';
create index live_status_started_idx on public.live_sessions (status, started_at desc);

alter table public.gifts add constraint gifts_live_session_fk foreign key (live_session_id) references public.live_sessions (id) on delete set null;

create table public.live_viewers (
  session_id   uuid not null references public.live_sessions (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index live_viewers_seen_idx on public.live_viewers (session_id, last_seen_at desc);

create table public.live_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind       text not null default 'TEXT' check (kind in ('TEXT', 'GIFT')),
  body       text not null check (char_length(btrim(body)) between 1 and 300),
  gift_id    uuid references public.gifts (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint live_gift_has_gift check ((kind = 'GIFT') = (gift_id is not null))
);
create index live_messages_session_created_idx on public.live_messages (session_id, created_at desc);
create trigger live_messages_rate before insert on public.live_messages for each row execute function public.tg_rate_limit('user_id', '30', '1 minute');

alter table public.live_sessions enable row level security;
alter table public.live_viewers enable row level security;
alter table public.live_messages enable row level security;
revoke all on public.live_sessions, public.live_viewers, public.live_messages from anon, authenticated;

grant select on public.live_sessions, public.live_viewers, public.live_messages to authenticated;
grant insert (session_id, user_id, body) on public.live_messages to authenticated;
grant delete on public.live_messages to authenticated;
create policy "live_sessions: read" on public.live_sessions for select to authenticated using (true);
create policy "live_viewers: read" on public.live_viewers for select to authenticated using (true);
create policy "live_messages: read" on public.live_messages for select to authenticated using (true);
create policy "live_messages: chat in a live session as self" on public.live_messages for insert to authenticated
  with check (user_id = auth.uid() and kind = 'TEXT'
              and exists (select 1 from public.live_sessions s where s.id = session_id and s.status = 'live'));
create policy "live_messages: delete own text" on public.live_messages for delete to authenticated
  using (user_id = auth.uid() and kind = 'TEXT');

create or replace function public._live_active_count(p_session uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from live_viewers where session_id = p_session and last_seen_at > now() - interval '45 seconds'
$$;

create or replace function public._live_json(s public.live_sessions)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'title', s.title, 'status', s.status, 'startedAt', s.started_at, 'endedAt', s.ended_at,
    'host', (select author_json(p) from profiles p where p.id = s.host_id),
    'viewers', _live_active_count(s.id), 'viewerPeak', s.viewer_peak, 'giftTotal', s.gift_total::text,
    'isHost', s.host_id = auth.uid())
$$;

create or replace function public.start_live(p_title text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); s live_sessions;
begin
  if exists (select 1 from live_sessions where host_id = me and status = 'live') then
    perform raise_app_error('ALREADY_LIVE', 'You already have a live session. End it before starting another.');
  end if;
  if (select count(*) from live_sessions where host_id = me and started_at > now() - interval '1 hour') >= 10 then
    perform raise_app_error('RATE_LIMITED', 'Too many live sessions started. Please wait a while.');
  end if;
  insert into live_sessions (host_id, title) values (me, btrim(coalesce(p_title, ''))) returning * into s;
  insert into live_viewers (session_id, user_id) values (s.id, me);
  return _live_json(s);
end $$;

create or replace function public.end_live(p_session uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s live_sessions;
begin
  update live_sessions set status = 'ended', ended_at = now()
  where id = p_session and host_id = _uid() and status = 'live' returning * into s;
  if s.id is null then perform raise_app_error('FORBIDDEN', 'Only the host can end a live session.'); end if;
  return _live_json(s);
end $$;

-- Presence heartbeat (client calls every ~20 s while the room is open)
create or replace function public.live_heartbeat(p_session uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := _uid(); s live_sessions; n int;
begin
  select * into s from live_sessions where id = p_session;
  if s.id is null then perform raise_app_error('NOT_FOUND', 'Live session not found.'); end if;
  if s.status = 'live' then
    insert into live_viewers (session_id, user_id) values (p_session, me)
    on conflict (session_id, user_id) do update set last_seen_at = now();
    n := _live_active_count(p_session);
    if n > s.viewer_peak then update live_sessions set viewer_peak = n where id = p_session returning * into s; end if;
  end if;
  return live_view(p_session);
end $$;

create or replace function public.live_leave(p_session uuid)
returns void language sql security definer set search_path = public as $$
  delete from live_viewers where session_id = p_session and user_id = _uid()
$$;

create or replace function public.live_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(_live_json(s) order by s.started_at desc), '[]'::jsonb)
  from (select * from live_sessions where status = 'live' order by started_at desc limit 20) s
$$;

create or replace function public.live_view(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s live_sessions;
begin
  select * into s from live_sessions where id = p_session;
  if s.id is null then perform raise_app_error('NOT_FOUND', 'Live session not found.'); end if;
  return _live_json(s) || jsonb_build_object(
    'viewerList', coalesce((select jsonb_agg(author_json(p) order by v.joined_at) from live_viewers v join profiles p on p.id = v.user_id
                            where v.session_id = s.id and v.last_seen_at > now() - interval '45 seconds'), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'body', m.body, 'createdAt', m.created_at,
                            'user', (select author_json(p) from profiles p where p.id = m.user_id),
                            'giftAmount', (select g.amount_ngn::text from gifts g where g.id = m.gift_id)) order by m.created_at)
                          from (select * from live_messages where session_id = s.id order by created_at desc limit 100) m), '[]'::jsonb));
end $$;

grant execute on function public.start_live(text), public.end_live(uuid), public.live_heartbeat(uuid), public.live_leave(uuid),
  public.live_list(), public.live_view(uuid) to authenticated;
revoke execute on function public._live_active_count(uuid), public._live_json(public.live_sessions) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.live_messages;
    alter publication supabase_realtime add table public.live_sessions;
  end if;
end $$;
