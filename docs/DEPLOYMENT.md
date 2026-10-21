# Deploying KAMKAM

- **Frontend:** Next.js app in `frontend/` → **Vercel** (recommended; first-class Next.js support, free tier is enough for 50–500 users). Netlify also works.
- **Backend:** Supabase (see `docs/SUPABASE_SETUP.md`). There is no separate server to host.

> Nothing is deployed automatically. Each step below is something you run or click, so you stay in control of production.

## Environments

| | Supabase project | Vercel | Data |
|---|---|---|---|
| Development | local test stack or `kamkam-staging` | `npm run dev` | throwaway |
| Staging | `kamkam-staging` | Preview deployments / `staging` branch | demo seed allowed |
| Production | `kamkam-production` | Production deployment | real users only |

## 1. Build check (local)

```bash
npm run install:all
npm run typecheck
npm run build          # next build — must succeed with zero errors
```

## 2. Vercel project

0. **Database first:** if your Supabase project ran the older `APPLY_ALL_MIGRATIONS.sql`, run `supabase/UPGRADE_20261018_REAL_FINANCE.sql` in the SQL Editor before deploying. Without it, the wallet page errors.
1. Push the repo to GitHub/GitLab. `.gitignore` keeps `.env.local` and the other `.env` files out of the commit.
2. https://vercel.com/new → import the repo.
3. **Root Directory:** `frontend` · Framework: **Next.js** (auto) · Build: `next build` · Output: default.
4. **Environment Variables** (Settings → Environment Variables):

| Name | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | project URL | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | public |
| `NEXT_PUBLIC_SHOW_DEMO_LOGIN` | `false` | |
| `APP_URL` | `https://<your-domain or project>.vercel.app` | Paystack callback base |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key | **secret**: server routes only |
| `CRON_SECRET` | long random string | secret |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` first | secret, optional |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | from portal.cdp.coinbase.com | secret, optional |
| `CRYPTO_NETWORK_MODE` | `testnet` | |

Server secrets are read only by `frontend/lib/server/*` (guarded by `server-only`) and never reach the browser. Never give them a `NEXT_PUBLIC_` prefix, and never add the database password. Without Paystack or CDP keys, those features show "Not available yet".

5. Deploy. Then **Settings → Domains** → add your domain (e.g. `kamkam.app`) and follow the DNS instructions. HTTPS is automatic. If the domain changes, update `APP_URL` and redeploy.
6. Paystack (once keys are set): Dashboard → Settings → API Keys & Webhooks → webhook URL `https://<domain>/api/payments/webhook`.
7. Cron: `vercel.json` runs `/api/cron/reconcile` daily, the limit on Vercel Hobby. On Pro, change the schedule to `*/10 * * * *`.

## 3. Point Supabase Auth at the live URL

Supabase → Authentication → URL Configuration:
- Site URL: `https://kamkam.app`
- Redirect URLs: `https://kamkam.app/auth/callback`, `https://kamkam.app/reset-password`
- (Staging project: your preview URL pattern, e.g. `https://*-yourteam.vercel.app/**`)

The app never hardcodes URLs: email links are built from the current origin and must match this allow-list.

## 4. Verify the live site

Use two real accounts (two browsers):

1. Register → confirmation email arrives → link opens `/auth/callback` → signed in.
2. Forgot password → email → `/reset-password` → new password works.
3. Post with an image; edit it; poll; story; profile + cover photo upload.
4. New account shows ₦0 and no transactions. Second account: follow, like, reply, DM with a photo, start a live room and chat.
5. With Paystack test keys: fund ₦500 with a test card, gift ₦200 (creator earns ₦160), withdraw to a test bank → Processing → Paid. See `docs/REAL_MONEY_SETUP.md` §5.
6. Check the browser console has no errors and response headers include `Content-Security-Policy`.

Only after this passes on the production domain is the site **live and verified**.

## Rollback

Vercel → Deployments → previous deployment → **Promote to Production**. Database migrations are additive; if one must be reverted, write a new migration that undoes it (test with `npm run test:db` first).

## Costs at 50–500 users

Supabase Free tier covers ~500 MB database and 1 GB storage but pauses after a week of inactivity — use **Pro** for production. Vercel Hobby is fine for a launch; Pro if the team grows. Add an SMTP provider (often free under a few thousand emails/month).
