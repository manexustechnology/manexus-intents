import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { createTestDb, type TestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest } from "../../server/oneclick.ts";
import { createChallenge, nep413Hash, verifyLogin } from "../../server/auth.ts";
import { HttpError } from "../../server/http.ts";
import { signSession } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import {
  addWhitelist,
  canonicalPolicyJson,
  enforceLimits,
  getPolicy,
  listWhitelist,
  parsePolicy,
  policyChallenge,
  policyHash,
  removeWhitelist,
  savePolicy,
  type Policy,
} from "../../server/policy.ts";
import { quoteTransfer, submitTransfer, type TransferDeps, type TransferRequest } from "../../server/transfers.ts";
import { onRequestGet as policyGet, onRequestPut as policyPut } from "../../functions/api/agent/policy.ts";
import { onRequestPost as challengePost } from "../../functions/api/agent/policy/challenge.ts";
import { onRequestDelete as whitelistDelete, onRequestGet as whitelistGet, onRequestPost as whitelistPost } from "../../functions/api/agent/whitelist.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const USDT = SETTLEMENT_TOKENS[1].tokenId;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const WNEAR = "nep141:wrap.near";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
];

// Same well-known test keys as tests/server/auth.test.ts; never hold funds.
const evmA = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const evmB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const EVM_USER = { account: evmA.address.toLowerCase(), kind: "evm" as const };
const NEAR_USER = { account: "alice.near", kind: "near" as const };
const nearSk = new Uint8Array(32).fill(7);
const nearPk = "ed25519:" + base58.encode(ed25519.getPublicKey(nearSk));
const CHECKSUM_DEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat #1, EIP-55 checksummed

const fakeRpc = (permission: unknown | null, balance = "100000000"): NearRpc => ({
  async viewAccessKey() {
    return permission === null ? null : { permission };
  },
  viewFunction: (async (_c: string, _m: string, args: { token_ids?: string[] }) =>
    (args.token_ids ?? []).map((id) => (id === USDC ? balance : id === WNEAR ? "7" : "0"))) as NearRpc["viewFunction"],
});

let depCounter = 0;
const nextDep = () => "p" + (++depCounter).toString(16).padStart(63, "0");

/** Fake 1Click as in transfers.test.ts: EXACT_OUTPUT asks for 1% more than the requested output. */
function fakes(o: { amountIn?: (r: QuoteRequest) => string } = {}) {
  const calls = { quote: [] as QuoteRequest[], generate: 0, submit: 0 };
  const quotes = new Map<string, Quote>();
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      const amountIn = o.amountIn?.(r) ?? (r.swapType === "EXACT_OUTPUT" ? ((BigInt(r.amount) * 101n) / 100n).toString() : r.amount);
      const amountOut = r.swapType === "EXACT_OUTPUT" ? r.amount : "990000";
      const q: Quote = { depositAddress: nextDep(), amountIn, minAmountIn: amountIn, amountOut, minAmountOut: amountOut, deadline: "2030-01-01T00:10:00.000Z" };
      quotes.set(q.depositAddress, q);
      return q;
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      calls.generate++;
      const q = quotes.get(a.depositAddress)!;
      const list = [{ intent: "transfer", receiver_id: a.depositAddress, tokens: { [USDC]: q.amountIn } }];
      const payload =
        a.standard === "nep413"
          ? { recipient: "intents.near", nonce: NONCE, message: JSON.stringify({ signer_id: a.signerId, deadline: "2030-01-01T00:10:00.000Z", intents: list }) }
          : JSON.stringify({ signer_id: a.signerId, verifying_contract: "intents.near", deadline: "2030-01-01T00:10:00.000Z", nonce: NONCE, intents: list });
      return { standard: a.standard, payload };
    },
    submitIntent: async () => {
      calls.submit++;
      return { intentHash: "IntentHash111" };
    },
    status: async () => {
      throw new Error("status not stubbed");
    },
  };
  return { oneclick, calls };
}

type F = ReturnType<typeof fakes>;
const deps = (db: Db, f: F = fakes(), rpc = fakeRpc("FullAccess"), now = NOW): TransferDeps => ({ db, oneclick: f.oneclick, rpc, now });

async function rejectsWith(p: Promise<unknown>, status: number, message?: string) {
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === status && (message === undefined || e.message === message));
}
const mismatch = (p: Promise<unknown>) => rejectsWith(p, 401, "Signature does not match this change");

const CTX = { settlementTokens: SETTLEMENT_TOKENS, whitelistIds: new Set(["w1"]) };
const FULL: Policy = {
  version: 1,
  convert: { enabled: true, targetTokenId: USDC, minUsdCents: 500 },
  sweep: { enabled: true, tokenId: USDC, thresholdUnits: "5000000", keepUnits: "1000000", whitelistId: "w1" },
  limits: { perTx: { [USDC]: "2000000" }, daily: { [USDC]: "3000000" }, whitelistOnly: false },
  reminders: { billDueDays: 3, invoiceOverdueDays: 14 },
};

// --- parsePolicy / canonical JSON ---

