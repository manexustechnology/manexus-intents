import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDb } from "./d1-shim.ts";
import { createInvoice, issueInvoice, cancelInvoice } from "../../server/invoices.ts";
import { createPaymentQuote, listAttempts, saveAttempt, submitDepositTx, toAttemptView, type AttemptRow } from "../../server/payments.ts";
import { getInvoiceByPublicId } from "../../server/invoices.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";
import type { OneClickToken, QuoteRequest } from "../../server/oneclick.ts";

const OWNER = "alice.near";
const USDC = SETTLEMENT_TOKENS[0].tokenId;
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const REFUND = "0x0000000000000000000000000000000000000001";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const draft: InvoiceDraft = {
  number: "D-1", client: "C", issuer: "I", dueDate: "2030-01-31", tokenId: USDC, notes: "",
  items: [{ description: "Design", quantity: "3", unitPrice: "0.1" }, { description: "Build", quantity: "2", unitPrice: "0.2" }],
};
const tokens = (JSON.parse(readFileSync("tests/fixtures/oneclick/tokens.json", "utf8")) as OneClickToken[]).map((t) => ({
  assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals,
}));

const ORIGIN = { symbol: "USDC", blockchain: "arb", decimals: 6 };

function fake(over: Partial<{ amountIn: string; deadline: string; amountOut: string }> = {}) {
  const calls = { quote: [] as QuoteRequest[], deposit: [] as [string, string][] };
  let n = 0;
  const oneclick = {
    tokens: async () => tokens,
    quote: async (r: QuoteRequest) => {
      calls.quote.push(r);
      return {
        depositAddress: `dep${++n}`, amountIn: over.amountIn ?? "710180", minAmountIn: "700000", amountOut: over.amountOut ?? r.amount, minAmountOut: r.amount,
        deadline: over.deadline ?? r.deadline,
      };
    },
    submitDeposit: async (tx: string, addr: string) => void calls.deposit.push([tx, addr]),
  };
  return { oneclick, calls };
}
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

async function setup(state: "draft" | "issued" | "cancelled" = "issued") {
  const db = createTestDb();
  let inv = await createInvoice(db, OWNER, draft, NOW.toISOString());
  if (state !== "draft") inv = await issueInvoice(db, OWNER, inv.id, NOW.toISOString());
  if (state === "cancelled") inv = await cancelInvoice(db, OWNER, inv.id, NOW.toISOString());
  const f = fake();
  return { db, inv, ...f, deps: { db, oneclick: f.oneclick, now: NOW } };
}

test("quote for an issued invoice pays the owner's Intents account exactly", async () => {
  const { db, inv, deps, calls } = await setup();
  const view = await createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND });
  assert.equal(calls.quote.length, 1);
  assert.deepEqual(calls.quote[0], {
    dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: ARB, depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC, amount: "700000", refundTo: REFUND, refundType: "ORIGIN_CHAIN", recipient: OWNER,
    recipientType: "INTENTS", deadline: "2030-01-01T00:30:00.000Z", referral: "manexus",
  });
  assert.equal(view.depositAddress, "dep1");
  assert.equal(view.amountIn, "710180");
  assert.equal(view.amountInFormatted, "0.71018");
  assert.equal(view.status, "PENDING_DEPOSIT");
  assert.equal(view.expired, false);
  const rows = await listAttempts(db, inv.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceId, inv.id);
  assert.equal(rows[0].refundTo, REFUND);
  assert.equal(rows[0].originAsset, ARB);
});

test("non-issued invoices are not payable and 1Click is not quoted", async () => {
  for (const s of ["draft", "cancelled"] as const) {
    const { inv, deps, calls } = await setup(s);
    assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND })), s === "draft" ? 404 : 409);
    assert.equal(calls.quote.length, 0);
  }
  const { db, inv, deps, calls } = await setup();
  await db.prepare("UPDATE invoices SET status='paid' WHERE id=?").bind(inv.id).run();
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND })), 409);
  await db.prepare("UPDATE invoices SET status='issued', total='0' WHERE id=?").bind(inv.id).run();
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND })), 409);
  assert.equal(calls.quote.length, 0);
});

