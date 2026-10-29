import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { createTestDb, type TestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";
import type { Policy } from "../../server/policy.ts";
import { HttpError } from "../../server/http.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { listProposals, runAgent, STUCK_APPROVE_MS, type Proposal } from "../../server/agent.ts";
import { approveProposal, OUT_OF_DATE } from "../../server/agent-actions.ts";
import { submitTransfer, type TransferQuote } from "../../server/transfers.ts";
import { onRequestPost as approvePost } from "../../functions/api/agent/proposals/[id]/approve.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const NOW = new Date("2030-01-10T12:00:00.000Z");
const DEADLINE = "2030-01-10T12:10:00.000Z";
const NONCE = Buffer.alloc(32, 7).toString("base64");
const ALICE = { account: "alice.near", kind: "near" as const };
const MALLORY = { account: "mallory.near", kind: "near" as const };
const ORIGIN = "https://app.manexus.test";
const DAILY = "This exceeds your 24-hour limit";
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
  { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, price: 1 },
];
for (let i = 0; i < 18; i++) TOKENS.push({ assetId: `nep141:t${i}.near`, symbol: `T${i}`, blockchain: "near", decimals: 6, price: 1 });
const at = (ms: number) => new Date(NOW.getTime() + ms);

let depCounter = 0;
const nextDep = () => "a" + (++depCounter).toString(16).padStart(63, "0");

function world(balances: Record<string, string>) {
  const db = createTestDb();
  const calls = { quote: [] as QuoteRequest[], status: 0 };
  const quotes = new Map<string, { q: Quote; origin: string }>();
  const statuses = new Map<string, SwapStatus["status"]>();
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      const amountIn = r.swapType === "EXACT_OUTPUT" ? ((BigInt(r.amount) * 101n) / 100n).toString() : r.amount;
      const q: Quote = { depositAddress: nextDep(), amountIn, minAmountIn: amountIn, amountOut: r.swapType === "EXACT_OUTPUT" ? r.amount : "990000", minAmountOut: r.swapType === "EXACT_OUTPUT" ? r.amount : "980000", deadline: DEADLINE };
      quotes.set(q.depositAddress, { q, origin: r.originAsset });
      return q;
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      const { q, origin } = quotes.get(a.depositAddress)!;
      const intents = [{ intent: "transfer", receiver_id: a.depositAddress, tokens: { [origin]: q.amountIn } }];
      return { standard: a.standard, payload: { recipient: "intents.near", nonce: NONCE, message: JSON.stringify({ signer_id: a.signerId, deadline: DEADLINE, intents }) } };
    },
    submitIntent: async () => ({ intentHash: "H" }),
    status: async (dep: string): Promise<SwapStatus> => {
      calls.status++;
      return { status: statuses.get(dep) ?? "PROCESSING", updatedAt: NOW.toISOString(), originTxHashes: [], destinationTxHashes: [] } as SwapStatus;
    },
  };
  const rpc = {
    viewAccessKey: async () => ({ permission: "FullAccess" }),
    viewFunction: (async (_c: string, _m: string, a: { token_ids: string[] }) => a.token_ids.map((t) => balances[t] ?? "0")) as NearRpc["viewFunction"],
  } as unknown as NearRpc;
  const deps = (now = NOW) => ({ db, rpc, oneclick, now, origin: ORIGIN });
  return { db, calls, balances, statuses, deps };
}

async function setPolicy(db: Db, owner: string, p: Omit<Policy, "version">) {
  await db.prepare("INSERT OR REPLACE INTO agent_policies (owner, policy, hash, updated_at) VALUES (?, ?, 'h', 't')").bind(owner, JSON.stringify({ version: 1, ...p })).run();
}
const whitelist = (db: Db, id = "w1", recipient = "cold.near") =>
  db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES (?, ?, 'Cold', ?, 'INTENTS', ?, 't')").bind(id, ALICE.account, USDC, recipient).run();
const insBill = (db: Db, id: string, due = "2030-01-11") =>
  db
    .prepare("INSERT INTO bills (id, owner, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, status, created_at, updated_at) VALUES (?, ?, 'Acme', 'INV-7', ?, ?, 'INTENTS', 'vendor.near', '1000000', 'manual', 'scheduled', 't', 't')")
    .bind(id, ALICE.account, due, USDC)
    .run();
