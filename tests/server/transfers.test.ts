import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { createTestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { getBalances } from "../../server/balances.ts";
import {
  listTransfers,
  prepareTransfer,
  quoteTransfer,
  refreshTransfer,
  submitTransfer,
  type TransferDeps,
  type TransferRequest,
} from "../../server/transfers.ts";
import { listWithdrawals, quoteWithdrawal, refreshWithdrawal, submitWithdrawal } from "../../server/withdraw.ts";
import { onRequestGet as transfersGet } from "../../functions/api/transfers/index.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const WNEAR = "nep141:wrap.near";
const NEAR_USER = { account: "alice.near", kind: "near" as const };
const EVM_USER = { account: "0x1111111111111111111111111111111111111111", kind: "evm" as const };
const VENDOR = "vendor.near";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
];
let depCounter = 0;
const nextDep = () => (++depCounter).toString(16).padStart(64, "0");

const intents = (amount: string, receiver: string, token = USDC) => [{ intent: "transfer", receiver_id: receiver, tokens: { [token]: amount } }];
const nepPayload = (signer: string, list: unknown) => ({
  recipient: "intents.near",
  nonce: NONCE,
  message: JSON.stringify({ signer_id: signer, deadline: "2030-01-01T00:10:00.000Z", intents: list }),
});
const ercPayload = (signer: string, list: unknown) =>
  JSON.stringify({ signer_id: signer, verifying_contract: "intents.near", deadline: "2030-01-01T00:10:00.000Z", nonce: NONCE, intents: list });
const NEP_SIG = { public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) };

/**
 * Fake 1Click: an EXACT_INPUT quote echoes the amount; an EXACT_OUTPUT quote asks for `amountIn`
 * (default 1% above the requested output). The generated intent transfers `transferAmount(q)`.
 */
function fakes(o: {
  balance?: string;
  quote?: (r: QuoteRequest) => Partial<Quote>;
  transferAmount?: (q: Quote, r: QuoteRequest) => string;
  status?: () => Promise<SwapStatus>;
} = {}) {
  const calls = { quote: [] as QuoteRequest[], generate: [] as unknown[], submit: [] as unknown[], rpcTokenIds: [] as string[][] };
  const quotes = new Map<string, { q: Quote; r: QuoteRequest }>();
  const rpc: NearRpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, _m: string, args: { token_ids?: string[] }) => {
      calls.rpcTokenIds.push(args.token_ids ?? []);
      return (args.token_ids ?? []).map((id) => (id === USDC ? (o.balance ?? "5000000") : id === WNEAR ? "7" : "0"));
    }) as NearRpc["viewFunction"],
  };
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      const amountIn = r.swapType === "EXACT_OUTPUT" ? ((BigInt(r.amount) * 101n) / 100n).toString() : r.amount;
      const amountOut = r.swapType === "EXACT_OUTPUT" ? r.amount : "990000";
      const q: Quote = { depositAddress: nextDep(), amountIn, minAmountIn: amountIn, amountOut, minAmountOut: amountOut, deadline: "2030-01-01T00:10:00.000Z", ...o.quote?.(r) };
      quotes.set(q.depositAddress, { q, r });
      return q;
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      calls.generate.push(a);
      const { q, r } = quotes.get(a.depositAddress)!;
      const list = intents(o.transferAmount ? o.transferAmount(q, r) : q.amountIn, a.depositAddress);
      return { standard: a.standard, payload: a.standard === "nep413" ? nepPayload(a.signerId, list) : ercPayload(a.signerId, list) };
    },
    submitIntent: async (s: unknown) => {
      calls.submit.push(s);
      return { intentHash: "IntentHash111" };
    },
    status: async () => {
      if (!o.status) throw new Error("status not stubbed");
      return o.status();
    },
  };
  return { rpc, oneclick, calls };
}
const deps = (db: Db, f: ReturnType<typeof fakes>, now = NOW): TransferDeps => ({ db, rpc: f.rpc, oneclick: f.oneclick, now });
const billReq = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  kind: "bill", originAsset: USDC, destinationAsset: USDC, amount: "1000000", swapType: "EXACT_OUTPUT",
  recipientType: "INTENTS", recipient: VENDOR, reference: "INV-7", billId: "bill-1", ...over,
});
const swapReq = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  kind: "swap", originAsset: USDC, destinationAsset: WNEAR, amount: "1000000", swapType: "EXACT_INPUT",
  recipientType: "INTENTS", recipient: NEAR_USER.account, ...over,
});
const rows = (db: Db) => db.prepare("SELECT * FROM withdrawals ORDER BY created_at").bind().all<Record<string, unknown>>().then((r) => r.results.map((x) => ({ ...x })));

