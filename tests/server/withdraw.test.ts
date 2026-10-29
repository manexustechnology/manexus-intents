import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { createTestDb } from "./d1-shim.ts";
import type { Db } from "../../server/db.ts";
import type { NearRpc } from "../../server/near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus } from "../../server/oneclick.ts";
import { HttpError } from "../../server/http.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import {
  keyStatus,
  listWithdrawals,
  quoteWithdrawal,
  refreshWithdrawal,
  submitWithdrawal,
  type WithdrawDeps,
} from "../../server/withdraw.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const NEAR_USER = { account: "alice.near", kind: "near" as const };
const EVM_USER = { account: "0x1111111111111111111111111111111111111111", kind: "evm" as const };
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const DEP = "a".repeat(64);
const NOW = new Date("2030-01-01T00:00:00.000Z");
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TOKENS: OneClickToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: "nep141:weird.omft.near", symbol: "W", blockchain: "zzz", decimals: 6 },
];

const intents = (amount = "1000000", receiver = DEP, token = USDC) => [{ intent: "transfer", receiver_id: receiver, tokens: { [token]: amount } }];
function nepPayload(signer = NEAR_USER.account, over: { intents?: unknown; deadline?: string; recipient?: string } = {}) {
  return {
    recipient: over.recipient ?? "intents.near",
    nonce: NONCE,
    message: JSON.stringify({ signer_id: signer, deadline: over.deadline ?? "2030-01-01T00:10:00.000Z", intents: over.intents ?? intents() }),
  };
}
function ercPayload(signer = EVM_USER.account, over: { intents?: unknown; deadline?: string } = {}) {
  return JSON.stringify({
    signer_id: signer, verifying_contract: "intents.near", deadline: over.deadline ?? "2030-01-01T00:10:00.000Z", nonce: NONCE, intents: over.intents ?? intents(),
  });
}
const NEP_SIG = { public_key: "ed25519:" + base58.encode(new Uint8Array(32).fill(3)), signature: "ed25519:" + base58.encode(new Uint8Array(64).fill(4)) };
const ERC_SIG = "secp256k1:" + base58.encode(new Uint8Array(65).fill(5).map((b, i) => (i === 64 ? 1 : b)));

type Calls = { quote: QuoteRequest[]; generate: unknown[]; submit: unknown[]; status: string[] };
function fakes(o: {
  balance?: string;
  payload?: (signer: string, standard: string) => unknown;
  quote?: Partial<Quote>;
  submit?: () => Promise<{ intentHash: string }>;
  status?: () => Promise<SwapStatus>;
  hasKey?: boolean;
} = {}) {
  const calls: Calls & { rpc: { method: string; args: unknown }[] } = { quote: [], generate: [], submit: [], status: [], rpc: [] };
  const rpc: NearRpc = {
    viewAccessKey: async () => null,
    viewFunction: (async (_c: string, method: string, args: { token_ids?: string[] }) => {
      calls.rpc.push({ method, args });
      if (method === "has_public_key") return o.hasKey ?? false;
      return (args.token_ids ?? []).map((id) => (id === USDC ? (o.balance ?? "5000000") : "0"));
    }) as NearRpc["viewFunction"],
  };
  const oneclick = {
    tokens: async () => TOKENS,
    quote: async (r: QuoteRequest): Promise<Quote> => {
      calls.quote.push(r);
      return { depositAddress: DEP, amountIn: r.amount, minAmountIn: r.amount, amountOut: "990000", minAmountOut: "980000", deadline: "2030-01-01T00:10:00.000Z", ...o.quote };
    },
    generateIntent: async (a: { depositAddress: string; signerId: string; standard: "nep413" | "erc191" }) => {
      calls.generate.push(a);
      const payload = o.payload ? o.payload(a.signerId, a.standard) : a.standard === "nep413" ? nepPayload(a.signerId) : ercPayload(a.signerId);
      return { standard: a.standard, payload };
    },
    submitIntent: async (s: unknown) => {
      calls.submit.push(s);
      return o.submit ? o.submit() : { intentHash: "IntentHash111" };
    },
    status: async (d: string) => {
      calls.status.push(d);
      if (!o.status) throw new Error("status not stubbed");
      return o.status();
    },
  };
  return { rpc, oneclick, calls };
}
const deps = (db: Db, f: ReturnType<typeof fakes>, now = NOW): WithdrawDeps => ({ db, rpc: f.rpc, oneclick: f.oneclick, now });
const body = (over: Record<string, unknown> = {}) => ({ originAsset: USDC, amount: "1000000", destinationAsset: ARB_USDC, recipient: RECIPIENT, ...over });
const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof HttpError ? e.status : -1));
const rowOf = (db: Db, d = DEP) => db.prepare("SELECT * FROM withdrawals WHERE deposit_address = ?").bind(d).first<Record<string, unknown>>().then((r) => (r ? { ...r } : null));