test("parsePolicy accepts a full policy and a minimal one", () => {
  assert.deepEqual(parsePolicy(FULL, CTX), FULL);
  assert.deepEqual(parsePolicy({ version: 1 }, CTX), { version: 1 });
});

test("parsePolicy rejects unknown keys at every level", () => {
  const bad: unknown[] = [
    { ...FULL, extra: 1 },
    { ...FULL, convert: { ...FULL.convert, x: 1 } },
    { ...FULL, sweep: { ...FULL.sweep, to: "0xabc" } },
    { ...FULL, limits: { ...FULL.limits, monthly: {} } },
    { ...FULL, reminders: { ...FULL.reminders, weekly: 1 } },
    { version: 2 },
    {},
    null,
    [],
    "policy",
  ];
  for (const v of bad) assert.throws(() => parsePolicy(v, CTX), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(v));
});

test("parsePolicy rejects bad unit strings, keep >= threshold, a foreign whitelist id and out-of-range numbers", () => {
  const sweep = (s: Record<string, unknown>) => ({ ...FULL, sweep: { ...FULL.sweep, ...s } });
  const bad: unknown[] = [
    sweep({ thresholdUnits: "1.5" }),
    sweep({ thresholdUnits: "-1" }),
    sweep({ thresholdUnits: "01" }),
    sweep({ thresholdUnits: 5000000 }),
    sweep({ thresholdUnits: "0" }),
    sweep({ keepUnits: "1e6" }),
    sweep({ keepUnits: "5000000" }),
    sweep({ keepUnits: "6000000" }),
    sweep({ whitelistId: "w-other-owner" }),
    sweep({ enabled: "yes" }),
    { ...FULL, limits: { ...FULL.limits, perTx: { [USDC]: "0" } } },
    { ...FULL, limits: { ...FULL.limits, daily: { [USDC]: " 100" } } },
    { ...FULL, limits: { ...FULL.limits, perTx: [] } },
    { ...FULL, limits: { ...FULL.limits, whitelistOnly: 1 } },
    { ...FULL, convert: { ...FULL.convert, targetTokenId: WNEAR } },
    { ...FULL, convert: { ...FULL.convert, minUsdCents: 1.5 } },
    { ...FULL, convert: { ...FULL.convert, minUsdCents: -1 } },
    { ...FULL, reminders: { billDueDays: 31, invoiceOverdueDays: 1 } },
    { ...FULL, reminders: { billDueDays: 1, invoiceOverdueDays: 91 } },
    { ...FULL, reminders: { billDueDays: 1 } },
  ];
  for (const v of bad) assert.throws(() => parsePolicy(v, CTX), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(v));
  // keepUnits "0" is fine (sweep everything above the threshold).
  assert.equal(parsePolicy(sweep({ keepUnits: "0" }), CTX).sweep?.keepUnits, "0");
});

test("canonicalPolicyJson sorts keys at every level with no whitespace; policyHash is its sha256 hex", () => {
  const shuffled = JSON.parse(JSON.stringify({ reminders: { invoiceOverdueDays: 14, billDueDays: 3 }, limits: FULL.limits, version: 1 }));
  const c = canonicalPolicyJson(shuffled as Policy);
  assert.equal(c, `{"limits":{"daily":{"${USDC}":"3000000"},"perTx":{"${USDC}":"2000000"},"whitelistOnly":false},"reminders":{"billDueDays":3,"invoiceOverdueDays":14},"version":1}`);
  assert.equal(policyHash(shuffled as Policy), createHash("sha256").update(c).digest("hex"));
  assert.equal(policyHash({ version: 1, reminders: { billDueDays: 3, invoiceOverdueDays: 14 }, limits: FULL.limits }), policyHash(shuffled as Policy));
});

// --- signed changes ---

const signEvm = (message: string, signer = evmA) => signer.signMessage({ message });
const signNear = (ch: { message: string; nonce: string }, sk = nearSk) =>
  base64.encode(ed25519.sign(nep413Hash({ message: ch.message, nonce: base64.decode(ch.nonce), recipient: "manexus-intents" }), sk));

test("policy challenge: exact message, 5-minute single-use row bound to the action hash", async () => {
  const db = createTestDb();
  const policy = { version: 1 as const, reminders: { billDueDays: 3, invoiceOverdueDays: 14 } };
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime());
  const hash = createHash("sha256").update(JSON.stringify({ kind: "policy", policy: JSON.parse(canonicalPolicyJson(policy)) })).digest("hex");
  assert.equal(ch.hash, hash);
  assert.equal(ch.message, `Manexus policy v1\nAccount: ${EVM_USER.account}\nHash: ${hash}\nNonce: ${ch.nonce}`);
  assert.equal(base64.decode(ch.nonce).length, 32);
  const row = await db.prepare("SELECT * FROM challenges WHERE nonce = ?").bind(ch.nonce).first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { nonce: ch.nonce, account: EVM_USER.account, kind: "evm", expires_at: NOW.getTime() + 5 * MIN, used: 0, purpose: `policy:${hash}` });
});

test("policy challenge validates the policy first (400, no challenge stored)", async () => {
  const db = createTestDb();
  await rejectsWith(policyChallenge(db, EVM_USER, { kind: "policy", policy: { version: 1, nope: true } as never }, NOW.getTime()), 400);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM challenges").bind().first<{ n: number }>();
  assert.equal(n?.n, 0);
});

