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