test("EVM quote: INTENTS deposit, refund to own account, destination-chain recipient, erc191 intent", async () => {
  const db = createTestDb();
  const f = fakes();
  const out = await quoteWithdrawal(deps(db, f), EVM_USER, body());
  const q = f.calls.quote[0];
  assert.equal(q.dry, false);
  assert.equal(q.swapType, "EXACT_INPUT");
  assert.equal(q.depositType, "INTENTS");
  assert.equal(q.refundType, "INTENTS");
  assert.equal(q.refundTo, EVM_USER.account);
  assert.equal(q.recipientType, "DESTINATION_CHAIN");
  assert.equal(q.recipient, RECIPIENT);
  assert.equal(q.originAsset, USDC);
  assert.equal(q.destinationAsset, ARB_USDC);
  assert.equal(q.amount, "1000000");
  assert.equal(q.slippageTolerance, 100);
  assert.equal(q.referral, "manexus");
  assert.equal(q.deadline, "2030-01-01T00:10:00.000Z");
  assert.deepEqual(f.calls.generate[0], { depositAddress: DEP, signerId: EVM_USER.account, standard: "erc191" });
  assert.equal(out.depositAddress, DEP);
  assert.equal(out.amountOut, "990000");
  assert.equal(out.amountOutFormatted, "0.99");
  assert.equal(out.minAmountOut, "980000");
  assert.equal(out.intent.standard, "erc191");
  assert.equal(out.intent.payload, ercPayload());
  const row = await rowOf(db);
  assert.equal(row?.status, "AWAITING_SIGNATURE");
  assert.equal(row?.owner, EVM_USER.account);
  assert.equal(row?.recipient, RECIPIENT);
  assert.equal(row?.amount, "1000000");
  assert.deepEqual(JSON.parse(String(row?.intent)).payload, ercPayload());
});

test("NEAR quote uses nep413", async () => {
  const f = fakes();
  const out = await quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body());
  assert.deepEqual(f.calls.generate[0], { depositAddress: DEP, signerId: "alice.near", standard: "nep413" });
  assert.deepEqual(out.intent.payload, nepPayload());
});

test("amount over balance is 400 and no quote is requested", async () => {
  const f = fakes({ balance: "1000000" });
  await assert.rejects(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ amount: "1000001" })), { status: 400, message: "Amount exceeds your balance" });
  assert.equal(f.calls.quote.length, 0);
  assert.equal(f.calls.generate.length, 0);
});

test("full balance is allowed", async () => {
  const f = fakes({ balance: "1000000" });
  await quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ amount: "1000000" }));
  assert.equal(f.calls.quote.length, 1);
});

test("origin token not held is 400", async () => {
  const f = fakes();
  await assert.rejects(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ originAsset: "nep141:usdt.tether-token.near" })), { status: 400 });
  assert.equal(f.calls.quote.length, 0);
});

test("invalid amounts are 400", async () => {
  for (const amount of ["0", "-1", "01", "1.5", "", "1e6", 5, "9".repeat(80)]) {
    const f = fakes();
    assert.equal(await status(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ amount }))), 400, String(amount));
    assert.equal(f.calls.quote.length, 0);
  }
});

test("recipient alice.near for an arb destination is 400", async () => {
  const f = fakes();
  await assert.rejects(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ recipient: "alice.near" })), { status: 400 });
  assert.equal(f.calls.quote.length, 0);
});

