import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { createTestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";
import { cancelInvoice, createInvoice, getInvoice, issueInvoice } from "../../server/invoices.ts";
import { listAttempts } from "../../server/payments.ts";
import { submitTransfer, type TransferDeps } from "../../server/transfers.ts";
import {
  cancelBill,
  createBill,
  getBill,
  importManexusInvoice,
  listBills,
  quoteBillPayment,
  refreshBill,
  updateBill,
} from "../../server/bills.ts";
import { listActivity } from "../../server/activity.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";
import { onRequestPost as importPost } from "../../functions/api/bills/import.ts";
import { onRequestGet as billsGet } from "../../functions/api/bills/index.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const WNEAR = "nep141:wrap.near";
const ALICE = { account: "alice.near", kind: "near" as const };
const VENDOR = "vendor.near";
const MALLORY = { account: "mallory.near", kind: "near" as const };
const ORIGIN = "https://app.manexus.test";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const LATER = new Date("2030-01-01T00:05:00.000Z");
const NONCE = Buffer.alloc(32, 7).toString("base64");
const NEP_SIG = { public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) };
const ARB_ADDR = "0x2222222222222222222222222222222222222222";
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
];
const vendorDraft: InvoiceDraft = {
  number: "V-42", client: "Alice Co", issuer: "Vendor Studio", dueDate: "2030-01-20", tokenId: USDC, notes: "",
  items: [{ description: "Design", quantity: "2", unitPrice: "0.5" }],
};

let depCounter = 0;
const nextDep = () => (++depCounter).toString(16).padStart(64, "0");
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

function fakes(o: { balance?: string; amountIn?: (r: QuoteRequest) => string } = {}) {
  const calls = { quote: [] as QuoteRequest[], generate: [] as unknown[], submit: [] as unknown[] };
  const quotes = new Map<string, { q: Quote; r: QuoteRequest }>();
  const statuses = new Map<string, SwapStatus>();
  const rpc: NearRpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, _m: string, args: { token_ids?: string[] }) =>
      (args.token_ids ?? []).map((id) => (id === USDC ? (o.balance ?? "5000000") : "0"))) as NearRpc["viewFunction"],
  };
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      const amountIn = o.amountIn ? o.amountIn(r) : ((BigInt(r.amount) * 101n) / 100n).toString();
      const q: Quote = { depositAddress: nextDep(), amountIn, minAmountIn: amountIn, amountOut: r.amount, minAmountOut: r.amount, deadline: r.deadline };
      quotes.set(q.depositAddress, { q, r });
      return q;
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      calls.generate.push(a);
      const { q } = quotes.get(a.depositAddress)!;
      const deadline = q.deadline;
      const list = [{ intent: "transfer", receiver_id: a.depositAddress, tokens: { [USDC]: q.amountIn } }];
      return {
        standard: a.standard,
        payload: { recipient: "intents.near", nonce: NONCE, message: JSON.stringify({ signer_id: a.signerId, deadline, intents: list }) },
      };
    },
    submitIntent: async (s: unknown) => {
      calls.submit.push(s);
      return { intentHash: "IntentHash111" };
    },
    status: async (dep: string): Promise<SwapStatus> => {
      const s = statuses.get(dep);
      if (!s) throw new Error("status not stubbed");
      return s;
    },
    submitDeposit: async () => {},
  };
  /** 1Click reports `st` for `dep`, echoing the quote request it executed. */
  const settle = (dep: string, st: SwapStatus["status"], over: Partial<SwapStatus> = {}) =>
    statuses.set(dep, {
      status: st, updatedAt: "t", quoteRequest: quotes.get(dep)!.r, depositAddress: dep,
      ...(st === "SUCCESS" ? { amountOut: quotes.get(dep)!.q.amountOut } : {}), originTxHashes: [], destinationTxHashes: [], ...over,
    });
  return { rpc, oneclick, calls, settle };
}
type F = ReturnType<typeof fakes>;
const deps = (db: Db, f: F, now = NOW): TransferDeps => ({ db, rpc: f.rpc, oneclick: f.oneclick, now });