test("EVM: signed policy save, then getPolicy returns it with its hash", async () => {
  const db = createTestDb();
  const d = deps(db);
  assert.deepEqual(await getPolicy(db, EVM_USER), { policy: null, hash: null, updatedAt: null });
  const policy = { version: 1 as const, limits: { perTx: { [USDC]: "2000000" }, daily: {}, whitelistOnly: false } };
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime());
  const saved = await savePolicy(d, EVM_USER, { policy, nonce: ch.nonce, signature: await signEvm(ch.message) });
  assert.deepEqual(saved, { policy, hash: policyHash(policy), updatedAt: NOW.toISOString() });
  assert.deepEqual(await getPolicy(db, EVM_USER), saved);
});

test("NEAR: signed policy save with a NEP-413 signature and a full-access key", async () => {
  const db = createTestDb();
  const policy = { version: 1 as const, reminders: { billDueDays: 0, invoiceOverdueDays: 90 } };
  const ch = await policyChallenge(db, NEAR_USER, { kind: "policy", policy }, NOW.getTime());
  assert.equal(ch.recipient, "manexus-intents");
  const saved = await savePolicy(deps(db), NEAR_USER, { policy, nonce: ch.nonce, signature: signNear(ch), publicKey: nearPk });
  assert.equal(saved.hash, policyHash(policy));
  // A function-call key is not enough.
  const ch2 = await policyChallenge(db, NEAR_USER, { kind: "policy", policy }, NOW.getTime());
  const rpcFc = fakeRpc({ FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } });
  await mismatch(savePolicy(deps(db, fakes(), rpcFc), NEAR_USER, { policy, nonce: ch2.nonce, signature: signNear(ch2), publicKey: nearPk }));
  // A different key is rejected.
  const ch3 = await policyChallenge(db, NEAR_USER, { kind: "policy", policy }, NOW.getTime());
  await mismatch(savePolicy(deps(db), NEAR_USER, { policy, nonce: ch3.nonce, signature: signNear(ch3, new Uint8Array(32).fill(9)), publicKey: nearPk }));
});

test("a replayed policy signature is 401", async () => {
  const db = createTestDb();
  const policy = { version: 1 as const };
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime());
  const body = { policy, nonce: ch.nonce, signature: await signEvm(ch.message) };
  await savePolicy(deps(db), EVM_USER, body);
  await mismatch(savePolicy(deps(db), EVM_USER, body));
});

test("a signature over a different policy is 401 and nothing is saved", async () => {
  const db = createTestDb();
  const signedFor = { version: 1 as const, reminders: { billDueDays: 1, invoiceOverdueDays: 1 } };
  const sent = { version: 1 as const };
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy: signedFor }, NOW.getTime());
  await mismatch(savePolicy(deps(db), EVM_USER, { policy: sent, nonce: ch.nonce, signature: await signEvm(ch.message) }));
  // Signing a message that names the submitted policy's hash does not help: the nonce is bound to the other hash.
  const forged = `Manexus policy v1\nAccount: ${EVM_USER.account}\nHash: ${policyHash(sent)}\nNonce: ${ch.nonce}`;
  await mismatch(savePolicy(deps(db), EVM_USER, { policy: sent, nonce: ch.nonce, signature: await signEvm(forged) }));
  // Another key, expired challenge, another account's challenge.
  const ch2 = await policyChallenge(db, EVM_USER, { kind: "policy", policy: sent }, NOW.getTime());
  await mismatch(savePolicy(deps(db), EVM_USER, { policy: sent, nonce: ch2.nonce, signature: await signEvm(ch2.message, evmB) }));
  const ch3 = await policyChallenge(db, EVM_USER, { kind: "policy", policy: sent }, NOW.getTime());
  await mismatch(savePolicy(deps(db, fakes(), fakeRpc(null), new Date(NOW.getTime() + 6 * MIN)), EVM_USER, { policy: sent, nonce: ch3.nonce, signature: await signEvm(ch3.message) }));
  const other = { account: evmB.address.toLowerCase(), kind: "evm" as const };
  const ch4 = await policyChallenge(db, other, { kind: "policy", policy: sent }, NOW.getTime());
  await mismatch(savePolicy(deps(db), EVM_USER, { policy: sent, nonce: ch4.nonce, signature: await signEvm(ch4.message.replace(other.account, EVM_USER.account)) }));
  assert.deepEqual(await getPolicy(db, EVM_USER), { policy: null, hash: null, updatedAt: null });
});

