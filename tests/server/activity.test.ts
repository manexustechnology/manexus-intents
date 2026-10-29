import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import { listActivity, monthSummary } from "../../server/activity.ts";
import { signSession } from "../../server/session.ts";
import { onRequestGet } from "../../functions/api/activity.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const ALICE = { account: "alice.near", kind: "near" as const };
const SECRET = "s".repeat(32);
const NOW = new Date("2030-03-15T12:00:00.000Z");
const run = (db: Db, sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).run();

async function invoice(db: Db, id: string, owner: string, token: string, number: string) {
  await run(db, "INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at) VALUES (?,?,?,'issued',?,?,'1',1,'t','t')", id, `p${id}`, owner, token, JSON.stringify({ number }));
}
async function attempt(db: Db, dep: string, inv: string, outcome: string | null, amountOut: string | null, at: string) {
  await run(db, "INSERT INTO payment_attempts (deposit_address, invoice_id, origin_asset, amount_in, refund_to, deadline, status, outcome, amount_out, created_at, updated_at) VALUES (?,?,'a','1','r','d','SUCCESS',?,?,?,?)", dep, inv, outcome, amountOut, at, at);
}
async function transfer(db: Db, dep: string, owner: string, kind: string, status: string, origin: string, amount: string, at: string, dest = "SOL") {
  const intent = JSON.stringify({ standard: "nep413", payload: {}, deadline: "2031-01-01T00:00:00.000Z", meta: { originSymbol: origin === USDT ? "USDT" : "USDC", originDecimals: 6, destinationSymbol: "wNEAR", destinationBlockchain: dest, destinationDecimals: 24, amountOut: "5", minAmountOut: "4" } });
  await run(db, "INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, upstream, intent, created_at, updated_at, kind) VALUES (?,?,?,?,?,'r',?,'{}',?,?,?,?)", dep, owner, origin, "d", amount, status, intent, at, at, kind);
}

async function seeded() {
  const db = createTestDb();
  await invoice(db, "i1", "alice.near", USDC, "INV-1");
  await invoice(db, "i2", "bob.near", USDC, "BOB-1");
  await attempt(db, "a1", "i1", "paid", "2500000", "2030-03-10T00:00:00.000Z");
  await attempt(db, "a2", "i1", "duplicate", "1000000", "2030-03-12T00:00:00.000Z");
  await attempt(db, "a3", "i1", "refunded", "9", "2030-03-13T00:00:00.000Z");
  await attempt(db, "a4", "i1", null, null, "2030-03-14T00:00:00.000Z");
  await attempt(db, "a5", "i2", "paid", "7000000", "2030-03-11T00:00:00.000Z");
  await transfer(db, "t1", "alice.near", "withdraw", "SUCCESS", USDC, "400000", "2030-03-11T00:00:00.000Z");
  await transfer(db, "t2", "alice.near", "swap", "PROCESSING", USDT, "300000", "2030-03-13T12:00:00.000Z");
  await transfer(db, "t3", "bob.near", "withdraw", "SUCCESS", USDC, "999", "2030-03-11T00:00:00.000Z");
  return db;
}

test("activity merges invoice payments and transfers, newest first, owner-scoped", async () => {
  const items = await listActivity({ db: await seeded(), now: NOW }, ALICE);
  assert.deepEqual(items.map((i) => [i.type, i.title, i.amountFormatted, i.symbol, i.status, i.href]), [
    ["swap", "Swap USDT → wNEAR", "0.3", "USDT", "PROCESSING", "#/swap"],
    ["payment_received_extra", "Extra payment received · INV-1", "1", "USDC", "duplicate", "#/invoices/i1"],
    ["withdraw", "Withdrawal to SOL", "0.4", "USDC", "SUCCESS", "#/withdraw"],
    ["invoice_paid", "Payment received · INV-1", "2.5", "USDC", "paid", "#/invoices/i1"],
  ]);
  assert.ok(items.every((i, n) => n === 0 || items[n - 1].at >= i.at));
  assert.ok(!JSON.stringify(items).includes("BOB-1"));
});

test("after_cancel is shown as an extra payment, and limit is clamped", async () => {
  const db = await seeded();
  await attempt(db, "a6", "i1", "after_cancel", "1", "2030-03-14T00:00:00.000Z");
  const all = await listActivity({ db, now: NOW }, ALICE);
  assert.equal(all[0].type, "payment_received_extra");
  assert.equal((await listActivity({ db, now: NOW }, ALICE, 2)).length, 2);
  assert.equal((await listActivity({ db, now: NOW }, ALICE, 0)).length, 1);
  assert.equal((await listActivity({ db, now: NOW }, ALICE, 5000)).length, 5);
});

test("month summary sums bigint per token for the current UTC month only", async () => {
  const db = await seeded();
  await attempt(db, "old", "i1", "paid", "5000000", "2030-02-28T23:59:59.999Z");
  await attempt(db, "nxt", "i1", "paid", "5000000", "2030-04-01T00:00:00.000Z");
  await transfer(db, "t4", "alice.near", "bill", "SUCCESS", USDC, "100000", "2030-03-01T00:00:00.000Z");
  await transfer(db, "t5", "alice.near", "bill", "FAILED", USDC, "100000", "2030-03-02T00:00:00.000Z");
  await transfer(db, "t6", "alice.near", "payroll", "SUCCESS", USDC, "9007199254740993", "2030-03-02T00:00:00.000Z");
  const s = await monthSummary({ db, now: NOW }, ALICE);
  assert.equal(s.month, "2030-03");
  const usdc = s.tokens.find((t) => t.symbol === "USDC")!;
  assert.deepEqual([usdc.received, usdc.sent], ["3500000", "9007199255240993"]);
  assert.deepEqual([s.tokens.find((t) => t.symbol === "USDT")!.received, s.tokens.find((t) => t.symbol === "USDT")!.sent], ["0", "0"]);
});

test("GET /api/activity requires a session and serves feed and summary", async () => {
  const db = await seeded();
  const env = { DB: db, SESSION_SECRET: SECRET } as never;
  const anon = await onRequestGet({ request: new Request("https://x/api/activity"), env, params: {} } as never);
  assert.equal(anon.status, 401);
  const h = { headers: { cookie: `mx_session=${await signSession(ALICE.account, "near", SECRET)}` } };
  const feed = (await (await onRequestGet({ request: new Request("https://x/api/activity", h), env, params: {} } as never)).json()) as unknown[];
  assert.equal(feed.length, 4);
  const sum = (await (await onRequestGet({ request: new Request("https://x/api/activity?summary=month", h), env, params: {} } as never)).json()) as { tokens: unknown[] };
  assert.equal(sum.tokens.length, 2);
});