const insInvoice = (db: Db, id: string, due: string) =>
  db
    .prepare("INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at, issued_at) VALUES (?, ?, ?, 'issued', ?, ?, '1000000', 1, 't', 't', 't')")
    .bind(id, `pub-${id}`, ALICE.account, USDC, JSON.stringify({ number: "INV-3", client: "Client Co", issuer: "Me", dueDate: due, tokenId: USDC, notes: "", items: [{ description: "x", quantity: "1", unitPrice: "1" }] }))
    .run();
const status = async (db: Db, id: string) => ({ ...(await db.prepare("SELECT status, deposit_address FROM agent_proposals WHERE id = ?").bind(id).first<{ status: string; deposit_address: string | null }>())! });
const byType = (ps: Proposal[], t: Proposal["type"]) => ps.find((p) => p.type === t)!;
async function rejectsWith(p: Promise<unknown>, code: number, message?: string) {
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === code && (message === undefined || e.message === message));
}
const stale = (p: Promise<unknown>) => rejectsWith(p, 409, OUT_OF_DATE);

const CONVERT = { convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } };
const SWEEP = { sweep: { enabled: true, tokenId: USDC, thresholdUnits: "100000000", keepUnits: "10000000", whitelistId: "w1" } };
const REMIND = { reminders: { billDueDays: 3, invoiceOverdueDays: 7 } };

test("convert: approve quotes an in-account swap of exactly the proposed amount at 1% slippage", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  const q = (await approveProposal(w.deps(at(1000)), ALICE, p.id, {})) as TransferQuote;
  assert.equal(w.calls.quote.length, 1);
  const r = w.calls.quote[0];
  assert.deepEqual(
    { swapType: r.swapType, originAsset: r.originAsset, destinationAsset: r.destinationAsset, amount: r.amount, slippage: r.slippageTolerance, recipient: r.recipient, recipientType: r.recipientType, refundTo: r.refundTo },
    { swapType: "EXACT_INPUT", originAsset: USDT, destinationAsset: USDC, amount: "120000000", slippage: 100, recipient: ALICE.account, recipientType: "INTENTS", refundTo: ALICE.account },
  );
  assert.equal(q.transfer.kind, "swap");
  assert.deepEqual(await status(w.db, p.id), { status: "executing", deposit_address: q.depositAddress });
  // Double approve: 409, no second quote.
  await rejectsWith(approveProposal(w.deps(at(2000)), ALICE, p.id, {}), 409, "This proposal is no longer open");
  assert.equal(w.calls.quote.length, 1);
});

test("sweep: approve withdraws balance minus keep to the whitelist entry", async () => {
  const w = world({ [USDC]: "500000000" });
  await whitelist(w.db);
  await setPolicy(w.db, ALICE.account, SWEEP);
  const p = byType(await runAgent(w.deps(), ALICE), "sweep");
  const q = (await approveProposal(w.deps(), ALICE, p.id, {})) as TransferQuote;
  const r = w.calls.quote[0];
  assert.deepEqual(
    { swapType: r.swapType, originAsset: r.originAsset, destinationAsset: r.destinationAsset, amount: r.amount, recipient: r.recipient, recipientType: r.recipientType, slippage: r.slippageTolerance },
    { swapType: "EXACT_INPUT", originAsset: USDC, destinationAsset: USDC, amount: "490000000", recipient: "cold.near", recipientType: "INTENTS", slippage: 100 },
  );
  assert.equal(q.transfer.kind, "withdraw");
});

test("sweep: a whitelist entry removed after the proposal is 409 + expired, nothing quoted", async () => {
  const w = world({ [USDC]: "500000000" });
  await whitelist(w.db);
  await setPolicy(w.db, ALICE.account, SWEEP);
  const p = byType(await runAgent(w.deps(), ALICE), "sweep");
  await w.db.prepare("DELETE FROM whitelist WHERE id = 'w1'").bind().run();
  await stale(approveProposal(w.deps(), ALICE, p.id, {}));
  assert.equal((await status(w.db, p.id)).status, "expired");
  assert.equal(w.calls.quote.length, 0);
});