test("login and policy challenges cannot be used for each other; login still works", async () => {
  const db = createTestDb();
  const login = await createChallenge(db, evmA.address, "evm", NOW.getTime());
  // A login nonce for a policy save.
  const policy = { version: 1 as const };
  const msg = `Manexus policy v1\nAccount: ${EVM_USER.account}\nHash: ${policyHash(policy)}\nNonce: ${login.nonce}`;
  await mismatch(savePolicy(deps(db), EVM_USER, { policy, nonce: login.nonce, signature: await signEvm(msg) }));
  // A policy nonce for login.
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime());
  const loginMsg = `Manexus Intents sign-in\nAccount: ${EVM_USER.account}\nNonce: ${ch.nonce}`;
  await rejectsWith(verifyLogin(db, fakeRpc(null), { kind: "evm", account: evmA.address, nonce: ch.nonce, signature: await signEvm(loginMsg) }, NOW.getTime()), 401, "Sign-in failed");
  // The untouched login challenge still signs in.
  assert.equal(
    await verifyLogin(db, fakeRpc(null), { kind: "evm", account: evmA.address, nonce: login.nonce, signature: await signEvm(login.message) }, NOW.getTime()),
    EVM_USER.account,
  );
});

test("savePolicy refuses a policy whose sweep names another owner's whitelist entry", async () => {
  const db = createTestDb();
  await db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('wb', 'bob.near', 'B', ?, 'INTENTS', 'bob2.near', ?)").bind(USDC, NOW.toISOString()).run();
  const policy = { version: 1 as const, sweep: { enabled: true, tokenId: USDC, thresholdUnits: "10", keepUnits: "1", whitelistId: "wb" } };
  await rejectsWith(policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime()), 400);
});

// --- whitelist ---

async function addEntry(db: TestDb, entry: Record<string, unknown>, user = EVM_USER) {
  const ch = await policyChallenge(db, user, { kind: "whitelist_add", entry: entry as never }, NOW.getTime());
  return addWhitelist(deps(db), user, { entry, nonce: ch.nonce, signature: await signEvm(ch.message) });
}
async function removeEntry(db: TestDb, id: string, user = EVM_USER) {
  const ch = await policyChallenge(db, user, { kind: "whitelist_remove", id }, NOW.getTime());
  return removeWhitelist(deps(db), user, { id, nonce: ch.nonce, signature: await signEvm(ch.message) });
}

test("whitelist: signed add (EVM addresses lowercased), list, duplicate 409, signed remove", async () => {
  const db = createTestDb();
  const w = await addEntry(db, { label: "Cold wallet", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: CHECKSUM_DEST });
  assert.equal(w.recipient, CHECKSUM_DEST.toLowerCase());
  assert.deepEqual(await listWhitelist(db, EVM_USER), [w]);
  assert.deepEqual(await listWhitelist(db, NEAR_USER), []);
  await rejectsWith(addEntry(db, { label: "Again", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: CHECKSUM_DEST.toLowerCase() }), 409);
  // Another owner cannot remove it.
  const other = { account: evmB.address.toLowerCase(), kind: "evm" as const };
  const ch = await policyChallenge(db, other, { kind: "whitelist_remove", id: w.id }, NOW.getTime());
  await rejectsWith(removeWhitelist(deps(db), other, { id: w.id, nonce: ch.nonce, signature: await signEvm(ch.message, evmB) }), 404);
  await removeEntry(db, w.id);
  assert.deepEqual(await listWhitelist(db, EVM_USER), []);
});

test("whitelist: invalid entries are 400; a signature over another entry or id is 401", async () => {
  const db = createTestDb();
  for (const entry of [
    { label: "", destinationAsset: USDC, recipientType: "INTENTS", recipient: "bob.near" },
    { label: "x", destinationAsset: "nep141:unknown.near", recipientType: "INTENTS", recipient: "bob.near" },
    { label: "x", destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: "bob.near" },
    { label: "x", destinationAsset: USDC, recipientType: "INTENTS", recipient: EVM_USER.account },
    { label: "x", destinationAsset: USDC, recipientType: "INTENTS", recipient: "bob.near", extra: 1 },
  ]) await rejectsWith(addEntry(db, entry), 400);
  const entry = { label: "Bob", destinationAsset: USDC, recipientType: "INTENTS", recipient: "bob.near" };
  const ch = await policyChallenge(db, EVM_USER, { kind: "whitelist_add", entry: entry as never }, NOW.getTime());
  const sig = await signEvm(ch.message);
  await mismatch(addWhitelist(deps(db), EVM_USER, { entry: { ...entry, recipient: "mallory.near" }, nonce: ch.nonce, signature: sig }));
  const w = await addEntry(db, entry);
  const ch2 = await policyChallenge(db, EVM_USER, { kind: "whitelist_remove", id: "other" }, NOW.getTime());
  await mismatch(removeWhitelist(deps(db), EVM_USER, { id: w.id, nonce: ch2.nonce, signature: await signEvm(ch2.message) }));
  // A whitelist_add challenge cannot authorize a policy save over the same signature.
  const ch3 = await policyChallenge(db, EVM_USER, { kind: "whitelist_add", entry: entry as never }, NOW.getTime());
  await mismatch(savePolicy(deps(db), EVM_USER, { policy: { version: 1 }, nonce: ch3.nonce, signature: await signEvm(ch3.message) }));
  assert.equal((await listWhitelist(db, EVM_USER)).length, 1);
});

