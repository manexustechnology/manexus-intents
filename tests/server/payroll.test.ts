import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { createTestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";
import { submitTransfer, type TransferDeps } from "../../server/transfers.ts";
import {
  createBatch,
  createBatchFromBody,
  createPayee,
  deletePayee,
  getBatch,
  listBatches,
  listPayees,
  quoteBatchLine,
} from "../../server/payroll.ts";
import { listActivity } from "../../server/activity.ts";
import { handle, HttpError } from "../../server/http.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";
import { onRequestGet as batchesGet, onRequestPost as batchesPost } from "../../functions/api/payroll/batches/index.ts";
import { onRequestGet as payeesGet } from "../../functions/api/payroll/payees.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const WNEAR = "nep141:wrap.near";
const ALICE = { account: "alice.near", kind: "near" as const };
const MALLORY = { account: "mallory.near", kind: "near" as const };
const NOW = new Date("2030-01-01T00:00:00.000Z");
const NONCE = Buffer.alloc(32, 7).toString("base64");
const NEP_SIG = { public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) };
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const A3 = "0x3333333333333333333333333333333333333333";
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
];
const HEADER = "name,chain,token,address,amount";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const at = (min: number, sec = 0) => new Date(NOW.getTime() + min * 60_000 + sec * 1000);

let depCounter = 0;
const nextDep = () => (++depCounter).toString(16).padStart(64, "0");
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

function fakes(o: { balance?: string } = {}) {
  const calls = { quote: [] as QuoteRequest[] };
  const quotes = new Map<string, { q: Quote; r: QuoteRequest }>();
  const statuses = new Map<string, SwapStatus>();
  const rpc: NearRpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, _m: string, args: { token_ids?: string[] }) =>
      (args.token_ids ?? []).map((id) => (id === USDC ? (o.balance ?? "10000000") : "0"))) as NearRpc["viewFunction"],
  };
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      const amountIn = ((BigInt(r.amount) * 101n) / 100n).toString();
      const q: Quote = { depositAddress: nextDep(), amountIn, minAmountIn: amountIn, amountOut: r.amount, minAmountOut: r.amount, deadline: r.deadline };
      quotes.set(q.depositAddress, { q, r });
      return q;
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      const { q } = quotes.get(a.depositAddress)!;
      const list = [{ intent: "transfer", receiver_id: a.depositAddress, tokens: { [USDC]: q.amountIn } }];
      return { standard: a.standard, payload: { recipient: "intents.near", nonce: NONCE, message: JSON.stringify({ signer_id: a.signerId, deadline: q.deadline, intents: list }) } };
    },
    submitIntent: async () => ({ intentHash: "IntentHash111" }),
    status: async (dep: string): Promise<SwapStatus> => {
      const s = statuses.get(dep);
      if (!s) throw new Error("status not stubbed");
      return s;
    },
  };
  const settle = (dep: string, st: SwapStatus["status"]) =>
    statuses.set(dep, { status: st, updatedAt: "t", quoteRequest: quotes.get(dep)!.r, depositAddress: dep, originTxHashes: [], destinationTxHashes: [] });
  return { rpc, oneclick, calls, settle };
}
type F = ReturnType<typeof fakes>;
const deps = (db: Db, f: F, now = NOW): TransferDeps => ({ db, rpc: f.rpc, oneclick: f.oneclick, now });
const signed = (qt: { depositAddress: string; intent: { payload: unknown } }) => ({ depositAddress: qt.depositAddress, signedData: { standard: "nep413", payload: qt.intent.payload, ...NEP_SIG } });
const count = async (db: Db, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first<{ n: number }>())!.n;
const lineErrors = (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => ({ status: e.status, message: e.message, lineErrors: (e.extra as { lineErrors?: unknown })?.lineErrors }));

const fiveLines = csv(`Ana,arb,USDC,${A1},1`, `Budi,arb,USDC,${A2},1`, `Citra,arb,USDC,${A3},1`, "Dewi,near-intents,USDC,dewi.near,1", "Eko,near,USDC,eko.near,1");

// --- create ---