test("pay_bill: approve pays the bill from the chosen token (EXACT_OUTPUT) and marks it paying", async () => {
  const w = world({ [USDC]: "500000000" });
  await insBill(w.db, "b1");
  await setPolicy(w.db, ALICE.account, REMIND);
  const p = byType(await runAgent(w.deps(), ALICE), "pay_bill");
  await rejectsWith(approveProposal(w.deps(), ALICE, p.id, {}), 400);
  assert.equal((await status(w.db, p.id)).status, "proposed", "quote failure releases the proposal");
  const q = (await approveProposal(w.deps(), ALICE, p.id, { originAsset: USDC })) as TransferQuote;
  const r = w.calls.quote[0];
  assert.deepEqual(
    { swapType: r.swapType, originAsset: r.originAsset, destinationAsset: r.destinationAsset, amount: r.amount, recipient: r.recipient },
    { swapType: "EXACT_OUTPUT", originAsset: USDC, destinationAsset: USDC, amount: "1000000", recipient: "vendor.near" },
  );
  assert.equal(q.transfer.kind, "bill");
  assert.equal(q.transfer.billId, "b1");
  const b = await w.db.prepare("SELECT status FROM bills WHERE id = 'b1'").bind().first<{ status: string }>();
  assert.equal(b?.status, "paying");
});

test("follow_up_invoice: approve returns the pay link from the request origin and marks it done", async () => {
  const w = world({});
  await insInvoice(w.db, "i1", "2030-01-01");
  await setPolicy(w.db, ALICE.account, REMIND);
  const p = byType(await runAgent(w.deps(), ALICE), "follow_up_invoice");
  assert.deepEqual(await approveProposal(w.deps(), ALICE, p.id, {}), { followUp: { payUrl: `${ORIGIN}/#/pay/pub-i1` } });
  assert.equal((await status(w.db, p.id)).status, "done");
  assert.equal(w.calls.quote.length, 0);
});

test("stale params: a balance that changed since the proposal is 409 + expired; expires_at passed is 409 + expired", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  w.balances[USDT] = "119000000";
  await stale(approveProposal(w.deps(), ALICE, p.id, {}));
  assert.equal((await status(w.db, p.id)).status, "expired");
  assert.equal(w.calls.quote.length, 0);

  w.balances[USDT] = "50000000";
  const p2 = byType(await runAgent(w.deps(at(120_000)), ALICE), "convert");
  await stale(approveProposal(w.deps(at(120_000 + 3_600_001)), ALICE, p2.id, {}));
  assert.equal((await status(w.db, p2.id)).status, "expired");
  // The rule turned off: out of date as well.
  const p3 = byType(await runAgent(w.deps(at(10_000_000)), ALICE), "convert");
  await setPolicy(w.db, ALICE.account, { convert: { ...CONVERT.convert, enabled: false } });
  await stale(approveProposal(w.deps(at(10_000_000)), ALICE, p3.id, {}));
  assert.equal(w.calls.quote.length, 0);
});

test("convert and sweep on the same token: once the first executes, the other is out of date", async () => {
  const w = world({ [USDT]: "500000000" });
  await w.db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w1', ?, 'Cold', ?, 'INTENTS', 'cold.near', 't')").bind(ALICE.account, USDT).run();
  await setPolicy(w.db, ALICE.account, { ...CONVERT, sweep: { ...SWEEP.sweep, tokenId: USDT } });
  const ps = await runAgent(w.deps(), ALICE);
  const conv = byType(ps, "convert"), sweep = byType(ps, "sweep");
  assert.equal(conv.params.originAsset, USDT);
  assert.equal(sweep.params.originAsset, USDT);
  await approveProposal(w.deps(), ALICE, conv.id, {});
  w.balances[USDT] = "0"; // the swap executed
  await stale(approveProposal(w.deps(), ALICE, sweep.id, {}));
  assert.equal((await status(w.db, sweep.id)).status, "expired");
  assert.equal(w.calls.quote.length, 1);
});