test("EXACT_OUTPUT whose amountIn exceeds the balance is 400 before generate-intent and nothing is stored", async () => {
  const db = createTestDb();
  const f = fakes({ balance: "1000000", quote: () => ({ amountIn: "1000001" }) });
  await assert.rejects(quoteTransfer(deps(db, f), NEAR_USER, billReq({ amount: "990000" })), { status: 400, message: "Amount exceeds your balance" });
  assert.equal(f.calls.quote.length, 1);
  assert.equal(f.calls.generate.length, 0);
  assert.deepEqual(await rows(db), []);
});

test("EXACT_OUTPUT amountIn equal to the balance is allowed", async () => {
  const db = createTestDb();
  const f = fakes({ balance: "1000000", quote: () => ({ amountIn: "1000000" }) });
  const out = await quoteTransfer(deps(db, f), NEAR_USER, billReq({ amount: "990000" }));
  assert.equal(out.transfer.amount, "1000000");
});

test("EXACT_OUTPUT with a non-numeric amountIn is 502 and nothing is stored", async () => {
  const db = createTestDb();
  const f = fakes({ quote: () => ({ amountIn: "1e6" }) });
  await assert.rejects(quoteTransfer(deps(db, f), NEAR_USER, billReq()), { status: 502 });
  assert.equal(f.calls.generate.length, 0);
  assert.deepEqual(await rows(db), []);
});

test("EXACT_OUTPUT whose amountOut is below the requested amount is 502 and nothing is stored", async () => {
  const db = createTestDb();
  const f = fakes({ quote: () => ({ amountOut: "999999", minAmountOut: "999999" }) });
  await assert.rejects(quoteTransfer(deps(db, f), NEAR_USER, billReq()), { status: 502 });
  assert.equal(f.calls.generate.length, 0);
  assert.deepEqual(await rows(db), []);
});

test("EXACT_OUTPUT whose minAmountOut is below the requested amount is 502 before generate-intent and nothing is stored", async () => {
  const db = createTestDb();
  const f = fakes({ quote: () => ({ amountOut: "1000500", minAmountOut: "999999" }) });
  await assert.rejects(quoteTransfer(deps(db, f), NEAR_USER, billReq()), { status: 502 });
  assert.equal(f.calls.generate.length, 0);
  assert.deepEqual(await rows(db), []);
});

test("withdraw routes keep the Withdrawal not found message", async () => {
  const f = fakes();
  await assert.rejects(refreshWithdrawal(deps(createTestDb(), f), NEAR_USER, "nope"), { status: 404, message: "Withdrawal not found" });
  await assert.rejects(submitWithdrawal(deps(createTestDb(), f), NEAR_USER, { depositAddress: "nope", signedData: { standard: "nep413" } }), { status: 404, message: "Withdrawal not found" });
  await assert.rejects(refreshTransfer(deps(createTestDb(), f), NEAR_USER, "nope"), { status: 404, message: "Transfer not found" });
});

test("EXACT_OUTPUT generated intent transferring the requested amount instead of amountIn is 502 and not stored", async () => {
  const db = createTestDb();
  const f = fakes({ transferAmount: (_q, r) => r.amount });
  await assert.rejects(quoteTransfer(deps(db, f), NEAR_USER, billReq()), { status: 502 });
  assert.equal(f.calls.generate.length, 1);
  assert.deepEqual(await rows(db), []);
});