test("CSV batch: all-or-nothing; a single bad line creates nothing and reports per-line errors", async () => {
  const db = createTestDb();
  const f = fakes();
  const bad = await lineErrors(createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: csv(`Ana,arb,USDC,${A1},1`, `@evil,arb,USDC,${A2},1`, `Citra,arb,USDC,nope,1`) }));
  assert.equal(bad?.status, 400);
  assert.deepEqual((bad?.lineErrors as { line: number }[]).map((e) => e.line), [3, 4]);
  assert.equal(await count(db, "payroll_batches"), 0);
  assert.equal(await count(db, "payroll_lines"), 0);

  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: fiveLines });
  assert.equal(v.lines.length, 5);
  assert.deepEqual(v.lines.map((l) => [l.n, l.name, l.recipientType, l.amount]), [
    [1, "Ana", "DESTINATION_CHAIN", "1000000"], [2, "Budi", "DESTINATION_CHAIN", "1000000"], [3, "Citra", "DESTINATION_CHAIN", "1000000"],
    [4, "Dewi", "INTENTS", "1000000"], [5, "Eko", "DESTINATION_CHAIN", "1000000"],
  ]);
  assert.deepEqual(v.summary, { sent: 0, processing: 0, awaiting: 5, failed: 0, total: 5 });
  assert.equal(f.calls.quote.length, 0);
});

test("the server re-validates rows; client-parsed amounts are never trusted", async () => {
  const db = createTestDb();
  const f = fakes();
  // createBatch with hand-built rows still checks every field.
  const r = await lineErrors(
    createBatch(deps(db, f), ALICE, {
      title: "Oct", originAsset: USDC,
      rows: [
        { line: 1, name: "Ana", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: A1, amount: "1.5" },
        { line: 2, name: "Own", destinationAsset: USDC, recipientType: "INTENTS", recipient: ALICE.account, amount: "1" },
        { line: 3, name: "Tok", destinationAsset: "nep141:unknown", recipientType: "DESTINATION_CHAIN", recipient: A2, amount: "1" },
      ],
    }),
  );
  assert.equal(r?.status, 400);
  assert.deepEqual((r?.lineErrors as { line: number }[]).map((e) => e.line), [1, 2, 3]);
  // An unknown body shape is refused.
  assert.equal(await status(createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, rows: [] })), 400);
  assert.equal(await status(createBatchFromBody(deps(db, f), ALICE, { title: "", originAsset: USDC, csv: fiveLines })), 400);
  assert.equal(await count(db, "payroll_batches"), 0);
});

test("same-token lines summing over the balance → 400 Batch exceeds your balance; cross-token lines wait for the quote", async () => {
  const db = createTestDb();
  const f = fakes({ balance: "2000000" });
  const over = csv("Ana,near,USDC,ana.near,1.5", "Budi,near-intents,USDC,budi.near,0.6");
  const e = await lineErrors(createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: over }));
  assert.deepEqual([e?.status, e?.message], [400, "Batch exceeds your balance"]);
  assert.equal(await count(db, "payroll_batches"), 0);
  // Exactly the balance in the same token, plus a cross-token line over it: accepted now, checked per line at quote time.
  const ok = csv("Ana,near,USDC,ana.near,1.5", "Budi,near-intents,USDC,budi.near,0.5", `Citra,arb,USDC,${A1},50`);
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: ok });
  assert.equal(v.lines.length, 3);
  assert.equal(await status(quoteBatchLine(deps(db, f), ALICE, v.batch.id, 3)), 400);
  // A token the owner does not hold is refused.
  assert.equal(await status(createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: WNEAR, csv: ok })), 400);
});

// --- saved payees ---

test("payees are owner-scoped, validated, capped at 500, and only the owner can delete them", async () => {
  const db = createTestDb();
  const f = fakes();
  const p = await createPayee(deps(db, f), ALICE, { name: "Ana", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: A1 });
  assert.equal(p.name, "Ana");
  for (const bad of [
    { name: "=1", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: A1 },
    { name: "X", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: "ana.near" },
    { name: "X", destinationAsset: USDC, recipientType: "INTENTS", recipient: ALICE.account },
    { name: "X", destinationAsset: "nep141:nope", recipientType: "DESTINATION_CHAIN", recipient: A1 },
  ])
    assert.equal(await status(createPayee(deps(db, f), ALICE, bad)), 400, JSON.stringify(bad));
  assert.deepEqual((await listPayees(deps(db, f), ALICE)).map((x) => x.id), [p.id]);
  assert.deepEqual(await listPayees(deps(db, f), MALLORY), []);
  assert.equal(await status(deletePayee(db, MALLORY, p.id)), 404);
  assert.equal((await listPayees(deps(db, f), ALICE)).length, 1);
  await deletePayee(db, ALICE, p.id);
  assert.equal((await listPayees(deps(db, f), ALICE)).length, 0);

  for (let i = 0; i < 500; i++)
    await db.prepare("INSERT INTO payees (id, owner, name, destination_asset, recipient_type, recipient, created_at) VALUES (?, ?, 'P', ?, 'INTENTS', 'p.near', ?)").bind(`p${i}`, ALICE.account, USDC, NOW.toISOString()).run();
  assert.equal(await status(createPayee(deps(db, f), ALICE, { name: "One more", destinationAsset: USDC, recipientType: "INTENTS", recipient: "x.near" })), 429);
});

