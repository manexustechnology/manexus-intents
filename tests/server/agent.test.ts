import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken } from "../../server/oneclick.ts";
import type { Balance } from "../../server/balances.ts";
import type { BillRow } from "../../server/bills.ts";
import type { InvoiceRow } from "../../shared/invoice.ts";
import type { Policy, WhitelistEntry } from "../../server/policy.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { dismissProposal, evaluate, listProposals, runAgent, type EvalInput } from "../../server/agent.ts";
import { onRequestGet as proposalsGet } from "../../functions/api/agent/proposals.ts";
import { onRequestPost as dismissPost } from "../../functions/api/agent/proposals/[id]/dismiss.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const WNEAR = "nep141:wrap.near";
const NOW = new Date("2030-01-10T12:00:00.000Z");
const ALICE = { account: "alice.near", kind: "near" as const };
const MALLORY = { account: "mallory.near", kind: "near" as const };
const WL: WhitelistEntry = { id: "w1", label: "Cold", destinationAsset: USDC, recipientType: "INTENTS", recipient: "cold.near", createdAt: "t" };
const bal = (tokenId: string, amount: string, usd?: string): Balance => ({ tokenId, symbol: "X", blockchain: "near", decimals: 6, amount, formatted: amount, ...(usd ? { usd } : {}) });
const bill = (id: string, dueDate: string, status: BillRow["status"] = "scheduled"): BillRow => ({
  id, owner: "alice.near", vendor: "V", reference: "R", dueDate, destinationAsset: USDC, recipientType: "INTENTS", recipient: "v.near", amount: "1", source: "manual", status, createdAt: "t", updatedAt: "t",
});
const inv = (id: string, dueDate: string, status: InvoiceRow["status"] = "issued"): InvoiceRow => ({
  id, publicId: `pub${id}`, owner: "alice.near", status, tokenId: USDC, total: "1", revision: 1, createdAt: "t", updatedAt: "t",
  data: { number: "1", client: "C", issuer: "I", dueDate, tokenId: USDC, notes: "", items: [] },
});
const input = (p: Partial<EvalInput> & { policy: Policy }): EvalInput => ({ now: NOW, balances: [], bills: [], invoices: [], whitelist: [WL], ...p });
const P = (p: Omit<Policy, "version">): Policy => ({ version: 1, ...p });

// --- evaluate ---

test("convert: usd cents threshold, target excluded, no price never proposed, deterministic", () => {
  const policy = P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 1000 } });
  const balances = [bal(USDC, "50000000", "50.00"), bal(USDT, "9990000", "9.99"), bal(WNEAR, "10000000000000000000000000", "10.00"), bal("nep141:nopx.near", "5")];
  const out = evaluate(input({ policy, balances }));
  assert.deepEqual(out.map((d) => [d.type, d.dedupKey, d.params]), [
    ["convert", `convert:${WNEAR}`, { originAsset: WNEAR, destinationAsset: USDC, amount: "10000000000000000000000000" }],
  ]);
  assert.equal(out[0].expiresAt, "2030-01-10T13:00:00.000Z");
  assert.deepEqual(evaluate(input({ policy, balances })), out);
  assert.deepEqual(evaluate(input({ policy: P({ convert: { enabled: false, targetTokenId: USDC, minUsdCents: 0 } }), balances })), []);
});

test("convert: usd parsed as integer cents, so huge values compare exactly", () => {
  const policy = P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100_000_000_000 } });
  assert.equal(evaluate(input({ policy, balances: [bal(USDT, "1", "999999999.99")] })).length, 0);
  assert.equal(evaluate(input({ policy, balances: [bal(USDT, "1", "1000000000.00")] })).length, 1);
});

test("sweep: above threshold sends balance minus keep to the whitelisted entry; at threshold does nothing", () => {
  const policy = P({ sweep: { enabled: true, tokenId: USDC, thresholdUnits: "100", keepUnits: "30", whitelistId: "w1" } });
  assert.deepEqual(evaluate(input({ policy, balances: [bal(USDC, "100")] })), []);
  const out = evaluate(input({ policy, balances: [bal(USDC, "101")] }));
  assert.deepEqual(out.map((d) => [d.type, d.dedupKey, d.params]), [["sweep", "sweep:" + USDC + ":w1", { originAsset: USDC, amount: "71", whitelistId: "w1" }]]);
  assert.deepEqual(evaluate(input({ policy, balances: [bal(USDC, "101")], whitelist: [] })), []);
});

