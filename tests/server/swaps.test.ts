import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest } from "../../server/oneclick.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { quoteSwap } from "../../server/swaps.ts";
import type { TransferDeps } from "../../server/transfers.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const WNEAR = "nep141:wrap.near";
const USER = { account: "alice.near", kind: "near" as const };
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
];

function setup() {
  const quotes: QuoteRequest[] = [];
  const rpc: NearRpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, _m: string, args: { token_ids?: string[] }) =>
      (args.token_ids ?? []).map((id) => (id === USDC ? "5000000" : "0"))) as NearRpc["viewFunction"],
  };
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      quotes.push(r);
      return { depositAddress: "d".repeat(64), amountIn: r.amount, minAmountIn: r.amount, amountOut: "3124560000000000000000000", minAmountOut: "3000000000000000000000000", deadline: "2030-01-01T00:10:00.000Z" };
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => ({
      standard: a.standard,
      payload: {
        recipient: "intents.near", nonce: NONCE,
        message: JSON.stringify({ signer_id: a.signerId, deadline: "2030-01-01T00:10:00.000Z", intents: [{ intent: "transfer", receiver_id: a.depositAddress, tokens: { [USDC]: "1000000" } }] }),
      },
    }),
  };
  const db = createTestDb();
  const deps = { db, rpc, oneclick, now: new Date("2030-01-01T00:00:00.000Z") } as unknown as TransferDeps;
  return { deps, quotes, db };
}
const body = (o: Record<string, unknown> = {}) => ({ originAsset: USDC, destinationAsset: WNEAR, amount: "1000000", slippageBps: 100, ...o }) as never;

test("swap quote: EXACT_INPUT into the owner's own Intents account, slippage passed through, kind swap stored", async () => {
  const { deps, quotes, db } = setup();
  const q = await quoteSwap(deps, USER, body({ slippageBps: 300 }));
  const r = quotes[0];
  assert.equal(r.swapType, "EXACT_INPUT");
  assert.equal(r.depositType, "INTENTS");
  assert.equal(r.refundType, "INTENTS");
  assert.equal(r.recipientType, "INTENTS");
  assert.equal(r.recipient, USER.account);
  assert.equal(r.slippageTolerance, 300);
  assert.equal(q.transfer.kind, "swap");
  assert.equal(q.amountOutFormatted, "3.12456");
  const row = await db.prepare("SELECT kind, recipient FROM withdrawals").bind().first<{ kind: string; recipient: string }>();
  assert.deepEqual({ ...row }, { kind: "swap", recipient: USER.account });
});

test("swapping a token for itself is 400 before any quote", async () => {
  const { deps, quotes } = setup();
  await assert.rejects(quoteSwap(deps, USER, body({ destinationAsset: USDC })), { status: 400, message: "Choose two different tokens" });
  assert.equal(quotes.length, 0);
});

test("slippage outside 0.5/1/3 % is 400", async () => {
  const { deps, quotes } = setup();
  await assert.rejects(quoteSwap(deps, USER, body({ slippageBps: 200 })), { status: 400 });
  await assert.rejects(quoteSwap(deps, USER, body({ slippageBps: undefined })), { status: 400 });
  assert.equal(quotes.length, 0);
});
