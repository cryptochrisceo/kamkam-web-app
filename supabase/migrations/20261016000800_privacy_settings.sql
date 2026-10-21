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