test("pay_bill: due within billDueDays or overdue; later, paid and cancelled are not", () => {
  const policy = P({ reminders: { billDueDays: 3, invoiceOverdueDays: 7 } });
  const bills = [bill("a", "2030-01-13"), bill("b", "2030-01-14"), bill("c", "2029-12-01"), bill("d", "2030-01-10", "paid"), bill("e", "bad")];
  const out = evaluate(input({ policy, bills }));
  assert.deepEqual(out.map((d) => d.dedupKey), ["bill:c", "bill:a"]); // oldest due first
  assert.equal(out[1].expiresAt, "2030-01-14T00:00:00.000Z");
  assert.equal(out[0].expiresAt, "2030-01-10T13:00:00.000Z"); // long overdue: not created already expired
});

test("follow_up_invoice: overdue by at least invoiceOverdueDays (UTC), expires in 7 days", () => {
  const policy = P({ reminders: { billDueDays: 3, invoiceOverdueDays: 7 } });
  const invoices = [inv("a", "2030-01-03"), inv("b", "2030-01-04"), inv("c", "2029-01-01", "paid")];
  const out = evaluate(input({ policy, invoices }));
  assert.deepEqual(out.map((d) => [d.dedupKey, d.params]), [["invoice:a", { invoiceId: "a", publicId: "puba" }]]);
  assert.equal(out[0].expiresAt, "2030-01-17T12:00:00.000Z");
  // 0 days still means strictly overdue.
  const z = evaluate(input({ policy: P({ reminders: { billDueDays: 0, invoiceOverdueDays: 0 } }), invoices: [inv("t", "2030-01-10"), inv("y", "2030-01-09")] }));
  assert.deepEqual(z.map((d) => d.dedupKey), ["invoice:y"]);
});

// --- runAgent ---

type World = { balances: Record<string, string>; fail?: boolean };
function setup(w: World = { balances: {} }) {
  const db = createTestDb();
  const tokens: OneClickToken[] = [
    { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
    { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, price: 1 },
    { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 6, price: 2 },
  ];
  for (let i = 0; i < 20; i++) tokens.push({ assetId: `nep141:t${i}.near`, symbol: `T${i}`, blockchain: "near", decimals: 6, price: 1 });
  const rpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, _m: string, a: { token_ids: string[] }) => {
      if (w.fail) throw new Error("down");
      return a.token_ids.map((t) => w.balances[t] ?? "0");
    }) as NearRpc["viewFunction"],
  } as NearRpc;
  const deps = (now = NOW) => ({ db, rpc, oneclick: { tokens: async () => tokens }, now });
  return { db, w, deps };
}
async function setPolicy(db: Db, owner: string, p: Policy) {
  await db.prepare("INSERT OR REPLACE INTO agent_policies (owner, policy, hash, updated_at) VALUES (?, ?, 'h', 't')").bind(owner, JSON.stringify(p)).run();
}
const insBill = (db: Db, id: string, owner: string, due: string, status = "scheduled") =>
  db.prepare("INSERT INTO bills (id, owner, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, status, created_at, updated_at) VALUES (?, ?, 'V', 'R', ?, ?, 'INTENTS', 'v.near', '1', 'manual', ?, 't', 't')").bind(id, owner, due, USDC, status).run();
const at = (ms: number) => new Date(NOW.getTime() + ms);

test("no policy: no proposals, no balances lookup", async () => {
  const { db, deps } = setup({ balances: { [USDT]: "50000000" } });
  assert.deepEqual(await runAgent(deps(), ALICE), []);
  assert.equal(await listProposals(db, ALICE).then((l) => l.length), 0);
});