test("EXACT_OUTPUT to an INTENTS recipient: quote request, stored row and view", async () => {
  const db = createTestDb();
  const f = fakes();
  const out = await quoteTransfer(deps(db, f), NEAR_USER, billReq({ slippageBps: 50 }));
  const r = f.calls.quote[0];
  assert.equal(r.swapType, "EXACT_OUTPUT");
  assert.equal(r.recipientType, "INTENTS");
  assert.equal(r.recipient, VENDOR);
  assert.equal(r.depositType, "INTENTS");
  assert.equal(r.refundType, "INTENTS");
  assert.equal(r.refundTo, NEAR_USER.account);
  assert.equal(r.amount, "1000000");
  assert.equal(r.slippageTolerance, 50);
  assert.equal(r.dry, false);
  const [row] = await rows(db);
  assert.equal(row.kind, "bill");
  assert.equal(row.amount, "1010000"); // what the intent transfers: the quote's amountIn
  assert.equal(row.reference, "INV-7");
  assert.equal(row.bill_id, "bill-1");
  assert.equal(row.batch_id, null);
  assert.equal(row.status, "AWAITING_SIGNATURE");
  const v = out.transfer;
  assert.equal(v.kind, "bill");
  assert.equal(v.swapType, "EXACT_OUTPUT");
  assert.equal(v.recipientType, "INTENTS");
  assert.equal(v.reference, "INV-7");
  assert.equal(v.billId, "bill-1");
  assert.equal(v.batchId, undefined);
  assert.equal(v.amount, "1010000");
  assert.equal(v.amountOut, "1000000");
  assert.equal(v.amountOutFormatted, "1");
  assert.deepEqual(out.withdrawal, out.transfer);
});

test("EXACT_INPUT keeps the Plan 1 checks: quote must echo the amount", async () => {
  const f = fakes({ quote: () => ({ amountIn: "999999" }) });
  await assert.rejects(quoteTransfer(deps(createTestDb(), f), NEAR_USER, swapReq()), { status: 502 });
  const g = fakes({ balance: "1000000" });
  await assert.rejects(quoteTransfer(deps(createTestDb(), g), NEAR_USER, swapReq({ amount: "1000001" })), { status: 400, message: "Amount exceeds your balance" });
  assert.equal(g.calls.quote.length, 0);
});

test("INTENTS recipient must be a NEAR account id or a lowercase 0x address", async () => {
  for (const bad of ["Bad Account", "0x1111111111111111111111111111111111111ABC", "0x0000000000000000000000000000000000000000", "a", "-x.near", "x".repeat(65)]) {
    const f = fakes();
    await assert.rejects(quoteTransfer(deps(createTestDb(), f), NEAR_USER, billReq({ recipient: bad })), { status: 400 }, bad);
    assert.equal(f.calls.quote.length, 0, bad);
  }
  for (const ok of ["vendor.near", "0x2222222222222222222222222222222222222abc", "a".repeat(64), "pay_me-1.tg"]) {
    await quoteTransfer(deps(createTestDb(), fakes()), NEAR_USER, billReq({ recipient: ok }));
  }
});

test("DESTINATION_CHAIN recipient is validated for the destination chain", async () => {
  const f = fakes();
  const req = billReq({ destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: "vendor.near" });
  await assert.rejects(quoteTransfer(deps(createTestDb(), f), NEAR_USER, req), { status: 400 });
  assert.equal(f.calls.quote.length, 0);
  await quoteTransfer(deps(createTestDb(), fakes()), NEAR_USER, { ...req, recipient: "0x2222222222222222222222222222222222222222" });
});

