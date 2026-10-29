# Manexus Intents

Non-custodial invoicing on [NEAR Intents](https://near-intents.org). A business invoices in USDC or USDT, the client pays with any supported token on any chain, the money lands in the business's **own** `intents.near` balance, and the business withdraws it to any chain or exchange address with a wallet signature. Manexus never holds keys or funds.

Hackathon entry for **Track 08 Real-World Money** (secondary: 04 Autonomous Business, planned, see Roadmap). Design: [docs/superpowers/specs/2026-10-29-manexus-intents-design.md](docs/superpowers/specs/2026-10-29-manexus-intents-design.md). Verified NEAR Intents facts: [docs/NEAR-INTENTS.md](docs/NEAR-INTENTS.md). Invoice rules: [docs/INVOICING.md](docs/INVOICING.md).

## What it does

1. **Sign in with a wallet.** NEAR (Meteor, HOT) via NEP-413, or an injected EVM wallet (MetaMask etc.) via ERC-191 personal_sign. The server verifies the signature and sets a session cookie. No passwords.
2. **Create and issue an invoice** in USDC or USDT with line items, due date and notes. Issuing yields a public pay link.
3. **The client pays with any token on any chain.** The pay page (no sign-in) lists tokens from 1Click, asks for a refund address, and shows an exact deposit address and amount from a 1Click quote that delivers the invoice total into the owner's Intents account. The invoice is marked **paid** only when the server sees 1Click report `SUCCESS` with a matching recipient, asset and amount (see [docs/INVOICING.md](docs/INVOICING.md)).
4. **Withdraw.** The owner sees their NEAR Intents balance, reviews a withdrawal quote (destination chain, address, expected and minimum receive), confirms the address, and signs the intent in their wallet. The signed intent is submitted to 1Click and progress is tracked to the destination transaction.

## Architecture

```
Browser SPA (Vite, TypeScript, hash routes)
   |  fetch same-origin only
   v
Cloudflare Pages Functions  /api/*   (functions/, server/)
   |-- 1Click API  (quotes, status, submit signed intent)   ONECLICK_BASE_URL, optional ONECLICK_API_KEY
   |-- NEAR RPC    (read intents.near balances, key checks)  NEAR_RPC_URL
   '-- D1 (SQLite) (sessions, invoices, payment attempts, withdrawals)
```

The browser talks only to `/api`; the wallet SDKs (Meteor, HOT, injected EVM) make their own wallet and RPC calls, which the CSP in `public/_headers` allows. Signing happens in the user's wallet; the server only verifies, quotes and relays.

## Run locally

Requires Node 22.18+ (Node 24 recommended).

```sh
cp .env.example .env          # then set SESSION_SECRET (generate command is in the file)
npm ci
npm run db:migrate:local      # creates the local D1 database in .wrangler/state
npm run dev                   # terminal 1: Vite on the port in .env (default 5173; 24010 if PORT=24010)
npm run dev:api               # terminal 2: wrangler Pages on http://localhost:24011, proxying Vite on 24010
```

`dev:api` proxies to port 24010, so set `PORT=24010` in `.env` (or edit the script). Open http://localhost:24011 so `/api` and the app share one origin. `ONECLICK_API_KEY` is optional locally. Live 1Click and NEAR mainnet are used even in local dev; there is no testnet.

## Tests

```sh
npm test            # node:test unit and server tests
npm run typecheck   # app and functions
npm run build       # typecheck + vite build
# browser tests (mocked /api, desktop and mobile projects):
npm run build && npx vite preview --port 24012 &
PLAYWRIGHT_BASE_URL=http://127.0.0.1:24012 npx playwright test tests/browser --workers=1
```

`tests/browser/core-loop.spec.ts` runs the whole loop (sign in, invoice, payer pays from a second browser context, balance, withdraw) against a fake `/api` and asserts no horizontal overflow at 390 px. No test moves real funds.

## Honest boundaries

- **Mainnet only.** NEAR Intents has no testnet; everything real runs on mainnet. Use small amounts.
- **Security incident context.** NEAR Intents had a reported exploit on 2026-10-01; see the public postmortem. Treat the protocol as having risk and do not hold more than you can lose.
- **Non-custodial.** Funds sit in your `intents.near` account, controlled by your wallet. Manexus holds no keys and cannot move them. Withdrawals need your signature.
- **No fiat.** Crypto stablecoins only; no card or bank rails, no tax or legal/accounting claims.
- **Fees.** 1Click quotes include provider fees and slippage; the payer pays the quoted amount, the owner receives the invoice total. Without a partner API key 1Click adds an extra 0.25% platform fee.
- **Named NEAR accounts** (`alice.near`) must register their public key on `intents.near` once (a wallet-approved `add_public_key` call, 1 yoctoNEAR plus gas) before they can sign withdrawals; the app guides this step. EVM accounts need no registration.
- `npm audit --omit=dev` reports advisories (3 high) in transitive dependencies of the Meteor wallet SDK bundled in the browser app (`@meteorwallet/sdk`, `nanoid`, `@near-js/*`); no fix is available upstream without breaking changes and they were not auto-fixed.
- Balance USD figures are reference prices only.

## Hackathon work vs. pre-existing baseline

**Baseline:** commits up to and including `7d827b1` (2026-10-21/22), a static, browser-only quote/invoice-preview prototype with no backend, no wallet sign-in, and no real payments. **Everything after `7d827b1` is hackathon work**, replacing that prototype with the core loop above:

```
b6d3694 feat: withdraw from Intents balance to any chain via signed intent
07d6633 feat: show non-custodial NEAR Intents balances
c300baa feat: reconcile invoice payments from verified 1Click status
5a20738 fix: require origin token in attempt view and validate upstream quote
aae6794 feat: public invoice payment via 1Click into owner Intents balance
6cdfec0 feat: server-side invoices with owner isolation
c3614e1 feat: wallet sign-in with NEP-413 and ERC-191, new app shell
55fefb3 feat: add shared money helpers and 1Click client
c826e55 chore: drop unneeded @types/node from functions typecheck
87d997f chore: add Pages Functions, D1 schema and server test harness
5cb9bd4 chore: record NEAR Intents 1Click routing facts
16c91a5 docs: add Manexus Intents design spec and Plan 1 core loop
```

Later commits (hardening, E2E test, docs, CSP) follow these; run `git log --oneline 7d827b1..HEAD` for the full list.

## Deploy (maintainer)

Not performed as part of this repository state. Deployment: see this section; no production URL is claimed.

```sh
# 1. 1Click partner key (optional, removes the extra 0.25% fee): register at https://partners.near-intents.org
# 2. Database
npx wrangler d1 create manexus-intents          # put the returned id in wrangler.toml (database_id)
npx wrangler d1 migrations apply manexus-intents --remote
# 3. Secrets and binding
npx wrangler pages secret put SESSION_SECRET --project-name manexus-intents
npx wrangler pages secret put ONECLICK_API_KEY --project-name manexus-intents
# bind the D1 database as DB in the Pages project settings
# 4. Deploy
npm run build
npx wrangler pages deploy dist --project-name manexus-intents --branch main
curl -s https://manexus-intents.pages.dev/api/health     # expect {"ok":true}
```

## Launch checklist

Gates before calling the deployment ready (none of these have been run with real funds yet):

- [ ] Live small invoice payment: issue a ~1 USDC invoice, pay from another wallet (for example USDC on Arbitrum), confirm the invoice flips to Paid and the Home balance shows it.
- [ ] Live small withdrawal from an **EVM** account to an Arbitrum/Base address.
- [ ] Live small withdrawal from a **named NEAR account**, including first-time key registration. This also verifies the strict generated-intent shape check in `server/withdraw.ts` against the real 1Click quote.
- [ ] Real wallet sign-in check with Meteor, HOT and MetaMask.
- [ ] Record resulting transaction hashes in `docs/NEAR-INTENTS.md`.

## Roadmap

Per the [design spec](docs/superpowers/specs/2026-10-29-manexus-intents-design.md): **Plan 2 (ramp features)**: in-account swap, bill pay, payroll/batch payout, treasury dashboard. **Plan 3 (automation and submission)**: agent rules within user-set limits (the Track 04 Autonomous Business angle), demo video and submission. Plan 1 (this core loop): [docs/superpowers/plans/2026-10-29-plan1-core-loop.md](docs/superpowers/plans/2026-10-29-plan1-core-loop.md).