test("dedup across runs; param change expires the old proposal and proposes the new one; paid bill expires", async () => {
  const { db, w, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 }, reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }));
  await insBill(db, "b1", ALICE.account, "2030-01-11");
  const first = await runAgent(deps(), ALICE);
  assert.deepEqual(first.map((p) => p.dedupKey).sort(), [`bill:b1`, `convert:${USDT}`]);
  const again = await runAgent(deps(at(120_000)), ALICE);
  assert.deepEqual(again.map((p) => p.id).sort(), first.map((p) => p.id).sort());
  const all = async () => (await db.prepare("SELECT dedup_key, status, params FROM agent_proposals ORDER BY created_at, status").bind().all<{ dedup_key: string; status: string; params: string }>()).results;
  assert.equal((await all()).length, 2);

  w.balances[USDT] = "60000000";
  const changed = await runAgent(deps(at(240_000)), ALICE);
  const conv = changed.find((p) => p.type === "convert")!;
  assert.equal(conv.params.amount, "60000000");
  assert.notEqual(conv.id, first.find((p) => p.type === "convert")!.id);
  const st = (await all()).filter((r) => r.dedup_key === `convert:${USDT}`).map((r) => r.status).sort();
  assert.deepEqual(st, ["expired", "proposed"]);

  await db.prepare("UPDATE bills SET status = 'paid' WHERE id = 'b1'").bind().run();
  const after = await runAgent(deps(at(360_000)), ALICE);
  assert.deepEqual(after.map((p) => p.type), ["convert"]);
  assert.equal((await all()).find((r) => r.dedup_key === "bill:b1")!.status, "expired");
});

test("time expiry: a proposal past expires_at is expired and re-proposed fresh", async () => {
  const { db, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  const a = (await runAgent(deps(), ALICE))[0];
  const b = (await runAgent(deps(at(2 * 3_600_000)), ALICE))[0];
  assert.notEqual(a.id, b.id);
  assert.equal((await db.prepare("SELECT status FROM agent_proposals WHERE id = ?").bind(a.id).first<{ status: string }>())!.status, "expired");
});

test("sweep: removing the whitelist entry expires open sweep proposals and drafts none", async () => {
  const { db, deps } = setup({ balances: { [USDC]: "500" } });
  await db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w1', ?, 'Cold', ?, 'INTENTS', 'cold.near', 't')").bind(ALICE.account, USDC).run();
  await setPolicy(db, ALICE.account, P({ sweep: { enabled: true, tokenId: USDC, thresholdUnits: "100", keepUnits: "10", whitelistId: "w1" } }));
  const [p] = await runAgent(deps(), ALICE);
  assert.deepEqual(p.params, { originAsset: USDC, amount: "490", whitelistId: "w1" });
  await db.prepare("DELETE FROM whitelist WHERE id = 'w1'").bind().run();
  assert.deepEqual(await runAgent(deps(at(120_000)), ALICE), []);
});

test("throttle: a run within 60 s evaluates nothing unless force; dismissed draft stays dismissed", async () => {
  const { db, w, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  const [p] = await runAgent(deps(), ALICE);
  w.fail = true; // would 502 if evaluated
  assert.equal((await runAgent(deps(at(30_000)), ALICE)).length, 1);
  await assert.rejects(runAgent(deps(at(30_000)), ALICE, { force: true }), { status: 502 });
  const d = await dismissProposal(db, ALICE, p.id, at(40_000));
  assert.equal(d.status, "dismissed");
  w.fail = false;
  assert.deepEqual(await runAgent(deps(at(200_000)), ALICE), []);
  w.balances[USDT] = "70000000"; // basis changed: proposed again
  assert.equal((await runAgent(deps(at(400_000)), ALICE)).length, 1);
});

test("balances failure is 502 and writes nothing", async () => {
  const { db, deps } = setup({ balances: {}, fail: true });
  await setPolicy(db, ALICE.account, P({ reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }));
  await insBill(db, "b1", ALICE.account, "2030-01-11");
  await assert.rejects(runAgent(deps(), ALICE), { status: 502 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM agent_proposals").bind().first<{ n: number }>())!.n, 0);
});

test("owner scoping: proposals and dismiss are per owner", async () => {
  const { db, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  const [p] = await runAgent(deps(), ALICE);
  assert.deepEqual(await runAgent(deps(), MALLORY), []);
  assert.deepEqual(await listProposals(db, MALLORY), []);
  await assert.rejects(dismissProposal(db, MALLORY, p.id), { status: 404 });
  await dismissProposal(db, ALICE, p.id);
  await assert.rejects(dismissProposal(db, ALICE, p.id), { status: 409 });
  await assert.rejects(dismissProposal(db, ALICE, "../x"), { status: 404 });
});

test("query budget: 50 bills, 100 invoices, 20 balances", async () => {
  const { db, w, deps } = setup();
  for (let i = 0; i < 20; i++) {
    w.balances[`nep141:t${i}.near`] = "50000000";
    await db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at) VALUES (?, ?, ?, ?, '1', 'x', 'SUCCESS', 't', 't')").bind(`d${i}`, ALICE.account, `nep141:t${i}.near`, USDC).run();
  }
  for (let i = 0; i < 50; i++) await insBill(db, `b${i}`, ALICE.account, "2030-01-11");
  for (let i = 0; i < 100; i++)
    await db.prepare("INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at) VALUES (?, ?, ?, 'issued', ?, ?, '1', 1, 't', 't')").bind(`i${i}`, `p${i}`, ALICE.account, USDC, JSON.stringify({ number: "1", client: "C", issuer: "I", dueDate: "2029-12-01", tokenId: USDC, notes: "", items: [] })).run();
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 }, reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }));
  (db as TestDb).queries = 0;
  const out = await runAgent(deps(), ALICE);
  console.log(`runAgent 50 bills / 100 invoices / 20 balances: ${(db as TestDb).queries} queries, ${out.length} proposals`);
  assert.equal(out.length, 170);
  assert.ok((db as TestDb).queries <= 45);
  (db as TestDb).queries = 0;
  await runAgent(deps(at(120_000)), ALICE);
  assert.ok((db as TestDb).queries <= 45);
});

