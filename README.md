# Manexus Intents

Non-custodial invoicing and treasury on [NEAR Intents](https://near-intents.org). A business invoices in USDC or USDT, the client pays with any supported token on any chain, the money lands in the business's **own** `intents.near` balance, and from there the business swaps, pays vendor bills, runs payroll and withdraws to any chain or exchange address, signing every outbound transfer in its wallet. A treasury agent suggests actions from rules the owner signs, within spending limits and a recipient whitelist. Manexus never holds keys or funds.

Built at **NEAR HACKATHON** for **Track 08 Real-World Money** (primary), with **04 Autonomous Business** and **06 AI Security & Defense** (see [Tracks](#tracks)). Submission text, demo script and checklist: [docs/SUBMISSION.md](docs/SUBMISSION.md).

## For judges

Quickstart from a clean clone (Node 22.18+; Node 24 recommended). No API keys are needed.

```sh
git clone https://github.com/manexustechnology/manexus-intents.git && cd manexus-intents
npm ci
cp .env.example .env
# set SESSION_SECRET in .env to the output of:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm run db:migrate:local      # creates the local D1 database in .wrangler/state
npm run dev:api               # terminal 1: builds the app, then serves it and /api on http://127.0.0.1:24011
npm run dev                   # terminal 2 (optional, live reload): Vite on http://127.0.0.1:24010, forwards /api to 24011
```

Open **http://127.0.0.1:24011** (the app and the API share that origin; `curl http://127.0.0.1:24011/api/health` returns `{"ok":true}`). Then:

1. **Sign in**: "Connect EVM wallet" (MetaMask or any injected browser wallet; it signs a message, no transaction, no gas) or "Connect NEAR wallet" (Meteor or HOT).
2. **Invoices → New invoice**: fill the client and a line item, **Save draft**, **Issue invoice**, **Copy payment link** and open it (`#/pay/<publicId>`) in another window: the payer picks any token on any chain and gets a 1Click deposit address and exact amount.
3. **Home**: Intents balance, receivables, payables, this month and activity. **Swap**, **Bills**, **Payroll** and **Withdraw** each end in a review and a wallet signature.
4. **Agent** (sidebar, or More on mobile): tick "Suggest converting other tokens", set limits, **Save rules** — the exact policy message is shown, sign it. Suggestions for your balance appear in the inbox; **Approve** shows the quote; **Sign in wallet** executes it. Without NEAR AI the page says "AI features are not configured" and everything else works.

What needs what:

| Works | Needs |
|---|---|
| Sign-in with an EVM wallet, invoices (create, edit, issue, cancel), agent rules, spending limits and whitelist (signed) | Nothing beyond `SESSION_SECRET` |
| NEAR wallet sign-in (key check), balances and agent suggestions, token lists, pay-page quotes, swap/bill/payroll/withdraw quotes | Network access to the public 1Click API and NEAR mainnet RPC (no key needed; without `ONECLICK_API_KEY` 1Click adds a 0.25 % fee) |
| "Describe your rules" and "AI summary" | `NEAR_AI_API_KEY` (NEAR AI Cloud); hidden without it |
| Actually moving funds | A funded `intents.near` balance on mainnet (there is no testnet) |

To check behaviour without a wallet or funds, run the test suites (see [Tests](#tests)): the browser tests drive every flow, including the agent loop, against a fake `/api`.

## Tracks

- **08 Real-World Money (primary)**: invoices, multichain payment into a non-custodial balance, verified reconciliation, bill pay, payroll and withdrawals (`server/invoices.ts`, `server/payments.ts`, `server/reconcile.ts`, `server/bills.ts`, `server/payroll.ts`, `server/transfers.ts`).
- **04 Autonomous Business**: a deterministic agent turns signed rules into suggestions (convert, sweep, pay bill, follow up an overdue invoice); approving one is a single wallet signature (`server/agent.ts`, `server/agent-actions.ts`).
- **06 AI Security & Defense**: per-transaction and rolling 24-hour spending limits, a recipient whitelist and signed policy changes, enforced by the transfer engine on every outbound transfer; NEAR AI output goes through the same strict validator as a manual edit and is never saved without a signature (`server/policy.ts`, `server/nearai.ts`).

Design: [docs/superpowers/specs/2026-10-29-manexus-intents-design.md](docs/superpowers/specs/2026-10-29-manexus-intents-design.md). Verified NEAR Intents facts: [docs/NEAR-INTENTS.md](docs/NEAR-INTENTS.md). NEAR AI Cloud facts: [docs/NEAR-AI.md](docs/NEAR-AI.md). Invoice and bill-pay reconciliation rules: [docs/INVOICING.md](docs/INVOICING.md).

## What it does

1. **Sign in with a wallet.** NEAR (Meteor, HOT) via NEP-413, or an injected EVM wallet (MetaMask etc.) via ERC-191 personal_sign. The server verifies the signature and sets a session cookie. No passwords.
2. **Create and issue an invoice** in USDC or USDT with line items, due date and notes. Issuing yields a public pay link.
3. **The client pays with any token on any chain.** The pay page (no sign-in) lists tokens from 1Click, asks for a refund address, and shows an exact deposit address and amount from a 1Click quote that delivers the invoice total into the owner's Intents account. The invoice is marked **paid** only when the server sees 1Click report `SUCCESS` with a matching recipient, asset and amount (see [docs/INVOICING.md](docs/INVOICING.md)).
4. **Withdraw.** The owner sees their NEAR Intents balance, reviews a withdrawal quote (destination chain, address, expected and minimum receive), confirms the address, and signs the intent in their wallet. The signed intent is submitted to 1Click and progress is tracked to the destination transaction.
5. **Swap** one balance for another token inside the same Intents account (see [Swap](#swap)).
6. **Treasury dashboard** on Home: cash, receivables, payables, this month's flows and one activity feed (see [Treasury dashboard](#treasury-dashboard)).
7. **Pay vendor bills** from the balance, entered by hand or imported from a Manexus invoice link (see [Bill pay](#bill-pay)).
8. **Run payroll / batch payouts** from a CSV or saved payees, one signed intent per line (see [Payroll](#payroll-and-batch-payouts)).
9. **Treasury agent**: signed rules, spending limits and a whitelist; the agent suggests and the owner approves each suggestion with one signature (see [Agent](#agent)).

Every outbound transfer (withdraw, swap, bill, payroll line) goes through one engine, `server/transfers.ts`: the server asks 1Click for a quote and an unsigned intent (`generate-intent`), checks it field by field and stores it; the browser has the owner sign that exact payload in their wallet (`src/sign-flow.ts`); the server relays the signature only if it covers the stored payload, the row is still awaiting a signature and the quote is unexpired. The origin token must be in the owner's own balance and the amount the intent moves must fit that balance at quote time (otherwise 400 "Amount exceeds your balance").

### Swap

`#/swap` (`src/views/swap.ts`, `server/swaps.ts`). Pick a balance, an amount and any token 1Click lists, and a slippage of 0.5 %, 1 % or 3 %. The swap is an `EXACT_INPUT` 1Click quote whose recipient is always the owner's own Intents account (`recipientType: INTENTS`; a recipient sent by the browser is ignored). The review shows what you send, the expected and minimum received amounts in the destination token's own decimals, and the rate; a USD figure is shown only when 1Click gives the token a reference price. If the price moves beyond the slippage the swap is refunded to the Intents balance. The swapped token is then part of the balance on Home (`server/balances.ts` includes the destination token of every swap).

### Treasury dashboard

`#/` (`src/views/home.ts`, `server/activity.ts`, `GET /api/activity`):

- **Cash**: every token in the Intents balance with a USD total at reference prices.
- **Receivables**: issued, unpaid invoices per token, with the overdue count.
- **Payables**: scheduled bills due in the next 14 days per token, with the overdue count.
- **This month**: received (verified invoice payments) and sent (successful withdrawals, bill payments and payroll lines; a swap stays in your account and is not counted) per settlement token (USDC, USDT), summed in integer base units and never mixed across tokens. Sent is what left the balance: for bills and payroll the quote's amount in, less any unused slippage buffer 1Click reports as refunded; when 1Click reports no refund amount, sent includes that buffer.
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

### Agent

`#/agent` (`src/views/agent.ts`, `server/policy.ts`, `server/agent.ts`, `server/agent-actions.ts`, `server/nearai.ts`). The agent suggests; it never signs and never moves funds.

- **Rules** (`Policy` in `server/policy.ts`): *convert* other tokens worth at least a USD minimum to USDC or USDT (only tokens with a reference price); *sweep* the balance of one token above a threshold to a whitelisted address, keeping a set amount; *reminders* for bills due within N days (0–30) and invoices overdue by N days (0–90); *spending limits*.
- **Every policy or whitelist change is signed.** Saving shows the exact message — `Manexus policy v1`, account, the SHA-256 of the canonical JSON of the change, nonce — and the wallet signs it (NEP-413 or ERC-191, verified like sign-in). Each challenge is single-use and expires in 5 minutes; a signature over a different change is refused with 401 "Signature does not match this change".
- **Spending limits** are enforced by the transfer engine (`enforceLimits`, called from `server/transfers.ts`) on every withdrawal, bill and payroll line, not on swaps inside your own account: a per-transaction cap and a rolling 24-hour cap per origin token on the amount that leaves the balance (for `EXACT_OUTPUT` the quoted amount in), counting transfers awaiting a signature, processing or successful in the last 24 hours, re-checked when the signed intent is submitted. Errors: "This exceeds your per-transaction limit", "This exceeds your 24-hour limit". With **Whitelisted recipients only**, withdrawals, manual bills and payroll lines to an address that is not on your whitelist fail with "Recipient is not on your whitelist" (a bill imported from a Manexus invoice pays the verified invoice owner and is subject to the caps only).
- **Suggestions** (`evaluate` in `server/agent.ts`, a pure function of rules, balances, bills, invoices and whitelist) are computed when you open Home or the Agent page (`GET /api/agent/proposals`, at most once a minute per owner unless forced). The same suggestion is never listed twice; one whose basis changed (balance moved, bill or invoice paid, whitelist entry removed) is expired instead of executed.
- **Approve** re-evaluates with fresh data, then requests a normal quote: convert → in-account swap (1 % slippage); sweep → withdrawal to the whitelisted address; pay bill → the bill's quote; follow-up → the invoice's pay link. You review and sign it exactly like a manual transfer, and the engine re-checks balance and limits. **Dismiss** hides a suggestion.
- **AI (optional, NEAR AI Cloud).** "Describe your rules" sends your text (max 1000 characters) and your whitelist ids and labels — never addresses — to the model; the reply is parsed by the same strict `parsePolicy` as a manual edit and only loads into the Rules form for review. It is saved only when you sign it; **Discard draft** puts the saved rules back. At most 5 drafting calls per owner per minute (then 429 "Too many AI requests — try again in a minute"). The **AI summary** is 2–4 sentences from totals and token symbols only (no names, notes, addresses or ids), capped at 600 characters, shown as escaped text and cached 10 minutes. AI output never becomes an amount, token id, address or proposal parameter. AI errors (bad key, no credits, rate limit, timeout) show "AI is unavailable right now" and do not affect rules or suggestions.

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
   |   policy.ts, agent.ts, agent-actions.ts       signed rules, limits, whitelist; suggestions; approve → quote
   |-- 1Click API  (tokens, quotes, generate-intent, submit signed intent, status)   ONECLICK_BASE_URL, optional ONECLICK_API_KEY
   |-- NEAR RPC    (read intents.near balances, key checks)                          NEAR_RPC_URL
   |-- NEAR AI Cloud (optional: rule drafts, summary; nearai.ts)                     NEAR_AI_API_KEY, NEAR_AI_MODEL, NEAR_AI_BASE_URL
   '-- D1 (SQLite) (sign-in and policy challenges, invoices, payment attempts, transfers, bills, payees, payroll
                    batches, policies, whitelist, proposals, AI cache; sessions are stateless signed cookies)
```

The browser talks only to `/api`; the wallet SDKs (Meteor, HOT, injected EVM) make their own wallet and RPC calls, which the CSP in `public/_headers` allows. Signing happens in the user's wallet; the server only verifies, quotes and relays.

### Routes

App (hash routes, `src/main.ts`): `#/` Home, `#/invoices`, `#/invoices/<id>`, `#/bills`, `#/bills/new`, `#/bills/<id>`, `#/swap`, `#/payroll`, `#/payroll/<id>`, `#/withdraw`, `#/agent`, and the public `#/pay/<publicId>` (no sign-in). The desktop sidebar lists every section; the mobile bottom bar shows Home, Invoices, Bills, Swap and More, which opens Payroll, Withdraw, Agent and Sign out.

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
| Agent | `GET/PUT /api/agent/policy`, `POST /api/agent/policy/challenge`, `GET/POST/DELETE /api/agent/whitelist`, `GET /api/agent/proposals`, `POST /api/agent/proposals/:id/approve`, `POST /api/agent/proposals/:id/dismiss` |
| Agent AI (optional) | `GET /api/agent/ai-status`, `POST /api/agent/policy/draft`, `GET /api/agent/summary` (`?refresh=1`) |

## Run locally

Same as [For judges](#for-judges). `npm run dev:api` runs `vite build` and then `wrangler pages dev`, which serves `dist/` (`pages_build_output_dir` in `wrangler.toml`) together with the Pages Functions and the local D1 database; re-run it to pick up frontend changes, or use `npm run dev` (Vite, `PORT=24010` from `.env.example`), which forwards `/api` to `http://127.0.0.1:24011` (`vite.config.ts`). Wrangler reads the backend variables from `.env` (or `.dev.vars` if present). Live 1Click and NEAR mainnet are used even in local dev; there is no testnet.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `24010` in `.env.example` | Vite dev/preview port. |
| `ALLOWED_HOSTS` | no | unset | Extra hostnames Vite accepts (comma-separated). |
| `API_PORT` | no | `24011` | Port Vite's dev server forwards `/api` to (the `dev:api` port). |
| `SESSION_SECRET` | **yes** | — | ≥ 32 characters; signs the session cookie. Generate with the command in `.env.example`. |
| `ONECLICK_API_KEY` | no | unset | 1Click partner key; without it 1Click adds a 0.25 % fee. |
| `ONECLICK_BASE_URL` | no | `https://1click.chaindefuser.com` | 1Click API. |
| `NEAR_RPC_URL` | no | `https://rpc.mainnet.fastnear.com` | NEAR RPC for balances and key checks. |
| `NEAR_AI_API_KEY` | no | unset (AI off) | Server secret, never `VITE_`. Without it `POST /api/agent/policy/draft` and `GET /api/agent/summary` return 404 and the Agent page shows "AI features are not configured". |
| `NEAR_AI_MODEL` | no | `openai/gpt-6-luna` | Chat model (a reasoning model, so the app leaves `max_tokens` headroom; see [docs/NEAR-AI.md](docs/NEAR-AI.md)). |
| `NEAR_AI_BASE_URL` | no | `https://cloud-api.near.ai/v1` | OpenAI-compatible endpoint. |

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

`tests/browser/core-loop.spec.ts` runs the whole loop (sign in, invoice, payer pays from a second browser context, balance, withdraw), `tests/browser/treasury-loop.spec.ts` the treasury loop (swap, bill imported from a Manexus invoice link, 2-line payroll, Home activity shows all of it, mobile More menu) and `tests/browser/agent-loop.spec.ts` the agent loop (rules saved through the signed step, a convert suggestion appears, approve, sign, done; AI summary hidden when not configured and shown when it is), all against a fake `/api`, on desktop and at 390 px with no horizontal overflow. No test moves real funds.

## Honest boundaries

- **Mainnet only.** NEAR Intents has no testnet; everything real runs on mainnet. Use small amounts.
- **Security incident context.** NEAR Intents was reported to have lost roughly $3.8M to an exploit on 2026-10-01 (third-party report: https://shattered.io/near-intents-3-8m-hack-postmortem-clears-omni-2026/). Check current NEAR Intents announcements before moving meaningful amounts.
- **Non-custodial.** Funds sit in your `intents.near` account, controlled by your wallet. Manexus holds no keys and cannot move them. Every withdrawal, swap, bill payment and payroll line needs your signature.
- **No fiat.** Crypto stablecoins only; no card or bank rails, no tax or legal/accounting claims.
- **Fees.** 1Click quotes include provider fees and slippage; the payer pays the quoted amount, the owner receives the invoice total. Bills and payroll lines are quoted so the recipient receives the exact amount; you send slightly more (1 % slippage buffer) and the unused part is refunded to your Intents balance. Without a partner API key 1Click adds an extra 0.25% platform fee.
- **No automatic execution.** The agent only suggests; each suggestion, bill and payroll line is executed only when you sign it. A bill's due date is a reminder. Suggestions are computed when you open Home or the Agent page, not on a schedule.
- **AI limits.** NEAR AI drafts and summaries can be wrong; a draft is validated and must be signed, the summary is labelled and built from totals only. The default model has not yet been exercised with a real key (see [docs/NEAR-AI.md](docs/NEAR-AI.md)). The drafting rate limit is a fixed one-minute window per owner (up to 10 calls can land within 60 s across a window boundary). Two summary requests that miss the cache at the same moment may each call the model once; the later one overwrites the cache.
- **Bill pay reconciliation across Manexus** works for invoices issued on the same Manexus deployment (same database); for any other vendor, enter the bill manually.
- **Named NEAR accounts** (`alice.near`) must register their public key on `intents.near` once (a wallet-approved `add_public_key` call, 1 yoctoNEAR plus gas) before they can sign withdrawals; the app guides this step. EVM accounts need no registration.
- `npm audit --omit=dev` reports 25 advisories (3 high, 8 moderate, 14 low) in wallet-SDK transitive dependencies (e.g. `@meteorwallet/sdk`, `nanoid`, `@hot-wallet/sdk`, `@solana/web3.js`); fixes require breaking upgrades.
- Balance, swap and dashboard USD figures are reference prices only; tokens without a reference price show no USD value.

## Hackathon work vs. pre-existing baseline

**Baseline:** commits up to and including `7d827b1` (2026-10-21/22), a static, browser-only quote/invoice-preview prototype with no backend, no wallet sign-in, and no real payments. **Everything after `7d827b1` is hackathon work** (Plan 1 core loop, Plan 2 treasury features, Plan 3 agent and submission). Generated with `git log --oneline 7d827b1..HEAD`, newest first; the commit that adds this list and `docs/SUBMISSION.md` follows these:

```
deadced fix: rate-limit AI rule drafting, discard a draft, summary token headroom
b1020d0 feat: NEAR AI Cloud rule drafting and treasury summary
cb7628c fix: unlink a failed transfer when its proposal reopens; guard the stuck release
db392c4 fix: link an approval only to its own claim; one signable agent quote per token
0cf9cb7 feat: approve agent proposals with one wallet signature
43ae642 fix: recount the 24-hour cap after the submit claim; whitelist matches recipient type
c6bcd29 fix: cap agent drafts, latest-dismissal semantics, chunked writes, force minimum
945b6aa feat: deterministic treasury agent proposals
bb6eb5a feat: signed treasury policy, whitelist and spending limits
e57f1ed fix: harden NEAR AI spike probe and document its behavior
5695bdf chore: record NEAR AI Cloud API facts
5b5b9a8 docs: Plan 3 AI treasury agent and submission
2e5a225 docs: list Plan 2 commits with real hashes, clarify this month's sent
1a76618 fix: measure the failed-relay grace from the later of intent and quote deadlines
b183196 fix: refreshInvoice checks at most 10 attempts per call, stalest first
228ea45 fix: this month's sent excludes the slippage buffer 1Click refunded
7aa6f00 fix: payroll batch view and payee import fit D1's per-request query limit
f26c727 docs: treasury features README and end-to-end test
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
7faf0e0 fix: only a stuck-submit expiry claims no funds moved; a late submit re-tracks the row
6ebcd1a test: browser mismatch row without an amount drops the default received amount
6ea02c9 fix: a withdrawal whose submit never finished fails after its quote deadline
1c1a393 fix: a mismatched SUCCESS not delivered to the owner shows no received amount
5bf1f9c fix: re-confirm the withdrawal address after a sign or submit error
05262ba docs: D1 holds challenges not sessions; hint that status updates on open
3fa683d fix: reject a pay quote that does not deliver the invoice total
6545994 fix: refresh never downgrades a withdrawal whose submit is in flight
1f72696 fix: never tell a payer funds were refunded after a 1Click SUCCESS
436d9f3 fix: call injected fetch bare so 1Click works on workerd
6903fee docs: tidy test block
f3a9cae docs: cite incident source, reword audit note, test and CSP checklist
cb79eae docs: core loop README, CSP, local dev scripts and E2E
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
# optional: enables AI rule drafting and the treasury summary (off without it)
npx wrangler pages secret put NEAR_AI_API_KEY --project-name manexus-intents
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
- [ ] Approve one live **agent convert proposal**: sign a rule that converts a small non-stablecoin balance (e.g. ~2 USD of wNEAR, with the minimum set to $1) to USDC, approve the suggestion, sign, and confirm it reaches Done and the USDC appears on Home.
- [ ] One signed **spending limit** checked live: a withdrawal above the per-transaction cap is refused with "This exceeds your per-transaction limit" before any signature.
- [ ] With `NEAR_AI_API_KEY` set: one "Describe your rules" draft and one AI summary; record latency and whether the default model needs a different `max_tokens` in `docs/NEAR-AI.md` (Step 2 of the NEAR AI spike).
- [ ] Real wallet sign-in check with Meteor, HOT and MetaMask; verify the CSP in `public/_headers` allows the wallet's network calls (browser console shows no CSP violations); adjust origins if needed.
- [ ] Record resulting transaction hashes in `docs/NEAR-INTENTS.md`.

## Roadmap

Per the [design spec](docs/superpowers/specs/2026-10-29-manexus-intents-design.md): Plan 1 (core loop, [plan](docs/superpowers/plans/2026-10-29-plan1-core-loop.md)), Plan 2 (in-account swap, bill pay, payroll/batch payout, treasury dashboard, [plan](docs/superpowers/plans/2026-10-30-plan2-treasury-features.md)) and Plan 3 (signed policy, spending limits, whitelist, agent suggestions, NEAR AI rule drafting and summary, submission package, [plan](docs/superpowers/plans/2026-10-30-plan3-ai-treasury-agent.md)) are implemented as described above. Not yet done: a production deployment, the live launch gates above, and the demo video and X post ([docs/SUBMISSION.md](docs/SUBMISSION.md)).