test("unknown or unsupported-chain destination token is 400", async () => {
  for (const destinationAsset of ["nep141:nope", "nep141:weird.omft.near"]) {
    const f = fakes();
    assert.equal(await status(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ destinationAsset }))), 400);
    assert.equal(f.calls.quote.length, 0);
  }
});

test("same asset (pure bridge to a NEAR address) is allowed", async () => {
  const f = fakes();
  await quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body({ destinationAsset: USDC, recipient: "bob.near" }));
  assert.equal(f.calls.quote[0].destinationAsset, USDC);
});

test("generated intent that does not match the quote is rejected with 502 and not stored", async () => {
  const cases: [string, (s: string, st: string) => unknown][] = [
    ["other signer", (_s, st) => (st === "nep413" ? nepPayload("mallory.near") : ercPayload("0x9999999999999999999999999999999999999999"))],
    ["other receiver", () => nepPayload("alice.near", { intents: intents("1000000", "b".repeat(64)) })],
    ["other amount", () => nepPayload("alice.near", { intents: intents("5000000") })],
    ["other token", () => nepPayload("alice.near", { intents: intents("1000000", DEP, ARB_USDC) })],
    ["extra intent", () => nepPayload("alice.near", { intents: [...intents(), ...intents("1", "c".repeat(64))] })],
    ["other intent type", () => nepPayload("alice.near", { intents: [{ intent: "ft_withdraw", receiver_id: DEP, tokens: { [USDC]: "1000000" } }] })],
    ["other contract", () => nepPayload("alice.near", { recipient: "evil.near" })],
    ["expired deadline", () => nepPayload("alice.near", { deadline: "2029-12-31T23:59:00.000Z" })],
    ["bad nonce", () => ({ ...nepPayload(), nonce: "AAAA" })],
    ["string payload for nep413", () => ercPayload("alice.near")],
  ];
  for (const [name, payload] of cases) {
    const db = createTestDb();
    const f = fakes({ payload });
    assert.equal(await status(quoteWithdrawal(deps(db, f), NEAR_USER, body())), 502, name);
    assert.equal(await rowOf(db), null, name);
  }
});

test("upstream quote that does not echo the amount is 502", async () => {
  const f = fakes({ quote: { amountIn: "999" } });
  assert.equal(await status(quoteWithdrawal(deps(createTestDb(), f), NEAR_USER, body())), 502);
  assert.equal(f.calls.generate.length, 0);
});

async function quoted(user = NEAR_USER, o: Parameters<typeof fakes>[0] = {}) {
  const db = createTestDb();
  const f = fakes(o);
  const q = await quoteWithdrawal(deps(db, f), user, body());
  return { db, f, q };
}
const nepSigned = (payload: unknown) => ({ standard: "nep413", payload, ...NEP_SIG });

test("NEAR submit relays signedData built from the stored payload, stores hash, PROCESSING", async () => {
  const { db, f, q } = await quoted();
  const out = await submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) });
  assert.equal(out.status, "PROCESSING");
  assert.equal(out.intentHash, "IntentHash111");
  assert.deepEqual(f.calls.submit[0], { standard: "nep413", payload: nepPayload(), public_key: NEP_SIG.public_key, signature: NEP_SIG.signature });
  const row = await rowOf(db);
  assert.equal(row?.status, "PROCESSING");
  assert.equal(row?.intent_hash, "IntentHash111");
});

test("EVM submit relays erc191 signedData without public_key", async () => {
  const { db, f, q } = await quoted(EVM_USER);
  await submitWithdrawal(deps(db, f), EVM_USER, { depositAddress: DEP, signedData: { standard: "erc191", payload: q.intent.payload, signature: ERC_SIG } });
  assert.deepEqual(f.calls.submit[0], { standard: "erc191", payload: ercPayload(), signature: ERC_SIG });
});

test("submit with signer_id of another account is 403 (even if it were stored)", async () => {
  const { db, f } = await quoted();
  // Tamper the stored row so the stored payload itself names another signer.
  const other = nepPayload("mallory.near");
  const rec = JSON.parse(String((await rowOf(db))?.intent));
  await db.prepare("UPDATE withdrawals SET intent = ?").bind(JSON.stringify({ ...rec, payload: other })).run();
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(other) })), 403);
  assert.equal(f.calls.submit.length, 0);
});

