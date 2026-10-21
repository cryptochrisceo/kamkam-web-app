-- KAMKAM · 009 · Signed-in users may also check username availability
-- (found by the API end-to-end tests: authenticated callers got "permission denied").
grant execute on function public.username_available(text) to authenticated;
