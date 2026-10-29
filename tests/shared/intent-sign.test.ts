import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { erc191SignedData, nep413SignArgs, nep413SignedData } from "../../shared/intent-sign.ts";

const nonceBytes = new Uint8Array(32).map((_, i) => i);
const payload = { recipient: "intents.near", nonce: Buffer.from(nonceBytes).toString("base64"), message: '{"signer_id":"alice.near"}' };
const PK = "ed25519:" + base58.encode(new Uint8Array(32).fill(1));

test("nep413SignArgs decodes the base64 nonce to 32 bytes and keeps message/recipient verbatim", () => {
  const a = nep413SignArgs(payload);
  assert.equal(a.message, payload.message);
  assert.equal(a.recipient, "intents.near");
  assert.deepEqual([...a.nonce], [...nonceBytes]);
  assert.throws(() => nep413SignArgs({ ...payload, nonce: "AAAA" }));
  assert.throws(() => nep413SignArgs({ ...payload, message: 1 } as never));
});

test("nep413SignedData converts the base64 signature to ed25519:<base58>", () => {
  const sig = new Uint8Array(64).fill(2);
  const out = nep413SignedData(payload, { publicKey: PK, signature: Buffer.from(sig).toString("base64") });
  assert.deepEqual(out, { standard: "nep413", payload, public_key: PK, signature: "ed25519:" + base58.encode(sig) });
  assert.throws(() => nep413SignedData(payload, { publicKey: PK, signature: Buffer.from(new Uint8Array(10)).toString("base64") }));
  assert.throws(() => nep413SignedData(payload, { publicKey: "bad", signature: Buffer.from(sig).toString("base64") }));
});

test("erc191SignedData normalizes v=27/28 to 0/1 and base58-encodes r||s||v", () => {
  const rs = "11".repeat(64);
  for (const [v, n] of [["1b", 0], ["1c", 1], ["00", 0], ["01", 1]] as const) {
    const out = erc191SignedData("{}", "0x" + rs + v);
    const bytes = new Uint8Array(65).fill(0x11);
    bytes[64] = n;
    assert.deepEqual(out, { standard: "erc191", payload: "{}", signature: "secp256k1:" + base58.encode(bytes) });
  }
  assert.throws(() => erc191SignedData("{}", "0x" + rs + "1d"));
  assert.throws(() => erc191SignedData("{}", "0x" + "11".repeat(10)));
});
