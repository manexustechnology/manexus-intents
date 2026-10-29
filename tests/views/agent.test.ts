import test from "node:test";
import assert from "node:assert/strict";
import { dollarsToCents, proposalReason, type ReasonContext } from "../../src/views/agent.ts";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
const ctx: ReasonContext = {
  balances: [{ tokenId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24, amount: "5000000000000000000000000", formatted: "5" }],
  tokens: [{ assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24, price: 3.2 }],
  bills: [], invoices: [], whitelist: [], policy: null, now: new Date("2030-01-10T12:00:00Z"),
};

test("convert reason uses the reference price when the balance has none for that amount; unknown items read plainly", () => {
  assert.equal(proposalReason({ type: "convert", params: { originAsset: WNEAR, destinationAsset: USDC, amount: "2000000000000000000000000" } }, ctx), "Convert 2 wNEAR → USDC (≈ $6.40 reference price)");
  assert.equal(proposalReason({ type: "sweep", params: { originAsset: USDC, amount: "1000000", whitelistId: "x" } }, ctx), "Sweep 1 USDC to your whitelisted address");
  assert.equal(proposalReason({ type: "pay_bill", params: { billId: "b" } }, ctx), "Pay a scheduled bill");
  assert.equal(proposalReason({ type: "follow_up_invoice", params: { invoiceId: "i" } }, ctx), "An invoice is overdue — send the pay link");
  const inv = { id: "i", publicId: "p", status: "issued", data: { number: "INV-1", client: "C", dueDate: "2030-01-09" } };
  assert.equal(proposalReason({ type: "follow_up_invoice", params: { invoiceId: "i" } }, { ...ctx, invoices: [inv] }), "Invoice INV-1 is 1 day overdue — send the pay link");
});

test("dollarsToCents parses plain dollar amounts only", () => {
  assert.equal(dollarsToCents("10"), 1000);
  assert.equal(dollarsToCents("10.5"), 1050);
  assert.equal(dollarsToCents(" 0.07 "), 7);
  for (const bad of ["", "1.234", "-1", "1e3", "abc"]) assert.equal(dollarsToCents(bad), undefined);
});

test("sweep reason says when the amount was limited by the per-transaction cap", () => {
  const c = { ...ctx, balances: [], tokens: [], policy: { version: 1 as const, sweep: { enabled: true, tokenId: USDC, thresholdUnits: "100000000", keepUnits: "10000000", whitelistId: "x" } } };
  assert.equal(proposalReason({ type: "sweep", params: { originAsset: USDC, amount: "50000000", whitelistId: "x", limitedByCap: "true" } }, c), "Sweep 50 USDC to your whitelisted address (limited by your per-transaction cap)");
  assert.equal(proposalReason({ type: "sweep", params: { originAsset: USDC, amount: "50000000", whitelistId: "x" } }, c), "Sweep 50 USDC to your whitelisted address (keeps 10 USDC)");
});
