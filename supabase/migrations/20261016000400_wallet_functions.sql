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