test("whitelist: an entry the sweep rule uses cannot be removed", async () => {
  const db = createTestDb();
  const w = await addEntry(db, { label: "Bob", destinationAsset: USDC, recipientType: "INTENTS", recipient: "bob.near" });
  const policy = { version: 1 as const, sweep: { enabled: true, tokenId: USDC, thresholdUnits: "10", keepUnits: "1", whitelistId: w.id } };
  const ch = await policyChallenge(db, EVM_USER, { kind: "policy", policy }, NOW.getTime());
  await savePolicy(deps(db), EVM_USER, { policy, nonce: ch.nonce, signature: await signEvm(ch.message) });
  await rejectsWith(removeEntry(db, w.id), 409);
  assert.equal((await listWhitelist(db, EVM_USER)).length, 1);
});

// --- enforceLimits ---

/** Stores a policy directly (the signed path is tested above). */
async function setPolicy(db: Db, owner: string, p: Policy) {
  await db.prepare("INSERT OR REPLACE INTO agent_policies (owner, policy, hash, updated_at) VALUES (?, ?, ?, ?)").bind(owner, canonicalPolicyJson(p), policyHash(p), NOW.toISOString()).run();
}
const limits = (l: Partial<NonNullable<Policy["limits"]>>): Policy => ({ version: 1, limits: { perTx: {}, daily: {}, whitelistOnly: false, ...l } });
async function whitelistRow(db: Db, owner: string, destinationAsset: string, recipient: string, id = "w-" + recipient) {
  await db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES (?, ?, 'L', ?, 'INTENTS', ?, ?)").bind(id, owner, destinationAsset, recipient, NOW.toISOString()).run();
}
async function transferRow(db: Db, o: { owner?: string; status: string; amount: string; kind?: string; origin?: string; createdAgoMs?: number; deadline?: string; recipient?: string }) {
  const created = new Date(NOW.getTime() - (o.createdAgoMs ?? MIN)).toISOString();
  const intent = JSON.stringify({ standard: "nep413", payload: {}, deadline: o.deadline ?? "2030-01-01T00:10:00.000Z", meta: {} });
  await db
    .prepare(
      "INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, intent, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(nextDep(), o.owner ?? NEAR_USER.account, o.origin ?? USDC, USDC, o.amount, o.recipient ?? (o.kind === "swap" ? (o.owner ?? NEAR_USER.account) : "x.near"), o.status, intent, created, created, o.kind ?? "withdraw")
    .run();
}
const withdrawReq = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  kind: "withdraw", originAsset: USDC, destinationAsset: USDC, amount: "1000000", swapType: "EXACT_INPUT", recipientType: "INTENTS", recipient: "bob.near", ...over,
});
const billReq = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  kind: "bill", originAsset: USDC, destinationAsset: USDC, amount: "1000000", swapType: "EXACT_OUTPUT", recipientType: "INTENTS", recipient: "vendor.near", billId: "bill-1", ...over,
});
const payrollReq = (recipient: string): TransferRequest => ({
  kind: "payroll", originAsset: USDC, destinationAsset: USDC, amount: "1000000", swapType: "EXACT_OUTPUT", recipientType: "INTENTS", recipient, batchId: "b1",
});
const swapReq = (amount: string): TransferRequest => ({
  kind: "swap", originAsset: USDC, destinationAsset: WNEAR, amount, swapType: "EXACT_INPUT", recipientType: "INTENTS", recipient: NEAR_USER.account,
});
async function billRow(db: Db, id: string, source: "manual" | "manexus") {
  await db
    .prepare(
      "INSERT INTO bills (id, owner, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, vendor_public_id, status, created_at, updated_at) VALUES (?, ?, 'V', 'R', '2030-01-05', ?, 'INTENTS', 'vendor.near', '1000000', ?, ?, 'scheduled', ?, ?)",
    )
    .bind(id, NEAR_USER.account, USDC, source, source === "manexus" ? "pub-" + id : null, NOW.toISOString(), NOW.toISOString())
    .run();
}
const PER_TX = "This exceeds your per-transaction limit";
const DAILY = "This exceeds your 24-hour limit";
const NOT_LISTED = "Recipient is not on your whitelist";
const signed = (q: { depositAddress: string; intent: { standard: string; payload: unknown } }) => ({
  depositAddress: q.depositAddress,
  signedData: { standard: q.intent.standard, payload: q.intent.payload, public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) },
});

test("no policy, or a policy without limits: quotes are unchanged", async () => {
  const db = createTestDb();
  await quoteTransfer(deps(db), NEAR_USER, withdrawReq({ amount: "90000000" }));
  await setPolicy(db, NEAR_USER.account, { version: 1, reminders: { billDueDays: 1, invoiceOverdueDays: 1 } });
  await quoteTransfer(deps(db), NEAR_USER, withdrawReq({ amount: "9000000" }));
});

test("per-transaction cap: EXACT_INPUT over the cap is 400 before the quote", async () => {
  const db = createTestDb();
  const f = fakes();
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "1000000" } }));
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, withdrawReq({ amount: "1000001" })), 400, PER_TX);
  assert.equal(f.calls.quote.length, 0);
  await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq({ amount: "1000000" }));
  // Caps are per origin token: a USDT cap does not limit USDC.
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDT]: "1" } }));
  await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq({ amount: "5000000" }));
});