test("submit with a modified payload is 403", async () => {
  const { db, f } = await quoted();
  const modified = { ...nepPayload(), message: JSON.parse(JSON.stringify(nepPayload().message).replace(DEP, "b".repeat(64))) };
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(modified) })), 403);
  const extraKey = { ...nepPayload(), callbackUrl: "x" };
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(extraKey) })), 403);
  assert.equal(f.calls.submit.length, 0);
  assert.equal((await rowOf(db))?.status, "AWAITING_SIGNATURE");
});

test("submit with the wrong standard or malformed signature is rejected", async () => {
  const { db, f, q } = await quoted();
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: { standard: "erc191", payload: q.intent.payload, signature: ERC_SIG } })), 403);
  for (const bad of [
    { ...nepSigned(q.intent.payload), signature: "ed25519:0OIl" },
    { ...nepSigned(q.intent.payload), public_key: "secp256k1:abc" },
    { standard: "nep413", payload: q.intent.payload, signature: NEP_SIG.signature },
    null,
    "x",
  ]) assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: bad })), 400);
  assert.equal(f.calls.submit.length, 0);
});

test("user B submitting A's depositAddress is 404", async () => {
  const { db, f, q } = await quoted();
  const bob = { account: "bob.near", kind: "near" as const };
  assert.equal(await status(submitWithdrawal(deps(db, f), bob, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) })), 404);
  assert.equal(await status(refreshWithdrawal(deps(db, f), bob, DEP)), 404);
  assert.deepEqual(await listWithdrawals(deps(db, f), bob), []);
  assert.equal(f.calls.submit.length, 0);
});

test("second submit is 409 and relays once; concurrent submits relay once", async () => {
  const { db, f, q } = await quoted();
  const args = { depositAddress: DEP, signedData: nepSigned(q.intent.payload) };
  const [a, b] = await Promise.all([status(submitWithdrawal(deps(db, f), NEAR_USER, args)), status(submitWithdrawal(deps(db, f), NEAR_USER, args))]);
  assert.deepEqual([a, b].sort(), [0, 409]);
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, args)), 409);
  assert.equal(f.calls.submit.length, 1);
});

test("expired quote is 409 and nothing is relayed", async () => {
  const { db, f, q } = await quoted();
  const later = new Date("2030-01-01T00:10:00.000Z");
  await assert.rejects(submitWithdrawal(deps(db, f, later), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) }), {
    status: 409, message: "Quote expired, request a new one",
  });
  assert.equal(f.calls.submit.length, 0);
});

test("upstream submit failure reverts to AWAITING_SIGNATURE so the same signed intent can be retried", async () => {
  let fail = true;
  const { db, f, q } = await quoted(NEAR_USER, { submit: async () => { if (fail) throw new HttpError(502, "NEAR Intents: boom"); return { intentHash: "H2" }; } });
  const args = { depositAddress: DEP, signedData: nepSigned(q.intent.payload) };
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, args)), 502);
  assert.equal((await rowOf(db))?.status, "AWAITING_SIGNATURE");
  fail = false;
  assert.equal((await submitWithdrawal(deps(db, f), NEAR_USER, args)).intentHash, "H2");
});

const swap = (st: SwapStatus["status"], over: Partial<SwapStatus> = {}): SwapStatus => ({
  status: st, updatedAt: NOW.toISOString(), quoteRequest: {} as QuoteRequest, originTxHashes: [], destinationTxHashes: [], ...over,
});

