import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { nep413Nonce } from "../../src/wallet/near.ts";

test("NEP-413 nonce passes wallet-selector's Buffer.isBuffer validation", async () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  // The raw challenge bytes are a plain Uint8Array, which wallet-selector rejects
  // with "Invalid nonce. It must be a Buffer with a length of 32 bytes."
  assert.equal(Buffer.isBuffer(bytes), false);
  const nonce = await nep413Nonce(bytes);
  assert.equal(Buffer.isBuffer(nonce), true);
  assert.equal(nonce.length, 32);
  assert.deepEqual([...nonce], [...bytes]);
});