async function vendorInvoice(db: Db, state: "draft" | "issued" | "cancelled" | "paid" = "issued", owner = VENDOR) {
  let inv = await createInvoice(db, owner, vendorDraft, NOW.toISOString());
  if (state !== "draft") inv = await issueInvoice(db, owner, inv.id, NOW.toISOString());
  if (state === "cancelled") inv = await cancelInvoice(db, owner, inv.id, NOW.toISOString());
  if (state === "paid") await db.prepare("UPDATE invoices SET status='paid', paid_by='someone' WHERE id=?").bind(inv.id).run();
  return inv;
}
const manual = (over: Record<string, unknown> = {}) => ({
  source: "manual", vendor: "Hosting Ltd", reference: "H-9", dueDate: "2030-01-10", destinationAsset: ARB_USDC,
  recipientType: "DESTINATION_CHAIN", recipient: ARB_ADDR, amount: "2.5", ...over,
});
const withdrawals = (db: Db) => db.prepare("SELECT * FROM withdrawals").bind().all<Record<string, unknown>>().then((r) => r.results.map((x) => ({ ...x })));
const signed = (qt: { depositAddress: string; intent: { payload: unknown } }) => ({ depositAddress: qt.depositAddress, signedData: { standard: "nep413", payload: qt.intent.payload, ...NEP_SIG } });

// --- import ---

test("import accepts this origin's pay link or a bare public id and prefills from the vendor invoice", async () => {
  const db = createTestDb();
  const inv = await vendorInvoice(db);
  for (const link of [`${ORIGIN}/#/pay/${inv.publicId}`, `  ${inv.publicId} `]) {
    const d = await importManexusInvoice({ db, origin: ORIGIN }, ALICE, link);
    assert.deepEqual(
      { vendor: d.vendor, reference: d.reference, dueDate: d.dueDate, amount: d.amount, destinationAsset: d.destinationAsset, recipient: d.recipient, recipientType: d.recipientType, source: d.source, vendorPublicId: d.vendorPublicId },
      { vendor: "Vendor Studio", reference: "V-42", dueDate: "2030-01-20", amount: "1000000", destinationAsset: USDC, recipient: VENDOR, recipientType: "INTENTS", source: "manexus", vendorPublicId: inv.publicId },
    );
    assert.equal(d.amountFormatted, "1");
    assert.equal(d.symbol, "USDC");
  }
});

test("import rejects other origins and anything that is not a pay link", async () => {
  const db = createTestDb();
  const inv = await vendorInvoice(db);
  for (const link of [
    `https://evil.test/#/pay/${inv.publicId}`,
    `http://app.manexus.test/#/pay/${inv.publicId}`,
    `${ORIGIN}.evil.test/#/pay/${inv.publicId}`,
    `${ORIGIN}/#/invoices/${inv.publicId}`,
    `${ORIGIN}/#/pay/short`,
    "not a link",
    "",
    5 as never,
  ])
    await assert.rejects(importManexusInvoice({ db, origin: ORIGIN }, ALICE, link), { status: 400, message: "Paste a Manexus invoice link" }, String(link));
});

test("import rejects the owner's own invoice, drafts and invoices no longer payable", async () => {
  const db = createTestDb();
  const own = await vendorInvoice(db, "issued", ALICE.account);
  await assert.rejects(importManexusInvoice({ db, origin: ORIGIN }, ALICE, own.publicId), { status: 400, message: "This is your own invoice" });
  const draft = await vendorInvoice(db, "draft");
  assert.equal(await status(importManexusInvoice({ db, origin: ORIGIN }, ALICE, draft.publicId)), 404);
  for (const s of ["cancelled", "paid"] as const) {
    const inv = await vendorInvoice(db, s);
    await assert.rejects(importManexusInvoice({ db, origin: ORIGIN }, ALICE, inv.publicId), { status: 409, message: "The vendor invoice is no longer payable" });
  }
});

test("POST /api/bills/import uses the request's own origin", async () => {
  const db = createTestDb();
  const inv = await vendorInvoice(db);
  const SECRET = "s".repeat(32);
  const env = { DB: db, SESSION_SECRET: SECRET } as unknown as Env;
  const cookie = `mx_session=${await signSession(ALICE.account, "near", SECRET)}`;
  const call = (link: string) =>
    importPost({ request: new Request(`${ORIGIN}/api/bills/import`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ link }) }), env } as never);
  const ok = await call(`${ORIGIN}/#/pay/${inv.publicId}`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { vendorPublicId: string }).vendorPublicId, inv.publicId);
  assert.equal((await call(`https://other.test/#/pay/${inv.publicId}`)).status, 400);
  const anon = await importPost({ request: new Request(`${ORIGIN}/api/bills/import`, { method: "POST", body: "{}" }), env } as never);
  assert.equal(anon.status, 401);
  const list = await billsGet({ request: new Request(`${ORIGIN}/api/bills`), env } as never);
  assert.equal(list.status, 401);
});

