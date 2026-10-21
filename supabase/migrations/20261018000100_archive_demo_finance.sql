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
