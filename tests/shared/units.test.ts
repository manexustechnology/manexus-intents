import test from "node:test";
import assert from "node:assert/strict";
import { baseUnits, formatAmount, validAmount } from "../../shared/units.ts";
import { escapeHTML } from "../../shared/text.ts";

test("units", () => {
  assert.equal(baseUnits("0.7", 6), 700000n);
  assert.throws(() => baseUnits("1.0000001", 6));
  assert.equal(formatAmount(700000n, 6), "0.7");
  assert.equal(formatAmount(2000000n, 6), "2");
  assert.equal(validAmount("01", 6), false);
  assert.equal(escapeHTML(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});
