import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import { cancelInvoice, createInvoice, getInvoice, issueInvoice } from "../../server/invoices.ts";
import { listAttempts, saveAttempt, type AttemptRow } from "../../server/payments.ts";
import { decideOutcome, ownerPayments, publicStatus, refreshInvoice } from "../../server/reconcile.ts";
import { HttpError } from "../../server/http.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { InvoiceDraft, InvoiceRow } from "../../shared/invoice.ts";
import type { OneClickToken, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";

const OWNER = "alice.near";
const USDC = SETTLEMENT_TOKENS[0].tokenId;
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const REFUND = "0x0000000000000000000000000000000000000001";
const NOW = new Date("2030-01-01T00:10:00.000Z");
const T0 = "2030-01-01T00:00:00.000Z";
const TOKENS: OneClickToken[] = [{ assetId: ARB, symbol: "USDC", blockchain: "arb", decimals: 6 }];
const draft: InvoiceDraft = {
  number: "D-1", client: "C", issuer: "I", dueDate: "2030-01-31", tokenId: USDC, notes: "",
  items: [{ description: "Design", quantity: "3", unitPrice: "0.1" }, { description: "Build", quantity: "2", unitPrice: "0.2" }],
};
const NEAR_TX = "6xJZ3tYbKk7d8m9QpR2sT4uV5wX6yZ7aB8cD9eF1gH2j";

const request = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: ARB, depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC, amount: "700000", refundTo: REFUND, refundType: "ORIGIN_CHAIN", recipient: OWNER,
  recipientType: "INTENTS", deadline: "2030-01-01T00:30:00.000Z", referral: "manexus", ...over,
});
const swap = (status: SwapStatus["status"], over: Partial<SwapStatus> = {}, req: Partial<QuoteRequest> = {}): SwapStatus => ({
  status, updatedAt: NOW.toISOString(), quoteRequest: request(req),
  ...(status === "SUCCESS" ? { amountOut: "700000" } : {}),
  originTxHashes: status === "SUCCESS" ? ["0xorigin"] : [], destinationTxHashes: status === "SUCCESS" ? [NEAR_TX] : [], ...over,
});
const attempt = (invoiceId: string, depositAddress: string, over: Partial<AttemptRow> = {}): AttemptRow => ({
  depositAddress, invoiceId, originAsset: ARB, amountIn: "710180", refundTo: REFUND, deadline: "2030-01-01T00:30:00.000Z",
  status: "PENDING_DEPOSIT", createdAt: T0, updatedAt: T0, ...over,
});
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

function fakeOneClick(statuses: Record<string, SwapStatus | Error>) {
  const calls: [string, string | undefined][] = [];
  return {
    calls,
    statuses,
    oneclick: {
      tokens: async () => TOKENS,
      status: async (addr: string, memo?: string) => {
        calls.push([addr, memo]);
        const s = statuses[addr];
        if (!s) throw new HttpError(502, "NEAR Intents: not found");
        if (s instanceof Error) throw s;
        return s;
      },
    },
  };
}

async function setup(statuses: Record<string, SwapStatus | Error>, attempts: string[] = ["dep1"], state: "issued" | "cancelled" = "issued") {
  const db = createTestDb();
  let inv = await issueInvoice(db, OWNER, (await createInvoice(db, OWNER, draft, T0)).id, T0);
  if (state === "cancelled") inv = await cancelInvoice(db, OWNER, inv.id, T0);
  for (const [i, a] of attempts.entries()) await saveAttempt(db, attempt(inv.id, a, { createdAt: `2030-01-01T00:0${i}:00.000Z` }));
  const f = fakeOneClick(statuses);
  return { db, inv, ...f, deps: { db, oneclick: f.oneclick, now: NOW } };
}
const reload = (db: Parameters<typeof getInvoice>[0], id: string) => getInvoice(db, OWNER, id);
const byAddr = async (db: Parameters<typeof listAttempts>[0], id: string) =>
  Object.fromEntries((await listAttempts(db, id)).map((a) => [a.depositAddress, a]));

// ---- decideOutcome (pure) ----