const insInv = (db: Db, id: string, due: string) =>
  db.prepare("INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at) VALUES (?, ?, ?, 'issued', ?, ?, '1', 1, 't', 't')").bind(id, `p${id}`, ALICE.account, USDC, JSON.stringify({ number: "1", client: "C", issuer: "I", dueDate: due, tokenId: USDC, notes: "", items: [] })).run();
const day = (k: number) => new Date(Date.UTC(2029, 0, 1) + k * 86_400_000).toISOString().slice(0, 10);

test("cap: 250 overdue invoices give at most 200 drafts, oldest due first; paid ones expire and the next refresh", async () => {
  const { db, deps } = setup();
  await setPolicy(db, ALICE.account, P({ reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }));
  for (let i = 0; i < 250; i++) await insInv(db, `i${String(i).padStart(3, "0")}`, day(i)); // i000 is the oldest
  const first = await runAgent(deps(), ALICE);
  assert.equal(first.length, 200);
  assert.deepEqual(first.map((p) => p.params.invoiceId).sort(), Array.from({ length: 200 }, (_, i) => `i${String(i).padStart(3, "0")}`));
  await db.prepare("UPDATE invoices SET status = 'paid' WHERE id < 'i050'").bind().run();
  const next = await runAgent(deps(at(120_000)), ALICE);
  assert.equal(next.length, 200);
  assert.deepEqual(next.map((p) => p.params.invoiceId).sort(), Array.from({ length: 200 }, (_, i) => `i${String(i + 50).padStart(3, "0")}`));
  const n = (st: string) => db.prepare("SELECT COUNT(*) AS n FROM agent_proposals WHERE status = ?").bind(st).first<{ n: number }>().then((r) => r!.n);
  assert.equal(await n("expired"), 50);
  assert.equal(await n("proposed"), 200);
});