test("slippageBps allows 50, 100 (default) and 300 only; kind, swapType and recipientType are checked", async () => {
  for (const s of [50, 100, 300] as const) {
    const f = fakes();
    await quoteTransfer(deps(createTestDb(), f), NEAR_USER, swapReq({ slippageBps: s }));
    assert.equal(f.calls.quote[0].slippageTolerance, s);
  }
  const d = fakes();
  await quoteTransfer(deps(createTestDb(), d), NEAR_USER, swapReq());
  assert.equal(d.calls.quote[0].slippageTolerance, 100);
  const bad: Record<string, unknown>[] = [{ slippageBps: 200 }, { slippageBps: "100" }, { slippageBps: 0 }, { kind: "gift" }, { swapType: "FLEX_INPUT" }, { recipientType: "ORIGIN_CHAIN" }, { reference: "x".repeat(201) }, { billId: 5 }];
  for (const over of bad) {
    const f = fakes();
    await assert.rejects(quoteTransfer(deps(createTestDb(), f), NEAR_USER, swapReq(over as Partial<TransferRequest>)), { status: 400 }, JSON.stringify(over));
    assert.equal(f.calls.quote.length, 0);
  }
});

test("prepareTransfer validates and stores a quote the caller already obtained", async () => {
  const db = createTestDb();
  const f = fakes();
  const req = billReq({ kind: "payroll", batchId: "batch-1", billId: undefined, reference: "Oct salary" });
  const q = await f.oneclick.quote({ swapType: "EXACT_OUTPUT", amount: req.amount } as QuoteRequest);
  const out = await prepareTransfer(deps(db, f), EVM_USER, req, q);
  assert.equal(out.depositAddress, q.depositAddress);
  assert.equal(out.intent.standard, "erc191");
  const [row] = await rows(db);
  assert.equal(row.kind, "payroll");
  assert.equal(row.batch_id, "batch-1");
  assert.equal(out.transfer.batchId, "batch-1");
  // A quote that does not satisfy the request is refused the same way.
  await assert.rejects(prepareTransfer(deps(db, f), EVM_USER, { ...req, amount: "2000000" }, { ...q, depositAddress: nextDep() }), { status: 502 });
});

test("submit and refresh work for any kind (swap)", async () => {
  const db = createTestDb();
  const f = fakes({ status: async () => ({ status: "SUCCESS", updatedAt: "t", originTxHashes: [], destinationTxHashes: ["h1"] }) });
  const qt = await quoteTransfer(deps(db, f), NEAR_USER, swapReq());
  const v = await submitTransfer(deps(db, f), NEAR_USER, { depositAddress: qt.depositAddress, signedData: { standard: "nep413", payload: qt.intent.payload, ...NEP_SIG } });
  assert.equal(v.status, "PROCESSING");
  assert.equal(v.kind, "swap");
  assert.equal(f.calls.submit.length, 1);
  const later = new Date(NOW.getTime() + 10_000);
  const r = await refreshTransfer(deps(db, f, later), NEAR_USER, qt.depositAddress);
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.kind, "swap");
  // Tampered payload is still refused for a non-withdraw kind.
  const q2 = await quoteTransfer(deps(db, f), NEAR_USER, swapReq());
  const tampered = { ...(q2.intent.payload as Record<string, unknown>), nonce: Buffer.alloc(32, 8).toString("base64") };
  await assert.rejects(submitTransfer(deps(db, f), NEAR_USER, { depositAddress: q2.depositAddress, signedData: { standard: "nep413", payload: tampered, ...NEP_SIG } }), { status: 403 });
});

async function submitted(db: Db, f: ReturnType<typeof fakes>, req: TransferRequest) {
  const qt = await quoteTransfer(deps(db, f), NEAR_USER, req);
  await submitTransfer(deps(db, f), NEAR_USER, { depositAddress: qt.depositAddress, signedData: { standard: "nep413", payload: qt.intent.payload, ...NEP_SIG } });
  return qt.depositAddress;
}

