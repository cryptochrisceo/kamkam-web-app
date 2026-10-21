-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 005 · Privileges & Row Level Security
-- Principle: deny by default, then grant the minimum per table/column.
-- ════════════════════════════════════════════════════════════════════

-- 0. Start from zero (Supabase grants broad defaults to anon/authenticated)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Size guard for user-controlled JSON
alter table public.profiles add constraint profiles_settings_size check (pg_column_size(settings) < 4000);

-- 1. Enable RLS on every table
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ── Reference data (read-only) ─────────────────────────────────────
grant select on public.assets, public.networks, public.asset_networks to anon, authenticated;
create policy "reference: read" on public.assets for select using (true);
create policy "reference: read" on public.networks for select using (true);
create policy "reference: read" on public.asset_networks for select using (true);
-- app_config is read through gift_config()/wallet_summary() only.

-- ── Profiles ───────────────────────────────────────────────────────
grant select on public.profiles to authenticated;
grant update (display_name, bio, avatar_path, cover_path, location, website, settings) on public.profiles to authenticated;
create policy "profiles: read" on public.profiles for select to authenticated using (true);
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ── Posts & media & polls ──────────────────────────────────────────
grant select on public.posts to authenticated;
grant insert (author_id, text, reply_policy, has_poll) on public.posts to authenticated;
grant update (text, reply_policy) on public.posts to authenticated;
grant delete on public.posts to authenticated;
create policy "posts: read" on public.posts for select to authenticated using (true);
create policy "posts: create own" on public.posts for insert to authenticated with check (author_id = auth.uid());
create policy "posts: edit own" on public.posts for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "posts: delete own" on public.posts for delete to authenticated using (author_id = auth.uid());

grant select on public.post_media to authenticated;
grant insert (post_id, path, kind, position) on public.post_media to authenticated;
create policy "post_media: read" on public.post_media for select to authenticated using (true);
create policy "post_media: add to own post from own folder" on public.post_media for insert to authenticated
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
    and path like 'post-media/' || auth.uid()::text || '/%');

grant select on public.poll_options to authenticated;
grant insert (post_id, position, label) on public.poll_options to authenticated;
create policy "poll_options: read" on public.poll_options for select to authenticated using (true);
create policy "poll_options: add to own poll" on public.poll_options for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid() and p.has_poll));

grant select, insert (post_id, option_id, user_id) on public.poll_votes to authenticated;
create policy "poll_votes: read own" on public.poll_votes for select to authenticated using (user_id = auth.uid());
create policy "poll_votes: vote as self" on public.poll_votes for insert to authenticated with check (user_id = auth.uid());

-- ── Comments ───────────────────────────────────────────────────────
grant select, delete on public.comments to authenticated;
grant insert (post_id, parent_id, text, author_id) on public.comments to authenticated;
create policy "comments: read" on public.comments for select to authenticated using (true);
create policy "comments: create as self" on public.comments for insert to authenticated with check (author_id = auth.uid());
create policy "comments: delete own" on public.comments for delete to authenticated using (author_id = auth.uid());

-- ── Likes / reposts / bookmarks (super_like can only be set by send_gift) ──
grant select, delete on public.likes to authenticated;
grant insert (user_id, post_id) on public.likes to authenticated;
create policy "likes: read own" on public.likes for select to authenticated using (user_id = auth.uid());
create policy "likes: like as self" on public.likes for insert to authenticated with check (user_id = auth.uid() and super_like = false);
create policy "likes: unlike own" on public.likes for delete to authenticated using (user_id = auth.uid());

grant select, delete on public.reposts to authenticated;
grant insert (user_id, post_id) on public.reposts to authenticated;
create policy "reposts: read own" on public.reposts for select to authenticated using (user_id = auth.uid());
create policy "reposts: repost as self" on public.reposts for insert to authenticated with check (user_id = auth.uid());
create policy "reposts: undo own" on public.reposts for delete to authenticated using (user_id = auth.uid());

grant select, delete on public.bookmarks to authenticated;
grant insert (user_id, post_id) on public.bookmarks to authenticated;
create policy "bookmarks: own only" on public.bookmarks for select to authenticated using (user_id = auth.uid());
create policy "bookmarks: add own" on public.bookmarks for insert to authenticated with check (user_id = auth.uid());
create policy "bookmarks: remove own" on public.bookmarks for delete to authenticated using (user_id = auth.uid());

-- ── Follows (public graph) ─────────────────────────────────────────
grant select, delete on public.follows to authenticated;
grant insert (follower_id, following_id) on public.follows to authenticated;
create policy "follows: read" on public.follows for select to authenticated using (true);
create policy "follows: follow as self" on public.follows for insert to authenticated with check (follower_id = auth.uid());
create policy "follows: unfollow own" on public.follows for delete to authenticated using (follower_id = auth.uid());

-- ── Stories ────────────────────────────────────────────────────────
grant select, delete on public.stories to authenticated;
grant insert (author_id, text, media_path, media_kind) on public.stories to authenticated;
create policy "stories: read active" on public.stories for select to authenticated using (expires_at > now() or author_id = auth.uid());
create policy "stories: post own" on public.stories for insert to authenticated
  with check (author_id = auth.uid() and (media_path is null or media_path like 'post-media/' || auth.uid()::text || '/%'));