test("status refresh SUCCESS stores SUCCESS and exposes destinationTxHashes", async () => {
  const { db, q } = await quoted();
  const f = fakes({ status: async () => swap("SUCCESS", { amountOut: "990000", destinationTxHashes: ["0x" + "ab".repeat(32)] }) });
  await submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) });
  const out = await refreshWithdrawal(deps(db, f, new Date(NOW.getTime() + 60_000)), NEAR_USER, DEP);
  assert.equal(out.status, "SUCCESS");
  assert.deepEqual(out.destinationTxHashes, ["0x" + "ab".repeat(32)]);
  assert.equal(out.destinationBlockchain, "arb");
  assert.equal(out.recipient, RECIPIENT);
  assert.equal((await rowOf(db))?.status, "SUCCESS");
  // Terminal: no more upstream calls.
  await refreshWithdrawal(deps(db, f, new Date(NOW.getTime() + 120_000)), NEAR_USER, DEP);
  assert.equal(f.calls.status.length, 1);
  const list = await listWithdrawals(deps(db, f), NEAR_USER);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "SUCCESS");
});

test("refresh of an unsigned withdrawal does not call upstream; list hides unsigned quotes", async () => {
  const { db, f } = await quoted();
  const out = await refreshWithdrawal(deps(db, f), NEAR_USER, DEP);
  assert.equal(out.status, "AWAITING_SIGNATURE");
  assert.equal(f.calls.status.length, 0);
  assert.deepEqual(await listWithdrawals(deps(db, f), NEAR_USER), []);
});

test("refresh upstream error returns stored state with refreshError", async () => {
  const { db, q } = await quoted();
  const f = fakes({ status: async () => { throw new HttpError(502, "NEAR Intents is unreachable"); } });
  await submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) });
  const out = await refreshWithdrawal(deps(db, f, new Date(NOW.getTime() + 60_000)), NEAR_USER, DEP);
  assert.equal(out.status, "PROCESSING");
  assert.equal(out.refreshError, "NEAR Intents is unreachable");
});

test("keyStatus: EVM never needs registration; NEAR named account checks intents.near has_public_key", async () => {
  const f = fakes({ hasKey: false });
  assert.deepEqual(await keyStatus({ rpc: f.rpc }, EVM_USER, ""), { required: false, registered: true });
  assert.deepEqual(await keyStatus({ rpc: f.rpc }, NEAR_USER, NEP_SIG.public_key), { required: true, registered: false });
  assert.deepEqual(f.calls.rpc.at(-1), { method: "has_public_key", args: { account_id: "alice.near", public_key: NEP_SIG.public_key } });
  const g = fakes({ hasKey: true });
  assert.deepEqual(await keyStatus({ rpc: g.rpc }, NEAR_USER, NEP_SIG.public_key), { required: true, registered: true });
  assert.equal(await status(keyStatus({ rpc: f.rpc }, NEAR_USER, "ed25519:not base58 0OIl")), 400);
});

test("keyStatus: implicit account with its own key needs no registration", async () => {
  const pk = new Uint8Array(32).fill(9);
  const implicit = { account: Buffer.from(pk).toString("hex"), kind: "near" as const };
  const f = fakes({ hasKey: false });
  assert.deepEqual(await keyStatus({ rpc: f.rpc }, implicit, "ed25519:" + base58.encode(pk)), { required: false, registered: true });
  assert.equal(f.calls.rpc.length, 0);
});

test("a failed submit stays visible in history and is refreshed from 1Click", async () => {
  let st: SwapStatus = swap("PENDING_DEPOSIT");
  const { db, f, q } = await quoted(NEAR_USER, { submit: async () => { throw new HttpError(502, "NEAR Intents is unreachable"); }, status: async () => st });
  assert.equal(await status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) })), 502);
  assert.equal((await listWithdrawals(deps(db, f), NEAR_USER)).length, 1);
  const later = (s: number) => new Date(NOW.getTime() + s * 1000);
  assert.equal((await refreshWithdrawal(deps(db, f, later(60)), NEAR_USER, DEP)).status, "AWAITING_SIGNATURE");
  st = swap("PROCESSING");
  assert.equal((await refreshWithdrawal(deps(db, f, later(120)), NEAR_USER, DEP)).status, "PROCESSING");
  assert.equal(f.calls.status.length, 2);
});