test("dismissal: only the latest dismissed row per key blocks (X, Y, X again is proposed)", async () => {
  const { db, w, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  const dismissOne = async (ms: number) => { const [p] = await listProposals(db, ALICE); await dismissProposal(db, ALICE, p.id, at(ms)); };
  await runAgent(deps(), ALICE); await dismissOne(1_000);              // X dismissed
  w.balances[USDT] = "60000000";
  await runAgent(deps(at(100_000)), ALICE); await dismissOne(101_000); // Y dismissed
  w.balances[USDT] = "50000000";
  const back = await runAgent(deps(at(200_000)), ALICE);                // X again: latest dismissal is Y
  assert.equal(back.length, 1);
  assert.equal(back[0].params.amount, "50000000");
  await dismissOne(201_000);                                           // X dismissed latest
  assert.deepEqual(await runAgent(deps(at(300_000)), ALICE), []);
});

test("force: a forced run within 5 s of the last write is ignored; after 5 s it evaluates", async () => {
  const { db, w, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  await runAgent(deps(), ALICE);
  w.fail = true;
  assert.equal((await runAgent(deps(at(4_000)), ALICE, { force: true })).length, 1);
  await assert.rejects(runAgent(deps(at(5_000)), ALICE, { force: true }), { status: 502 });
});

test("query budget: worst-case first run (200 bills, 200 invoices, 20 balances) stays within 45", async () => {
  const { db, w, deps } = setup();
  for (let i = 0; i < 20; i++) {
    w.balances[`nep141:t${i}.near`] = "50000000";
    await db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at) VALUES (?, ?, ?, ?, '1', 'x', 'SUCCESS', 't', 't')").bind(`d${i}`, ALICE.account, `nep141:t${i}.near`, USDC).run();
  }
  for (let i = 0; i < 200; i++) { await insBill(db, `b${i}`, ALICE.account, day(i)); await insInv(db, `i${i}`, day(i)); }
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 }, reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }));
  (db as TestDb).queries = 0;
  const out = await runAgent(deps(), ALICE);
  console.log(`runAgent worst case first run: ${(db as TestDb).queries} queries, ${out.length} proposals`);
  assert.equal(out.length, 200);
  assert.ok((db as TestDb).queries <= 45);
});

// --- routes ---

test("routes: GET proposals and POST dismiss need a session and are owner scoped", async () => {
  const { db, deps } = setup({ balances: { [USDT]: "50000000" } });
  await setPolicy(db, ALICE.account, P({ convert: { enabled: true, targetTokenId: USDC, minUsdCents: 100 } }));
  const [p] = await runAgent({ ...deps(), now: new Date() }, ALICE);
  const SECRET = "s".repeat(32);
  const env = { DB: db, SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.invalid", ONECLICK_BASE_URL: "https://1click.invalid" } as unknown as Env;
  const url = "https://app.manexus.test/api/agent/proposals";
  assert.equal((await proposalsGet({ request: new Request(url), env } as never)).status, 401);
  assert.equal((await dismissPost({ request: new Request(`${url}/${p.id}/dismiss`, { method: "POST" }), env, params: { id: p.id } } as never)).status, 401);
  const mal = `mx_session=${await signSession(MALLORY.account, "near", SECRET)}`;
  const ali = `mx_session=${await signSession(ALICE.account, "near", SECRET)}`;
  assert.equal((await dismissPost({ request: new Request(`${url}/${p.id}/dismiss`, { method: "POST", headers: { cookie: mal } }), env, params: { id: p.id } } as never)).status, 404);
  const g = await proposalsGet({ request: new Request(url, { headers: { cookie: ali } }), env } as never);
  assert.equal(g.status, 200);
  assert.deepEqual(((await g.json()) as { id: string }[]).map((x) => x.id), [p.id]);
  assert.equal((await dismissPost({ request: new Request(`${url}/${p.id}/dismiss`, { method: "POST", headers: { cookie: ali } }), env, params: { id: p.id } } as never)).status, 200);
});

test("sweep: amount is clipped to the per-transaction cap for that token and marked as limited", () => {
  const sweep = { enabled: true, tokenId: USDC, thresholdUnits: "100", keepUnits: "30", whitelistId: "w1" };
  const capped = (cap: Record<string, string>) => evaluate(input({ policy: P({ sweep, limits: { perTx: cap, daily: {}, whitelistOnly: false } }), balances: [bal(USDC, "101")] }));
  assert.deepEqual(capped({ [USDC]: "50" }).map((d) => d.params), [{ originAsset: USDC, amount: "50", whitelistId: "w1", limitedByCap: "true" }]);
  // At or above the sweep amount, or a cap on another token: not limited.
  assert.deepEqual(capped({ [USDC]: "71" }).map((d) => d.params), [{ originAsset: USDC, amount: "71", whitelistId: "w1" }]);
  assert.deepEqual(capped({ [USDT]: "1" }).map((d) => d.params), [{ originAsset: USDC, amount: "71", whitelistId: "w1" }]);
});