test("batch from saved payees: amounts in the payee token's decimals; someone else's payee is a line error", async () => {
  const db = createTestDb();
  const f = fakes();
  const ana = await createPayee(deps(db, f), ALICE, { name: "Ana", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: A1 });
  const dewi = await createPayee(deps(db, f), ALICE, { name: "Dewi", destinationAsset: USDC, recipientType: "INTENTS", recipient: "dewi.near" });
  const theirs = await createPayee(deps(db, f), MALLORY, { name: "M", destinationAsset: USDC, recipientType: "INTENTS", recipient: "m2.near" });
  const e = await lineErrors(createBatchFromBody(deps(db, f), ALICE, { title: "Nov", originAsset: USDC, payeeIds: [ana.id, theirs.id], amounts: ["1", "1"] }));
  assert.deepEqual([e?.status, (e?.lineErrors as { line: number }[]).map((x) => x.line)], [400, [2]]);
  const e2 = await lineErrors(createBatchFromBody(deps(db, f), ALICE, { title: "Nov", originAsset: USDC, payeeIds: [ana.id], amounts: ["1.0000001"] }));
  assert.deepEqual((e2?.lineErrors as { line: number }[]).map((x) => x.line), [1]);
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Nov", originAsset: USDC, payeeIds: [ana.id, dewi.id], amounts: ["2.5", "0.1"] });
  assert.deepEqual(v.lines.map((l) => [l.name, l.destinationAsset, l.recipientType, l.recipient, l.amount]), [
    ["Ana", ARB_USDC, "DESTINATION_CHAIN", A1, "2500000"], ["Dewi", USDC, "INTENTS", "dewi.near", "100000"],
  ]);
});

// --- quote and re-quote ---

test("line quote: EXACT_OUTPUT payroll transfer with batch id and '<title> · <name>' reference", async () => {
  const db = createTestDb();
  const f = fakes();
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: fiveLines });
  const qt = await quoteBatchLine(deps(db, f), ALICE, v.batch.id, 4);
  const r = f.calls.quote[0];
  assert.deepEqual([r.swapType, r.amount, r.destinationAsset, r.recipientType, r.recipient, r.originAsset], ["EXACT_OUTPUT", "1000000", USDC, "INTENTS", "dewi.near", USDC]);
  assert.deepEqual([qt.transfer.kind, qt.transfer.batchId, qt.transfer.reference], ["payroll", v.batch.id, "Oct · Dewi"]);
  const b = await getBatch(deps(db, f), ALICE, v.batch.id);
  assert.equal(b.lines[3].depositAddress, qt.depositAddress);
  assert.equal(b.lines[3].state, "awaiting");
  assert.deepEqual(b.lines[3].pendingQuote?.intent, qt.intent);
  // Activity links to the batch once submitted.
  await submitTransfer(deps(db, f), ALICE, signed(qt));
  const items = await listActivity({ db, now: NOW }, ALICE);
  assert.deepEqual(items.map((i) => i.href), [`#/payroll/${v.batch.id}`]);
});

test("re-quote rules: never after SUCCESS/PROCESSING or an open quote; allowed after FAILED, REFUNDED or an expired unsigned quote", async () => {
  const db = createTestDb();
  const f = fakes();
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: fiveLines });
  const id = v.batch.id;
  const err = (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => [e.status, e.message]);

  const q1 = await quoteBatchLine(deps(db, f), ALICE, id, 1);
  assert.deepEqual(await err(quoteBatchLine(deps(db, f, at(1)), ALICE, id, 1)), [409, "Already sent"]); // open, unsigned
  await submitTransfer(deps(db, f, at(1)), ALICE, signed(q1));
  assert.deepEqual(await err(quoteBatchLine(deps(db, f, at(2)), ALICE, id, 1)), [409, "Already sent"]); // processing
  f.settle(q1.depositAddress, "SUCCESS");
  assert.deepEqual(await err(quoteBatchLine(deps(db, f, at(3)), ALICE, id, 1)), [409, "Already sent"]); // sent

  for (const [n, end] of [[2, "FAILED"], [3, "REFUNDED"]] as const) {
    const q = await quoteBatchLine(deps(db, f, at(3)), ALICE, id, n);
    await submitTransfer(deps(db, f, at(3)), ALICE, signed(q));
    f.settle(q.depositAddress, end);
    const again = await quoteBatchLine(deps(db, f, at(4)), ALICE, id, n);
    assert.notEqual(again.depositAddress, q.depositAddress);
    assert.equal((await getBatch(deps(db, f, at(4, 10)), ALICE, id)).lines[n - 1].depositAddress, again.depositAddress);
  }

  // Expired, never relayed: can be re-quoted.
  const q4 = await quoteBatchLine(deps(db, f, at(4)), ALICE, id, 4);
  const q4b = await quoteBatchLine(deps(db, f, at(15)), ALICE, id, 4);
  assert.notEqual(q4b.depositAddress, q4.depositAddress);

  // Expired after a failed relay: only once 1Click was consulted past the grace period.
  const q5 = await quoteBatchLine(deps(db, f, at(15)), ALICE, id, 5);
  f.oneclick.submitIntent = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(submitTransfer(deps(db, f, at(15)), ALICE, signed(q5)));
  f.settle(q5.depositAddress, "PENDING_DEPOSIT");
  assert.deepEqual(await err(quoteBatchLine(deps(db, f, at(25, 30)), ALICE, id, 5)), [409, "Already sent"]); // past deadline, inside grace
  const real = f.oneclick.status;
  f.oneclick.status = async () => {
    throw new Error("down");
  };
  assert.deepEqual(await err(quoteBatchLine(deps(db, f, at(28)), ALICE, id, 5)), [409, "Already sent"]); // 1Click unreachable
  f.oneclick.status = real;
  const q5b = await quoteBatchLine(deps(db, f, at(29)), ALICE, id, 5);
  assert.notEqual(q5b.depositAddress, q5.depositAddress);
  assert.equal(await status(quoteBatchLine(deps(db, f), ALICE, id, 6)), 404);
  assert.equal(await status(quoteBatchLine(deps(db, f), ALICE, id, 0)), 404);
});

