# Plan 1 — Core Loop (Invoice → Multichain Payment → Intents Balance → Withdraw) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business signs in with a NEAR or EVM wallet, issues a USDC/USDT invoice, a client pays it with any token on any chain via NEAR Intents 1Click, the funds land in the owner's non-custodial `intents.near` balance, the invoice is verifiably marked paid, and the owner withdraws to any chain/exchange address.

**Architecture:** Existing Vite + vanilla-TS SPA becomes a hash-routed app talking only to same-origin `/api/*` Cloudflare Pages Functions. Functions are thin route files over pure, dependency-injected modules in `server/` (tested with Node's test runner and a `node:sqlite` D1 shim). Pure helpers shared by browser and server live in `shared/`. 1Click API key, sessions and NEAR RPC calls are server-side only.

**Tech Stack:** TypeScript 5.9, Vite 7, Cloudflare Pages Functions + D1 (wrangler), viem (EVM signatures/addresses), `@noble/curves` + `@noble/hashes` + `@scure/base` (NEP-413 verification), `@near-wallet-selector/core` + `modal-ui` + `meteor-wallet` + `hot-wallet`, Node 24 `node:test` + `node:sqlite`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-manexus-intents-design.md`

## Global Constraints

- 1Click base URL `https://1click.chaindefuser.com`; endpoints `/v0/tokens`, `/v0/quote`, `/v0/status`, `/v0/deposit/submit`, `/v0/generate-intent`, `/v0/submit-intent`. `X-API-Key: <ONECLICK_API_KEY>` header sent only when the secret is set; never shipped to the browser.
- Mainnet only. No mock/sample data is ever displayed as real; any upstream failure shows an error, never a fallback number.
- Manexus never holds keys or funds. Recipient of invoice payments is the owner's Intents account (`recipientType: "INTENTS"`).
- Intents account id: NEAR → the NEAR account id; EVM → lowercase `0x` address (confirmed in Task 0).
- Settlement tokens: exactly the USDC and USDT `nep141:` ids recorded in Task 0 (`shared/assets.ts`).
- All money as integer base-unit strings / `bigint`. No `Number` arithmetic on amounts.
- Invoice `paid` is set only by `server/reconcile.ts` from a 1Click `SUCCESS` status (no manual mark-paid).
- Every HTML interpolation of user/upstream text goes through `escapeHTML` (`shared/text.ts`).
- Local env: `.env` (gitignored) holds `PORT`, `ALLOWED_HOSTS`, `SESSION_SECRET`, `ONECLICK_API_KEY`, `ONECLICK_BASE_URL`, `NEAR_RPC_URL`; `.env.example` is committed. Server secrets are never `VITE_`-prefixed. Ports stay in staging block 24010–24019 (vite 24010, wrangler 24011).
- Sessions: HttpOnly, Secure, SameSite=Lax cookie `mx_session`, HMAC-SHA256 with `SESSION_SECRET`, 7-day expiry. Sign-in challenges single-use, 5-minute expiry.
- Copy: English UI; never claim "safe", "guaranteed" or "insured"; show "Powered by NEAR Intents".
- Existing test convention: `node --test` over `tests/**/*.test.ts`, `assert/strict`; one Playwright worker.
- Commits: one per task minimum, message prefix `feat:`/`chore:`/`test:`/`docs:`; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Underpayment / wrong token sent by payer** — 1Click returns `INCOMPLETE_DEPOSIT` or `REFUNDED`; invoice must stay `issued`, attempt shows refunded/incomplete. (Task 6 tests.)
2. **Two payment attempts both succeed** — invoice becomes `paid` once (first SUCCESS by `updatedAt`); the second attempt is flagged `duplicate` and shown to the owner as extra funds received. (Task 6 tests.)
3. **Quote expired before deposit** — attempt past `deadline` with `PENDING_DEPOSIT` is shown expired; payer page refuses to redisplay its deposit address and offers a new quote. (Task 5 tests.)
4. **Cross-tenant access** — user A requesting user B's invoice, attempt or withdrawal id gets 404, and B's invoices never appear in A's list. (Task 4 and Task 8 tests.)
5. **Withdraw over balance / invalid destination address / signer mismatch** — rejected before any 1Click call; a signed intent whose signer ≠ session account is rejected. (Task 8 tests.)

---

## File Structure

```
shared/                      pure, browser+server
  text.ts                    escapeHTML, text guards (moved from src/domain.ts)
  units.ts                   validAmount, baseUnits, formatUnits, formatAmount (moved from src/domain.ts, src/live.ts, src/invoice.ts)
  address.ts                 validDestination(chain, address)
  assets.ts                  SETTLEMENT_TOKENS (USDC/USDT nep141 ids from Task 0)
  invoice.ts                 InvoiceDraft type, validateDraft, invoiceTotal (line math from src/invoice.ts)
server/                      pure logic, deps injected
  env.ts                     Env type
  http.ts                    json(), error(), readJson(), HttpError
  db.ts                      Db type (D1 subset)
  session.ts                 sign/verify session cookie
  auth.ts                    challenges, verifyErc191Login, verifyNep413Login, nep413Hash
  near-rpc.ts                viewFunction, viewAccessKey
  oneclick.ts                OneClick client
  invoices.ts                invoice repository + lifecycle
  payments.ts                createPaymentQuote, attempt repository
  reconcile.ts               reconcileAttempt, refreshInvoice
  balances.ts                getBalances
  withdraw.ts                quoteWithdrawal, submitWithdrawal, refreshWithdrawal
functions/api/...            thin Pages Function routes (one file per route)
migrations/0001_init.sql
wrangler.toml
src/
  main.ts                    router + shell (rewritten)
  api.ts                     fetch wrapper
  wallet/near.ts, wallet/evm.ts, wallet/index.ts
  views/login.ts, home.ts, invoices.ts, invoice-detail.ts, pay.ts, withdraw.ts
  style.css                  kept, extended
tests/
  server/d1-shim.ts          node:sqlite → Db
  server/*.test.ts, shared/*.test.ts
  fixtures/oneclick/*.json   recorded in Task 0
  browser/*.spec.ts          mocked /api
```

Deleted in Task 3: `src/testnet.ts`, `src/testnet-ui.ts`, `src/invoice-ui.ts`, `src/live.ts`, `src/domain.ts`, `src/invoice.ts` (contents moved to `shared/`), `tests/testnet.test.ts`, `tests/browser/{testnet,live,flows,invoice}.spec.ts`, `tests/domain.test.ts`, `tests/invoice.test.ts` (relevant cases moved to `tests/shared/`).

---

### Task 0: Spike — verify 1Click Intents routing and record fixtures

No production code. Output is facts the later tasks depend on. Uses `dry: true` quotes only; no funds.

**Files:**
- Create: `scripts/spike-oneclick.ts`, `tests/fixtures/oneclick/tokens.json`, `tests/fixtures/oneclick/quote-pay-exact-output.json`, `tests/fixtures/oneclick/quote-withdraw-intents.json`, `docs/NEAR-INTENTS.md`

- [ ] **Step 1: Record tokens** — `GET /v0/tokens` → save to `tokens.json`. Record in `docs/NEAR-INTENTS.md` the `assetId`, `decimals`, `blockchain` for USDC and USDT whose `blockchain` is `near` (settlement tokens), plus USDC on `arb`, `base`, `eth`, `sol` (withdraw targets).
- [ ] **Step 2: Dry pay quote** — `scripts/spike-oneclick.ts` posts `{dry:true, swapType:"EXACT_OUTPUT", slippageTolerance:100, originAsset:<USDC arb>, depositType:"ORIGIN_CHAIN", destinationAsset:<USDC near>, amount:"1000000", refundTo:"0x000…01", refundType:"ORIGIN_CHAIN", recipient:<R>, recipientType:"INTENTS", deadline:+30min}` twice: `R = "manexus-spike.near"` and `R = lowercase EVM address`. Save the first to `quote-pay-exact-output.json`. Record: accepted? (HTTP 200 with `quote.amountIn`). If EVM ids are rejected, STOP and report — the account-id decision in the spec must change.
- [ ] **Step 3: Dry withdraw quote** — `{dry:true, swapType:"EXACT_INPUT", depositType:"INTENTS", originAsset:<USDC near>, destinationAsset:<USDC arb>, refundType:"INTENTS", refundTo:R, recipientType:"DESTINATION_CHAIN", recipient:"0x…02", amount:"1000000", …}` → save `quote-withdraw-intents.json`.
- [ ] **Step 4: Signing facts** — from the docs pages "Signing Intents" and `submit-a-signed-intent.md` (offset ≥100000), record in `docs/NEAR-INTENTS.md`: the exact ERC-191 `standard` literal; the `signedData` shape for erc191 (field names); whether a NEAR named account must call `intents.near` `add_public_key` before its NEP-413 signatures are accepted, and the view method to check (`has_public_key`); whether EVM accounts need any registration.
- [ ] **Step 5: Public balance read** — call NEAR RPC `https://rpc.mainnet.fastnear.com` `query` `call_function` on `intents.near` `mt_batch_balance_of` `{account_id:R, token_ids:[<USDC near>]}` for both R forms; record that it returns `["0"]` (not an error).
- [ ] **Step 6: Commit** — `git add scripts tests/fixtures docs/NEAR-INTENTS.md && git commit -m "chore: record NEAR Intents 1Click routing facts"`

---

### Task 1: Backend foundation (Pages Functions, D1, test shim)

**Files:**
- Create: `wrangler.toml`, `migrations/0001_init.sql`, `server/env.ts`, `server/db.ts`, `server/http.ts`, `functions/api/health.ts`, `functions/tsconfig.json`, `tests/server/d1-shim.ts`, `tests/server/http.test.ts`, `tests/server/schema.test.ts`
- Modify: `package.json` (scripts, devDeps `wrangler`, `@cloudflare/workers-types`), `tsconfig.json` (`include: ["src","shared","server"]`). `vite.config.ts` stays as is (wrangler fronts vite, so no `/api` proxy). Env/secrets already exist in `.env` / `.env.example` (wrangler reads `.env` when no `.dev.vars` exists) — do not create `.dev.vars`

**Interfaces:**
- Produces:
  - `type Env = { DB: Db; SESSION_SECRET: string; ONECLICK_API_KEY?: string; NEAR_RPC_URL: string; ONECLICK_BASE_URL: string }`
  - `type Db = { prepare(sql: string): { bind(...v: unknown[]): Stmt } }`, `Stmt = { first<T>(): Promise<T|null>; all<T>(): Promise<{results:T[]}>; run(): Promise<{meta:{changes:number}}> }` (D1-compatible subset)
  - `class HttpError extends Error { status: number }`, `json(body: unknown, status = 200): Response`, `readJson(req: Request, maxBytes = 16384): Promise<unknown>`, `handle(fn: () => Promise<Response>): Promise<Response>` (maps HttpError → `{error}` with status, others → 500 `{error:"Internal error"}`)
  - `createTestDb(): Db` in `tests/server/d1-shim.ts` — `node:sqlite` `DatabaseSync(":memory:")`, executes `migrations/*.sql` in order.

Schema (`0001_init.sql`):
```sql
CREATE TABLE challenges (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('near','evm')), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE invoices (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','issued','paid','cancelled')), token_id TEXT NOT NULL, data TEXT NOT NULL, total TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issued_at TEXT, paid_at TEXT, paid_by TEXT);
CREATE INDEX invoices_owner ON invoices(owner, updated_at);
CREATE TABLE payment_attempts (deposit_address TEXT PRIMARY KEY, deposit_memo TEXT, invoice_id TEXT NOT NULL REFERENCES invoices(id), origin_asset TEXT NOT NULL, amount_in TEXT NOT NULL, refund_to TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, amount_out TEXT, upstream TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX attempts_invoice ON payment_attempts(invoice_id);
CREATE TABLE withdrawals (deposit_address TEXT PRIMARY KEY, owner TEXT NOT NULL, origin_asset TEXT NOT NULL, destination_asset TEXT NOT NULL, amount TEXT NOT NULL, recipient TEXT NOT NULL, intent_hash TEXT, status TEXT NOT NULL, upstream TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX withdrawals_owner ON withdrawals(owner, created_at);
```

`wrangler.toml`: `name = "manexus-intents"`, `pages_build_output_dir = "dist"`, `compatibility_date = "2026-10-01"`, `[[d1_databases]] binding = "DB", database_name = "manexus-intents", migrations_dir = "migrations"`, `[vars] NEAR_RPC_URL = "https://rpc.mainnet.fastnear.com"`, `ONECLICK_BASE_URL = "https://1click.chaindefuser.com"`.

Scripts: `"test": "node --test 'tests/**/*.test.ts'"`, `"dev:api": "wrangler pages dev --d1 DB --port 24011 -- vite --host 127.0.0.1"`, `"db:migrate:local": "wrangler d1 migrations apply manexus-intents --local"`.

- [ ] **Step 1: Write failing tests** — `tests/server/schema.test.ts`: `createTestDb()` then inserting an invoice with `status='unknown'` throws; `tests/server/http.test.ts`: `await handle(async () => { throw new HttpError(404, "Not found") })` → status 404 body `{error:"Not found"}`; a plain `Error("secret")` → 500 body `{error:"Internal error"}` (no leak); `readJson` on a 20 000-byte body throws HttpError 413; on invalid JSON throws 400.
- [ ] **Step 2: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 3: Implement** the files above; `functions/api/health.ts` exports `onRequestGet` returning `json({ ok: true })`.
- [ ] **Step 4: Run** `npm test` → PASS; `npx wrangler pages dev` + `curl -s localhost:24011/api/health` → `{"ok":true}`.
- [ ] **Step 5: Commit** `chore: add Pages Functions, D1 schema and server test harness`.

---

### Task 2: Shared helpers, settlement tokens and the 1Click client

**Files:**
- Create: `shared/text.ts`, `shared/units.ts`, `shared/address.ts`, `shared/assets.ts`, `server/oneclick.ts`, `tests/shared/units.test.ts`, `tests/shared/address.test.ts`, `tests/server/oneclick.test.ts`

**Interfaces:**
- Produces:
  - `escapeHTML(s: string): string`; `validAmount(v: string, decimals: number): boolean`; `baseUnits(amount: string, decimals: number): bigint`; `formatAmount(units: bigint, decimals: number): string` (trailing zeros trimmed)
  - `validDestination(chain: string, address: string): boolean` — supports `eth, arb, base, op, pol, bsc, avax, gnosis` (viem `isAddress` strict, nonzero), `near` (named regex from old `validAddress` or 64-hex implicit), `sol` (base58 32–44), `btc` (bech32 `bc1` or base58 `1`/`3`), `tron` (`T` + 33 base58). Unknown chain → `false`.
  - `SETTLEMENT_TOKENS: readonly { symbol: "USDC"|"USDT"; tokenId: string; decimals: 6 }[]`, `settlementToken(tokenId: string)` throws if unknown.
  - `type OneClickToken = { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number }`
  - `type QuoteRequest` (fields per spec; `dry`, `swapType`, `slippageTolerance`, `originAsset`, `depositType`, `destinationAsset`, `amount`, `refundTo`, `refundType`, `recipient`, `recipientType`, `deadline`, optional `referral`)
  - `type Quote = { depositAddress: string; depositMemo?: string; amountIn: string; minAmountIn: string; amountOut: string; minAmountOut: string; deadline: string; timeEstimate?: number }`
  - `type SwapStatus = { status: "KNOWN_DEPOSIT_TX"|"PENDING_DEPOSIT"|"INCOMPLETE_DEPOSIT"|"PROCESSING"|"SUCCESS"|"REFUNDED"|"FAILED"; updatedAt: string; quoteRequest: QuoteRequest; amountOut?: string; refundedAmount?: string; originTxHashes: string[]; destinationTxHashes: string[] }`
  - `createOneClick(opts: { baseUrl: string; apiKey?: string; fetch: typeof fetch }): { tokens(): Promise<OneClickToken[]>; quote(r: QuoteRequest): Promise<Quote>; status(depositAddress: string, memo?: string): Promise<SwapStatus>; submitDeposit(txHash: string, depositAddress: string): Promise<void>; generateIntent(a: { depositAddress: string; signerId: string; standard: "nep413"|"erc191" }): Promise<{ standard: string; payload: unknown }>; submitIntent(signedData: unknown): Promise<{ intentHash: string }> }`
  - Upstream non-2xx → `HttpError(502, "NEAR Intents: <upstream message, max 200 chars>")`; malformed body → `HttpError(502, "NEAR Intents returned an unexpected response")`. Timeout 15 s via `AbortSignal.timeout`.

- [ ] **Step 1: Write failing tests**
  - units: `baseUnits("0.7", 6) === 700000n`; `baseUnits("1.0000001", 6)` throws; `formatAmount(700000n, 6) === "0.7"`; `validAmount("01", 6) === false`.
  - address: `validDestination("arb","0x2222222222222222222222222222222222222222")` true; `("arb","0x0000000000000000000000000000000000000000")` false; `("near","alice.near")` true; `("near","0x22…22")` false; `("sol","So11111111111111111111111111111111111111112")` true; `("btc","bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")` true; `("doge","D…")` false.
  - assets: every `SETTLEMENT_TOKENS[i].tokenId` exists in `tests/fixtures/oneclick/tokens.json` with `blockchain === "near"` and matching decimals.
  - oneclick (fake `fetch` recording calls): `quote()` sends `X-API-Key` only when `apiKey` set; parses `quote-pay-exact-output.json` (with a synthetic `depositAddress` injected) into `Quote`; a quote missing `depositAddress` when `dry:false` → 502; `status()` builds `/v0/status?depositAddress=...&depositMemo=...`; upstream 400 `{message:"bad"}` → `HttpError` 502 `"NEAR Intents: bad"`.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement.** Move helpers from `src/domain.ts`, `src/live.ts`, `src/invoice.ts` (keep originals until Task 3 deletes them). `SETTLEMENT_TOKENS` values from `docs/NEAR-INTENTS.md`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: add shared money helpers and 1Click client`.

---

### Task 3: Wallet sign-in and new app shell

**Files:**
- Create: `server/session.ts`, `server/auth.ts`, `server/near-rpc.ts`, `functions/api/auth/challenge.ts`, `functions/api/auth/verify.ts`, `functions/api/auth/logout.ts`, `functions/api/me.ts`, `functions/api/_middleware.ts`, `src/api.ts`, `src/wallet/near.ts`, `src/wallet/evm.ts`, `src/wallet/index.ts`, `src/views/login.ts`, `tests/server/session.test.ts`, `tests/server/auth.test.ts`, `tests/browser/login.spec.ts`
- Modify: `src/main.ts` (rewrite), `src/style.css`, `package.json` (deps)
- Delete: files listed under File Structure "Deleted in Task 3"

**Interfaces:**
- Consumes: `Env`, `Db`, `HttpError`, `json`, `readJson`, `handle` (Task 1).
- Produces:
  - `signSession(account: string, kind: "near"|"evm", secret: string, now = Date.now()): Promise<string>`; `readSession(cookieHeader: string|null, secret: string, now = Date.now()): Promise<{ account: string; kind: "near"|"evm" } | null>`
  - `requireUser(req: Request, env: Env): Promise<{ account: string; kind: "near"|"evm" }>` (throws HttpError 401)
  - `createChallenge(db: Db, account: string, kind, now): Promise<{ nonce: string; message: string; recipient: "manexus-intents" }>` — nonce = 32 random bytes base64; EVM `message` = `"Manexus Intents sign-in\nAccount: <account>\nNonce: <nonce>"`; NEAR `message` = `"Sign in to Manexus Intents"`.
  - `nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string|null }): Uint8Array` — sha256 of: u32 LE `2147484061`, then borsh `string message`, `[u8;32] nonce`, `string recipient`, `Option<string> callbackUrl` (borsh string = u32 LE length + UTF-8 bytes; Option = 0 or 1 + value).
  - `verifyLogin(db: Db, rpc: NearRpc, body: { kind; account; nonce; signature; publicKey? }, now): Promise<string /*account*/>` — consumes challenge (must exist, unused, unexpired, same account/kind); EVM: viem `verifyMessage`; NEAR: ed25519 verify over `nep413Hash`, and `rpc.viewAccessKey(account, publicKey)` permission must be `"FullAccess"`.
  - `type NearRpc = { viewAccessKey(account: string, publicKey: string): Promise<{ permission: unknown } | null>; viewFunction<T>(contract: string, method: string, args: object): Promise<T> }`; `createNearRpc(url: string, fetch: typeof fetch): NearRpc`
  - Routes: `POST /api/auth/challenge {kind, account}` → challenge; `POST /api/auth/verify` → sets `mx_session`, returns `{account, kind}`; `POST /api/auth/logout`; `GET /api/me` → `{account, kind}` or 401.
  - `_middleware.ts`: rejects non-GET `/api/*` requests whose `Origin` header is present and ≠ request origin (403).
  - Browser: `api<T>(path: string, init?: RequestInit): Promise<T>` (throws `Error(body.error)`); `connectWallet(kind: "near"|"evm"): Promise<{ account: string; kind }>`; `signNep413(p: { message: string; nonce: Uint8Array; recipient: string }): Promise<{ publicKey: string; signature: string /* base64 */ }>`; `signErc191(message: string): Promise<string>`.
  - Router in `src/main.ts`: routes `#/` (home), `#/invoices`, `#/invoices/:id`, `#/withdraw`, `#/pay/:publicId` (public, no login). `registerView(name, mount: (el: HTMLElement, params: Record<string,string>) => () => void)`. Signed-out users on private routes see the login view.