const INV = { id: "i1", owner: OWNER, status: "issued", tokenId: USDC, total: "700000" } as InvoiceRow;
const ATT = attempt("i1", "dep1");

test("decideOutcome: matching SUCCESS is paid, carries amountOut", () => {
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS")), { status: "SUCCESS", outcome: "paid", amountOut: "700000" });
  assert.equal(decideOutcome(INV, ATT, swap("SUCCESS", { amountOut: "700001" })).outcome, "paid");
});

test("decideOutcome: a definite mismatch on SUCCESS is mismatch, never paid or failed", () => {
  const cases: [Partial<SwapStatus>, Partial<QuoteRequest>][] = [
    [{}, { recipient: "attacker.near" }],
    [{}, { recipient: "Alice.near" }],
    [{}, { recipientType: "DESTINATION_CHAIN" }],
    [{}, { destinationAsset: "nep141:usdt.tether-token.near" }],
    [{}, { swapType: "EXACT_INPUT" }],
    [{}, { amount: "1" }],
    [{ amountOut: "699999" }, {}],
    [{ depositAddress: "other" }, {}],
  ];
  for (const [s, r] of cases) {
    const d = decideOutcome(INV, ATT, swap("SUCCESS", s, r));
    assert.equal(d.outcome, "mismatch", JSON.stringify([s, r]));
    assert.equal(d.status, "SUCCESS");
  }
  assert.equal(decideOutcome(INV, { ...ATT, invoiceId: "other" }, swap("SUCCESS")).outcome, "mismatch");
});

test("decideOutcome: SUCCESS with incomplete details records the status only (re-checked later)", () => {
  for (const s of [{ amountOut: "" }, { amountOut: "7e5" }, { amountOut: undefined }, { quoteRequest: undefined }] as Partial<SwapStatus>[]) {
    const want = s.quoteRequest === undefined && "quoteRequest" in s ? { status: "SUCCESS", amountOut: "700000" } : { status: "SUCCESS" };
    assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", s)), want, JSON.stringify(s));
    assert.deepEqual(decideOutcome({ ...INV, status: "paid", paidBy: "dep2" }, ATT, swap("SUCCESS", s)), want);
  }
});

test("decideOutcome: invoice state decides duplicate / after_cancel / idempotent paid", () => {
  assert.equal(decideOutcome({ ...INV, status: "paid", paidBy: "dep2" }, ATT, swap("SUCCESS")).outcome, "duplicate");
  assert.equal(decideOutcome({ ...INV, status: "paid", paidBy: "dep1" }, ATT, swap("SUCCESS")).outcome, "paid");
  assert.equal(decideOutcome({ ...INV, status: "cancelled" }, ATT, swap("SUCCESS")).outcome, "after_cancel");
  // A mismatched SUCCESS on a paid invoice is mismatch, not an "extra payment in your balance".
  assert.equal(decideOutcome({ ...INV, status: "paid", paidBy: "dep2" }, ATT, swap("SUCCESS", {}, { recipient: "x.near" })).outcome, "mismatch");
});

test("decideOutcome: non-final statuses carry no outcome; REFUNDED/FAILED map", () => {
  for (const s of ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING"] as const)
    assert.deepEqual(decideOutcome(INV, ATT, swap(s)), { status: s });
  assert.equal(decideOutcome(INV, ATT, swap("REFUNDED", { refundedAmount: "710180" })).outcome, "refunded");
  assert.equal(decideOutcome(INV, ATT, swap("FAILED")).outcome, "failed");
});

// ---- refreshInvoice ----

test("SUCCESS matching → attempt paid, invoice paid with paid_by and paid_at", async () => {
  const { db, inv, deps, calls } = await setup({ dep1: swap("SUCCESS") });
  await refreshInvoice(deps, inv.id);
  assert.deepEqual(calls, [["dep1", undefined]]);
  const after = await reload(db, inv.id);
  assert.equal(after.status, "paid");
  assert.equal(after.paidBy, "dep1");
  assert.equal(after.paidAt, NOW.toISOString());
  const a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.status, "SUCCESS");
  assert.equal(a.outcome, "paid");
  assert.equal(a.amountOut, "700000");
  assert.equal(a.updatedAt, NOW.toISOString());
  assert.deepEqual(JSON.parse(a.upstream!).destinationTxHashes, [NEAR_TX]);
});

