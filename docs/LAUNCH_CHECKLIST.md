# KAMKAM launch checklist

✅ = done and tested in this repository · ⬜ = you must do it (needs your accounts/decisions) · ⚠️ = known limitation

## Code & security (done)
- ✅ All UI data comes from Supabase (no mock arrays; Communities moved off localStorage)
- ✅ RLS enabled on every table; deny-by-default grants; column-level update rights
- ✅ Money only moves inside SECURITY DEFINER functions (atomic, server-side maths, idempotent, rate-limited)
- ✅ Gift split 80/20 enforced by code **and** a database CHECK constraint
- ✅ Balances can never go negative (conditional debits + CHECK constraint); concurrent double-spend tested
- ✅ Ledger rows are append-only (trigger)
- ✅ Recovery phrase generated in the browser only; never sent, stored or logged; API rejects bodies containing one
- ✅ Private DM attachments in a private bucket, read via short-lived signed URLs
- ✅ Security headers (CSP, frame-deny, nosniff, referrer, permissions, HSTS)
- ✅ No secrets in frontend code; `.env*` git-ignored; `.env.example` with placeholders
- ✅ 131 database tests · 53 client API tests · 18-step two-user browser journey — all passing locally
- ✅ Production build passes

## Before going live (you)
- ⬜ Create `kamkam-staging` and `kamkam-production` Supabase projects (Pro plan for production)
- ⬜ `supabase db push` to staging → run `npm run test:api` against staging → run the browser checks in `DEPLOYMENT.md §4`
- ⬜ Configure SMTP (custom sender) and email templates
- ⬜ Set Site URL + redirect URLs on both projects
- ⬜ Enable `pg_cron` and re-run migration 007 (offline settlement of demo withdrawals)
- ⬜ Deploy to Vercel with the production env vars; add your domain
- ⬜ Run the live verification with two real accounts on the production domain
- ⬜ Publish Terms of Service & Privacy Policy (the footer references them) — include that the wallet is a **demo** and holds no real money
- ⬜ Decide a moderation process: currently users can delete only their own content; add a report/remove flow or moderate via the Supabase dashboard
- ⬜ Turn on Supabase backups (Pro includes daily backups) and note how to restore
- ⬜ Add an uptime monitor (e.g. Better Stack, UptimeRobot) for the domain

## Real money — NOT available (by design)
- ⚠️ Real-money wallet code is in place. Paystack and Coinbase CDP are **not yet verified with real credentials**, and live keys require the legal/KYC items in `docs/REAL_MONEY_SETUP.md` §6. Apply `supabase/UPGRADE_20261018_REAL_FINANCE.sql` first.
- ⚠️ Enabling real money requires, at minimum: a licensed payment processor (e.g. Paystack/Flutterwave) with server-side webhook verification; a custody/wallet provider for crypto (no keys on KAMKAM servers); live price feeds; KYC/AML; CBN/SEC Nigeria regulatory review; reconciliation and refunds. Do not switch `wallet_mode` until those exist — the functions deliberately refuse to run in any other mode.
- ⚠️ Demo deposits are capped at ₦1,000,000 per user per day so demo money can't be farmed endlessly.

## Other known limitations
- ⚠️ Live streaming is a design preview (sample content, clearly labelled); live gifting arrives with streaming.
- ⚠️ Wallet PIN and biometric (Face ID) need a native app — shown as "not available yet".
- ⚠️ Receive addresses are deterministic **demo** addresses (not derived from the recovery phrase). Funds sent to them on a real chain would be lost — the UI warns about this.
- ⚠️ Feed ranking is computed per request — fine for 500 users; revisit (materialised scores) beyond ~50k posts.
- ⚠️ Push notifications (phone/browser) are not implemented; in-app notifications are realtime.
- ⚠️ The local test stack (`supabase/tests/local-stack.mjs`) emulates Supabase Auth/Storage for testing only; email confirmation, password-reset emails and Realtime must be verified on a real Supabase project.
