import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validAmount,
  validAddress,
  validateRequest,
  parseRequest,
  requestHash,
  estimate,
  fixtures,
  escapeHTML,
} from "../src/domain.ts";
test("reject ambiguous, negative, zero, scientific and excessive precision amounts", () => {
  for (const a of [
    "",
    "0",
    "-1",
    "NaN",
    "1e3",
    "01",
    "1.000000001",
    "Infinity",
  ])
    assert.equal(validAmount(a), false);
  assert.equal(validAmount("0.000001", 6), true);
  assert.equal(validAmount("1.0000001", 6), false);
});
test("network-aware address validation", () => {
  assert.ok(validAddress("alice.near", "near"));
  assert.ok(validAddress("0x" + "a".repeat(40), "eth"));
  assert.equal(validAddress("alice.near", "eth"), false);
  assert.equal(validAddress("<script>", "near"), false);
  assert.equal(validAddress("a..near", "near"), false);
});
test("payment request round trip and pair enforcement", () => {
  const d = {
    address: "alice.near",
    amount: "1.25",
    chain: "near",
    symbol: "NEAR",
  };
  assert.deepEqual(parseRequest(requestHash(d)), d);
  assert.equal(validateRequest({ ...d, symbol: "USDC" }), false);
  assert.equal(parseRequest("#address=<script>&amount=1"), null);
});
test("estimate validates pair and computes illustrative minimum", () => {
  assert.throws(() => estimate("1", fixtures[0], fixtures[0], 0.5));
  assert.throws(() => estimate("-2", fixtures[0], fixtures[1], 0.5));
  assert.deepEqual(estimate("100", fixtures[0], fixtures[1], 1), {
    output: 31.25,
    minimum: 30.9375,
  });
});
test("HTML encoding covers request injection", () =>
  assert.equal(escapeHTML('<img "x">'), "&lt;img &quot;x&quot;&gt;"));
import { baseUnits, dryQuoteBody, safeQuote } from "../src/live.ts";
test("base-unit amounts never lose integer precision", () => {
  assert.equal(baseUnits("1.000000000000000001", 18), "1000000000000000001");
  assert.throws(() => baseUnits("1e3", 6));
});
test("dry quote has no execution and no real user addresses", () => {
  const body = dryQuoteBody("10", fixtures[0], fixtures[1]);
  assert.equal(body.dry, true);
  assert.equal(body.amount, "10000000");
  assert.equal(body.recipient, "preview.near");
  assert.ok(!("confidentiality" in body));
});
test("reject deposit addresses and malformed provider responses", () => {
  assert.throws(() =>
    safeQuote({
      quote: {
        depositAddress: "0x123",
        amountOutFormatted: "1",
        minAmountOut: "1",
      },
    }),
  );
  assert.throws(() => safeQuote({ quote: { amountOutFormatted: "NaN" } }));
  assert.equal(
    safeQuote({ quote: { amountOutFormatted: "1.2", minAmountOut: "12" } })
      .amountOutFormatted,
    "1.2",
  );
});
