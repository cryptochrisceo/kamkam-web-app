# Legacy local API (not used)

This Express + Prisma server powered the first local MVP. KAMKAM now runs entirely on **Supabase** (`supabase/migrations/`), and the frontend no longer calls this API.

It is kept only as a reference for the original business logic. It is safe to delete this folder once you are happy with the Supabase version (`npm run legacy:dev` still starts it if you need to compare).
