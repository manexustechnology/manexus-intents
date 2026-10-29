import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import { createInvoice } from "../../server/invoices.ts";
import { getBalances } from "../../server/balances.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken } from "../../server/oneclick.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const NOW = "2030-01-01T00:00:00.000Z";
const draft: InvoiceDraft = { number: "D-1", client: "C", issuer: "I", dueDate: "2030-01-31", tokenId: USDC, notes: "", items: [{ description: "x", quantity: "1", unitPrice: "1" }] };
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1.0001 },
  { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6 },
];
function rpcWith(reply: (args: { account_id: string; token_ids: string[] }) => string[]): NearRpc & { calls: { contract: string; method: string; args: { account_id: string; token_ids: string[] } }[] } {
  const calls: never[] = [];
  return {
    calls,
    viewAccessKey: async () => null,
    viewFunction: (async (contract: string, method: string, args: { account_id: string; token_ids: string[] }) => {
      (calls as unknown[]).push({ contract, method, args });
      return reply(args);
    }) as NearRpc["viewFunction"],
  };
}
const oneclick = (tokens: () => Promise<OneClickToken[]> = async () => TOKENS) => ({ tokens });

test("returns non-zero balances with formatted amount and reference usd", async () => {
  const rpc = rpcWith(() => ["2500000", "0"]);
  const out = await getBalances({ rpc, oneclick: oneclick(), db: createTestDb() }, "alice.near");
  assert.deepEqual(out, [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5", usd: "2.50" }]);
  assert.equal(rpc.calls[0].contract, "intents.near");
  assert.equal(rpc.calls[0].method, "mt_batch_balance_of");
  assert.equal(rpc.calls[0].args.account_id, "alice.near");
  assert.deepEqual(rpc.calls[0].args.token_ids, [USDC, USDT]);
});

test("usd uses integer math and is omitted without a price", async () => {
  const rpc = rpcWith(() => ["123456789012345678", "1000000"]);
  const out = await getBalances({ rpc, oneclick: oneclick(), db: createTestDb() }, "alice.near");
  assert.equal(out[0].usd, "123469134691.25"); // 123456789012.345678 * 1.0001
  assert.equal(out[1].usd, undefined);
});

test("rpc failure is a 502 and returns no zeros", async () => {
  const rpc = rpcWith(() => { throw new Error("boom"); });
  await assert.rejects(getBalances({ rpc, oneclick: oneclick(), db: createTestDb() }, "alice.near"), { status: 502, message: "Could not read NEAR Intents balance" });
});

test("malformed rpc reply is a 502", async () => {
  const rpc = rpcWith(() => ["1"]);
  await assert.rejects(getBalances({ rpc, oneclick: oneclick(), db: createTestDb() }, "alice.near"), { status: 502 });
});

test("queries invoice and withdrawal token ids, owner scoped, deduped, capped at 50", async () => {
  const db = createTestDb();
  const other = "nep141:other.near";
  await createInvoice(db, "alice.near", { ...draft, tokenId: USDT }, NOW).catch(() => {});
  for (let i = 0; i < 60; i++)
    await db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`d${i}`, i === 0 ? "bob.near" : "alice.near", i === 1 ? other : `nep141:t${i}.near`, "x", "1", "r", "s", NOW, NOW).run();
  const rpc = rpcWith((a) => a.token_ids.map(() => "0"));
  await getBalances({ rpc, oneclick: oneclick(), db }, "alice.near");
  const ids = rpc.calls[0].args.token_ids;
  assert.equal(ids.length, 50);
  assert.deepEqual(ids.slice(0, 2), [USDC, USDT]);
  assert.equal(new Set(ids).size, 50);
  assert.ok(!ids.includes("nep141:t0.near"));
});

test("tokens() failure falls back to settlement tokens without usd; unknown tokens are omitted", async () => {
  const db = createTestDb();
  await db.prepare("INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind("d", "alice.near", "nep141:mystery.near", "x", "1", "r", "s", NOW, NOW).run();
  const rpc = rpcWith(() => ["1500000", "0", "999"]);
  const out = await getBalances({ rpc, oneclick: oneclick(async () => { throw new Error("down"); }), db }, "alice.near");
  assert.deepEqual(out, [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "1500000", formatted: "1.5" }]);
});
