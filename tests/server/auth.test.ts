import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { createChallenge, nep413Hash, verifyLogin } from "../../server/auth.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import { HttpError } from "../../server/http.ts";
import { createTestDb } from "./d1-shim.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
// Well-known test keys (Hardhat accounts #0 and #1); never hold funds.
const evmA = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const evmB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const fakeRpc = (permission: unknown | null): NearRpc & { calls: [string, string][] } => {
  const calls: [string, string][] = [];
  return {
    calls,
    async viewAccessKey(account, publicKey) {
      calls.push([account, publicKey]);
      return permission === null ? null : { permission };
    },
    async viewFunction() {
      throw new Error("not used");
    },
  };
};
const noRpc = fakeRpc(null);

async function rejects401(p: Promise<unknown>) {
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === 401);
}

async function evmLogin(db = createTestDb(), signer = evmA, account = evmA.address as string, now = NOW) {
  const ch = await createChallenge(db, account, "evm", NOW);
  const signature = await signer.signMessage({ message: ch.message });
  return { db, ch, body: { kind: "evm" as const, account, nonce: ch.nonce, signature }, now };
}

test("challenge shape", async () => {
  const db = createTestDb();
  const evm = await createChallenge(db, evmA.address, "evm", NOW);
  assert.equal(evm.recipient, "manexus-intents");
  assert.equal(base64.decode(evm.nonce).length, 32);
  assert.equal(evm.message, `Manexus Intents sign-in\nAccount: ${evmA.address.toLowerCase()}\nNonce: ${evm.nonce}`);
  const near = await createChallenge(db, "alice.near", "near", NOW);
  assert.equal(near.message, "Sign in to Manexus Intents");
  assert.notEqual(near.nonce, evm.nonce);
  const row = await db.prepare("SELECT * FROM challenges WHERE nonce = ?").bind(near.nonce).first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { nonce: near.nonce, account: "alice.near", kind: "near", expires_at: NOW + 5 * MIN, used: 0, purpose: "login" });
});

test("challenge rejects invalid accounts and kinds", async () => {
  const db = createTestDb();
  for (const [account, kind] of [
    ["0x123", "evm"],
    ["Alice.near", "near"],
    ["a", "near"],
    ["alice..near", "near"],
    ["alice.near", "sol"],
  ]) {
    await assert.rejects(createChallenge(db, account, kind as "near", NOW), (e) => e instanceof HttpError && e.status === 400, account);
  }
});

test("EVM login with a valid ERC-191 signature returns the lowercase address", async () => {
  const { db, body } = await evmLogin();
  assert.equal(await verifyLogin(db, noRpc, body, NOW + MIN), evmA.address.toLowerCase());
});

test("EVM: reusing the same nonce is rejected", async () => {
  const { db, body } = await evmLogin();
  await verifyLogin(db, noRpc, body, NOW + MIN);
  await rejects401(verifyLogin(db, noRpc, body, NOW + MIN));
});

test("EVM: a nonce issued for a different account is rejected", async () => {
  const db = createTestDb();
  const ch = await createChallenge(db, evmA.address, "evm", NOW);
  const message = `Manexus Intents sign-in\nAccount: ${evmB.address.toLowerCase()}\nNonce: ${ch.nonce}`;
  const signature = await evmB.signMessage({ message });
  await rejects401(verifyLogin(db, noRpc, { kind: "evm", account: evmB.address, nonce: ch.nonce, signature }, NOW + MIN));
});

test("EVM: signature by another key is rejected", async () => {
  const { db, body } = await evmLogin(createTestDb(), evmB, evmA.address);
  await rejects401(verifyLogin(db, noRpc, body, NOW + MIN));
});

test("EVM: expired challenge (now + 6 min) is rejected", async () => {
  const { db, body } = await evmLogin();
  await rejects401(verifyLogin(db, noRpc, body, NOW + 6 * MIN));
});

