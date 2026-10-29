# Plan 2 — Treasury Features (Swap, Dashboard, Bill Pay, Payroll) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of the Plan 1 core loop, a business can swap between assets inside its own NEAR Intents balance, see a Ramp-style treasury dashboard (balances, receivables, payables, unified activity), pay vendor bills (Manexus invoice links or manual addresses on any chain), and run payroll / batch payouts from a CSV or saved payees.

**Architecture:** The Plan 1 withdrawal engine (`server/withdraw.ts`: quote → 1Click `generate-intent` → owner signs → server relays the stored payload) becomes a generic **transfer engine** (`server/transfers.ts`) with a `kind` (`withdraw | swap | bill | payroll`), both swap types (`EXACT_INPUT` / `EXACT_OUTPUT`) and both recipient types (`DESTINATION_CHAIN` / `INTENTS`). Swap, bill pay and payroll are thin domain modules over it. The browser signing flow in `src/views/withdraw.ts` is extracted to `src/sign-flow.ts` and reused by every view.

**Tech Stack:** unchanged from Plan 1 (TypeScript, Vite, Cloudflare Pages Functions + D1, viem, wallet-selector Meteor/HOT, Node `node:test`, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-29-manexus-intents-design.md` (Roadmap → Plan 2). Plan 1: `docs/superpowers/plans/2026-10-29-plan1-core-loop.md`. Facts: `docs/NEAR-INTENTS.md`.

**Branch:** `feat/treasury-swap-billpay-payroll`, created from `feat/multichain-invoicing-core-loop` (PR #1). PR targets `main` after PR #1 merges.

## Decisions (from the user, 2026-10-30)

| Topic | Decision |
|---|---|
| Order | Swap → Dashboard → Bill pay → Payroll |
| Bill pay | Paste a Manexus invoice link (`…#/pay/<publicId>`) to prefill vendor, amount, token and pay-to account, **or** enter address/chain/token/amount manually. Paid from the owner's Intents balance via a signed intent. |
| Payroll | CSV upload **and** saved payees. Each line becomes one signed intent; the owner signs lines one after another in one session. |

## Global Constraints

- All Plan 1 Global Constraints still apply (mainnet only, no fallback numbers, non-custodial, bigint money, `escapeHTML` everywhere, session cookie rules, copy never says "safe", "guaranteed" or "insured", commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- The server never signs and relays only a signature over the exact stored 1Click-generated payload; every Plan 1 submit check (owner, `AWAITING_SIGNATURE`, unexpired, standard, deep-equal payload, signer) applies to every transfer kind.
- Origin asset of every outbound transfer must be a token in the owner's own balance (`getBalances`), and the amount the intent transfers must be ≤ that balance at quote time.
- Recipient amounts for bills and payroll are what the **recipient receives** → `swapType: "EXACT_OUTPUT"`, `amount` = recipient amount; the transferred amount is the quote's `amountIn` (includes slippage buffer, unused part refunded to the owner's Intents account). Swaps and withdrawals stay `EXACT_INPUT`.
- Destination tokens come only from `oneclick.tokens()`; `DESTINATION_CHAIN` recipients pass `validDestination(chain, address)`; `INTENTS` recipients are a NEAR account id or lowercase `0x` address.
- Limits: payroll batch ≤ 50 lines; CSV ≤ 64 KB; saved payees ≤ 500 per owner; bills ≤ 1000 per owner (list paginated 100).
- Mobile bottom nav: Home, Invoices, Bills, Swap, More (More opens Payroll, Withdraw, Sign out). Desktop sidebar lists all.

## Review Focus

1. **EXACT_OUTPUT quote whose `amountIn` exceeds the balance** — rejected 400 "Amount exceeds your balance" after the quote, before `generate-intent`; nothing stored. (Task 1)
2. **Manexus invoice changes state between import and signing** (vendor cancels it, someone else pays it) — the bill's submit is refused (409) if the vendor invoice is no longer `issued`; a payment that lands anyway is reconciled on the vendor side as `duplicate`/`after_cancel` and shown on the bill as "Paid — vendor reports extra payment". (Task 4)
3. **Malformed or hostile CSV** — wrong columns, quoted commas, BOM, CRLF, formula-injection prefixes (`= + - @`), duplicate rows, unknown token/chain, invalid address, decimals beyond token precision, > 50 lines: the whole upload is rejected with per-line errors; nothing is created. (Task 5)
4. **Payroll batch partially fails** (some lines signed, one quote expires or is refunded) — batch status is derived per line (`3/5 sent, 1 failed, 1 awaiting`), failed lines can be re-quoted individually, already-sent lines are never re-sent. (Task 5)
5. **Swap into a token with no price or unusual decimals** — amount formatted with the destination token's own decimals; no USD shown without price; the new balance appears on Home after SUCCESS. (Task 2)

---

## File Structure

```
migrations/0003_transfers.sql      kind, batch_id, reference, bill_id on withdrawals; bills; payees; payroll_batches
server/transfers.ts                generic engine (moved from server/withdraw.ts); quoteTransfer/submitTransfer/refreshTransfer/listTransfers/keyStatus
server/withdraw.ts                 thin: quoteWithdrawal = quoteTransfer(kind "withdraw", …)
server/swaps.ts                    quoteSwap
server/bills.ts                    bill repository, importManexusInvoice, quoteBillPayment
server/payroll.ts                  payees, createBatch, quoteBatchLine, batch view
server/activity.ts                 unified activity feed
shared/csv.ts                      parsePayrollCsv
functions/api/transfers/…          submit, [depositAddress] (GET refresh), index (GET list ?kind=), key-status
functions/api/swaps/quote.ts
functions/api/bills/…              index (GET/POST), [id] (GET/PUT), [id]/cancel, [id]/quote, import
functions/api/payroll/…            payees (GET/POST/DELETE), batches (GET/POST), batches/[id] (GET), batches/[id]/lines/[n]/quote
functions/api/activity.ts
src/sign-flow.ts                   signAndSubmit(quote, session) extracted from views/withdraw.ts
src/views/swap.ts, bills.ts, bill-detail.ts, payroll.ts, payroll-batch.ts, home.ts (extended)
```

`functions/api/withdrawals/*` keep working (they call the engine with kind `withdraw`) so Plan 1 tests and the README stay true.

---

### Task 1: Generic transfer engine

**Files:**
- Create: `migrations/0003_transfers.sql`, `server/transfers.ts`, `functions/api/transfers/submit.ts`, `functions/api/transfers/[depositAddress].ts`, `functions/api/transfers/index.ts`, `src/sign-flow.ts`, `tests/server/transfers.test.ts`
- Modify: `server/withdraw.ts` (becomes thin), `functions/api/withdrawals/*.ts`, `server/balances.ts` (token set), `src/views/withdraw.ts` (uses sign-flow)

**Interfaces:**
- Produces:
  - Migration: `ALTER TABLE withdrawals ADD COLUMN kind TEXT NOT NULL DEFAULT 'withdraw' CHECK (kind IN ('withdraw','swap','bill','payroll'))`, `ADD COLUMN reference TEXT`, `ADD COLUMN batch_id TEXT`, `ADD COLUMN bill_id TEXT`; `CREATE INDEX withdrawals_owner_kind ON withdrawals(owner, kind, created_at)`. (Table name stays `withdrawals`; in code it is "transfers".)
  - `type TransferKind = "withdraw" | "swap" | "bill" | "payroll"`
  - `type TransferRequest = { kind: TransferKind; originAsset: string; destinationAsset: string; amount: string; swapType: "EXACT_INPUT" | "EXACT_OUTPUT"; recipientType: "DESTINATION_CHAIN" | "INTENTS"; recipient: string; slippageBps?: 50 | 100 | 300; reference?: string; batchId?: string; billId?: string }`
  - `prepareTransfer(deps: TransferDeps, user, req: TransferRequest, q: Quote): Promise<TransferQuote>` — validates an already-obtained 1Click quote against `req` and the balance, calls `generate-intent`, checks it, stores the row. `quoteTransfer(deps, user, req)` = build the `QuoteRequest` from `req` → `oneclick.quote` → `prepareTransfer`. Task 4 uses `prepareTransfer` directly with a quote it built itself.
  - `quoteTransfer(deps: TransferDeps, user, req: TransferRequest): Promise<TransferQuote>` — `TransferQuote` = Plan 1 `WithdrawalQuote` with `transfer: TransferView` (alias `withdrawal` kept for the withdraw route). For `EXACT_OUTPUT`: after quote require `/^\d+$/` `amountIn`, `BigInt(amountIn) <= balance` (else 400 "Amount exceeds your balance"), `BigInt(amountOut) >= BigInt(req.amount)`; the generated-intent check expects transfer amount `q.amountIn`. For `EXACT_INPUT`: unchanged Plan 1 checks. For `INTENTS` recipient: validate account id (NEAR regex or lowercase `0x` address); `DESTINATION_CHAIN`: `validDestination`.
  - `submitTransfer`, `refreshTransfer`, `listTransfers(deps, user, kind?: TransferKind)`, `keyStatus` — Plan 1 behaviour, now for any kind.
  - `TransferView` = `WithdrawalView` + `kind`, `reference?`, `batchId?`, `billId?`, `swapType`, `recipientType`.
  - `quoteWithdrawal(deps, user, body)` = `quoteTransfer({ kind:"withdraw", swapType:"EXACT_INPUT", recipientType:"DESTINATION_CHAIN", … })`.
  - `getBalances` token set adds `destination_asset` of the owner's rows `WHERE kind = 'swap'` (swaps are the only kind that deliver into the owner's own Intents account).
  - Browser: `signAndSubmit(quote: { depositAddress; intent }, session: Session, onStep: (s: "key" | "sign" | "submit") => void): Promise<TransferView>` in `src/sign-flow.ts` (NEAR key registration + NEP-413/ERC-191 signing + POST `/api/transfers/submit`).

