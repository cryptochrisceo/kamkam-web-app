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