test("a refresh racing a slow submit keeps PROCESSING, so a later submit failure still reverts", async () => {
  let release!: (fail: boolean) => void;
  const gate = new Promise<boolean>((r) => (release = r));
  const { db, f, q } = await quoted(NEAR_USER, {
    submit: async () => {
      if (await gate) throw new HttpError(502, "NEAR Intents: boom");
      return { intentHash: "H" };
    },
    status: async () => swap("PENDING_DEPOSIT"),
  });
  const submitting = status(submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) }));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.submit.length, 1, "submit is in flight");
  const mid = await refreshWithdrawal(deps(db, f, new Date(NOW.getTime() + 60_000)), NEAR_USER, DEP);
  assert.equal(f.calls.status.length, 1);
  assert.equal(mid.status, "PROCESSING");
  assert.equal((await rowOf(db))?.status, "PROCESSING");
  release(true);
  assert.equal(await submitting, 502);
  const row = await rowOf(db);
  assert.equal(row?.status, "AWAITING_SIGNATURE");
  assert.match(String(row?.upstream), /submitError/);
});

test("a PROCESSING row with no intent hash that 1Click never saw fails after the deadline plus 2 minutes", async () => {
  const { db, f, q } = await quoted(NEAR_USER, { status: async () => swap("PENDING_DEPOSIT") });
  const dl = new Date(q.deadline).getTime();
  await db.prepare("UPDATE withdrawals SET status = 'PROCESSING' WHERE deposit_address = ?").bind(DEP).run();
  const at = (ms: number) => new Date(ms);
  assert.equal((await refreshWithdrawal(deps(db, f, at(dl + 119_000)), NEAR_USER, DEP)).status, "PROCESSING");
  const failed = await refreshWithdrawal(deps(db, f, at(dl + 130_000)), NEAR_USER, DEP);
  assert.equal(failed.status, "FAILED");
  assert.equal((await rowOf(db))?.status, "FAILED");
  assert.equal(failed.expiredUnsubmitted, true);
});

test("the stuck-submit expiry does not touch a row that has an intent hash", async () => {
  const { db, f, q } = await quoted(NEAR_USER, { status: async () => swap("PENDING_DEPOSIT") });
  await db.prepare("UPDATE withdrawals SET status = 'PROCESSING', intent_hash = 'H' WHERE deposit_address = ?").bind(DEP).run();
  const before = await rowOf(db);
  const out = await refreshWithdrawal(deps(db, f, new Date(new Date(q.deadline).getTime() + 600_000)), NEAR_USER, DEP);
  assert.equal(out.status, "PENDING_DEPOSIT");
  assert.equal(out.expiredUnsubmitted, undefined);
  assert.equal((await rowOf(db))?.intent_hash, before?.intent_hash);
});

test("an upstream FAILED with no intent hash is plain FAILED, not expired-unsubmitted", async () => {
  const { db, f, q } = await quoted(NEAR_USER, { status: async () => swap("FAILED") });
  await db.prepare("UPDATE withdrawals SET status = 'PROCESSING' WHERE deposit_address = ?").bind(DEP).run();
  const out = await refreshWithdrawal(deps(db, f, new Date(new Date(q.deadline).getTime() + 600_000)), NEAR_USER, DEP);
  assert.equal(out.status, "FAILED");
  assert.equal(out.expiredUnsubmitted, undefined);
  assert.doesNotMatch(String((await rowOf(db))?.upstream), /stuckSubmit/);
});

test("a submit that lands after the stuck-submit rule failed the row records its hash and tracks it again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { db, f, q } = await quoted(NEAR_USER, {
    submit: async () => { await gate; return { intentHash: "LATE" }; },
    status: async () => swap("PENDING_DEPOSIT"),
  });
  const submitting = submitWithdrawal(deps(db, f), NEAR_USER, { depositAddress: DEP, signedData: nepSigned(q.intent.payload) });
  await new Promise((r) => setImmediate(r));
  const failed = await refreshWithdrawal(deps(db, f, new Date(new Date(q.deadline).getTime() + 130_000)), NEAR_USER, DEP);
  assert.equal(failed.status, "FAILED");
  release();
  const out = await submitting;
  assert.equal(out.status, "PROCESSING");
  assert.equal(out.expiredUnsubmitted, undefined);
  const row = await rowOf(db);
  assert.equal(row?.intent_hash, "LATE");
  assert.equal(row?.upstream, null);
});
