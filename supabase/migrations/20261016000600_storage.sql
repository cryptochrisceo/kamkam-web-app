-- ════════════════════════════════════════════════════════════════════
-- KAMKAM · 006 · Storage buckets & policies
--   avatars              public  · 5 MB  · images      · <uid>/...
--   post-media           public  · 50 MB · image/video · <uid>/...
--   message-attachments  PRIVATE · 10 MB · image/audio · <conversation_id>/<uid>/...
-- Database columns store "<bucket>/<object path>".
-- ════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('post-media', 'post-media', true, 52428800,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']),
  ('message-attachments', 'message-attachments', false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'])
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;
grant execute on function public.try_uuid(text) to authenticated;

-- Public buckets: anyone may read via the public URL; only the owner writes in their own folder.
create policy "kamkam public media: owner read" on storage.objects for select to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner update" on storage.objects for update to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kamkam public media: owner delete" on storage.objects for delete to authenticated
  using (bucket_id in ('avatars', 'post-media') and (storage.foldername(name))[1] = auth.uid()::text);

-- Private DM attachments: only conversation members can read (via signed URLs);
-- a member may upload only into <conversation>/<own uid>/.
create policy "kamkam dm attachments: members read" on storage.objects for select to authenticated
  using (bucket_id = 'message-attachments'
         and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1])));
create policy "kamkam dm attachments: member upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'message-attachments'
              and (storage.foldername(name))[2] = auth.uid()::text
              and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1])));
create policy "kamkam dm attachments: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'message-attachments' and (storage.foldername(name))[2] = auth.uid()::text);
