# KAMKAM — Real wallet, payments & live: setup and status

This replaces the old demo wallet. Nothing on this page is simulated: every balance is either a
ledger total in Postgres (Naira) or read live from a blockchain (crypto). Features whose provider is
not configured show **"Not available yet"**; they are never faked.

## 1. Status

| Feature | Provider | Code | Verified with |
|---|---|---|---|
| Naira balance, gifts (80/20), KAMKAM→KAMKAM transfers, earnings → balance | Postgres ledger | ✅ | DB tests, API-client E2E, browser E2E |
| Fund wallet (card / bank transfer / USSD) | Paystack Collections | ✅ | Route tests against a **mock** Paystack only |
| Withdraw to a Nigerian bank | Paystack Transfers | ✅ | Route tests against a **mock** Paystack only |
| Create crypto wallet, Receive, Send, on-chain balances, confirmations | Coinbase CDP Server Wallets | ✅ | **Not verified**: needs CDP credentials |
| Live rooms (chat, presence, live gifts) | Supabase Realtime | ✅ | DB tests, API-client E2E, browser E2E (Realtime itself only on hosted Supabase) |
| Live **video** | none | ❌ | Not implemented; needs a streaming provider (e.g. Mux, LiveKit, Agora) |
| Buy / Sell / Swap crypto | none | ❌ | Shown as "Not available yet" |
| BNB Chain, TRON, Polygon, Arbitrum | not supported by the chosen provider flow | ❌ | Removed from the UI |

Supported crypto networks: **Ethereum, Base, Solana**. Assets: ETH, USDC, SOL, and USDT on Ethereum/Solana
(mainnet only). `CRYPTO_NETWORK_MODE=testnet` (default) uses Ethereum Sepolia, Base Sepolia and Solana Devnet.

## 2. Apply the database upgrade

Your project already ran `APPLY_ALL_MIGRATIONS.sql` (the 20261016* migrations). Run **only**
`supabase/UPGRADE_20261018_REAL_FINANCE.sql` in Supabase → SQL Editor, once. It runs in one transaction.

What it does:
- It moves the old demo tables (simulated balances, demo transactions and gifts) into the private `demo_archive` schema. Nothing is deleted; you can review `demo_archive.balances_snapshot`.
- It drops the demo functions: the ₦50,000 sign-up grant, the crypto "starter" grant, and simulated swap/buy/sell/send.
- Every existing user's new Naira balance starts at **₦0**. Demo balances are not carried over because they were never backed by real money.

New projects use `supabase/APPLY_ALL_MIGRATIONS.sql`, which now contains all 12 migrations.
Both bundles are regenerated and checked with `npm run db:bundles`.

## 3. Server environment variables

Set these in your host (e.g. Vercel → Settings → Environment Variables). Never set them in a
`NEXT_PUBLIC_*` variable, never commit them, and never paste them into chat. The full list with
comments is in `frontend/.env.example`.

| Variable | Where to get it |
|---|---|
| `APP_URL` | Your deployed URL, e.g. `https://kamkam.example` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → service_role / secret |
| `PAYSTACK_SECRET_KEY` | Paystack Dashboard → Settings → API Keys & Webhooks (`sk_test_…` first) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | portal.cdp.coinbase.com → API Keys → Secret API key |
| `CDP_WALLET_SECRET` | portal.cdp.coinbase.com → Server Wallet → Wallet Secret |
| `CRYPTO_NETWORK_MODE` | `testnet` until you are licensed and ready, then `mainnet` |
| `ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `SOLANA_RPC_URL` | Optional; recommended for production (public RPCs are rate-limited) |
| `CRON_SECRET` | Any long random string |

## 4. Provider configuration

**Paystack**
1. Webhook URL: `${APP_URL}/api/payments/webhook`. Signatures are verified with HMAC-SHA512, and every event is re-verified against Paystack's API before any balance changes.
2. Transfers: to send payouts automatically, disable OTP for API transfers (Settings → Preferences). With OTP on, payouts are marked failed and the funds are returned.
3. Keep enough balance in your Paystack account to cover payouts.

**Coinbase CDP**
- The keys are **provider-managed**: CDP generates and holds them in a secure enclave. KAMKAM stores only the account name (`kk-<user id>`) and public addresses. The UI says so; it does not claim to be non-custodial.
- Testnet funds can come from the CDP faucet or a public Sepolia/Devnet faucet.
- Sends need native gas (ETH on Ethereum/Base, SOL on Solana) in the same account.

**Reconciliation**
- `vercel.json` schedules `/api/cron/reconcile` daily, the limit on Vercel Hobby. On Pro, change it to `*/10 * * * *`, or use an external scheduler that sends `Authorization: Bearer $CRON_SECRET`. Webhooks and the callback page settle payments in real time either way; the job is a safety net.
- The job re-verifies pending deposits, payouts and crypto sends, and reports ledger mismatches.

## 5. Verify on staging (with test keys) before going live

1. Sign up a new user: the wallet must show ₦0 and no transactions.
2. Fund ₦500 with a Paystack test card. Check that the balance updates only after the callback page says "Wallet Funded".
3. Gift ₦200 to a second user. The sender should be debited ₦200, the creator's earnings should rise by ₦160, and platform revenue by ₦40.
4. Withdraw to a Paystack test bank account, and watch it go Processing → Paid.
5. Create a crypto wallet (testnet). Fund the address from a faucet, send a small amount out, then open the explorer link and wait for "Confirmed".
6. Start a live room from two browsers, then chat and gift the host.

## 6. Legal and regulatory: required before real money

Holding customer Naira balances and custodial crypto is regulated in Nigeria. Before using live keys:
- Take legal advice on CBN rules for stored-value/e-money, and on SEC Nigeria rules for virtual-asset service providers.
- Put KYC/AML (identity checks and transaction limits) in place.
- Get Paystack's approval for this business model, and set Coinbase CDP terms for your jurisdiction.
- Publish terms of service and a privacy policy.

The limits in `app_settings` (deposit ₦100–₦1,000,000, withdrawal fee ₦50, daily withdrawal max ₦1,000,000) are placeholders to review.