NEAR wallets: Meteor and HOT only (both sign NEP-413 without page redirect). EVM: injected `window.ethereum` (EIP-1193), EOAs only, `personal_sign`.

- [ ] **Step 1: Write failing tests**
  - session: round-trip returns account; tampered HMAC → null; expired (`now + 8 days`) → null.
  - auth: EVM login with a viem `privateKeyToAccount` test key signing the challenge message → returns lowercase address; reusing the same nonce → 401; nonce for a different account → 401; expired (now + 6 min) → 401. NEAR login with a `@noble/curves` ed25519 test key signing `nep413Hash(...)` and fake rpc returning `{permission:"FullAccess"}` → returns account; fake rpc returning a `FunctionCall` permission → 401; rpc returning null → 401. `nep413Hash` of a fixed vector (message `"hi"`, nonce 32×`0x01`, recipient `"r"`) equals the hex value computed once with the reference `@near-js` implementation and pasted as constant (record the source in the test comment).
  - browser `login.spec.ts` (mock `/api/me` 401 then 200): `#/` shows "Connect NEAR wallet" and "Connect EVM wallet"; `#/pay/abc` does not show the login view.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** server modules and routes.
- [ ] **Step 4: Implement** browser wallet adapters, `api.ts`, login view, router shell (sidebar: Home, Invoices, Withdraw; account chip with sign-out; mobile bottom nav as in the current CSS). Delete retired files and their tests.
- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run build` → PASS; `npx playwright test login.spec.ts --workers=1` → PASS.
- [ ] **Step 6: Manual check** with a real Meteor/HOT wallet and MetaMask on `npm run dev:api`: sign-in works, `/api/me` returns the account. Record result in the task report.
- [ ] **Step 7: Commit** `feat: wallet sign-in with NEP-413 and ERC-191, new app shell`.

---

### Task 4: Server-side invoices

**Files:**
- Create: `shared/invoice.ts`, `server/invoices.ts`, `functions/api/invoices/index.ts` (GET list, POST create), `functions/api/invoices/[id].ts` (GET, PUT), `functions/api/invoices/[id]/issue.ts`, `functions/api/invoices/[id]/cancel.ts`, `functions/api/public/invoices/[publicId].ts`, `src/views/invoices.ts`, `src/views/invoice-detail.ts`, `tests/shared/invoice.test.ts`, `tests/server/invoices.test.ts`, `tests/browser/invoices.spec.ts`

**Interfaces:**
- Consumes: `requireUser` (Task 3), `SETTLEMENT_TOKENS`, `baseUnits`, `formatAmount` (Task 2).
- Produces:
  - `type InvoiceDraft = { number: string; client: string; issuer: string; dueDate: string; tokenId: string; notes: string; items: { description: string; quantity: string; unitPrice: string }[] }` (limits as old `readData`: number 32, issuer/client 64, notes 280, description 100, 1–10 items, quantity 1–9999)
  - `readDraft(v: unknown): InvoiceDraft` (shape only, for drafts); `validateDraft(v: unknown): InvoiceDraft` (full, for issue); `invoiceTotal(d: InvoiceDraft): bigint`
  - `type InvoiceRow = { id; publicId; owner; status: "draft"|"issued"|"paid"|"cancelled"; tokenId; data: InvoiceDraft; total: string; revision: number; createdAt; updatedAt; issuedAt?; paidAt?; paidBy?: string }`
  - `createInvoice(db, owner, draft, now): Promise<InvoiceRow>`; `listInvoices(db, owner): Promise<InvoiceRow[]>` (max 200, `updated_at DESC`); `getInvoice(db, owner, id): Promise<InvoiceRow>` (404 if other owner); `updateInvoice(db, owner, id, revision, draft, now)` (409 on stale revision, 409 if not draft); `issueInvoice(db, owner, id, now)` (runs `validateDraft`); `cancelInvoice(db, owner, id, now)` (only from `issued`); `getPublicInvoice(db, publicId): Promise<PublicInvoice>` — `PublicInvoice = { publicId; status; tokenId; symbol; data: InvoiceDraft; total: string; totalFormatted: string; payTo: string /*owner*/; dueDate }`, 404 for drafts.
  - `publicId` = 16 random bytes base64url; `id` = `crypto.randomUUID()`.
  - Derived `overdue` (UTC `dueDate` < today and status `issued`) is computed in the view, not stored.

- [ ] **Step 1: Write failing tests**
  - shared: lines `3 × 0.1` + `2 × 0.2` USDC → `invoiceTotal === 700000n`; quantity `"0"` throws `"Line 1: use a whole quantity from 1 to 9999."`; unknown `tokenId` throws.
  - server: create → status `draft`, revision 1; owner B `getInvoice(A's id)` → 404 and `listInvoices(B)` excludes it (**Review Focus 4**); update with revision 1 after another update → 409; issue → status `issued`, `total === "700000"`, then `updateInvoice` → 409; cancel draft → 409; `getPublicInvoice` of a draft → 404; of issued → `payTo === owner`, `totalFormatted === "0.7"`.
  - browser (mocked API): create invoice form → list shows `DEMO-001`, `0.7 USDC`, status chip `Issued`; detail shows "Copy payment link" with `#/pay/<publicId>`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** server module + routes.
- [ ] **Step 4: Implement** views: list with status filters (All, Draft, Issued, Overdue, Paid, Cancelled), editor (reuse field layout from the retired `invoice-ui.ts`), detail with issue/cancel/duplicate and copy link. Token select shows only `SETTLEMENT_TOKENS`.
- [ ] **Step 5: Run** unit + `invoices.spec.ts` → PASS.
- [ ] **Step 6: Commit** `feat: server-side invoices with owner isolation`.

---

### Task 5: Public pay page — quote from any chain into the owner's Intents balance

**Files:**
- Create: `server/payments.ts`, `functions/api/public/invoices/[publicId]/quote.ts`, `functions/api/public/invoices/[publicId]/deposit.ts`, `functions/api/tokens.ts`, `src/views/pay.ts`, `tests/server/payments.test.ts`, `tests/browser/pay.spec.ts`

**Interfaces:**
- Consumes: `getPublicInvoice` (Task 4), `createOneClick` (Task 2), `validDestination` (Task 2).
- Produces:
  - `GET /api/tokens` → `OneClickToken[]` (proxied, `Cache-Control: max-age=300`).
  - `createPaymentQuote(deps: { db; oneclick; now: Date }, publicId: string, body: { originAsset: string; refundTo: string }): Promise<PaymentAttemptView>` — rejects unless invoice `issued` (409 `"This invoice is not payable"`); `originAsset` must exist in `tokens()`; `refundTo` must pass `validDestination(originToken.blockchain, refundTo)` (400). Quote request: `dry:false, swapType:"EXACT_OUTPUT", slippageTolerance:100, depositType:"ORIGIN_CHAIN", refundType:"ORIGIN_CHAIN", destinationAsset: invoice.tokenId, amount: invoice.total, recipient: invoice.payTo, recipientType:"INTENTS", deadline: now+30 min ISO, referral:"manexus"`. Stores a `payment_attempts` row with status `PENDING_DEPOSIT`.
  - `type AttemptRow` = camelCase mirror of the `payment_attempts` columns; `listAttempts(db, invoiceId): Promise<AttemptRow[]>`; `saveAttempt(db, row: AttemptRow): Promise<void>`.
  - `type PaymentAttemptView = { depositAddress; depositMemo?; originAsset; amountIn; amountInFormatted; deadline; status; outcome?: "paid"|"duplicate"|"after_cancel"|"refunded"|"failed"; expired: boolean }`
  - `submitDepositTx(deps, publicId, { depositAddress, txHash })` → `oneclick.submitDeposit`; 404 if the attempt is not for that invoice.
  - Rate limit: max 20 attempts per invoice (429).

- [ ] **Step 1: Write failing tests** (fake oneclick)
  - quote for issued invoice → oneclick received `recipient === owner`, `recipientType === "INTENTS"`, `amount === "700000"`, `swapType === "EXACT_OUTPUT"`, `destinationAsset === USDC tokenId`; attempt row saved.
  - draft / cancelled / paid invoice → 409, oneclick not called.
  - `refundTo` `"alice.near"` for an `arb` origin token → 400, oneclick not called.
  - **Review Focus 3:** attempt with `deadline` < now and status `PENDING_DEPOSIT` → view `expired: true` and `depositAddress` replaced by `""`.
  - 21st attempt → 429.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Implement** `pay.ts`: invoice summary (issuer, client, items, total, due date, "Paid to <account> on NEAR Intents"); "Pay with" searchable token+chain picker from `/api/tokens`; refund address field labelled for the chosen chain; "Get payment instructions" → shows exact `amountInFormatted` + symbol + chain, deposit address (+ memo if any) with copy buttons, countdown to deadline, note "Send exactly this amount from the selected chain. Unused amount is refunded to your refund address."; optional "I've sent it — paste tx hash". Paid/cancelled invoices show their state and no form.
- [ ] **Step 5: Run** unit + `pay.spec.ts` (mocked API: picker, instructions, expired state, paid state) → PASS.
- [ ] **Step 6: Commit** `feat: public invoice payment via 1Click into owner Intents balance`.

---

### Task 6: Reconciliation — verified paid status

**Files:**
- Create: `server/reconcile.ts`, `functions/api/public/invoices/[publicId]/status.ts`, `functions/api/invoices/[id]/payments.ts`, `tests/server/reconcile.test.ts`
- Modify: `src/views/pay.ts` (poll status every 10 s while pending), `src/views/invoice-detail.ts` (payments list), `src/views/invoices.ts` (Paid chip)

**Interfaces:**
- Consumes: `SwapStatus`, `oneclick.status` (Task 2), attempt rows (Task 5), invoice rows (Task 4).
- Produces:
  - `decideOutcome(invoice: InvoiceRow, attempt: AttemptRow, s: SwapStatus): { status: SwapStatus["status"]; outcome?: "paid"|"duplicate"|"after_cancel"|"refunded"|"failed"; amountOut?: string }` — **pure**. `paid` only if all hold: `s.status === "SUCCESS"`, `s.quoteRequest.recipient === invoice.owner`, `s.quoteRequest.recipientType === "INTENTS"`, `s.quoteRequest.destinationAsset === invoice.tokenId`, `BigInt(s.amountOut) >= BigInt(invoice.total)`. If those hold but the invoice is already `paid` by another attempt → `duplicate`; invoice `cancelled` → `after_cancel`. `REFUNDED` → `refunded`; `FAILED` → `failed`; SUCCESS with mismatched recipient/asset/amount → `failed` (log, never paid).
  - `refreshInvoice(deps: { db; oneclick; now }, invoiceId: string): Promise<void>` — for each attempt not in a terminal outcome and not expired >24 h: fetch status, apply `decideOutcome`; marks invoice `paid` (sets `paid_at`, `paid_by = deposit_address`) inside a single `UPDATE invoices SET status='paid' … WHERE id=? AND status='issued'` so concurrent refreshes can't double-pay.
  - `GET /api/public/invoices/:publicId/status` → `{ invoiceStatus, attempts: PaymentAttemptView[] }` (calls `refreshInvoice`, throttled to once per 5 s per invoice via `updated_at`).
  - `GET /api/invoices/:id/payments` (owner) → same plus `originTxHashes`, `destinationTxHashes`, `amountOut`.

- [ ] **Step 1: Write failing tests** (pure `decideOutcome` + `refreshInvoice` with test db and fake oneclick)
  - SUCCESS, matching, `amountOut "700000"` → `paid`; invoice row `status==='paid'`, `paid_by` set.
  - SUCCESS with `recipient: "attacker.near"` → `failed`, invoice stays `issued`.
  - SUCCESS with `amountOut "699999"` → not paid.
  - **Review Focus 1:** `INCOMPLETE_DEPOSIT` → invoice `issued`, attempt status `INCOMPLETE_DEPOSIT`; `REFUNDED` → outcome `refunded`.
  - **Review Focus 2:** two attempts both SUCCESS → exactly one `paid`, other `duplicate`; running `refreshInvoice` twice is idempotent.
  - cancelled invoice + SUCCESS → `after_cancel`, invoice stays `cancelled`.
  - oneclick throws 502 → attempt unchanged, invoice unchanged, error propagates as 502.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update views**: pay page shows Processing → "Paid — thank you" with destination explorer links; owner detail shows payment list with outcome badges, "Extra payment received (in your balance)" for duplicate/after_cancel.
- [ ] **Step 5: Run** `npm test` + `pay.spec.ts` → PASS.
- [ ] **Step 6: Commit** `feat: reconcile invoice payments from verified 1Click status`.

---

### Task 7: Intents balance and Home view

**Files:**
- Create: `server/balances.ts`, `functions/api/balances.ts`, `src/views/home.ts`, `tests/server/balances.test.ts`, `tests/browser/home.spec.ts`

**Interfaces:**
- Consumes: `NearRpc.viewFunction` (Task 3), `oneclick.tokens` (Task 2), `listInvoices` (Task 4).
- Produces:
  - `getBalances(deps: { rpc: NearRpc; oneclick }, account: string): Promise<{ tokenId; symbol; blockchain; decimals; amount: string; formatted: string; usd?: string }[]>` — `mt_batch_balance_of` on `intents.near` for all `SETTLEMENT_TOKENS` plus token ids from the user's past attempts/withdrawals (Plan 2 swaps will add more); drop zero balances; `usd` from token `price` only, labelled "reference price".
  - `GET /api/balances` (session) → that array.

- [ ] **Step 1: Write failing tests** — fake rpc returning `["2500000","0"]` → one entry USDC `formatted "2.5"`; rpc error → HttpError 502 `"Could not read NEAR Intents balance"` (no zeros returned).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Implement** `home.ts`: Ramp-style overview — total reference USD, balance cards per token, "Receivables" (issued unpaid total + overdue count), recent invoices, buttons "New invoice" and "Withdraw". Copy: "Your funds are held in your own NEAR Intents account (<account>), controlled by your wallet."
- [ ] **Step 5: Run** tests + `home.spec.ts` (mocked) → PASS.
- [ ] **Step 6: Commit** `feat: show non-custodial NEAR Intents balances`.

---

### Task 8: Withdraw to any chain / exchange address

**Files:**
- Create: `server/withdraw.ts`, `functions/api/withdrawals/quote.ts`, `functions/api/withdrawals/submit.ts`, `functions/api/withdrawals/index.ts` (GET list), `functions/api/withdrawals/[depositAddress].ts` (GET status), `src/views/withdraw.ts`, `tests/server/withdraw.test.ts`, `tests/browser/withdraw.spec.ts`
- Modify: `src/wallet/near.ts` (key registration, if Task 0 says it is required)
- Create (only if Task 0 says key registration is required): `functions/api/withdrawals/key-status.ts`

**Interfaces:**
- Consumes: `getBalances` (Task 7), `oneclick.quote/generateIntent/submitIntent/status` (Task 2), `validDestination` (Task 2), `requireUser` (Task 3), `signNep413`/`signErc191` (Task 3).
- Produces:
  - `quoteWithdrawal(deps: { db; oneclick; rpc; now }, user, body: { originAsset: string; amount: string /*base units*/; destinationAsset: string; recipient: string }): Promise<{ depositAddress; amountOut; amountOutFormatted; minAmountOut; deadline; intent: { standard: "nep413"|"erc191"; payload: unknown } }>` — checks `BigInt(amount) > 0` and `<= balance` (400 `"Amount exceeds your balance"`); `validDestination(destinationToken.blockchain, recipient)` (400); quote `dry:false, swapType:"EXACT_INPUT", depositType:"INTENTS", refundType:"INTENTS", refundTo: user.account, recipientType:"DESTINATION_CHAIN", slippageTolerance:100, deadline: now+10 min, referral:"manexus"`; then `generateIntent({ depositAddress, signerId: user.account, standard: user.kind === "near" ? "nep413" : "erc191" })`; stores withdrawal row status `AWAITING_SIGNATURE`.
  - `submitWithdrawal(deps, user, body: { depositAddress: string; signedData: unknown })` — row must belong to user (404); for nep413 `signedData.payload.message` parsed JSON `signer_id` must equal `user.account`; for erc191 parsed payload `signer_id` must equal it (**Review Focus 5**, 403 otherwise); payload must deep-equal the stored generated payload (403); then `submitIntent`, store `intent_hash`, status `PROCESSING`.
  - `refreshWithdrawal(deps, user, depositAddress)` → status from 1Click.
  - Browser: NEP-413 signedData = `{ standard:"nep413", payload, public_key: "ed25519:"+base58(pk), signature: "ed25519:"+base58(sig) }`; ERC-191 signedData per `docs/NEAR-INTENTS.md`.
  - If Task 0 recorded that NEAR named accounts need key registration: before signing, `GET /api/withdrawals/key-status?publicKey=` → `intents.near has_public_key`; if false, UI asks the user to approve `intents.near add_public_key({public_key})` with 1 yoctoNEAR via wallet `signAndSendTransaction`, then re-checks.

- [ ] **Step 1: Write failing tests** (test db, fake oneclick/rpc)
  - happy path: quote request has `depositType "INTENTS"`, `refundTo === account`, `recipientType "DESTINATION_CHAIN"`; generateIntent called with `standard "erc191"` for an EVM user.
  - **Review Focus 5:** amount `balance + 1` → 400, oneclick not called; recipient `"alice.near"` for `arb` destination → 400; submit with `signer_id` of another account → 403; submit with a modified payload → 403; user B submitting A's depositAddress → 404 (**Review Focus 4**).
  - status refresh `SUCCESS` → row `SUCCESS`, `destinationTxHashes` exposed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** server.
- [ ] **Step 4: Implement** `withdraw.ts`: pick balance → amount (with Max) → destination token+chain picker (filtered from `/api/tokens`) → destination address with hint "Exchange deposit address or your wallet; check the network matches" → review screen (you send, you receive ≈ `amountOutFormatted`, min, network, address) → explicit checkbox "I confirm this address is on <chain>" → sign in wallet → progress → success with explorer link. Withdrawal history list.
- [ ] **Step 5: Run** tests + `withdraw.spec.ts` (mocked API and mocked wallet signer) → PASS.
- [ ] **Step 6: Commit** `feat: withdraw from Intents balance to any chain via signed intent`.

---

### Task 9: Hardening, docs, deploy and real-funds smoke test

**Files:**
- Modify: `public/_headers` (CSP `connect-src 'self'` + only wallet origins observed in Task 3 manual check), `README.md` (rewrite), `docs/INVOICING.md` (replace with current behaviour), `index.html` (title/description)
- Create: `tests/browser/core-loop.spec.ts`

- [ ] **Step 1: E2E** `core-loop.spec.ts` with mocked `/api`: sign in → create+issue invoice → open pay link in a new context → get instructions → status flips to Paid → owner Home shows balance → withdraw review → success. Run both desktop and mobile projects, `--workers=1` → PASS; no horizontal overflow at 390 px (assert `document.documentElement.scrollWidth <= 390`).
- [ ] **Step 2: README** — what it does (pak Eko's flow in 4 steps), architecture diagram (text), how to run locally (`cp .env.example .env`, fill `SESSION_SECRET`, `npm run db:migrate:local`, `npm run dev:api`), how judges can try it (production URL; demo invoice payable with ~1 USDC), honest boundaries (mainnet, small amounts, NEAR Intents incident of 2026-10-01, non-custodial, no fiat), section **"Hackathon work vs. pre-existing baseline"** listing baseline commit `7d827b1` and everything after it, track 08 Real-World Money, link to roadmap Plans 2–3.
- [ ] **Step 3: Provision** (user runs/approves): register key at partners.near-intents.org; `npx wrangler d1 create manexus-intents` → put id in `wrangler.toml`; `npx wrangler d1 migrations apply manexus-intents --remote`; `npx wrangler pages secret put SESSION_SECRET` and `ONECLICK_API_KEY`; bind D1 to the Pages project.
- [ ] **Step 4: Verify** `npm test && npm run typecheck && npm run build && git diff --check` → all pass.
- [ ] **Step 5: Deploy** (after user approval) `npx wrangler pages deploy dist --project-name manexus-intents --branch main`; `curl -s https://manexus-intents.pages.dev/api/health` → `{"ok":true}`.
- [ ] **Step 6: Real-funds smoke test (user performs, with their own wallets):** issue a 1 USDC invoice; pay from another wallet with USDC on Arbitrum; confirm invoice → Paid and balance 1 USDC on Home; withdraw 0.5 USDC to an Arbitrum/Base address; record tx hashes in `docs/NEAR-INTENTS.md`.
- [ ] **Step 7: Commit** `docs: core loop README, CSP and deployment notes`.
