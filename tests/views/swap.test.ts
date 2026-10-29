import test from "node:test";
import assert from "node:assert/strict";
import { swapRate, usdValue } from "../../src/views/swap.ts";

test("usdValue: integer-cent value at a reference price", () => {
  assert.equal(usdValue(1_500_000n, 6, 1), "1.50");
  assert.equal(usdValue(468_684_000_000_000_000_000_000n, 24, 3.2), "1.49");
});

test("usdValue: no USD without a usable price", () => {
  assert.equal(usdValue(1n, 6, undefined), undefined);
  assert.equal(usdValue(1n, 6, 0), undefined);
  assert.equal(usdValue(1n, 6, Number.NaN), undefined);
});

test("usdValue: a price that rounds to 0 micro-dollars is treated as no price, not $0.00", () => {
  assert.equal(usdValue(10n ** 30n, 24, 0.0000001), undefined);
  assert.equal(usdValue(10n ** 30n, 24, 0.0000004), undefined);
  assert.equal(usdValue(10n ** 24n, 24, 0.000001), "0.00");
});

test("swapRate: per-unit rate with 6 truncated digits", () => {
  assert.equal(swapRate(1_500_000n, 6, 468_684_000_000_000_000_000_000n, 24), "0.312456");
  assert.equal(swapRate(0n, 6, 1n, 24), "0.000000");
});