test("EVM: unknown nonce and malformed signature are rejected", async () => {
  const { db, body } = await evmLogin();
  await rejects401(verifyLogin(db, noRpc, { ...body, nonce: base64.encode(new Uint8Array(32)) }, NOW));
  await rejects401(verifyLogin(db, noRpc, { ...body, signature: "0x1234" }, NOW));
});

// NEAR test key: fixed 32-byte seed, never used on chain.
const nearSk = new Uint8Array(32).fill(7);
const nearPk = "ed25519:" + base58.encode(ed25519.getPublicKey(nearSk));

async function nearLogin(account = "alice.near", sk = nearSk) {
  const db = createTestDb();
  const ch = await createChallenge(db, account, "near", NOW);
  const hash = nep413Hash({ message: ch.message, nonce: base64.decode(ch.nonce), recipient: ch.recipient });
  const signature = base64.encode(ed25519.sign(hash, sk));
  return { db, body: { kind: "near" as const, account, nonce: ch.nonce, signature, publicKey: nearPk } };
}

test("NEAR login with NEP-413 signature and a full-access key returns the account", async () => {
  const { db, body } = await nearLogin();
  const rpc = fakeRpc("FullAccess");
  assert.equal(await verifyLogin(db, rpc, body, NOW + MIN), "alice.near");
  assert.deepEqual(rpc.calls, [["alice.near", nearPk]]);
});

test("NEAR: function-call access key is rejected", async () => {
  const { db, body } = await nearLogin();
  const rpc = fakeRpc({ FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } });
  await rejects401(verifyLogin(db, rpc, body, NOW + MIN));
});

test("NEAR: key not found on the account is rejected", async () => {
  const { db, body } = await nearLogin();
  await rejects401(verifyLogin(db, fakeRpc(null), body, NOW + MIN));
});

test("NEAR: signature by a different key is rejected even with a full-access key", async () => {
  const { db, body } = await nearLogin("alice.near", new Uint8Array(32).fill(9));
  await rejects401(verifyLogin(db, fakeRpc("FullAccess"), body, NOW + MIN));
});

test("NEAR: missing or malformed public key is rejected", async () => {
  for (const publicKey of [undefined, "secp256k1:abc", "ed25519:0OIl", "ed25519:" + base58.encode(new Uint8Array(31))]) {
    const { db, body } = await nearLogin();
    await rejects401(verifyLogin(db, fakeRpc("FullAccess"), { ...body, publicKey }, NOW + MIN));
  }
});

test("nep413Hash matches the near-api-js reference vector", () => {
  // Reference: near-api-js@7.4.0 `Signer.signNep413Message` (src/nep413/schema.ts `serializeMessage`),
  // run with a Signer subclass whose signBytes() echoes its input, for
  // { message: "hi", nonce: 32 x 0x01, recipient: "r" } (callbackUrl omitted -> borsh None).
  // Bytes hashed: 9d010080 | 02000000 6869 | 01 x32 | 01000000 72 | 00
  const hash = nep413Hash({ message: "hi", nonce: new Uint8Array(32).fill(1), recipient: "r" });
  assert.equal(Buffer.from(hash).toString("hex"), "8731cb39995b2b447f8730d70de7d25cfee7d89c86a324357631db837649ff7d");
  const withCb = nep413Hash({ message: "hi", nonce: new Uint8Array(32).fill(1), recipient: "r", callbackUrl: "u" });
  assert.notEqual(Buffer.from(withCb).toString("hex"), Buffer.from(hash).toString("hex"));
  assert.throws(() => nep413Hash({ message: "hi", nonce: new Uint8Array(31), recipient: "r" }));
});

test("NEAR: an RPC failure during the full-access check is 503, not 500 (and the nonce stays used)", async () => {
  const { db, body } = await nearLogin();
  const down: NearRpc = { async viewAccessKey() { throw new Error("timeout"); }, async viewFunction() { throw new Error("not used"); } };
  await assert.rejects(verifyLogin(db, down, body, NOW + MIN), (e) => e instanceof HttpError && e.status === 503 && e.message === "NEAR RPC is unavailable, try again");
  await rejects401(verifyLogin(db, fakeRpc("FullAccess"), body, NOW + MIN));
});