- [ ] **Step 1: Failing tests** (`tests/server/transfers.test.ts`, fake oneclick/rpc, test db): existing `tests/server/withdraw.test.ts` passes unchanged; EXACT_OUTPUT quote with `amountIn` = balance + 1 → 400 and `generateIntent` not called, no row (**Review Focus 1**); EXACT_OUTPUT with `amountOut` < requested → 502, no row; EXACT_OUTPUT generated intent transferring `amount` instead of `amountIn` → 502; INTENTS recipient `"Bad Account"` → 400; `listTransfers(user, "swap")` returns only swaps; balances include a swap's destination asset.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** — move the engine to `server/transfers.ts` (git mv to keep history), parameterise, migration 0003, routes under `/api/transfers/*`, withdraw routes delegate.
- [ ] **Step 4: Extract** `src/sign-flow.ts` from `src/views/withdraw.ts`; withdraw view uses it; existing `withdraw.spec.ts` passes.
- [ ] **Step 5: Run** `npm test`, `npm run typecheck`, `npx playwright test tests/browser --workers=1` → PASS.
- [ ] **Step 6: Commit** `refactor: generic transfer engine for withdraw, swap, bill and payroll`.

---

### Task 2: In-account swap

**Files:**
- Create: `server/swaps.ts`, `functions/api/swaps/quote.ts`, `src/views/swap.ts`, `tests/server/swaps.test.ts`, `tests/browser/swap.spec.ts`
- Modify: `src/main.ts` (route `#/swap`, nav), `src/style.css`