test("SUCCESS to attacker.near → mismatch, invoice stays issued", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS", {}, { recipient: "attacker.near" }) });
  await refreshInvoice(deps, inv.id);
  assert.equal((await reload(db, inv.id)).status, "issued");
  assert.equal((await byAddr(db, inv.id)).dep1.outcome, "mismatch");
});

test("mismatch not delivered to the owner's account records no amountOut and clears a stored one", async () => {
  const db = createTestDb();
  const inv = await issueInvoice(db, OWNER, (await createInvoice(db, OWNER, draft, T0)).id, T0);
  await saveAttempt(db, attempt(inv.id, "dep1", { status: "PROCESSING", amountOut: "500000" }));
  const f = fakeOneClick({ dep1: swap("SUCCESS", {}, { recipient: "attacker.near" }) });
  await refreshInvoice({ db, oneclick: f.oneclick, now: NOW }, inv.id);
  const a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.outcome, "mismatch");
  assert.equal(a.amountOut, undefined);
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", {}, { recipientType: "DESTINATION_CHAIN" })), { status: "SUCCESS", outcome: "mismatch" });
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", {}, { destinationAsset: ARB })), { status: "SUCCESS", outcome: "mismatch" });
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", { depositAddress: "other" })), { status: "SUCCESS", outcome: "mismatch" });
  assert.deepEqual(decideOutcome(INV, { ...ATT, invoiceId: "other" }, swap("SUCCESS")), { status: "SUCCESS", outcome: "mismatch" });
});

test("mismatch delivered to the owner (amount short, other swapType) keeps amountOut", () => {
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", { amountOut: "699999" })), { status: "SUCCESS", outcome: "mismatch", amountOut: "699999" });
  assert.deepEqual(decideOutcome(INV, ATT, swap("SUCCESS", {}, { swapType: "EXACT_INPUT" })), { status: "SUCCESS", outcome: "mismatch", amountOut: "700000" });
});

test("SUCCESS without amountOut → status recorded, no outcome; a later complete status pays", async () => {
  const { db, inv, deps, statuses, calls } = await setup({ dep1: swap("SUCCESS", { amountOut: undefined }) });
  await refreshInvoice(deps, inv.id);
  assert.equal((await reload(db, inv.id)).status, "issued");
  let a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.status, "SUCCESS");
  assert.equal(a.outcome, undefined);
  statuses.dep1 = swap("SUCCESS");
  await refreshInvoice({ ...deps, now: new Date(NOW.getTime() + 10_000) }, inv.id);
  assert.equal(calls.length, 2, "re-checked on the next refresh");
  a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.outcome, "paid");
  assert.equal((await reload(db, inv.id)).paidBy, "dep1");
});

test("ownerPayments shows the received amount for a mismatch", async () => {
  const { inv, deps } = await setup({ dep1: swap("SUCCESS", { amountOut: "699999" }) });
  const [a] = (await ownerPayments(deps, OWNER, inv.id)).attempts;
  assert.equal(a.outcome, "mismatch");
  assert.equal(a.amountOutFormatted, "0.699999");
});

test("SUCCESS with amountOut 699999 → not paid", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS", { amountOut: "699999" }) });
  await refreshInvoice(deps, inv.id);
  const after = await reload(db, inv.id);
  assert.equal(after.status, "issued");
  assert.equal(after.paidBy, undefined);
  assert.equal((await byAddr(db, inv.id)).dep1.outcome, "mismatch");
});

test("INCOMPLETE_DEPOSIT keeps the invoice issued; REFUNDED → refunded", async () => {
  const { db, inv, deps, statuses } = await setup({ dep1: swap("INCOMPLETE_DEPOSIT") });
  await refreshInvoice(deps, inv.id);
  assert.equal((await reload(db, inv.id)).status, "issued");
  let a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.status, "INCOMPLETE_DEPOSIT");
  assert.equal(a.outcome, undefined);
  statuses.dep1 = swap("REFUNDED", { refundedAmount: "500000" });
  await refreshInvoice({ ...deps, now: new Date(NOW.getTime() + 10_000) }, inv.id);
  a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.status, "REFUNDED");
  assert.equal(a.outcome, "refunded");
  assert.equal((await reload(db, inv.id)).status, "issued");
});