test("EXACT_OUTPUT is checked on amountIn after the quote; nothing is stored", async () => {
  const db = createTestDb();
  const f = fakes(); // amountIn = amount * 1.01 = 1010000
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "1009999" } }));
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq()), 400, PER_TX);
  assert.equal(f.calls.quote.length, 1);
  assert.equal(f.calls.generate, 0);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM withdrawals").bind().first<{ n: number }>();
  assert.equal(n?.n, 0);
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1009999" } }));
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq()), 400, DAILY);
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "1010000" }, daily: { [USDC]: "1010000" } }));
  const q = await quoteTransfer(deps(db, f), NEAR_USER, billReq());
  assert.equal(q.transfer.amount, "1010000");
});

test("24-hour cap counts AWAITING (unexpired), PROCESSING and SUCCESS rows of the token, not swaps/expired/refunded/old/other owners", async () => {
  const db = createTestDb();
  await transferRow(db, { status: "AWAITING_SIGNATURE", amount: "1000000" });
  await transferRow(db, { status: "PROCESSING", amount: "1000000", kind: "bill" });
  await transferRow(db, { status: "SUCCESS", amount: "1000000", kind: "payroll" });
  // Not counted:
  await transferRow(db, { status: "AWAITING_SIGNATURE", amount: "50000000", deadline: "2029-12-31T23:59:00.000Z" });
  await transferRow(db, { status: "REFUNDED", amount: "50000000" });
  await transferRow(db, { status: "FAILED", amount: "50000000" });
  await transferRow(db, { status: "SUCCESS", amount: "50000000", kind: "swap" });
  await transferRow(db, { status: "SUCCESS", amount: "50000000", origin: USDT });
  await transferRow(db, { status: "SUCCESS", amount: "50000000", createdAgoMs: 24 * HOUR + 1 });
  await transferRow(db, { status: "SUCCESS", amount: "50000000", owner: "bob.near" });
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "4000000" } }));
  await rejectsWith(quoteTransfer(deps(db), NEAR_USER, withdrawReq({ amount: "1000001" })), 400, DAILY);
  await quoteTransfer(deps(db), NEAR_USER, withdrawReq({ amount: "1000000" }));
  // Now exactly at the cap: nothing more leaves, not even an EXACT_OUTPUT whose amountIn is unknown yet.
  const f = fakes();
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ amount: "1" })), 400, DAILY);
  assert.equal(f.calls.quote.length, 1);
});

test("in-flight statuses (KNOWN_DEPOSIT_TX, INCOMPLETE_DEPOSIT, PENDING_DEPOSIT) count too", async () => {
  const db = createTestDb();
  for (const status of ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PENDING_DEPOSIT"]) await transferRow(db, { status, amount: "1000000" });
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "3500000" } }));
  await rejectsWith(quoteTransfer(deps(db), NEAR_USER, withdrawReq({ amount: "500001" })), 400, DAILY);
});

test("swaps are exempt from caps and the whitelist", async () => {
  const db = createTestDb();
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "1" }, daily: { [USDC]: "1" }, whitelistOnly: true }));
  await quoteTransfer(deps(db), NEAR_USER, swapReq("5000000"));
  await enforceLimits(deps(db), NEAR_USER, swapReq("5000000"), 5000000n);
  // A "swap" that would leave the owner's account is not internal: it is limited like any transfer.
  await rejectsWith(enforceLimits(deps(db), NEAR_USER, { ...swapReq("5000000"), recipient: "bob.near" }, 5000000n), 400, PER_TX);
});

test("a swap-kind row sent to another account counts in the 24-hour window", async () => {
  const db = createTestDb();
  await transferRow(db, { status: "SUCCESS", amount: "1000000", kind: "swap", recipient: "bob.near" });
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1500000" } }));
  await rejectsWith(quoteTransfer(deps(db), NEAR_USER, withdrawReq()), 400, DAILY);
});

test("payroll lines count individually and accumulate in the 24-hour window", async () => {
  const db = createTestDb();
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "1500000" }, daily: { [USDC]: "2500000" } }));
  await quoteTransfer(deps(db), NEAR_USER, payrollReq("p1.near"));
  await quoteTransfer(deps(db), NEAR_USER, payrollReq("p2.near"));
  await rejectsWith(quoteTransfer(deps(db), NEAR_USER, payrollReq("p3.near")), 400, DAILY);
});

test("whitelistOnly blocks withdraw, manual bills and payroll to unlisted recipients but not a Manexus-link bill", async () => {
  const db = createTestDb();
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true, perTx: { [USDC]: "1005000" } }));
  await billRow(db, "bill-manual", "manual");
  await billRow(db, "bill-mx", "manexus");
  const f = fakes();
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, withdrawReq()), 400, NOT_LISTED);
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-manual" })), 400, NOT_LISTED);
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, payrollReq("p1.near")), 400, NOT_LISTED);
  assert.equal(f.calls.quote.length, 0, "whitelist is checked before the quote");
  // A bill id that is not the owner's Manexus bill gets no exemption.
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-nope" })), 400, NOT_LISTED);
  // Manexus-link bill: exempt from the whitelist, not from caps (amountIn 1010000 > 1005000).
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-mx" })), 400, PER_TX);
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true }));
  await quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-mx" }));
  // The exemption covers only the imported invoice's own recipient and token.
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-mx", recipient: "mallory.near" })), 400, NOT_LISTED);
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, billReq({ billId: "bill-mx", destinationAsset: USDT })), 400, NOT_LISTED);
  // Whitelisted (destination asset, recipient) pairs pass; the asset must match too.
  await whitelistRow(db, NEAR_USER.account, USDC, "bob.near");
  await whitelistRow(db, NEAR_USER.account, USDT, "p1.near");
  await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, payrollReq("p1.near")), 400, NOT_LISTED);
  // Another owner's entry does not count.
  await whitelistRow(db, "bob.near", USDC, "p2.near");
  await rejectsWith(quoteTransfer(deps(db, f), NEAR_USER, payrollReq("p2.near")), 400, NOT_LISTED);
});

