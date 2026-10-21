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
