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