test("two SUCCESS attempts → exactly one paid (earliest), other duplicate; repeat refresh is idempotent", async () => {
  const { db, inv, deps, calls } = await setup({ dep1: swap("SUCCESS"), dep2: swap("SUCCESS") }, ["dep1", "dep2"]);
  await refreshInvoice(deps, inv.id);
  const first = await byAddr(db, inv.id);
  assert.equal(first.dep1.outcome, "paid");
  assert.equal(first.dep2.outcome, "duplicate");
  const paid = await reload(db, inv.id);
  assert.equal(paid.paidBy, "dep1");
  const n = calls.length;
  await refreshInvoice({ ...deps, now: new Date(NOW.getTime() + 60_000) }, inv.id);
  assert.equal(calls.length, n, "terminal attempts are not re-fetched");
  assert.deepEqual(await byAddr(db, inv.id), first);
  assert.deepEqual(await reload(db, inv.id), paid);
});

test("concurrent refreshes cannot double-pay", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS"), dep2: swap("SUCCESS") }, ["dep1", "dep2"]);
  await Promise.all([refreshInvoice(deps, inv.id), refreshInvoice(deps, inv.id), refreshInvoice(deps, inv.id)]);
  const rows = await byAddr(db, inv.id);
  const outcomes = [rows.dep1.outcome, rows.dep2.outcome].sort();
  assert.deepEqual(outcomes, ["duplicate", "paid"]);
  const after = await reload(db, inv.id);
  assert.equal(after.status, "paid");
  assert.equal(rows[after.paidBy!].outcome, "paid");
});

test("an attempt recorded as paid_by but missing its outcome is recovered as paid", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS") });
  await db.prepare("UPDATE invoices SET status='paid', paid_by='dep1', paid_at=? WHERE id=?").bind(T0, inv.id).run();
  await refreshInvoice(deps, inv.id);
  assert.equal((await byAddr(db, inv.id)).dep1.outcome, "paid");
  assert.equal((await reload(db, inv.id)).paidAt, T0);
});

test("cancelled invoice + SUCCESS → after_cancel, invoice stays cancelled", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS") }, ["dep1"], "cancelled");
  await refreshInvoice(deps, inv.id);
  assert.equal((await reload(db, inv.id)).status, "cancelled");
  assert.equal((await byAddr(db, inv.id)).dep1.outcome, "after_cancel");
});

test("1Click 502 → attempt and invoice unchanged, error propagates as 502", async () => {
  const { db, inv, deps } = await setup({ dep1: new HttpError(502, "NEAR Intents is unreachable") });
  const before = await byAddr(db, inv.id);
  assert.equal(await status(refreshInvoice(deps, inv.id)), 502);
  assert.deepEqual(await byAddr(db, inv.id), before);
  assert.deepEqual(await reload(db, inv.id), inv);
});

test("memo is passed; attempts touched < 5 s ago and pending attempts expired > 24 h are skipped", async () => {
  const { db, inv, deps, calls } = await setup({ dep1: swap("PROCESSING"), dep2: swap("PROCESSING"), dep3: swap("PROCESSING") }, []);
  await saveAttempt(db, attempt(inv.id, "dep1", { depositMemo: "m1", updatedAt: new Date(NOW.getTime() - 6_000).toISOString() }));
  await saveAttempt(db, attempt(inv.id, "dep2", { updatedAt: new Date(NOW.getTime() - 2_000).toISOString() }));
  await saveAttempt(db, attempt(inv.id, "dep3", { deadline: "2029-12-30T00:00:00.000Z" }));
  await saveAttempt(db, attempt(inv.id, "dep4", { status: "SUCCESS", outcome: "refunded" }));
  await refreshInvoice(deps, inv.id);
  assert.deepEqual(calls, [["dep1", "m1"]]);
});

