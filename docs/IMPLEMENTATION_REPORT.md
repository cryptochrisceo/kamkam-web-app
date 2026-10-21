# Supabase migration — implementation report

## 1. What existed before

| Area | Before | Now |
|---|---|---|
| Frontend | Next.js 15 + TypeScript + Tailwind, all data through `frontend/lib/api.ts` | Same UI; `lib/api.ts` re-implemented on `supabase-js` with the same functions & response shapes |
| Backend | Express + Prisma + local PostgreSQL, JWT cookie auth | Supabase Postgres + Auth + Storage + Realtime. Express app kept in `backend/` as legacy reference (unused) |
| State | React context (`AppProvider`) + shared post store | Unchanged, plus Supabase Auth session events & Realtime |
| Browser-only data | Communities (localStorage), wallet security toggles (memory) | Persisted in the database |
| Placeholders | Poll button, DM image & voice buttons, Create community, security rows | All functional (or explicitly labelled "not available yet") |
| Wallet | Demo ledger (honestly labelled) | Same behaviour, now enforced in Postgres; still demo |

## 2. Feature checklist

| Feature | Status |
|---|---|
| Register / login / logout / session persistence / expiry handling | ✅ Supabase Auth |
| Email verification, password reset | ✅ pages `/auth/callback`, `/forgot-password`, `/reset-password` (emails need SMTP on your project) |
| Profile: name, bio, location, website, avatar, cover, counts | ✅ |
| Posts: text, images (≤4), video, polls, edit, delete | ✅ |
| Feeds: For You (with gift boost), Following, Trending, pagination | ✅ |
| Likes, comments + replies, reposts, bookmarks, shares | ✅ |
| Follow / unfollow, followers / following lists | ✅ |
| Search users & posts, explore, trending hashtags | ✅ |
| Stories (24h, text/photo/video, reply by DM, gift) | ✅ new table |
| Communities: list, join/leave, create | ✅ moved to DB |
| Notifications (follow, like, comment, repost, message, gift, wallet), read state, realtime badges | ✅ trigger-generated only |
| Settings toggles enforced (DM privacy, gift alerts, reply notifications, supporter wall) | ✅ |
| DMs: create, list, history, read receipts, unread counts, realtime, private photo & voice notes | ✅ |
| Gifts ₦200/₦500/₦2,000/₦3,000/custom, pay with NGN/USDT/BNB/ETH/SOL, 80/20, Super Like, boost, idempotent | ✅ |
| Creator earnings dashboard + withdrawals (KAMKAM wallet / external / bank) | ✅ demo settlement |
| Wallet: buy, sell, swap, send, receive, deposit, withdraw, transfer, history | ✅ demo mode |
| Live streaming | ⚠️ labelled preview |

## 3. Files

**New**
- `supabase/migrations/2026101600{0100…0900}_*.sql` — 9 migrations (schema, wallet schema, social functions, wallet functions, RLS, storage, realtime/cron, settings enforcement, grant fix)
- `supabase/config.toml`
- `supabase/tests/` — `shim.sql`, `harness.mjs`, `run-db-tests.mjs` (131 tests), `local-stack.mjs`, `get-postgrest.mjs`
- `supabase/seed/seed-staging.mjs`
- `frontend/lib/supabase.ts`, `frontend/tests/api-client.test.mts` (53 tests)
- `frontend/app/auth/callback/page.tsx`, `frontend/app/forgot-password/page.tsx`, `frontend/app/reset-password/page.tsx`
- `scripts/run-api-tests.mjs`, `docs/*.md`

**Changed (UI preserved)**
- `frontend/lib/api.ts` — rewritten on supabase-js, same surface + new calls
- `frontend/components/AppProvider.tsx` — Supabase session + Realtime
- `frontend/components/AuthForm.tsx` — email login, confirmation, forgot/reset modes
- `frontend/components/Composer.tsx` — real polls, story mode, retry-safe
- `frontend/components/PostCard.tsx` — poll block (from the original design), edit post, "edited"
- `frontend/components/StoryViewer.tsx` — real stories
- `frontend/components/GiftSheet.tsx`, `WalletFlows.tsx` — idempotency keys
- `frontend/components/Shell.tsx` — honest Live preview copy
- `frontend/app/(main)/{page, messages, communities, wallet, settings, post/[id], profile/[username]}` — wiring
- `frontend/types/index.ts`, `frontend/next.config.ts` (security headers), `frontend/.env.example`
- Root `package.json`, `.gitignore`, `README.md`

## 4. Tests performed (all passing)

| Suite | Command | Result |
|---|---|---|
| Database / RLS / money (3 users, real PostgREST-style role switching) | `npm run test:db` | **131 / 131** |
| Frontend data layer through supabase-js → PostgREST 16 → RLS | `npm run test:api` | **53 / 53** |
| Two-user browser journey (Edge, production build, CSP on) | scratch Playwright script | **18 / 18**, 0 console errors |
| Type check + production build | `npm run typecheck`, `npm run build` | ✅ |

Highlights covered: forged identities, cross-user reads/writes, protected columns, self-awarded Super Likes, forged notifications/gifts/ledger rows, internal function access, storage folder isolation, private attachment access, duplicate gift submission, concurrent double-spend, exact 80/20 for ₦1,000 and odd amounts, insufficient funds with no partial writes, settlement Pending → Processing → Completed, demo-mode lock, append-only ledger.

**Not testable here** (no Docker/Supabase account on this machine): the hosted Supabase Auth email flows, Supabase's own Storage server, Realtime websockets, and the live deployment. The local stack uses the real PostgREST and the real migrations/RLS, with a minimal stand-in for Auth/Storage. These must be verified on your staging project (`docs/DEPLOYMENT.md §4`).
