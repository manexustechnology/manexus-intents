import test from "node:test";
import assert from "node:assert/strict";
import { validDestination as v } from "../../shared/address.ts";
import { SETTLEMENT_TOKENS, settlementToken } from "../../shared/assets.ts";
import { readFileSync } from "node:fs";

const evm = "0x" + "2".repeat(40);
test("validDestination", () => {
  assert.equal(v("arb", evm), true);
  assert.equal(v("arb", "0x" + "0".repeat(40)), false);
  assert.equal(v("near", "alice.near"), true);
  assert.equal(v("near", "a".repeat(64)), true);
  assert.equal(v("near", evm), false);
  assert.equal(v("sol", "So11111111111111111111111111111111111111112"), true);
  assert.equal(v("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), true);
  assert.equal(v("btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), true);
  assert.equal(v("tron", "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"), true);
  assert.equal(v("doge", "D8mQ2sKq9Yz5Zx1Pq7N3Vw4Rt6Uy8Hb2Jk"), false);
});

test("settlement tokens exist in fixture", () => {
  const tokens = JSON.parse(readFileSync("tests/fixtures/oneclick/tokens.json", "utf8"));
  for (const s of SETTLEMENT_TOKENS) {
    const t = tokens.find((x: any) => x.assetId === s.tokenId);
    assert.ok(t, s.symbol);
    assert.equal(t.blockchain, "near");
    assert.equal(t.decimals, s.decimals);
    assert.equal(settlementToken(s.tokenId), s);
  }
  assert.throws(() => settlementToken("nope"));
});