**Interfaces:**
- Consumes: `quoteTransfer`, `signAndSubmit`, `getBalances`, `oneclick.tokens()`.
- Produces: `quoteSwap(deps, user, body: { originAsset: string; destinationAsset: string; amount: string; slippageBps: 50 | 100 | 300 }): Promise<TransferQuote>` → `quoteTransfer({ kind:"swap", swapType:"EXACT_INPUT", recipientType:"INTENTS", recipient: user.account, … })`; rejects `originAsset === destinationAsset` (400 "Choose two different tokens"). `POST /api/swaps/quote`.
- View `#/swap`: From (balance picker with Max) → To (searchable token list, any 1Click token) → slippage 0.5/1/3 % → "Get quote" → shows you send, you receive ≈ `amountOutFormatted` (destination decimals), minimum, rate (`amountOut/amount` displayed with bigint-scaled 6-digit precision), countdown → Sign → progress → "Swapped — new balance on Home". Copy: "The swapped tokens stay in your NEAR Intents account."

- [ ] **Step 1: Failing tests** — server: request fields (`depositType/refundType INTENTS`, `recipientType INTENTS`, `recipient === account`, `EXACT_INPUT`, slippage passed through, `kind "swap"` stored); same token → 400; slippage 200 → 400. Browser (mocked API + mocked signer): quote shows receive amount formatted with destination decimals (e.g. 24-decimal wNEAR), sign completes, **Review Focus 5**: token without price shows no USD.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** unit + browser → PASS.
- [ ] **Step 5: Commit** `feat: swap between assets inside the NEAR Intents account`.

