# Manexus Intents

Non-custodial invoicing and treasury on [NEAR Intents](https://near-intents.org). A business invoices in USDC or USDT, the client pays with any supported token on any chain, the money lands in the business's **own** `intents.near` balance, and from there the business swaps, pays vendor bills, runs payroll and withdraws to any chain or exchange address, signing every outbound transfer in its wallet. Manexus never holds keys or funds.

Hackathon entry for **Track 08 Real-World Money** (secondary: 04 Autonomous Business, planned, see Roadmap). Design: [docs/superpowers/specs/2026-10-29-manexus-intents-design.md](docs/superpowers/specs/2026-10-29-manexus-intents-design.md). Verified NEAR Intents facts: [docs/NEAR-INTENTS.md](docs/NEAR-INTENTS.md). Invoice and bill-pay reconciliation rules: [docs/INVOICING.md](docs/INVOICING.md).

## What it does

1. **Sign in with a wallet.** NEAR (Meteor, HOT) via NEP-413, or an injected EVM wallet (MetaMask etc.) via ERC-191 personal_sign. The server verifies the signature and sets a session cookie. No passwords.
2. **Create and issue an invoice** in USDC or USDT with line items, due date and notes. Issuing yields a public pay link.
3. **The client pays with any token on any chain.** The pay page (no sign-in) lists tokens from 1Click, asks for a refund address, and shows an exact deposit address and amount from a 1Click quote that delivers the invoice total into the owner's Intents account. The invoice is marked **paid** only when the server sees 1Click report `SUCCESS` with a matching recipient, asset and amount (see [docs/INVOICING.md](docs/INVOICING.md)).
4. **Withdraw.** The owner sees their NEAR Intents balance, reviews a withdrawal quote (destination chain, address, expected and minimum receive), confirms the address, and signs the intent in their wallet. The signed intent is submitted to 1Click and progress is tracked to the destination transaction.
5. **Swap** one balance for another token inside the same Intents account (see [Swap](#swap)).
6. **Treasury dashboard** on Home: cash, receivables, payables, this month's flows and one activity feed (see [Treasury dashboard](#treasury-dashboard)).
7. **Pay vendor bills** from the balance, entered by hand or imported from a Manexus invoice link (see [Bill pay](#bill-pay)).
8. **Run payroll / batch payouts** from a CSV or saved payees, one signed intent per line (see [Payroll](#payroll-and-batch-payouts)).

Every outbound transfer (withdraw, swap, bill, payroll line) goes through one engine, `server/transfers.ts`: the server asks 1Click for a quote and an unsigned intent (`generate-intent`), checks it field by field and stores it; the browser has the owner sign that exact payload in their wallet (`src/sign-flow.ts`); the server relays the signature only if it covers the stored payload, the row is still awaiting a signature and the quote is unexpired. The origin token must be in the owner's own balance and the amount the intent moves must fit that balance at quote time (otherwise 400 "Amount exceeds your balance").

### Swap

`#/swap` (`src/views/swap.ts`, `server/swaps.ts`). Pick a balance, an amount and any token 1Click lists, and a slippage of 0.5 %, 1 % or 3 %. The swap is an `EXACT_INPUT` 1Click quote whose recipient is always the owner's own Intents account (`recipientType: INTENTS`; a recipient sent by the browser is ignored). The review shows what you send, the expected and minimum received amounts in the destination token's own decimals, and the rate; a USD figure is shown only when 1Click gives the token a reference price. If the price moves beyond the slippage the swap is refunded to the Intents balance. The swapped token is then part of the balance on Home (`server/balances.ts` includes the destination token of every swap).

### Treasury dashboard

`#/` (`src/views/home.ts`, `server/activity.ts`, `GET /api/activity`):

- **Cash**: every token in the Intents balance with a USD total at reference prices.
- **Receivables**: issued, unpaid invoices per token, with the overdue count.
- **Payables**: scheduled bills due in the next 14 days per token, with the overdue count.
- **This month**: received (verified invoice payments) and sent (successful withdrawals, bill payments and payroll lines; a swap stays in your account and is not counted) per settlement token (USDC, USDT), summed in integer base units and never mixed across tokens.
- **Activity**: invoice payments (including extra payments), withdrawals, swaps, bill payments and payroll lines, newest first, each linking to its invoice, bill or payout. Unsigned quotes moved no funds and are not listed.

Each tile loads on its own; one failing request does not blank the others.

### Bill pay

`#/bills`, `#/bills/new`, `#/bills/<id>` (`src/views/bills.ts`, `src/views/bill-detail.ts`, `server/bills.ts`). Two ways to create a bill:

- **Paste a Manexus invoice link** (`<this app>/#/pay/<publicId>`, or the bare public id). Vendor, reference, amount, token and pay-to account are read from the vendor's issued invoice and are read-only; the due date is prefilled from it. Your own invoice, an invoice that is not issued, a link from another site, or a second bill for the same invoice (unless the earlier one was cancelled) are refused.
- **Manual**: vendor name, reference, due date, any token 1Click lists, the vendor's address on that token's chain (or a NEAR Intents account) and the amount the vendor receives.

Bills are `scheduled` → `paying` → `paid`, or `cancelled`; only scheduled bills can be edited or cancelled, and a scheduled bill past its due date shows as overdue. Paying is an `EXACT_OUTPUT` quote: the vendor receives exactly the bill amount, you send the quote's input amount, which includes a 1 % slippage buffer whose unused part is refunded to your Intents balance. You confirm the vendor, network and address, then sign.

**Vendor reconciliation.** For an imported bill the deposit address is also recorded as a payment attempt on the vendor's invoice, so the vendor's own invoice becomes paid through the same verified 1Click status check as any other payment. If the vendor cancels the invoice (or it is paid by someone else) after import, getting a quote or relaying the signature is refused with 409 "The vendor invoice is no longer payable". A payment that lands anyway is recorded on the vendor's side as `duplicate` or `after_cancel` and the bill shows **"Paid — vendor reports extra payment"**. Details: [docs/INVOICING.md](docs/INVOICING.md#bill-pay-and-vendor-reconciliation).

Limits: 1000 bills per owner; the list is paginated 100 per page.

### Payroll and batch payouts

`#/payroll`, `#/payroll/<id>` (`src/views/payroll.ts`, `src/views/payroll-batch.ts`, `server/payroll.ts`, `shared/csv.ts`). Create a payout from a CSV file or from saved payees, choose the balance to pay from, then send. Each line is its own `EXACT_OUTPUT` transfer (the payee receives exactly the line amount) and **needs its own wallet signature**; "Send all" asks for them one after another and can be stopped after the current line.

CSV format, header required:

```csv
name,chain,token,address,amount
Ana Putri,arb,USDC,0x1111111111111111111111111111111111111111,250
"Budi, Contractor",near-intents,USDC,budi.near,99.5
```

- `chain` is a chain id the app can validate addresses for (`eth`, `arb`, `base`, `op`, `pol`, `bsc`, `avax`, `gnosis`, `near`, `sol`, `btc`, `tron`) and `address` an address on it; `near-intents` pays a NEAR Intents account (a NEAR account id or lowercase `0x` address).
- `token` is the token symbol on that chain; `amount` is what the person receives, in that token, with at most its decimals.
- RFC 4180 quoting, LF or CRLF, optional BOM. Names starting with `=`, `+`, `-` or `@` are refused (spreadsheet formula injection), as are duplicate recipients, unknown tokens or chains, invalid addresses and too many decimals.
- The server re-parses the raw CSV; any bad line rejects the whole upload with per-line errors and nothing is created. Lines paid in the origin token itself must fit the balance together ("Batch exceeds your balance"); other lines are checked against the balance when each is quoted.

Limits: 50 lines per payout, 64 KB per CSV, 500 saved payees per owner.

Batch status is derived per line ("3/5 sent, 1 failed, 1 awaiting"). A line that may have moved funds is never quoted again: sent and in-flight lines are locked, and an expired quote whose relay failed stays "checking" until a 1Click status read after a grace period shows nothing landed. "Send all" sends only lines never sent and open unsigned quotes; a failed, refunded or expired line is retried only with its own Retry button.

## Architecture

```
Browser SPA (Vite, TypeScript, hash routes)        src/views/*, src/sign-flow.ts (wallet signs every outbound intent)
   |  fetch same-origin only
   v
Cloudflare Pages Functions  /api/*   (functions/, server/)
   |   invoices.ts, payments.ts, reconcile.ts      invoicing and verified payment status
   |   transfers.ts                                one outbound engine: withdraw | swap | bill | payroll
   |     withdraw.ts, swaps.ts, bills.ts, payroll.ts   thin domain modules over it
   |   activity.ts, balances.ts                    dashboard feed and Intents balances
   |-- 1Click API  (tokens, quotes, generate-intent, submit signed intent, status)   ONECLICK_BASE_URL, optional ONECLICK_API_KEY
   |-- NEAR RPC    (read intents.near balances, key checks)                          NEAR_RPC_URL
   '-- D1 (SQLite) (sign-in challenges, invoices, payment attempts, transfers, bills, payees, payroll batches;
                    sessions are stateless signed cookies)
```

The browser talks only to `/api`; the wallet SDKs (Meteor, HOT, injected EVM) make their own wallet and RPC calls, which the CSP in `public/_headers` allows. Signing happens in the user's wallet; the server only verifies, quotes and relays.

### Routes

App (hash routes, `src/main.ts`): `#/` Home, `#/invoices`, `#/invoices/<id>`, `#/bills`, `#/bills/new`, `#/bills/<id>`, `#/swap`, `#/payroll`, `#/payroll/<id>`, `#/withdraw`, and the public `#/pay/<publicId>` (no sign-in). The desktop sidebar lists every section; the mobile bottom bar shows Home, Invoices, Bills, Swap and More, which opens Payroll, Withdraw and Sign out.

API (`functions/api/`, all owner-scoped behind the session cookie except `public/*`, `auth/*` and `health`):

| Area | Routes |
|---|---|
| Session | `POST /api/auth/challenge`, `POST /api/auth/verify`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/health` |
| Invoices | `GET/POST /api/invoices`, `GET/PUT /api/invoices/:id`, `POST /api/invoices/:id/issue`, `POST /api/invoices/:id/cancel`, `GET /api/invoices/:id/payments` |
| Public pay page | `GET /api/public/invoices/:publicId`, `POST …/quote`, `POST …/deposit`, `GET …/status` |
| Balances, tokens, dashboard | `GET /api/balances`, `GET /api/tokens`, `GET /api/activity` (`?summary=month` for this month's flows) |
| Transfers (every kind) | `POST /api/transfers/submit`, `GET /api/transfers/:depositAddress` (refresh), `GET /api/transfers?kind=`, `GET /api/transfers/key-status` |
| Withdraw | `POST /api/withdrawals/quote`, plus the Plan 1 `submit`, `:depositAddress`, list and `key-status` routes (same engine) |
| Swap | `POST /api/swaps/quote` |
| Bills | `GET/POST /api/bills`, `POST /api/bills/import`, `GET/PUT /api/bills/:id`, `POST /api/bills/:id/quote`, `POST /api/bills/:id/cancel` |
| Payroll | `GET/POST/DELETE /api/payroll/payees`, `GET/POST /api/payroll/batches`, `GET /api/payroll/batches/:id`, `POST /api/payroll/batches/:id/lines/:n/quote` |

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
npm run build       # typecheck + vite build (needed before preview)
# then, in a second terminal:
npx vite preview --port 24012   # stop it with Ctrl+C when done
# back in the first terminal (mocked /api, desktop and mobile projects):
PLAYWRIGHT_BASE_URL=http://127.0.0.1:24012 npm run test:e2e -- --workers=1
```

`tests/browser/core-loop.spec.ts` runs the whole loop (sign in, invoice, payer pays from a second browser context, balance, withdraw) and `tests/browser/treasury-loop.spec.ts` the treasury loop (swap, bill imported from a Manexus invoice link, 2-line payroll, Home activity shows all of it, mobile More menu), both against a fake `/api`, on desktop and at 390 px with no horizontal overflow. No test moves real funds.

## Honest boundaries

- **Mainnet only.** NEAR Intents has no testnet; everything real runs on mainnet. Use small amounts.
- **Security incident context.** NEAR Intents was reported to have lost roughly $3.8M to an exploit on 2026-10-01 (third-party report: https://shattered.io/near-intents-3-8m-hack-postmortem-clears-omni-2026/). Check current NEAR Intents announcements before moving meaningful amounts.
- **Non-custodial.** Funds sit in your `intents.near` account, controlled by your wallet. Manexus holds no keys and cannot move them. Every withdrawal, swap, bill payment and payroll line needs your signature.
- **No fiat.** Crypto stablecoins only; no card or bank rails, no tax or legal/accounting claims.
- **Fees.** 1Click quotes include provider fees and slippage; the payer pays the quoted amount, the owner receives the invoice total. Bills and payroll lines are quoted so the recipient receives the exact amount; you send slightly more (1 % slippage buffer) and the unused part is refunded to your Intents balance. Without a partner API key 1Click adds an extra 0.25% platform fee.
- **No scheduling or automation.** A bill's due date is a reminder; nothing is paid automatically. Payroll lines are signed by you, one per line.
- **Bill pay reconciliation across Manexus** works for invoices issued on the same Manexus deployment (same database); for any other vendor, enter the bill manually.
- **Named NEAR accounts** (`alice.near`) must register their public key on `intents.near` once (a wallet-approved `add_public_key` call, 1 yoctoNEAR plus gas) before they can sign withdrawals; the app guides this step. EVM accounts need no registration.
- `npm audit --omit=dev` reports 25 advisories (3 high, 8 moderate, 14 low) in wallet-SDK transitive dependencies (e.g. `@meteorwallet/sdk`, `nanoid`, `@hot-wallet/sdk`, `@solana/web3.js`); fixes require breaking upgrades.
- Balance, swap and dashboard USD figures are reference prices only; tokens without a reference price show no USD value.

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

Later Plan 1 commits (hardening, E2E test, docs, CSP) follow these. Plan 2, the treasury features ([plan](docs/superpowers/plans/2026-10-30-plan2-treasury-features.md)), is also hackathon work:

```
docs: treasury features README and end-to-end test   (this commit: navigation, README, docs/INVOICING.md, treasury E2E)
9dcf641 fix: swap, transfer and payroll follow-ups from review
fd24455 feat: payroll and batch payouts from CSV or saved payees
ff730c1 fix: bills reschedule a failed relay only after a real post-grace 1Click check
9d01b38 feat: bill pay from the Intents balance, with Manexus invoice import
47ff7fb feat: treasury dashboard with cash, receivables, payables and activity
8ee4247 feat: swap between assets inside the NEAR Intents account
1c4652c fix: EXACT_OUTPUT transfers require minAmountOut to cover the requested amount
8ac482c refactor: generic transfer engine for withdraw, swap, bill and payroll
fb50d2b refactor: move server/withdraw.ts to server/transfers.ts
ace6241 docs: Plan 2 treasury features (swap, dashboard, bill pay, payroll)
```

Run `git log --oneline 7d827b1..HEAD` for the full list.

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
- [ ] Live small withdrawal from a **named NEAR account**, including first-time key registration. This also verifies the strict generated-intent shape check in `server/transfers.ts` against the real 1Click quote.
- [ ] Live small **swap** (for example 1 USDC → wNEAR) inside the Intents account: the review's expected and minimum amounts match 1Click, the swap reaches SUCCESS and the new token appears on Home.
- [ ] One **bill paid to a Manexus invoice**: issue a ~1 USDC invoice from a second account, import its link as a bill, pay it, and confirm the bill shows Paid and the vendor's invoice flips to Paid. Also check that cancelling the vendor invoice before signing makes the payment fail with "The vendor invoice is no longer payable".
- [ ] One **2-line payroll** (one line to a chain address, one to a NEAR Intents account): both lines reach Sent with one signature each, and each payee receives exactly the line amount.
- [ ] Real wallet sign-in check with Meteor, HOT and MetaMask; verify the CSP in `public/_headers` allows the wallet's network calls (browser console shows no CSP violations); adjust origins if needed.
- [ ] Record resulting transaction hashes in `docs/NEAR-INTENTS.md`.

## Roadmap

Per the [design spec](docs/superpowers/specs/2026-10-29-manexus-intents-design.md): Plan 1 (core loop, [plan](docs/superpowers/plans/2026-10-29-plan1-core-loop.md)) and Plan 2 (in-account swap, bill pay, payroll/batch payout, treasury dashboard, [plan](docs/superpowers/plans/2026-10-30-plan2-treasury-features.md)) are implemented as described above. **Plan 3 (automation and submission)**: agent rules within user-set limits (the Track 04 Autonomous Business angle), demo video and submission; not started.