test("listTransfers filters by kind; listWithdrawals shows only withdrawals; unknown kind is 400", async () => {
  const db = createTestDb();
  const f = fakes();
  const swap = await submitted(db, f, swapReq());
  const bill = await submitted(db, f, billReq());
  const wd = await quoteWithdrawal(deps(db, f), NEAR_USER, { originAsset: USDC, amount: "1000", destinationAsset: ARB_USDC, recipient: "0x2222222222222222222222222222222222222222" });
  await submitTransfer(deps(db, f), NEAR_USER, { depositAddress: wd.depositAddress, signedData: { standard: "nep413", payload: wd.intent.payload, ...NEP_SIG } });
  assert.deepEqual((await listTransfers(deps(db, f), NEAR_USER, "swap")).map((x) => x.depositAddress), [swap]);
  assert.deepEqual((await listTransfers(deps(db, f), NEAR_USER, "bill")).map((x) => x.depositAddress), [bill]);
  assert.deepEqual((await listWithdrawals(deps(db, f), NEAR_USER)).map((x) => x.depositAddress), [wd.depositAddress]);
  assert.equal((await listTransfers(deps(db, f), NEAR_USER)).length, 3);
  assert.equal(wd.withdrawal.kind, "withdraw");
  assert.equal(wd.withdrawal.swapType, "EXACT_INPUT");
  assert.equal(wd.withdrawal.recipientType, "DESTINATION_CHAIN");
  await assert.rejects(listTransfers(deps(db, f), NEAR_USER, "gift" as never), { status: 400 });
});

test("balances include the destination asset of the owner's swaps (and not of other kinds)", async () => {
  const db = createTestDb();
  const f = fakes();
  await submitted(db, f, swapReq());
  await submitted(db, f, billReq({ destinationAsset: USDT }));
  f.calls.rpcTokenIds.length = 0;
  const out = await getBalances({ db, rpc: f.rpc, oneclick: f.oneclick }, NEAR_USER.account);
  const ids = f.calls.rpcTokenIds[0];
  assert.ok(ids.includes(WNEAR));
  assert.equal(out.find((b) => b.tokenId === WNEAR)?.amount, "7");
  // Another owner's swap does not add tokens.
  f.calls.rpcTokenIds.length = 0;
  await getBalances({ db, rpc: f.rpc, oneclick: f.oneclick }, "bob.near");
  assert.ok(!f.calls.rpcTokenIds[0].includes(WNEAR));
});

test("migration 0003: kind defaults to withdraw and rejects unknown kinds", async () => {
  const db = createTestDb();
  const ins = "INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at) VALUES (?, 'o', 'a', 'b', '1', 'r', 'FAILED', 't', 't')";
  await db.prepare(ins).bind("d1").run();
  const r = await db.prepare("SELECT kind, reference, batch_id, bill_id FROM withdrawals WHERE deposit_address = 'd1'").bind().first<Record<string, unknown>>();
  assert.deepEqual({ ...r }, { kind: "withdraw", reference: null, batch_id: null, bill_id: null });
  await assert.rejects(db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at, kind) VALUES ('d2', 'o', 'a', 'b', '1', 'r', 'FAILED', 't', 't', 'gift')").bind().run());
});

test("GET /api/transfers?kind= lists by kind and rejects an unknown kind", async () => {
  const SECRET = "s".repeat(32);
  const env: Env = { DB: createTestDb(), SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.test/", ONECLICK_BASE_URL: "https://oneclick.test" };
  const f = fakes();
  const swap = await submitted(env.DB, f, swapReq());
  await submitted(env.DB, f, billReq());
  const cookie = `mx_session=${await signSession(NEAR_USER.account, "near", SECRET)}`;
  const call = (qs: string) =>
    transfersGet({ request: new Request(`https://app.test/api/transfers${qs}`, { headers: { cookie } }), env, params: {} } as unknown as Parameters<PagesFunction<Env>>[0]);
  const res = await call("?kind=swap");
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(((await res.json()) as { depositAddress: string }[]).map((x) => x.depositAddress), [swap]);
  assert.equal(((await (await call("")).json()) as unknown[]).length, 2);
  assert.equal((await call("?kind=gift")).status, 400);
});