create policy "stories: delete own" on public.stories for delete to authenticated using (author_id = auth.uid());

-- ── Communities ────────────────────────────────────────────────────
grant select on public.communities to authenticated;
grant insert (name, description, color, created_by) on public.communities to authenticated;
grant delete on public.communities to authenticated;
create policy "communities: read" on public.communities for select to authenticated using (true);
create policy "communities: create as self" on public.communities for insert to authenticated with check (created_by = auth.uid());
create policy "communities: delete own" on public.communities for delete to authenticated using (created_by = auth.uid());

grant select, delete on public.community_members to authenticated;
grant insert (community_id, user_id) on public.community_members to authenticated;
create policy "community_members: read" on public.community_members for select to authenticated using (true);
create policy "community_members: join as self" on public.community_members for insert to authenticated with check (user_id = auth.uid());
create policy "community_members: leave own" on public.community_members for delete to authenticated using (user_id = auth.uid());

-- ── Messaging (members only) ───────────────────────────────────────
grant select on public.conversations to authenticated;
create policy "conversations: members read" on public.conversations for select to authenticated
  using (public.is_conversation_member(id));

grant select on public.conversation_members to authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;
create policy "conversation_members: members read" on public.conversation_members for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy "conversation_members: mark own read" on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.messages to authenticated;
grant insert (conversation_id, sender_id, kind, body, attachment_path) on public.messages to authenticated;
create policy "messages: members read" on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));
create policy "messages: send as self to own conversation" on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and kind in ('TEXT', 'IMAGE', 'AUDIO')
    and public.is_conversation_member(conversation_id)
    and (attachment_path is null or attachment_path like 'message-attachments/' || conversation_id::text || '/' || auth.uid()::text || '/%'));

-- ── Notifications (created only by trusted code) ───────────────────
grant select, delete on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;
create policy "notifications: read own" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notifications: mark own read" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notifications: delete own" on public.notifications for delete to authenticated using (user_id = auth.uid());

-- ── Wallet & money: READ OWN ONLY. No client writes, ever. ─────────
grant select on public.wallets, public.wallet_assets, public.wallet_transactions, public.gifts, public.creator_earnings,
                public.withdrawals, public.deposits, public.swaps, public.buy_transactions, public.sell_transactions to authenticated;
create policy "wallets: read own" on public.wallets for select to authenticated using (user_id = auth.uid());
create policy "wallet_assets: read own" on public.wallet_assets for select to authenticated using (user_id = auth.uid());
create policy "wallet_transactions: read own" on public.wallet_transactions for select to authenticated using (user_id = auth.uid());
create policy "gifts: sender or recipient" on public.gifts for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "creator_earnings: read own" on public.creator_earnings for select to authenticated using (user_id = auth.uid());
create policy "withdrawals: read own" on public.withdrawals for select to authenticated using (user_id = auth.uid());
create policy "deposits: read own" on public.deposits for select to authenticated using (user_id = auth.uid());
create policy "swaps: read own" on public.swaps for select to authenticated using (user_id = auth.uid());
create policy "buys: read own" on public.buy_transactions for select to authenticated using (user_id = auth.uid());
create policy "sells: read own" on public.sell_transactions for select to authenticated using (user_id = auth.uid());
-- platform_fees, idempotency_keys, app_config: RLS on, no policies, no grants → no client access.

-- ── Function privileges ────────────────────────────────────────────
-- Public API (signed-in users)
grant execute on function
  public.raise_app_error(text, text), public.author_json(public.profiles), public.excerpt(text, int),
  public.poll_json(uuid), public.post_json(public.posts), public.is_conversation_member(uuid, uuid),
  public.unread_message_count(),
  public.feed(text, int, int), public.post_detail(uuid), public.user_posts(uuid, text), public.comments_list(uuid),
  public.create_post(text, jsonb, text, jsonb), public.post_counts(uuid),
  public.profile_view(text), public.follow_list(uuid, text), public.suggested_users(int), public.search(text),
  public.trending(int), public.bookmarks_list(), public.gift_wall(uuid), public.stories_feed(), public.communities_list(),
  public.notifications_list(text), public.me(),
  public.start_conversation(uuid), public.conversations_list(), public.conversation_view(uuid), public.mark_conversation_read(uuid),
  public.wallet_quote(text, jsonb), public.wallet_execute(text, jsonb, uuid),
  public.gift_quote(jsonb), public.send_gift(jsonb, uuid), public.gift_config(),
  public.activate_wallet(), public.settle_due(), public.wallet_summary(), public.wallet_transactions_list(text, int),
  public.transaction_by_reference(text), public.receive_address(text, text), public.gifts_list(text), public.earnings_summary(),
  public.update_wallet_security(text, boolean)
to authenticated;

-- Anonymous: only what the sign-up / landing screens need
grant execute on function public.username_available(text), public.gift_config(), public.raise_app_error(text, text) to anon;

-- Everything prefixed with "_" (ledger, credit/debit, settlement internals) stays private.
