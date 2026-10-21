# Supabase setup

KAMKAM's backend is entirely Supabase: Postgres (schema, Row Level Security, trusted functions), Auth, Storage and Realtime. Everything is defined in `supabase/migrations/` — nothing has to be clicked together by hand except the settings listed in step 4.

Use **two projects**: `kamkam-staging` (demo data, testing with friends) and `kamkam-production` (real users, starts empty). Repeat these steps for each.

---

## 1. Create the project

1. https://supabase.com/dashboard → **New project**.
2. Region: closest to your users (e.g. *West EU (London)* or *Central EU (Frankfurt)* for Nigeria).
3. Save the **database password** in a password manager. You need it for migrations; it never goes in the app.

## 2. Apply the database migrations

**Option A — Supabase CLI (recommended)**

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>     # from the project URL
npx supabase db push                                  # applies supabase/migrations/* in order
```

`db push` shows the list of migrations before applying. On production, read the list and confirm — never run `supabase db reset` against production (it deletes all data).

**Option B — SQL editor**

Dashboard → **SQL Editor** → paste and run each file in `supabase/migrations/` **in filename order** (`…000100_core_schema.sql` first, `…000900_grants_fixups.sql` last).

Migrations create: all tables and indexes · RLS policies · trusted functions · triggers · the 3 storage buckets and their policies · Realtime publication entries · default communities · demo-mode wallet configuration.

## 3. Get the API keys

Dashboard → **Project Settings → API**:

| Value | Where it goes | Secret? |
|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` (frontend host) | No |
| `anon` / publishable key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` (frontend host) | No — protected by RLS |
| `service_role` / secret key | **Only** your own machine, for `supabase/seed/seed-staging.mjs` | **Yes — never in the frontend, never committed** |

## 4. Authentication settings (dashboard)

**Authentication → URL Configuration**
- **Site URL:** `https://your-domain` (production) or your staging URL.
- **Redirect URLs** (add all):
  - `https://your-domain/auth/callback`
  - `https://your-domain/reset-password`
  - `http://localhost:3000/auth/callback`, `http://localhost:3000/reset-password` (staging/dev projects only)

**Authentication → Providers → Email**
- Enable **Email** provider · **Confirm email: ON** · minimum password length **8**.

**Authentication → Emails → SMTP Settings** — *required before public launch.*
Supabase's built-in mailer is for testing only (a handful of emails per hour). Configure a provider (Resend, Postmark, Brevo, AWS SES…) and set the sender (e.g. `no-reply@your-domain`). Customise the *Confirm signup* and *Reset password* templates to mention KAMKAM.

**Authentication → Rate Limits** — defaults are fine for 50–500 users.

## 5. Storage (verify)

Dashboard → **Storage** should show:

| Bucket | Public | Limit | Types | Write access |
|---|---|---|---|---|
| `avatars` | yes | 5 MB | jpg/png/webp/gif | owner folder `<user-id>/…` only |
| `post-media` | yes | 50 MB | images + mp4/webm/mov | owner folder only |
| `message-attachments` | **no** | 10 MB | images + audio | conversation members only; read via signed URLs |

## 6. Realtime & scheduled settlement (verify)

- **Database → Publications → `supabase_realtime`** should include `messages` and `notifications` (added by migration 007).
- **Database → Extensions → `pg_cron`**: enable it, then re-run `supabase/migrations/20261016000700_realtime_cron.sql` in the SQL editor. This settles demo withdrawals every minute even if the user closes the app (otherwise they settle the next time the user opens their wallet).

## 7. Smoke test (SQL editor)

```sql
select count(*) from public.communities;                 -- 6
select value from public.app_config where key = 'wallet_mode';  -- "demo"
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;  -- 0 rows (RLS on everywhere)
```

Then run the app against the project (see `docs/DEPLOYMENT.md`) and the client test suite:

```bash
cd frontend && TEST_AGAINST_ENV=1 npm --prefix .. run test:api    # uses frontend/.env.local; creates test users
```
(Only against staging — it creates accounts. With email confirmation ON, temporarily disable it on staging for this test, or confirm the emails.)

## 8. Staging demo data (optional, staging only)

```bash
cd supabase/seed && npm install
SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… node seed-staging.mjs --yes
```
Creates 6 demo creators (`amaka@kamkam.demo` … password `password123`), posts, follows and likes. It creates no balances or gifts. Set `NEXT_PUBLIC_SHOW_DEMO_LOGIN=true` on the staging deployment only.

---

## Wallet mode

Superseded: the demo wallet was removed on 2026-10-18 and archived into the private `demo_archive` schema. Money now runs through a ledger plus Paystack and Coinbase CDP; see `docs/REAL_MONEY_SETUP.md`.

## Changing the schema later

Add a **new** file in `supabase/migrations/` (never edit applied ones), then:

```bash
npm run test:db           # applies all migrations to a fresh local DB and runs the RLS/money tests
npx supabase db push      # staging first, then production
```
New tables need `alter table … enable row level security`, explicit `grant`s and policies — Supabase gives new tables broad default grants, so a table without RLS would be readable by any signed-in user.