test("publicStatus refreshes and returns views; unknown origin token omits the formatted amount", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("SUCCESS"), dep2: swap("PROCESSING") }, ["dep1"]);
  await saveAttempt(db, attempt(inv.id, "dep2", { originAsset: "nep141:gone.near", createdAt: "2030-01-01T00:05:00.000Z" }));
  const r = await publicStatus(deps, inv.publicId);
  assert.equal(r.invoiceStatus, "paid");
  assert.equal(r.attempts.length, 2);
  const [latest, paid] = r.attempts;
  assert.equal(latest.depositAddress, "dep2");
  assert.equal(latest.amountInFormatted, "");
  assert.equal(latest.symbol, "");
  assert.equal(paid.outcome, "paid");
  assert.equal(paid.amountInFormatted, "0.71018");
  assert.deepEqual(paid.destinationTxHashes, [NEAR_TX]);
  assert.equal("originTxHashes" in paid, false);
  assert.equal("refundTo" in paid, false);
});

test("publicStatus works when the token list is unavailable", async () => {
  const { inv, deps } = await setup({ dep1: swap("PROCESSING") });
  const r = await publicStatus({ ...deps, oneclick: { ...deps.oneclick, tokens: async () => { throw new HttpError(502, "x"); } } }, inv.publicId);
  assert.equal(r.attempts[0].status, "PROCESSING");
  assert.equal(r.attempts[0].amountInFormatted, "");
});

test("ownerPayments is owner-scoped and includes tx hashes and amountOut", async () => {
  const { inv, deps } = await setup({ dep1: swap("SUCCESS") });
  assert.equal(await status(ownerPayments(deps, "bob.near", inv.id)), 404);
  const r = await ownerPayments(deps, OWNER, inv.id);
  assert.equal(r.invoiceStatus, "paid");
  const [a] = r.attempts;
  assert.deepEqual(a.originTxHashes, ["0xorigin"]);
  assert.deepEqual(a.destinationTxHashes, [NEAR_TX]);
  assert.equal(a.amountOut, "700000");
  assert.equal(a.amountOutFormatted, "0.7");
  assert.equal(a.outcome, "paid");
});

test("guarded UPDATE: a payment recorded by another refresh between read and write wins; this one is duplicate", async () => {
  const { db, inv, oneclick } = await setup({ dep1: swap("SUCCESS") });
  let raced = false;
  const racing: typeof db = {
    batch: (stmts) => db.batch(stmts),
    prepare(sql: string) {
      const p = db.prepare(sql);
      return {
        bind(...v: unknown[]) {
          const st = p.bind(...v);
          if (!raced && sql.startsWith("UPDATE invoices SET status='paid'")) {
            raced = true;
            return {
              ...st,
              run: async () => {
                await db.prepare("UPDATE invoices SET status='paid', paid_by='depX', paid_at=? WHERE id=?").bind(T0, inv.id).run();
                return st.run();
              },
            };
          }
          return st;
        },
      };
    },
  };
  await refreshInvoice({ db: racing, oneclick, now: NOW }, inv.id);
  assert.ok(raced);
  const after = await reload(db, inv.id);
  assert.equal(after.paidBy, "depX");
  assert.equal(after.paidAt, T0);
  assert.equal((await byAddr(db, inv.id)).dep1.outcome, "duplicate");
});

test("a refresh never overwrites an outcome recorded concurrently", async () => {
  const { db, inv, deps } = await setup({ dep1: swap("PROCESSING") });
  const slow = {
    ...deps.oneclick,
    status: async (a: string, m?: string) => {
      const s = await deps.oneclick.status(a, m);
      await db.prepare("UPDATE payment_attempts SET outcome='refunded', status='REFUNDED' WHERE deposit_address=?").bind(a).run();
      return s;
    },
  };
  await refreshInvoice({ ...deps, oneclick: slow }, inv.id);
  const a = (await byAddr(db, inv.id)).dep1;
  assert.equal(a.outcome, "refunded");
  assert.equal(a.status, "REFUNDED");
});
