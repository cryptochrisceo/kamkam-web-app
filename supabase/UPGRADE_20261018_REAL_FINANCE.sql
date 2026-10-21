-- KAMKAM upgrade: real finance + live sessions. Paste into Supabase → SQL Editor → Run, ONCE.
-- For a project that already applied the 20261016* migrations (APPLY_ALL_MIGRATIONS.sql from before 2026-10-18).
--
-- WHAT THIS DOES (review before running):
--   • Moves the old DEMO wallet tables (simulated balances, demo transactions, demo gifts) into a private
--     "demo_archive" schema — nothing is deleted; it is no longer readable by app users.
--   • Removes the demo wallet functions (starter money, simulated swaps/buys/sends).
--   • Every user starts at ₦0 in the new ledger-backed Naira wallet. Demo balances are NOT carried over,
--     because they were never backed by real money.
--   • Adds Paystack payments/withdrawals, Coinbase CDP crypto wallet records, live sessions.
-- It runs in a single transaction: if any statement fails, nothing changes.

begin;
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

commit;
