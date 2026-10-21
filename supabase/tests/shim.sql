-- ════════════════════════════════════════════════════════════════════
-- LOCAL TEST SHIM — emulates the parts of a Supabase database that the
-- KAMKAM migrations depend on, so migrations + RLS can be tested on a plain
-- PostgreSQL. NEVER run this against a real Supabase project.
-- Mirrors: roles, auth.uid()/jwt(), auth.users, storage.buckets/objects,
-- storage.foldername(), supabase_realtime publication, default privileges.
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, extensions to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;

-- ── auth ───────────────────────────────────────────────────────────
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  aud                text default 'authenticated',
  role               text default 'authenticated',
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
grant select on auth.users to service_role;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claim.role', true),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- ── storage ────────────────────────────────────────────────────────
create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  owner              uuid,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create table storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text not null,
  owner            uuid default auth.uid(),
  owner_id         text default auth.uid()::text,
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
create policy "buckets readable" on storage.buckets for select using (true);
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant all on storage.buckets to service_role;

create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ── realtime ───────────────────────────────────────────────────────
create publication supabase_realtime;

-- ── Supabase-style default privileges for objects created by migrations ──
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