test("whitelist match on EVM destinations is case-insensitive", async () => {
  const db = createTestDb();
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true }));
  await db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w', ?, 'L', ?, 'DESTINATION_CHAIN', ?, ?)").bind(NEAR_USER.account, ARB_USDC, CHECKSUM_DEST.toLowerCase(), NOW.toISOString()).run();
  await quoteTransfer(deps(db), NEAR_USER, withdrawReq({ destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: CHECKSUM_DEST }));
});

test("submit re-checks the policy: of two quotes that each fit the 24-hour cap, only the first signed one is relayed", async () => {
  const db = createTestDb();
  const f = fakes();
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1500000" } }));
  // Simulate the race: both quotes were taken before either was stored.
  await db.prepare("DELETE FROM agent_policies").bind().run();
  const a = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  const b = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1500000" } }));
  await submitTransfer(deps(db, f), NEAR_USER, signed(a));
  await rejectsWith(submitTransfer(deps(db, f), NEAR_USER, signed(b)), 400, DAILY);
  assert.equal(f.calls.submit, 1);
  const row = await db.prepare("SELECT status FROM withdrawals WHERE deposit_address = ?").bind(b.depositAddress).first<{ status: string }>();
  assert.equal(row?.status, "AWAITING_SIGNATURE");
});

test("submit re-checks the policy: a tightened cap or a removed whitelist entry blocks an older quote", async () => {
  const db = createTestDb();
  const f = fakes();
  await whitelistRow(db, NEAR_USER.account, USDC, "bob.near", "wb");
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true }));
  const a = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  const b = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  await db.prepare("DELETE FROM whitelist WHERE id = 'wb'").bind().run();
  await rejectsWith(submitTransfer(deps(db, f), NEAR_USER, signed(a)), 400, NOT_LISTED);
  await setPolicy(db, NEAR_USER.account, limits({ perTx: { [USDC]: "999999" } }));
  await rejectsWith(submitTransfer(deps(db, f), NEAR_USER, signed(b)), 400, PER_TX);
  assert.equal(f.calls.submit, 0);
});

test("submit recounts after the claim: two submits racing past the pre-claim check do not both relay", async () => {
  const db = createTestDb();
  const f = fakes();
  const a = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  const b = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1500000" } }));
  // While a's claim runs, b's concurrent submit has already claimed b (both passed the pre-claim check).
  const raced: Db = {
    batch: (s) => db.batch(s),
    prepare(sql: string) {
      const s = db.prepare(sql);
      if (!sql.includes("SET status = 'PROCESSING'")) return s;
      return {
        bind(...v: unknown[]) {
          const bound = s.bind(...v);
          return {
            ...bound,
            run: async () => {
              await db.prepare("UPDATE withdrawals SET status = 'PROCESSING' WHERE deposit_address = ?").bind(b.depositAddress).run();
              return bound.run();
            },
          };
        },
      } as ReturnType<Db["prepare"]>;
    },
  };
  await rejectsWith(submitTransfer({ ...deps(db, f), db: raced }, NEAR_USER, signed(a)), 400, DAILY);
  assert.equal(f.calls.submit, 0);
  const row = await db.prepare("SELECT status, upstream, intent_hash FROM withdrawals WHERE deposit_address = ?").bind(a.depositAddress).first<{ status: string; upstream: string | null; intent_hash: string | null }>();
  assert.deepEqual({ ...row }, { status: "AWAITING_SIGNATURE", upstream: null, intent_hash: null });
});

test("committedOnly counts an unsigned quote whose relay was attempted (unexpired), but not the row being submitted", async () => {
  const db = createTestDb();
  const f = fakes();
  const a = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  const b = await quoteTransfer(deps(db, f), NEAR_USER, withdrawReq());
  // a's relay was attempted and failed (it may still land): it is committed for the 24 h window.
  await db.prepare("UPDATE withdrawals SET upstream = ? WHERE deposit_address = ?").bind(JSON.stringify({ submitError: "x", submitAttemptedAt: NOW.toISOString() }), a.depositAddress).run();
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1500000" } }));
  await rejectsWith(submitTransfer(deps(db, f), NEAR_USER, signed(b)), 400, DAILY);
  // Retrying a itself does not count a twice.
  await submitTransfer(deps(db, f), NEAR_USER, signed(a));
  assert.equal(f.calls.submit, 1);
  // b was refused and stays unsigned.
  const c = await db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'AWAITING_SIGNATURE'").bind().first<{ n: number }>();
  assert.equal(c?.n, 1);
});