// --- create / list / update / cancel ---

test("manual bill: amount entered in the destination token's decimals is stored in base units", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  assert.equal(b.amount, "2500000");
  assert.equal(b.source, "manual");
  assert.equal(b.status, "scheduled");
  assert.equal(b.recipientType, "DESTINATION_CHAIN");
  const w = await createBill(deps(db, f), ALICE, manual({ destinationAsset: WNEAR, recipient: "shop.near", amount: "0.000000000000000000000001" }));
  assert.equal(w.amount, "1");
  const i = await createBill(deps(db, f), ALICE, manual({ destinationAsset: USDC, recipientType: "INTENTS", recipient: "shop.near", amount: "3" }));
  assert.equal(i.recipientType, "INTENTS");
});

test("manual bill validation", async () => {
  const db = createTestDb();
  const f = fakes();
  const bad: Record<string, unknown>[] = [
    { vendor: "" }, { vendor: "x".repeat(101) }, { vendor: "a\u0000b" }, { reference: 7 }, { reference: "x".repeat(101) },
    { dueDate: "2030-02-30" }, { dueDate: "soon" }, { destinationAsset: "nep141:nope" }, { recipient: "alice.near" },
    { recipient: "0x0000000000000000000000000000000000000000" }, { amount: "12.1234567" }, { amount: "0" }, { amount: "-1" }, { amount: 12 },
    { recipientType: "ORIGIN_CHAIN" }, { recipientType: "INTENTS", recipient: "Bad Account" }, { recipientType: "INTENTS", recipient: ALICE.account },
  ];
  for (const over of bad) assert.equal(await status(createBill(deps(db, f), ALICE, manual(over))), 400, JSON.stringify(over));
  assert.deepEqual(await listBills(db, ALICE.account), []);
});

test("manexus bill takes every payment field from the vendor invoice, not the client; one open bill per invoice", async () => {
  const db = createTestDb();
  const f = fakes();
  const inv = await vendorInvoice(db);
  const b = await createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: inv.publicId, amount: "1", recipient: "mallory.near", vendor: "Fake" });
  assert.deepEqual(
    [b.vendor, b.reference, b.amount, b.recipient, b.recipientType, b.destinationAsset, b.source, b.vendorPublicId, b.dueDate],
    ["Vendor Studio", "V-42", "1000000", VENDOR, "INTENTS", USDC, "manexus", inv.publicId, "2030-01-20"],
  );
  await assert.rejects(createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: inv.publicId }), { status: 409 });
  const own = await vendorInvoice(db, "issued", ALICE.account);
  await assert.rejects(createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: own.publicId }), { status: 400, message: "This is your own invoice" });
  const gone = await vendorInvoice(db, "cancelled");
  assert.equal(await status(createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: gone.publicId })), 409);
});

test("list filters by status; update and cancel only while scheduled; other owners get 404", async () => {
  const db = createTestDb();
  const f = fakes();
  const a = await createBill(deps(db, f), ALICE, manual());
  const b = await createBill(deps(db, f), ALICE, manual({ vendor: "Second", dueDate: "2030-01-05" }));
  assert.deepEqual((await listBills(db, ALICE.account)).map((x) => x.vendor), ["Second", "Hosting Ltd"]);
  const u = await updateBill(deps(db, f), ALICE, a.id, manual({ amount: "1", vendor: "Hosting Ltd 2" }));
  assert.deepEqual([u.amount, u.vendor], ["1000000", "Hosting Ltd 2"]);
  const c = await cancelBill(deps(db, f), ALICE, b.id);
  assert.equal(c.status, "cancelled");
  assert.deepEqual((await listBills(db, ALICE.account, "scheduled")).map((x) => x.id), [a.id]);
  assert.deepEqual((await listBills(db, ALICE.account, "cancelled")).map((x) => x.id), [b.id]);
  await assert.rejects(listBills(db, ALICE.account, "nope" as never), { status: 400 });
  assert.equal(await status(cancelBill(deps(db, f), ALICE, b.id)), 409);
  assert.equal(await status(updateBill(deps(db, f), ALICE, b.id, manual())), 409);

  for (const p of [
    getBill(db, MALLORY.account, a.id),
    updateBill(deps(db, f), MALLORY, a.id, manual()),
    cancelBill(deps(db, f), MALLORY, a.id),
    quoteBillPayment(deps(db, f), MALLORY, a.id, { originAsset: USDC }),
    refreshBill(deps(db, f), MALLORY, a.id),
  ])
    await assert.rejects(p, { status: 404, message: "Bill not found" });
  assert.deepEqual(await listBills(db, MALLORY.account), []);
  assert.equal(f.calls.quote.length, 0);
  assert.equal((await getBill(db, ALICE.account, a.id)).status, "scheduled");
});

