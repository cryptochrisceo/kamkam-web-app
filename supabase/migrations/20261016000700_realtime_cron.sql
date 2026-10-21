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