test("spending limits still apply to approved sweeps and bills; a refused quote releases the proposal", async () => {
  const w = world({ [USDC]: "500000000" });
  await whitelist(w.db);
  await insBill(w.db, "b1");
  await setPolicy(w.db, ALICE.account, { ...SWEEP, ...REMIND, limits: { perTx: { [USDC]: "100000000" }, daily: { [USDC]: "1000000" }, whitelistOnly: true } });
  const ps = await runAgent(w.deps(), ALICE);
  const sweep = byType(ps, "sweep"), bill = byType(ps, "pay_bill");
  // The sweep is clipped to the 100 USDC per-transaction cap; the 1 USDC daily cap still refuses it.
  assert.deepEqual(sweep.params, { originAsset: USDC, amount: "100000000", whitelistId: "w1", limitedByCap: "true" });
  await rejectsWith(approveProposal(w.deps(), ALICE, sweep.id, {}), 400, DAILY);
  assert.equal((await status(w.db, sweep.id)).status, "proposed");
  // Bill: amountIn 1010000 > the 1000000 daily cap (checked after the quote on EXACT_OUTPUT); vendor not whitelisted either.
  await rejectsWith(approveProposal(w.deps(), ALICE, bill.id, { originAsset: USDC }), 400);
  assert.equal((await status(w.db, bill.id)).status, "proposed");
  await w.db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w2', ?, 'V', ?, 'INTENTS', 'vendor.near', 't')").bind(ALICE.account, USDC).run();
  await rejectsWith(approveProposal(w.deps(), ALICE, bill.id, { originAsset: USDC }), 400, DAILY);
  assert.equal(w.calls.quote.length, 1);
});

test("owner scoping and unknown ids", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  await rejectsWith(approveProposal(w.deps(), MALLORY, p.id, {}), 404);
  await rejectsWith(approveProposal(w.deps(), ALICE, "../x", {}), 404);
  await rejectsWith(approveProposal(w.deps(), ALICE, "nope", {}), 404);
  assert.equal((await status(w.db, p.id)).status, "proposed");
});

const signed = (q: TransferQuote) => ({
  depositAddress: q.depositAddress,
  signedData: { standard: q.intent.standard, payload: q.intent.payload, public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) },
});

test("runAgent settles executing proposals: SUCCESS → done, REFUNDED → proposed, expired unsigned → proposed, in flight stays", async () => {
  const w = world({ [USDT]: "120000000", "nep141:t0.near": "5000000", "nep141:t1.near": "5000000" });
  // Make the extra tokens part of the owner's balance set.
  for (const t of ["nep141:t0.near", "nep141:t1.near"])
    await w.db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at, kind) VALUES (?, ?, ?, ?, '1', ?, 'SUCCESS', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'swap')").bind(nextDep(), ALICE.account, t, t, ALICE.account).run();
  await setPolicy(w.db, ALICE.account, CONVERT);
  const ps = await runAgent(w.deps(), ALICE);
  const [a, b, c] = ["nep141:t0.near", "nep141:t1.near", USDT].map((t) => ps.find((p) => p.params.originAsset === t)!);
  const qa = (await approveProposal(w.deps(), ALICE, a.id, {})) as TransferQuote;
  const qb = (await approveProposal(w.deps(), ALICE, b.id, {})) as TransferQuote;
  await approveProposal(w.deps(), ALICE, c.id, {}); // never signed
  await submitTransfer(w.deps(), ALICE, signed(qa));
  await submitTransfer(w.deps(), ALICE, signed(qb));
  w.statuses.set(qa.depositAddress, "SUCCESS");
  w.statuses.set(qb.depositAddress, "REFUNDED");

  // Still in flight a minute later (throttled refresh): nothing changes.
  w.db.queries = 0;
  await runAgent(w.deps(at(1000)), ALICE);
  assert.deepEqual([(await status(w.db, a.id)).status, (await status(w.db, b.id)).status, (await status(w.db, c.id)).status], ["executing", "executing", "executing"]);

  await runAgent(w.deps(at(60_000)), ALICE);
  assert.equal((await status(w.db, a.id)).status, "done");
  assert.deepEqual(await status(w.db, b.id), { status: "proposed", deposit_address: null }, "old transfer unlinked");
  // Approving it again links and returns the new quote.
  const qb2 = (await approveProposal(w.deps(at(61_000)), ALICE, b.id, {})) as TransferQuote;
  assert.notEqual(qb2.depositAddress, qb.depositAddress);
  assert.deepEqual(await status(w.db, b.id), { status: "executing", deposit_address: qb2.depositAddress });
  assert.equal((await status(w.db, c.id)).status, "executing", "unsigned quote not yet expired");
  // The unsigned quote expires (10 min) and was never relayed: the proposal is open again.
  await runAgent(w.deps(at(11 * 60_000)), ALICE);
  const open = await listProposals(w.db, ALICE);
  assert.ok(open.some((p) => p.dedupKey === c.dedupKey && p.status === "proposed"));
});