// --- pay a manual bill ---

test("manual bill quote: EXACT_OUTPUT of the bill amount to the vendor, bill moves to paying", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  const r = f.calls.quote[0];
  assert.deepEqual(
    [r.swapType, r.amount, r.destinationAsset, r.recipient, r.recipientType, r.depositType, r.refundType, r.refundTo, r.originAsset],
    ["EXACT_OUTPUT", "2500000", ARB_USDC, ARB_ADDR, "DESTINATION_CHAIN", "INTENTS", "INTENTS", ALICE.account, USDC],
  );
  assert.equal(qt.transfer.kind, "bill");
  assert.equal(qt.transfer.billId, b.id);
  assert.equal(qt.transfer.reference, "H-9");
  const bill = await getBill(db, ALICE.account, b.id);
  assert.deepEqual([bill.status, bill.depositAddress], ["paying", qt.depositAddress]);
  // A second quote while one is in flight is refused.
  assert.equal(await status(quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC })), 409);
  assert.equal(f.calls.quote.length, 1);
});

test("paying → scheduled when the quote expires unsigned, or the transfer fails or is refunded; → paid on SUCCESS", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  // Still valid: stays paying.
  assert.equal((await refreshBill(deps(db, f, LATER), ALICE, b.id)).status, "paying");
  const expired = new Date("2030-01-01T00:11:00.000Z");
  assert.equal((await refreshBill(deps(db, f, expired), ALICE, b.id)).status, "scheduled");

  for (const end of ["FAILED", "REFUNDED"] as const) {
    const qt = await quoteBillPayment(deps(db, f, expired), ALICE, b.id, { originAsset: USDC });
    await submitTransfer(deps(db, f, expired), ALICE, signed(qt));
    f.settle(qt.depositAddress, end);
    const v = await refreshBill(deps(db, f, new Date(expired.getTime() + 10_000)), ALICE, b.id);
    assert.equal(v.status, "scheduled", end);
    assert.equal(v.transfer?.status, end);
  }
  const at = new Date("2030-01-01T00:12:00.000Z");
  const qt = await quoteBillPayment(deps(db, f, at), ALICE, b.id, { originAsset: USDC });
  await submitTransfer(deps(db, f, at), ALICE, signed(qt));
  f.settle(qt.depositAddress, "SUCCESS");
  const v = await refreshBill(deps(db, f, new Date(at.getTime() + 10_000)), ALICE, b.id);
  assert.equal(v.status, "paid");
  assert.equal(v.extraPayment, false);
  assert.equal(await status(cancelBill(deps(db, f), ALICE, b.id)), 409);
  assert.equal(await status(quoteBillPayment(deps(db, f, at), ALICE, b.id, { originAsset: USDC })), 409);
});

test("a submit that failed upstream is not put back to scheduled right at the deadline", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  f.oneclick.submitIntent = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(submitTransfer(deps(db, f), ALICE, signed(qt)));
  f.settle(qt.depositAddress, "PENDING_DEPOSIT");
  assert.equal((await refreshBill(deps(db, f, new Date("2030-01-01T00:10:30.000Z")), ALICE, b.id)).status, "paying");
  assert.equal((await refreshBill(deps(db, f, new Date("2030-01-01T00:13:00.000Z")), ALICE, b.id)).status, "scheduled");
});

// --- pay a Manexus bill ---

async function manexusBill(db: Db, f: F) {
  const inv = await vendorInvoice(db);
  const b = await createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: inv.publicId });
  return { inv, b };
}

