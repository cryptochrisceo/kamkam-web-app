# KAMKAM

**Social media + creator gifts + creator earnings + a (demo) digital wallet.**

```
Browser ── Next.js app (frontend/, hosted on Vercel)
              │  supabase-js with the public anon key only
              ▼
           Supabase
             ├─ Auth        sign-up, login, email confirmation, password reset
             ├─ Postgres    tables + Row Level Security + trusted functions (supabase/migrations)
             ├─ Storage     avatars · post-media (public) · message-attachments (private)
             └─ Realtime    new messages & notifications
```

All rules live in the database: who can read/write what (RLS), and every balance change (gifts, wallet actions) happens inside atomic, idempotent Postgres functions that compute amounts server-side. The browser never decides money.

> **Wallet:** Naira balances come from a server-side ledger and change only through verified Paystack events or atomic database functions. Crypto uses Coinbase CDP server wallets, with balances read live from the chain. Nothing is simulated: features whose provider keys aren't configured show "Not available yet". Setup and verification status are in `docs/REAL_MONEY_SETUP.md`.

## Docs

| | |
|---|---|
| `docs/SUPABASE_SETUP.md` | Create the project, apply migrations, auth/SMTP/storage settings |
| `docs/DEPLOYMENT.md` | Vercel deployment, environments, live verification, rollback |
| `docs/LAUNCH_CHECKLIST.md` | What is done, what you must do before launch, known limitations |
| `docs/IMPLEMENTATION_REPORT.md` | What changed, files, migrations, tests |

## Run it locally

You need Node.js 20+.

**With a Supabase project (recommended):** follow `docs/SUPABASE_SETUP.md` steps 1–4, then

```bash
npm run install:all
cp frontend/.env.example frontend/.env.local     # fill in your project URL + anon key
npm run dev                                      # http://localhost:3000
```

**Without a Supabase account (local test stack, Windows-tested):**

```bash
npm run install:all
npm run local:db            # terminal 1 — bundled PostgreSQL on :5432
npm run local:postgrest     # once — downloads PostgREST
npm run local:supabase      # terminal 2 — Supabase-compatible API on :54321 (fresh database each start)
npm run seed:staging        # optional demo data (needs SUPABASE_URL/ANON/SERVICE env vars, see .local-stack.json)
npm run dev                 # terminal 3 — http://localhost:3000
```

The local stack runs the real migrations behind the real PostgREST; Auth and Storage are minimal stand-ins for testing (no emails, no Realtime).

## Tests

```bash
npm run test:db     # 131 tests: migrations on a fresh DB, RLS, privacy, gifts, wallet, double-spend
npm run test:api    # 53 tests: the real frontend/lib/api.ts against the local stack (or TEST_AGAINST_ENV=1 for .env.local)
npm run build       # production build
```

## Project layout

```
frontend/              Next.js UI (unchanged design) — lib/api.ts is the only data layer
supabase/migrations/   the backend: schema, RLS, functions, storage, realtime
supabase/tests/        DB test harness + local Supabase-compatible stack
supabase/seed/         staging demo seed (never production)
database/              bundled PostgreSQL for local testing
backend/               LEGACY Express API from the first MVP — unused, see backend/LEGACY.md
docs/                  setup, deployment, launch checklist, report
```