test("an approval that never stored its quote is released after STUCK_APPROVE_MS (5 minutes)", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  await w.db.prepare("UPDATE agent_proposals SET status = 'executing', updated_at = ? WHERE id = ?").bind(NOW.toISOString(), p.id).run();
  assert.equal(STUCK_APPROVE_MS, 300_000);
  await runAgent(w.deps(at(STUCK_APPROVE_MS)), ALICE);
  assert.equal((await status(w.db, p.id)).status, "executing");
  await runAgent(w.deps(at(STUCK_APPROVE_MS + 1000)), ALICE);
  assert.equal((await status(w.db, p.id)).status, "proposed");
});

test("query budget: approve with 50 bills / 100 invoices / 20 balances, and runAgent with 50 executing proposals", async () => {
  const bal: Record<string, string> = { [USDT]: "120000000" };
  const w = world(bal);
  for (let i = 0; i < 18; i++) {
    bal[`nep141:t${i}.near`] = "5000000";
    await w.db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at, kind) VALUES (?, ?, ?, ?, '1', ?, 'SUCCESS', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'swap')").bind(nextDep(), ALICE.account, `nep141:t${i}.near`, `nep141:t${i}.near`, ALICE.account).run();
  }
  for (let i = 0; i < 50; i++) await insBill(w.db, `b${i}`, "2030-01-11");
  for (let i = 0; i < 100; i++) await insInvoice(w.db, `i${i}`, "2030-01-01");
  await whitelist(w.db);
  await setPolicy(w.db, ALICE.account, { ...CONVERT, ...REMIND, limits: { perTx: { [USDC]: "900000000" }, daily: { [USDC]: "900000000" }, whitelistOnly: false } });
  const ps = await runAgent(w.deps(), ALICE);
  const db = w.db as TestDb;
  let max = 0;
  for (const p of [byType(ps, "convert"), byType(ps, "pay_bill"), byType(ps, "follow_up_invoice")]) {
    db.queries = 0;
    await approveProposal(w.deps(), ALICE, p.id, { originAsset: USDT });
    console.log(`approve ${p.type}: ${db.queries} queries`);
    max = Math.max(max, db.queries);
  }
  assert.ok(max <= 45, `${max} queries`);

  // 50 executing proposals, several with transfers in flight that need a refresh.
  await w.db.prepare("UPDATE agent_proposals SET status = 'executing' WHERE status = 'proposed' AND id IN (SELECT id FROM agent_proposals WHERE status = 'proposed' LIMIT 50)").bind().run();
  db.queries = 0;
  await runAgent(w.deps(at(10 * 60_000)), ALICE, { force: true });
  console.log(`runAgent with executing proposals: ${db.queries} queries`);
  assert.ok(db.queries <= 45, `${db.queries} queries`);
});

test("route: POST /api/agent/proposals/:id/approve needs a session; follow-up link uses the request origin", async () => {
  const w = world({});
  await insInvoice(w.db, "i1", "2000-01-01");
  await setPolicy(w.db, ALICE.account, REMIND);
  const p = byType(await runAgent({ ...w.deps(), now: new Date() }, ALICE), "follow_up_invoice");
  const SECRET = "s".repeat(32);
  const env = { DB: w.db, SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.invalid", ONECLICK_BASE_URL: "https://1click.invalid" } as unknown as Env;
  const url = `https://intents.example.test/api/agent/proposals/${p.id}/approve`;
  const req = (cookie?: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: "{}" });
  assert.equal((await approvePost({ request: req(), env, params: { id: p.id } } as never)).status, 401);
  const mal = `mx_session=${await signSession(MALLORY.account, "near", SECRET)}`;
  assert.equal((await approvePost({ request: req(mal), env, params: { id: p.id } } as never)).status, 404);
  const ali = `mx_session=${await signSession(ALICE.account, "near", SECRET)}`;
  const r = await approvePost({ request: req(ali), env, params: { id: p.id } } as never);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { followUp: { payUrl: "https://intents.example.test/#/pay/pub-i1" } });
});