test("manexus quote: vendor attempt from the Intents balance and the owner's bill transfer share one deposit address", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  assert.equal(f.calls.quote.length, 1);
  assert.deepEqual(f.calls.quote[0], {
    dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: USDC, depositType: "INTENTS",
    destinationAsset: USDC, amount: "1000000", refundTo: ALICE.account, refundType: "INTENTS", recipient: VENDOR,
    recipientType: "INTENTS", deadline: "2030-01-01T00:30:00.000Z", referral: "manexus",
  });
  const [att] = await listAttempts(db, inv.id);
  assert.deepEqual([att.depositAddress, att.originAsset, att.refundTo, att.amountIn, att.status], [qt.depositAddress, USDC, ALICE.account, "1010000", "PENDING_DEPOSIT"]);
  const [w] = await withdrawals(db);
  assert.deepEqual(
    [w.deposit_address, w.owner, w.kind, w.bill_id, w.recipient, w.destination_asset, w.amount, w.status],
    [qt.depositAddress, ALICE.account, "bill", b.id, VENDOR, USDC, "1010000", "AWAITING_SIGNATURE"],
  );
  assert.equal(qt.transfer.swapType, "EXACT_OUTPUT");
  assert.equal(qt.transfer.recipientType, "INTENTS");
  assert.equal(qt.transfer.amountOut, "1000000");
  assert.deepEqual([(await getBill(db, ALICE.account, b.id)).status, (await getBill(db, ALICE.account, b.id)).depositAddress], ["paying", qt.depositAddress]);
});

test("manexus quote whose transfer cannot be prepared leaves no vendor attempt, no transfer, bill scheduled", async () => {
  const db = createTestDb();
  const f = fakes({ balance: "1000000" }); // amountIn 1010000 > balance
  const { inv, b } = await manexusBill(db, f);
  await assert.rejects(quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC }), { status: 400, message: "Amount exceeds your balance" });
  assert.equal(f.calls.quote.length, 1);
  assert.equal(f.calls.generate.length, 0);
  assert.deepEqual(await listAttempts(db, inv.id), []);
  assert.deepEqual(await withdrawals(db), []);
  assert.equal((await getBill(db, ALICE.account, b.id)).status, "scheduled");
  // A token the owner does not hold is refused before any quote.
  assert.equal(await status(quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDT })), 400);
  assert.equal(f.calls.quote.length, 1);
});

test("manexus quote is refused once the vendor invoice is no longer issued", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  await cancelInvoice(db, VENDOR, inv.id, NOW.toISOString());
  await assert.rejects(quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC }), { status: 409, message: "The vendor invoice is no longer payable" });
  assert.equal(f.calls.quote.length, 0);
});

test("vendor cancels between quote and signing: submit is 409 and nothing is relayed (Review Focus 2)", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  await cancelInvoice(db, VENDOR, inv.id, NOW.toISOString());
  await assert.rejects(submitTransfer(deps(db, f), ALICE, signed(qt)), { status: 409, message: "The vendor invoice is no longer payable" });
  assert.equal(f.calls.submit.length, 0);
  const [w] = await withdrawals(db);
  assert.equal(w.status, "AWAITING_SIGNATURE");
  // Paid by someone else meanwhile: same refusal.
  await db.prepare("UPDATE invoices SET status='paid' WHERE id=?").bind(inv.id).run();
  assert.equal(await status(submitTransfer(deps(db, f), ALICE, signed(qt))), 409);
  assert.equal(f.calls.submit.length, 0);
  void b;
});

test("after SUCCESS the bill is paid and the vendor invoice reconciles paid through refreshInvoice", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  await submitTransfer(deps(db, f), ALICE, signed(qt));
  f.settle(qt.depositAddress, "SUCCESS");
  const v = await refreshBill(deps(db, f, LATER), ALICE, b.id);
  assert.equal(v.status, "paid");
  assert.equal(v.extraPayment, false);
  assert.equal(v.vendorInvoiceStatus, "paid");
  assert.equal(v.transfer?.status, "SUCCESS");
  const fresh = await getInvoice(db, VENDOR, inv.id);
  assert.deepEqual([fresh.status, fresh.paidBy], ["paid", qt.depositAddress]);
  assert.equal((await listAttempts(db, inv.id))[0].outcome, "paid");
});

test("a payment that lands after the vendor invoice was paid elsewhere: bill paid, vendor reports extra payment", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  await submitTransfer(deps(db, f), ALICE, signed(qt));
  await db.prepare("UPDATE invoices SET status='paid', paid_by='other-dep' WHERE id=?").bind(inv.id).run();
  f.settle(qt.depositAddress, "SUCCESS");
  const v = await refreshBill(deps(db, f, LATER), ALICE, b.id);
  assert.equal(v.status, "paid");
  assert.equal(v.extraPayment, true);
  assert.equal((await listAttempts(db, inv.id))[0].outcome, "duplicate");
});