test("refund address must be valid for the origin chain; unknown assets rejected", async () => {
  const { inv, deps, calls } = await setup();
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: "alice.near" })), 400);
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: "nep141:nope", refundTo: REFUND })), 400);
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: 5 as never, refundTo: REFUND })), 400);
  assert.equal(calls.quote.length, 0);
});

test("an expired pending attempt hides its deposit address", async () => {
  const { db, inv, deps } = await setup();
  await createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND });
  const [row] = await listAttempts(db, inv.id);
  const later = new Date("2030-01-01T00:31:00.000Z");
  const v = toAttemptView(row, later, ORIGIN);
  assert.equal(v.symbol, "USDC");
  assert.equal(v.blockchain, "arb");
  assert.equal(v.amountInFormatted, "0.71018");
  assert.equal(v.expired, true);
  assert.equal(v.depositAddress, "");
  assert.equal("depositMemo" in v, false);
  const live = toAttemptView({ ...row, depositMemo: "m1" }, NOW, ORIGIN);
  assert.equal(live.depositMemo, "m1");
  const done = toAttemptView({ ...row, status: "SUCCESS", outcome: "paid" }, later, ORIGIN);
  assert.equal(done.expired, false);
  assert.equal(done.outcome, "paid");
  assert.equal(done.depositAddress, row.depositAddress);
});

test("the 21st attempt is rate limited", async () => {
  const { inv, deps, calls } = await setup();
  for (let i = 0; i < 20; i++) await createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND });
  assert.equal(await status(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND })), 429);
  assert.equal(calls.quote.length, 20);
});

test("submitDepositTx only works for attempts of that invoice", async () => {
  const { db, inv, deps, calls } = await setup();
  const other = await issueInvoice(db, OWNER, (await createInvoice(db, OWNER, draft, NOW.toISOString())).id, NOW.toISOString());
  const v = await createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND });
  assert.equal(await status(submitDepositTx(deps, other.publicId, { depositAddress: v.depositAddress, txHash: "0xabc" })), 404);
  assert.equal(await status(submitDepositTx(deps, inv.publicId, { depositAddress: v.depositAddress, txHash: "" })), 400);
  assert.equal(calls.deposit.length, 0);
  await submitDepositTx(deps, inv.publicId, { depositAddress: v.depositAddress, txHash: "0xabc" });
  assert.deepEqual(calls.deposit, [["0xabc", v.depositAddress]]);
});

test("saveAttempt round-trips and getInvoiceByPublicId hides drafts", async () => {
  const { db, inv } = await setup();
  const row: AttemptRow = {
    depositAddress: "x", invoiceId: inv.id, originAsset: ARB, amountIn: "1", refundTo: REFUND, deadline: NOW.toISOString(),
    status: "PENDING_DEPOSIT", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
  await saveAttempt(db, row);
  assert.deepEqual({ ...(await listAttempts(db, inv.id))[0] }, row);
  assert.equal((await getInvoiceByPublicId(db, inv.publicId)).id, inv.id);
  const d = await createInvoice(db, OWNER, draft, NOW.toISOString());
  assert.equal(await status(getInvoiceByPublicId(db, d.publicId)), 404);
});

test("malformed upstream quotes are rejected before saving", async () => {
  for (const over of [{ amountIn: "1.5" }, { amountIn: "" }, { deadline: "soon" }, { amountOut: "699999" }, { amountOut: "7e5" }, { amountOut: "" }]) {
    const { db, inv, oneclick } = await setup();
    const deps = { db, oneclick: fake(over).oneclick, now: NOW };
    void oneclick;
    await assert.rejects(createPaymentQuote(deps, inv.publicId, { originAsset: ARB, refundTo: REFUND }), (e: { status?: number; message?: string }) =>
      e.status === 502 && e.message === "NEAR Intents returned an unexpected response", JSON.stringify(over));
    assert.equal((await listAttempts(db, inv.id)).length, 0);
  }
  // Delivering more than the total is fine.
  const { db, inv } = await setup();
  await createPaymentQuote({ db, oneclick: fake({ amountOut: "700001" }).oneclick, now: NOW }, inv.publicId, { originAsset: ARB, refundTo: REFUND });
  assert.equal((await listAttempts(db, inv.id)).length, 1);
});