test("partial failure: summary is derived per line (3/5 sent, 1 failed, 1 awaiting) and sent lines stay sent", async () => {
  const db = createTestDb();
  const f = fakes();
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: fiveLines });
  const id = v.batch.id;
  for (const n of [1, 2, 3, 4]) {
    const q = await quoteBatchLine(deps(db, f), ALICE, id, n);
    await submitTransfer(deps(db, f), ALICE, signed(q));
    f.settle(q.depositAddress, n === 4 ? "REFUNDED" : "SUCCESS");
  }
  await quoteBatchLine(deps(db, f), ALICE, id, 5); // quoted, left unsigned
  const b = await getBatch(deps(db, f, at(1)), ALICE, id);
  assert.deepEqual(b.summary, { sent: 3, processing: 0, awaiting: 1, failed: 1, total: 5 });
  assert.deepEqual(b.lines.map((l) => [l.state, l.canQuote]), [["sent", false], ["sent", false], ["sent", false], ["refunded", true], ["awaiting", false]]);
  const [row] = await listBatches(deps(db, f), ALICE);
  assert.deepEqual([row.id, row.title, row.total, row.sent], [id, "Oct", 5, 3]);
});

test("cross-tenant: another owner's batch is 404 everywhere", async () => {
  const db = createTestDb();
  const f = fakes();
  const v = await createBatchFromBody(deps(db, f), ALICE, { title: "Oct", originAsset: USDC, csv: fiveLines });
  assert.equal(await status(getBatch(deps(db, f), MALLORY, v.batch.id)), 404);
  assert.equal(await status(quoteBatchLine(deps(db, f), MALLORY, v.batch.id, 1)), 404);
  assert.deepEqual(await listBatches(deps(db, f), MALLORY), []);
  assert.equal(f.calls.quote.length, 0);
  assert.equal(await status(getBatch(deps(db, f), ALICE, "nope")), 404);
});

test("line errors travel in the error body; payroll routes require a session", async () => {
  const res = await handle(async () => {
    throw new HttpError(400, "Fix the highlighted lines.", { lineErrors: [{ line: 2, message: "x" }] });
  });
  assert.deepEqual([res.status, await res.json()], [400, { error: "Fix the highlighted lines.", lineErrors: [{ line: 2, message: "x" }] }]);
  const db = createTestDb();
  const SECRET = "s".repeat(32);
  const env = { DB: db, SESSION_SECRET: SECRET } as unknown as Env;
  const url = "https://app.manexus.test/api/payroll/batches";
  assert.equal((await batchesGet({ request: new Request(url), env } as never)).status, 401);
  assert.equal((await batchesPost({ request: new Request(url, { method: "POST", body: "{}" }), env } as never)).status, 401);
  assert.equal((await payeesGet({ request: new Request("https://app.manexus.test/api/payroll/payees"), env } as never)).status, 401);
  const cookie = `mx_session=${await signSession(ALICE.account, "near", SECRET)}`;
  const list = await batchesGet({ request: new Request(url, { headers: { cookie } }), env } as never);
  assert.deepEqual([list.status, await list.json()], [200, []]);
});