test("bill activity links to the bill", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  await submitTransfer(deps(db, f), ALICE, signed(qt));
  const items = await listActivity({ db, now: NOW }, ALICE);
  assert.deepEqual(items.map((i) => [i.type, i.href]), [["bill", `#/bills/${b.id}`]]);
});

test("vendor cancels after the payment was relayed: bill paid, after_cancel shown as extra payment", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  await submitTransfer(deps(db, f), ALICE, signed(qt));
  await cancelInvoice(db, VENDOR, inv.id, NOW.toISOString());
  f.settle(qt.depositAddress, "SUCCESS");
  const v = await refreshBill(deps(db, f, LATER), ALICE, b.id);
  assert.deepEqual([v.status, v.extraPayment, v.vendorOutcome, v.vendorInvoiceStatus], ["paid", true, "after_cancel", "cancelled"]);
});

test("a concurrent quote that loses the scheduled → paying race leaves nothing signable behind", async () => {
  const db = createTestDb();
  const f = fakes();
  const { inv, b } = await manexusBill(db, f);
  // Another request moved the bill on while this quote was in flight.
  const realQuote = f.oneclick.quote;
  f.oneclick.quote = async (r) => {
    await db.prepare("UPDATE bills SET status='paying', deposit_address='other' WHERE id=?").bind(b.id).run();
    return realQuote(r);
  };
  assert.equal(await status(quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC })), 409);
  assert.deepEqual(await withdrawals(db), []);
  assert.deepEqual(await listAttempts(db, inv.id), []);
});

test("after a failed relay, the bill is rescheduled only once 1Click was actually consulted past the grace period", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  f.oneclick.submitIntent = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(submitTransfer(deps(db, f), ALICE, signed(qt)));
  // A check before the grace period ended, then the throttled cache of it: still paying.
  f.settle(qt.depositAddress, "PENDING_DEPOSIT");
  assert.equal((await refreshBill(deps(db, f, new Date("2030-01-01T00:11:58.000Z")), ALICE, b.id)).status, "paying");
  assert.equal((await refreshBill(deps(db, f, new Date("2030-01-01T00:12:01.000Z")), ALICE, b.id)).status, "paying");
  // 1Click unreachable after the grace period: no proof the relay did not land → stay paying.
  const real = f.oneclick.status;
  f.oneclick.status = async () => {
    throw new Error("down");
  };
  const down = await refreshBill(deps(db, f, new Date("2030-01-01T00:13:00.000Z")), ALICE, b.id);
  assert.equal(down.status, "paying");
  assert.ok(down.refreshError);
  f.oneclick.status = real;
  // A real check after the grace period that has not seen the deposit → scheduled.
  assert.equal((await refreshBill(deps(db, f, new Date("2030-01-01T00:14:00.000Z")), ALICE, b.id)).status, "scheduled");
});

test("concurrent imports of one vendor invoice create a single open bill", async () => {
  const db = createTestDb();
  const f = fakes();
  const inv = await vendorInvoice(db);
  const res = await Promise.allSettled([1, 2, 3].map(() => createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: inv.publicId })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of res)
    if (r.status === "rejected") assert.deepEqual([r.reason.status, r.reason.message], [409, "You already have an open bill for this invoice"]);
  assert.equal((await listBills(db, ALICE.account)).length, 1);
  // Once cancelled, the invoice can be imported again.
  const [only] = await listBills(db, ALICE.account);
  await cancelBill(deps(db, f), ALICE, only.id);
  await createBill(deps(db, f), ALICE, { source: "manexus", vendorPublicId: inv.publicId });
});

test("a paying bill with an unsigned, unexpired quote exposes that intent to its owner for resuming", async () => {
  const db = createTestDb();
  const f = fakes();
  const b = await createBill(deps(db, f), ALICE, manual());
  const qt = await quoteBillPayment(deps(db, f), ALICE, b.id, { originAsset: USDC });
  const v = await refreshBill(deps(db, f, LATER), ALICE, b.id);
  assert.deepEqual(v.pendingQuote, { depositAddress: qt.depositAddress, deadline: qt.deadline, amountOutFormatted: qt.amountOutFormatted, intent: qt.intent, transfer: v.transfer });
  const expired = await refreshBill(deps(db, f, new Date("2030-01-01T00:10:30.000Z")), ALICE, b.id);
  assert.equal(expired.pendingQuote, undefined);
});