---

### Task 3: Treasury dashboard and activity

**Files:**
- Create: `server/activity.ts`, `functions/api/activity.ts`, `tests/server/activity.test.ts`, `tests/browser/dashboard.spec.ts`
- Modify: `src/views/home.ts`

**Interfaces:**
- Produces: `listActivity(deps: { db; now }, user, limit = 50): Promise<ActivityItem[]>` where `ActivityItem = { at: string; type: "invoice_paid" | "payment_received_extra" | "withdraw" | "swap" | "bill" | "payroll"; title: string; amountFormatted: string; symbol: string; status: string; href: string }` — merges paid/duplicate/after_cancel attempts of the owner's invoices (`invoice_id IN (SELECT id FROM invoices WHERE owner=?)`) and the owner's transfers, sorted by time desc. `GET /api/activity`.
- Home additions: stat tiles **Cash** (reference USD total), **Receivables** (open invoices per token, overdue count), **Payables** (bills `scheduled` due within 14 days per token, overdue count — reads `/api/bills?status=scheduled` once Task 4 exists; until then the tile shows "No bills yet"), **This month** (received vs sent per settlement token, bigint sums of activity in the current UTC month); activity feed with type icons and links.

- [ ] **Step 1: Failing tests** — activity merges both sources in time order, owner-scoped (bob's rows never appear), duplicate/after_cancel shown as "payment_received_extra"; browser: tiles render, activity links go to `#/invoices/:id` / transfer history, an API failure on one tile does not blank the others.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat: treasury dashboard with cash, receivables, payables and activity`.

---

### Task 4: Bill pay

**Files:**
- Create: `server/bills.ts`, `functions/api/bills/index.ts`, `functions/api/bills/[id].ts`, `functions/api/bills/[id]/cancel.ts`, `functions/api/bills/[id]/quote.ts`, `functions/api/bills/import.ts`, `src/views/bills.ts`, `src/views/bill-detail.ts`, `tests/server/bills.test.ts`, `tests/browser/bills.spec.ts`
- Create: `migrations/0004_bills.sql`
- Modify: `server/payments.ts` (intents-funded payment attempt), `src/main.ts`

**Interfaces:**
- Schema: `bills (id TEXT PK, owner TEXT NOT NULL, vendor TEXT NOT NULL, reference TEXT NOT NULL, due_date TEXT NOT NULL, destination_asset TEXT NOT NULL, recipient_type TEXT NOT NULL CHECK (recipient_type IN ('DESTINATION_CHAIN','INTENTS')), recipient TEXT NOT NULL, amount TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('manual','manexus')), vendor_public_id TEXT, status TEXT NOT NULL CHECK (status IN ('scheduled','paying','paid','cancelled')), deposit_address TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, index `(owner, status, due_date)`.
- `importManexusInvoice(deps, user, link: string): Promise<BillDraft>` — accepts only `https://<this origin>/#/pay/<publicId>` or a bare publicId; reads `getPublicInvoice`; returns vendor = issuer label, reference = invoice number, amount = total, destination = invoice `tokenId`, recipient = `payTo`, `recipientType "INTENTS"`, `source "manexus"`, `vendorPublicId`. Rejects the owner's own invoice (400 "This is your own invoice").
- `createBill`, `listBills(db, owner, status?)`, `getBill`, `updateBill` (only `scheduled`), `cancelBill` (only `scheduled`).
- `quoteBillPayment(deps, user, billId, body: { originAsset: string }): Promise<TransferQuote>`:
  - `manual`: `quoteTransfer({ kind:"bill", billId, swapType:"EXACT_OUTPUT", amount: bill.amount, destinationAsset, recipientType, recipient, reference })`.
  - `manexus`: vendor invoice must still be `issued` (409 "The vendor invoice is no longer payable"); calls a new `createIntentsPaymentQuote(deps, publicId, { originAsset, payer: user.account })` in `server/payments.ts` that builds the **same** quote request as `createPaymentQuote` except `depositType:"INTENTS"`, `refundType:"INTENTS"`, `refundTo: payer`, stores the payment attempt on the vendor invoice (so the vendor's reconciliation marks it paid), then calls `prepareTransfer(deps, user, { kind:"bill", billId, swapType:"EXACT_OUTPUT", amount: total, destinationAsset: tokenId, recipientType:"INTENTS", recipient: vendor owner, originAsset }, quote)` to store a `kind:"bill"` transfer with the generated intent. If `prepareTransfer` fails, the vendor attempt row is deleted in the same request (it has no deposit yet). One deposit address links the vendor attempt and the owner's bill transfer.
  - Bill moves `scheduled → paying` (guarded) when the quote is stored; `paying → paid` when the transfer reaches SUCCESS (refresh); back to `scheduled` if the transfer expires unsigned / FAILED / REFUNDED.
- Submit for a `manexus` bill re-checks the vendor invoice is `issued` (409) — **Review Focus 2**.
- Views: `#/bills` list (Scheduled, Paying, Paid, Cancelled; due/overdue chips), "New bill" with two tabs: **Paste Manexus invoice link** (prefills, read-only vendor fields) and **Manual** (vendor, reference, due date, destination token+chain, address with network hint, amount the vendor receives); `#/bills/:id` detail with "Pay from balance" (pick origin balance token, default USDC) → review (vendor, network, address or "Manexus account <id>", vendor receives, you send ≈ amountIn, buffer refunded note, confirm checkbox) → `signAndSubmit` → status.

- [ ] **Step 1: Failing tests** — import parses link, rejects foreign origin, own invoice, draft/cancelled invoice; manual bill validation; manexus quote creates a vendor payment attempt with `depositType INTENTS`, `recipient` = vendor owner, `EXACT_OUTPUT`, `amount` = vendor total, and a bill transfer sharing the deposit address; vendor invoice cancelled before submit → 409 and nothing relayed; after a SUCCESS refresh the vendor invoice reconciles `paid` (reuse `refreshInvoice`) and the bill is `paid`; cross-tenant 404s; browser: both tabs, review screen, overdue chip.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat: bill pay from the Intents balance, with Manexus invoice import`.

---

### Task 5: Payroll and batch payouts

**Files:**
- Create: `shared/csv.ts`, `server/payroll.ts`, `functions/api/payroll/payees.ts`, `functions/api/payroll/batches/index.ts`, `functions/api/payroll/batches/[id].ts`, `functions/api/payroll/batches/[id]/lines/[n]/quote.ts`, `src/views/payroll.ts`, `src/views/payroll-batch.ts`, `tests/shared/csv.test.ts`, `tests/server/payroll.test.ts`, `tests/browser/payroll.spec.ts`
- Create: `migrations/0005_payroll.sql` (payees, payroll_batches, payroll_lines)
- Modify: `src/main.ts`

**Interfaces:**
- Schema: `payees (id PK, owner, name, destination_asset, recipient_type, recipient, created_at)`; `payroll_batches (id PK, owner, title, origin_asset, created_at)`; `payroll_lines (batch_id, n INTEGER, name, destination_asset, recipient_type, recipient, amount, deposit_address, PRIMARY KEY (batch_id, n))`.
- `parsePayrollCsv(text: string, tokens: OneClickToken[]): { rows: PayrollRow[]; errors: { line: number; message: string }[] }` — header `name,chain,token,address,amount` (case-insensitive, order fixed), RFC 4180 quoting, strips BOM, accepts CRLF; `token` matched by symbol+chain against `tokens` (exactly one match); `chain === "near-intents"` means recipientType `INTENTS`; amount via `baseUnits(amount, decimals)`; name trimmed, ≤ 64 chars, leading `= + - @` rejected ("Names may not start with = + - @"); duplicate (chain, token, address) rows rejected; > 50 rows → single error.
- `createBatch(deps, user, { title, originAsset, rows })` — all-or-nothing validation; early balance check: ∑ amounts of lines whose destination token **is** the origin token must be ≤ the origin balance (400 "Batch exceeds your balance"). Cross-token lines are checked exactly per line at quote time (Task 1 EXACT_OUTPUT rule). Saved payees can be added as rows in the UI.
- `quoteBatchLine(deps, user, batchId, n)` → `quoteTransfer({ kind:"payroll", batchId, reference: "<title> · <name>", swapType:"EXACT_OUTPUT", … })`; refuses a line that already has a transfer in `AWAITING_SIGNATURE`/`PROCESSING`/`SUCCESS` (409 "Already sent") — **Review Focus 4**; a line whose transfer is FAILED/REFUNDED/expired can be re-quoted (replaces `deposit_address`).
- `getBatch` → `{ batch, lines: (line + transfer status)[], summary: { sent, processing, awaiting, failed, total } }`.
- Views: `#/payroll` — payees list (add/delete), batches list, "New payout" (upload CSV → preview table with per-line errors highlighted, or pick payees and enter amounts) → create batch; `#/payroll/:id` — lines table with status chips, "Send next" runs quote → `signAndSubmit` for the next unsent line, "Send all" loops lines sequentially (one wallet signature per line, stop on first error or user cancel), progress `3/5 sent`.

- [ ] **Step 1: Failing tests** — csv: valid file, BOM+CRLF, quoted comma in name, formula prefix, duplicate row, unknown token, ambiguous symbol, invalid address, too many decimals, 51 rows (**Review Focus 3**); payroll: all-or-nothing create, same-token sum over balance → 400, line re-quote rules, summary counts, cross-tenant 404; browser: upload preview with errors, send-all progress stops on a mocked signer rejection, sent lines stay sent.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat: payroll and batch payouts from CSV or saved payees`.

---

### Task 6: Navigation, docs and E2E

**Files:**
- Modify: `src/main.ts` (final nav incl. mobile "More"), `src/style.css`, `README.md` (features, routes, limits, launch gates for swap/bill/payroll: one live small swap, one bill to a Manexus invoice, one 2-line payroll), `docs/INVOICING.md` (bill pay ↔ vendor reconciliation)
- Create: `tests/browser/treasury-loop.spec.ts` (mocked: swap → bill from Manexus link → payroll 2 lines → dashboard activity shows all; 390 px no horizontal overflow)

- [ ] **Step 1:** E2E spec → PASS on desktop + mobile, `--workers=1`.
- [ ] **Step 2:** README claims each checked against code (every claim maps to a file).
- [ ] **Step 3:** `npm test`, `npm run typecheck`, `npm run build`, `git diff --check` → pass.
- [ ] **Step 4: Commit** `docs: treasury features README and end-to-end test`.