test("a slow approve released mid-flight (and re-approved) gets 409 and no quote; the re-approval links normally", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  // While approve A waits for 1Click, the proposal is released (stuck rule) and approved again as B.
  const origQuote = w.deps().oneclick.quote;
  let second: TransferQuote | undefined;
  let inner = false;
  w.deps().oneclick.quote = async (r: QuoteRequest) => {
    if (!inner) {
      inner = true;
      await w.db.prepare("UPDATE agent_proposals SET status = 'proposed' WHERE id = ?").bind(p.id).run();
      second = (await approveProposal(w.deps(at(STUCK_APPROVE_MS + 1000)), ALICE, p.id, {})) as TransferQuote;
    }
    return origQuote(r);
  };
  await stale(approveProposal(w.deps(), ALICE, p.id, {}));
  assert.ok(second);
  assert.deepEqual(await status(w.db, p.id), { status: "executing", deposit_address: second!.depositAddress });
});

test("no second convert/sweep draft for a token that already has an executing proposal", async () => {
  const w = world({ [USDT]: "500000000" });
  await w.db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w1', ?, 'Cold', ?, 'INTENTS', 'cold.near', 't')").bind(ALICE.account, USDT).run();
  await setPolicy(w.db, ALICE.account, { ...CONVERT, sweep: { ...SWEEP.sweep, tokenId: USDT } });
  const ps = await runAgent(w.deps(), ALICE);
  const conv = byType(ps, "convert"), sweep = byType(ps, "sweep");
  await approveProposal(w.deps(), ALICE, conv.id, {});
  // The sweep on the same token is out of date while the convert is in flight.
  await stale(approveProposal(w.deps(), ALICE, sweep.id, {}));
  const after = await runAgent(w.deps(at(120_000)), ALICE);
  assert.deepEqual(after.map((x) => [x.type, x.status]), [["convert", "executing"]]);
});

test("pay_bill approve without a string originAsset is 400 and the proposal stays open", async () => {
  const w = world({ [USDC]: "500000000" });
  await insBill(w.db, "b1");
  await setPolicy(w.db, ALICE.account, REMIND);
  const p = byType(await runAgent(w.deps(), ALICE), "pay_bill");
  await rejectsWith(approveProposal(w.deps(), ALICE, p.id, { originAsset: 5 as unknown as string }), 400, "Choose a token from your balance.");
  assert.equal((await status(w.db, p.id)).status, "proposed");
  assert.equal(w.calls.quote.length, 0);
});

test("the stuck release never releases a row an approve linked after runAgent read it", async () => {
  const w = world({ [USDT]: "120000000" });
  await setPolicy(w.db, ALICE.account, CONVERT);
  const p = byType(await runAgent(w.deps(), ALICE), "convert");
  await w.db.prepare("UPDATE agent_proposals SET status = 'executing', updated_at = ? WHERE id = ?").bind(NOW.toISOString(), p.id).run();
  // Between settle's read and its write batch, the (slow) approve links its quote.
  const raced: Db = {
    prepare: (sql: string) => w.db.prepare(sql),
    batch: async (stmts) => {
      await w.db.prepare("UPDATE agent_proposals SET deposit_address = 'A-dep', updated_at = ? WHERE id = ?").bind(at(STUCK_APPROVE_MS).toISOString(), p.id).run();
      return w.db.batch(stmts);
    },
  };
  await runAgent({ ...w.deps(at(STUCK_APPROVE_MS + 1000)), db: raced }, ALICE);
  assert.deepEqual(await status(w.db, p.id), { status: "executing", deposit_address: "A-dep" });
});

test("follow_up_invoice: an approved follow-up is not re-proposed for 7 days, then may be proposed again", async () => {
  const w = world({});
  await insInvoice(w.db, "i1", "2030-01-01");
  await setPolicy(w.db, ALICE.account, REMIND);
  const p = byType(await runAgent(w.deps(), ALICE), "follow_up_invoice");
  await approveProposal(w.deps(), ALICE, p.id, {});
  assert.equal((await runAgent(w.deps(at(120_000)), ALICE)).filter((x) => x.type === "follow_up_invoice").length, 0);
  assert.equal((await runAgent(w.deps(at(3 * 86_400_000)), ALICE)).filter((x) => x.type === "follow_up_invoice").length, 0);
  const again = (await runAgent(w.deps(at(7 * 86_400_000 + 1000)), ALICE)).filter((x) => x.type === "follow_up_invoice");
  assert.equal(again.length, 1);
  assert.notEqual(again[0].id, p.id);
  assert.deepEqual(again[0].params, p.params);
});