test("an attempted unsigned quote past its deadline does not count as committed", async () => {
  const db = createTestDb();
  await transferRow(db, { status: "AWAITING_SIGNATURE", amount: "1000000", deadline: "2029-12-31T23:59:00.000Z" });
  await db.prepare("UPDATE withdrawals SET upstream = ?").bind(JSON.stringify({ submitAttemptedAt: "2029-12-31T23:58:00.000Z" })).run();
  await setPolicy(db, NEAR_USER.account, limits({ daily: { [USDC]: "1000000" } }));
  await enforceLimits(deps(db), NEAR_USER, withdrawReq(), 1000000n, { committedOnly: true });
});

test("whitelist match includes the recipient type", async () => {
  const db = createTestDb();
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true }));
  const addr = CHECKSUM_DEST.toLowerCase();
  // Listed as an Intents account, not as an Arbitrum address.
  await db.prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES ('w', ?, 'L', ?, 'INTENTS', ?, ?)").bind(NEAR_USER.account, ARB_USDC, addr, NOW.toISOString()).run();
  await rejectsWith(quoteTransfer(deps(db), NEAR_USER, withdrawReq({ destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: CHECKSUM_DEST })), 400, NOT_LISTED);
  await quoteTransfer(deps(db), NEAR_USER, withdrawReq({ destinationAsset: ARB_USDC, recipientType: "INTENTS", recipient: addr }));
});

test("query budget: a quote under a full policy and its submit stay small", async () => {
  const db = createTestDb();
  await billRow(db, "bill-manual", "manual");
  await whitelistRow(db, NEAR_USER.account, USDC, "vendor.near");
  for (let i = 0; i < 20; i++) await transferRow(db, { status: "SUCCESS", amount: "1000" });
  await setPolicy(db, NEAR_USER.account, limits({ whitelistOnly: true, perTx: { [USDC]: "5000000" }, daily: { [USDC]: "50000000" } }));
  db.queries = 0;
  const q = await quoteTransfer(deps(db), NEAR_USER, billReq({ billId: "bill-manual" }));
  console.log(`quote under policy: ${db.queries} queries`);
  assert.ok(db.queries <= 15, `${db.queries} queries`);
  db.queries = 0;
  await submitTransfer(deps(db), NEAR_USER, signed(q));
  console.log(`submit under policy: ${db.queries} queries`);
  assert.ok(db.queries <= 12, `${db.queries} queries`);
});

// --- routes ---

test("routes: auth required; GET policy, POST challenge, GET whitelist for a signed-in owner", async () => {
  const db = createTestDb();
  const SECRET = "s".repeat(32);
  const env = { DB: db, SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.invalid", ONECLICK_BASE_URL: "https://1click.invalid" } as unknown as Env;
  const base = "https://app.manexus.test/api/agent";
  assert.equal((await policyGet({ request: new Request(`${base}/policy`), env } as never)).status, 401);
  assert.equal((await policyPut({ request: new Request(`${base}/policy`, { method: "PUT", body: "{}" }), env } as never)).status, 401);
  assert.equal((await challengePost({ request: new Request(`${base}/policy/challenge`, { method: "POST", body: "{}" }), env } as never)).status, 401);
  assert.equal((await whitelistGet({ request: new Request(`${base}/whitelist`), env } as never)).status, 401);
  assert.equal((await whitelistPost({ request: new Request(`${base}/whitelist`, { method: "POST", body: "{}" }), env } as never)).status, 401);
  assert.equal((await whitelistDelete({ request: new Request(`${base}/whitelist`, { method: "DELETE", body: "{}" }), env } as never)).status, 401);
  const cookie = `mx_session=${await signSession(EVM_USER.account, "evm", SECRET)}`;
  const g = await policyGet({ request: new Request(`${base}/policy`, { headers: { cookie } }), env } as never);
  assert.deepEqual([g.status, await g.json()], [200, { policy: null, hash: null, updatedAt: null }]);
  const w = await whitelistGet({ request: new Request(`${base}/whitelist`, { headers: { cookie } }), env } as never);
  assert.deepEqual([w.status, await w.json()], [200, []]);
  const policy = { version: 1, reminders: { billDueDays: 2, invoiceOverdueDays: 7 } };
  const c = await challengePost({ request: new Request(`${base}/policy/challenge`, { method: "POST", headers: { cookie }, body: JSON.stringify({ kind: "policy", policy }) }), env } as never);
  assert.equal(c.status, 200);
  const ch = (await c.json()) as { nonce: string; message: string };
  const p = await policyPut({
    request: new Request(`${base}/policy`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ policy, nonce: ch.nonce, signature: await signEvm(ch.message) }) }),
    env,
  } as never);
  assert.equal(p.status, 200);
  assert.deepEqual(((await p.json()) as { policy: unknown }).policy, policy);
  const bad = await challengePost({ request: new Request(`${base}/policy/challenge`, { method: "POST", headers: { cookie }, body: JSON.stringify({ kind: "nope" }) }), env } as never);
  assert.equal(bad.status, 400);
});
