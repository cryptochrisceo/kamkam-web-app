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

1. Push the repo to GitHub/GitLab (make sure `.env.local` is **not** committed — `.gitignore` covers it).
2. https://vercel.com/new → import the repo.
3. **Root Directory:** `frontend` · Framework: **Next.js** (auto) · Build: `next build` · Output: default.
4. **Environment Variables** (Settings → Environment Variables):

| Name | Production | Preview |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | production project URL | staging project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | production anon key | staging anon key |
| `NEXT_PUBLIC_SHOW_DEMO_LOGIN` | `false` | `true` (optional) |

Never add the `service_role` key or database password to Vercel.

5. Deploy. Then **Settings → Domains** → add your domain (e.g. `kamkam.app`) and follow the DNS instructions. HTTPS is automatic.

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
4. Second account: follow, like, reply, DM with a photo, gift ₦200 in Naira, create wallet, gift in USDT.
5. First account: notifications arrive (instantly via Realtime), earnings show 80%, withdraw → Pending → Processing → Completed.
6. Check the browser console has no errors and response headers include `Content-Security-Policy`.

Only after this passes on the production domain is the site **live and verified**.

## Rollback

Vercel → Deployments → previous deployment → **Promote to Production**. Database migrations are additive; if one must be reverted, write a new migration that undoes it (test with `npm run test:db` first).

## Costs at 50–500 users

Supabase Free tier covers ~500 MB database and 1 GB storage but pauses after a week of inactivity — use **Pro** for production. Vercel Hobby is fine for a launch; Pro if the team grows. Add an SMTP provider (often free under a few thousand emails/month).
