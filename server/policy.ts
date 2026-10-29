// The owner's treasury policy (agent rules and spending limits) and recipient whitelist. Every change is
// authorized by a fresh wallet signature over `Manexus policy v1\nAccount\nHash\nNonce`, where Hash is the
// sha256 of the canonical JSON of the exact change; the challenge row is bound to that hash (`purpose`) and
// consumed once. Spending limits are enforced by the transfer engine (server/transfers.ts) via `enforceLimits`.
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { supportedChain, validDestination, validIntentsAccount } from "../shared/address.ts";
import { SETTLEMENT_TOKENS } from "../shared/assets.ts";
import { CHALLENGE_TTL_MS, RECIPIENT, verifySignedMessage } from "./auth.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { NearRpc } from "./near-rpc.ts";
import type { OneClickToken } from "./oneclick.ts";
import type { TransferRequest } from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };
type Rec = Record<string, unknown>;

export type Policy = {
  version: 1;
  convert?: { enabled: boolean; targetTokenId: string; minUsdCents: number };
  sweep?: { enabled: boolean; tokenId: string; thresholdUnits: string; keepUnits: string; whitelistId: string };
  limits?: { perTx: Record<string, string>; daily: Record<string, string>; whitelistOnly: boolean };
  reminders?: { billDueDays: number; invoiceOverdueDays: number };
};

export type WhitelistInput = { label: string; destinationAsset: string; recipientType: "DESTINATION_CHAIN" | "INTENTS"; recipient: string };
export type WhitelistEntry = WhitelistInput & { id: string; createdAt: string };

export type PolicyAction =
  | { kind: "policy"; policy: Policy }
  | { kind: "whitelist_add"; entry: WhitelistInput }
  | { kind: "whitelist_remove"; id: string };

export type PolicyView = { policy: Policy | null; hash: string | null; updatedAt: string | null };

export const PER_TX_LIMIT = "This exceeds your per-transaction limit";
export const DAILY_LIMIT = "This exceeds your 24-hour limit";
export const NOT_WHITELISTED = "Recipient is not on your whitelist";
const MISMATCH = "Signature does not match this change";
const MAX_WHITELIST = 50;
const MAX_LIMIT_TOKENS = 50;
const MAX_LABEL = 60;
const DAY_MS = 24 * 3_600_000;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (msg: string) => new HttpError(400, msg);
const POSITIVE_UNITS = /^[1-9][0-9]{0,77}$/;
const UNITS = /^(0|[1-9][0-9]{0,77})$/;
// Intents token ids ("nep141:…", "nep245:…"). The prefix also keeps keys like "__proto__" out of the records.
const TOKEN_ID = /^nep[0-9]{3}:[A-Za-z0-9._:-]{1,190}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/;

function only(v: unknown, keys: readonly string[], what: string): Rec {
  if (!isRec(v)) throw bad(`Invalid ${what}.`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw bad(`Unknown field in ${what}: ${k.slice(0, 40)}`);
  for (const k of keys) if (!Object.hasOwn(v, k)) throw bad(`Missing field in ${what}: ${k}`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw bad(`Invalid ${what}.`);
  return v;
}
function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}
function units(v: unknown, what: string, positive = true): string {
  if (typeof v !== "string" || !(positive ? POSITIVE_UNITS : UNITS).test(v)) throw bad(`${what} must be a whole number of base units.`);
  return v;
}
function tokenId(v: unknown, what: string): string {
  if (typeof v !== "string" || !TOKEN_ID.test(v)) throw bad(`Invalid ${what}.`);
  return v;
}
function caps(v: unknown, what: string): Record<string, string> {
  if (!isRec(v)) throw bad(`Invalid ${what}.`);
  const entries = Object.entries(v);
  if (entries.length > MAX_LIMIT_TOKENS) throw bad(`Too many tokens in ${what}.`);
  const out: Record<string, string> = {};
  for (const [k, x] of entries) out[tokenId(k, `token in ${what}`)] = units(x, what);
  return out;
}

/**
 * Strict policy validator for manual edits and AI drafts alike: unknown keys, missing keys, non-digit unit
 * strings, out-of-range numbers, `keepUnits >= thresholdUnits`, a non-settlement convert target and a sweep
 * whitelist id the owner does not have are all 400. Returns a fresh object (no input references kept).
 */
export function parsePolicy(v: unknown, ctx: { settlementTokens: readonly { tokenId: string }[]; whitelistIds: Set<string> }): Policy {
  const known = ["version", "convert", "sweep", "limits", "reminders"];
  if (!isRec(v)) throw bad("Invalid policy.");
  for (const k of Object.keys(v)) if (!known.includes(k)) throw bad(`Unknown field in policy: ${k.slice(0, 40)}`);
  if (v.version !== 1) throw bad("Unsupported policy version.");
  const out: Policy = { version: 1 };
  if (v.convert !== undefined) {
    const c = only(v.convert, ["enabled", "targetTokenId", "minUsdCents"], "convert rule");
    const target = tokenId(c.targetTokenId, "convert target");
    if (!ctx.settlementTokens.some((t) => t.tokenId === target)) throw bad("Convert to USDC or USDT.");
    out.convert = { enabled: bool(c.enabled, "convert switch"), targetTokenId: target, minUsdCents: int(c.minUsdCents, 0, 100_000_000_000, "Minimum (cents)") };
  }
  if (v.sweep !== undefined) {
    const s = only(v.sweep, ["enabled", "tokenId", "thresholdUnits", "keepUnits", "whitelistId"], "sweep rule");
    const thresholdUnits = units(s.thresholdUnits, "Sweep threshold");
    const keepUnits = units(s.keepUnits, "Amount to keep", false);
    if (BigInt(keepUnits) >= BigInt(thresholdUnits)) throw bad("The amount to keep must be below the sweep threshold.");
    if (typeof s.whitelistId !== "string" || !ctx.whitelistIds.has(s.whitelistId)) throw bad("Sweep to an address on your whitelist.");
    out.sweep = { enabled: bool(s.enabled, "sweep switch"), tokenId: tokenId(s.tokenId, "sweep token"), thresholdUnits, keepUnits, whitelistId: s.whitelistId };
  }
  if (v.limits !== undefined) {
    const l = only(v.limits, ["perTx", "daily", "whitelistOnly"], "limits");
    out.limits = { perTx: caps(l.perTx, "per-transaction limits"), daily: caps(l.daily, "24-hour limits"), whitelistOnly: bool(l.whitelistOnly, "whitelist-only switch") };
  }
  if (v.reminders !== undefined) {
    const r = only(v.reminders, ["billDueDays", "invoiceOverdueDays"], "reminders");
    out.reminders = { billDueDays: int(r.billDueDays, 0, 30, "Bill reminder days"), invoiceOverdueDays: int(r.invoiceOverdueDays, 0, 90, "Invoice reminder days") };
  }
  return out;
}

/** JSON with object keys sorted at every level and no whitespace. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRec(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = (s: string) => hex(sha256(new TextEncoder().encode(s)));

export const canonicalPolicyJson = (p: Policy): string => canonicalJson(p);
export const policyHash = (p: Policy): string => sha256Hex(canonicalPolicyJson(p));
/** The hash a policy change's signature covers: sha256 hex of the canonical JSON of the whole action. */
export const actionHash = (a: PolicyAction): string => sha256Hex(canonicalJson(a));

export const policyMessage = (account: string, hash: string, nonce: string) => `Manexus policy v1\nAccount: ${account}\nHash: ${hash}\nNonce: ${nonce}`;

/** EVM hex addresses compare lowercase (intents.near ids and EVM chains are case-insensitive); others exactly. */
const normRecipient = (r: string) => (EVM_HEX.test(r) ? r.toLowerCase() : r);

/** Shape and normalization of a whitelist entry; the token/recipient check against the token list is in `addWhitelist`. */
function normalizeEntry(v: unknown): WhitelistInput {
  const e = only(v, ["label", "destinationAsset", "recipientType", "recipient"], "whitelist entry");
  if (typeof e.label !== "string" || !e.label.trim() || e.label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(e.label))
    throw bad(`Enter a label (up to ${MAX_LABEL} characters).`);
  if (typeof e.destinationAsset !== "string" || !TOKEN_ID.test(e.destinationAsset)) throw bad("Choose a token.");
  if (e.recipientType !== "DESTINATION_CHAIN" && e.recipientType !== "INTENTS") throw bad("Unknown recipient type.");
  if (typeof e.recipient !== "string" || !e.recipient.trim() || e.recipient.length > 200) throw bad("Enter the address.");
  return { label: e.label.trim(), destinationAsset: e.destinationAsset, recipientType: e.recipientType, recipient: normRecipient(e.recipient.trim()) };
}

async function whitelistIds(db: Db, owner: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT id FROM whitelist WHERE owner = ?").bind(owner).all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/** The action as it will be hashed: validated and normalized, so the challenge and the submit hash agree. */
async function normalizeAction(db: Db, user: User, v: unknown): Promise<PolicyAction> {
  const a = isRec(v) ? v : {};
  if (a.kind === "policy") {
    only(a, ["kind", "policy"], "change");
    return { kind: "policy", policy: parsePolicy(a.policy, { settlementTokens: SETTLEMENT_TOKENS, whitelistIds: await whitelistIds(db, user.account) }) };
  }
  if (a.kind === "whitelist_add") {
    only(a, ["kind", "entry"], "change");
    return { kind: "whitelist_add", entry: normalizeEntry(a.entry) };
  }
  if (a.kind === "whitelist_remove") {
    only(a, ["kind", "id"], "change");
    if (typeof a.id !== "string" || !ID.test(a.id)) throw new HttpError(404, "Whitelist entry not found");
    return { kind: "whitelist_remove", id: a.id };
  }
  throw bad("Unknown change.");
}

const purposeOf = (a: PolicyAction, hash: string) => `${a.kind}:${hash}`;

/**
 * A single-use, 5-minute challenge for one policy change. The owner signs `message` (ERC-191 personal_sign,
 * or NEP-413 with `nonce` as the 32-byte nonce and `recipient`); the challenge only verifies that change.
 */
export async function policyChallenge(
  db: Db, user: User, action: PolicyAction, now = Date.now(),
): Promise<{ nonce: string; message: string; recipient: typeof RECIPIENT; hash: string }> {
  const a = await normalizeAction(db, user, action);
  const hash = actionHash(a);
  const nonce = base64.encode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now).run();
  await db
    .prepare("INSERT INTO challenges (nonce, account, kind, expires_at, used, purpose) VALUES (?, ?, ?, ?, 0, ?)")
    .bind(nonce, user.account, user.kind, now + CHALLENGE_TTL_MS, purposeOf(a, hash))
    .run();
  return { nonce, message: policyMessage(user.account, hash, nonce), recipient: RECIPIENT, hash };
}

type Signed = { nonce?: unknown; signature?: unknown; publicKey?: unknown };
type SignDeps = { db: Db; rpc: NearRpc; now: Date };

/** Recompute the hash from the submitted (normalized) action and verify + consume its challenge. 401 on mismatch. */
async function verifyChange(deps: SignDeps, user: User, a: PolicyAction, body: Signed): Promise<void> {
  const hash = actionHash(a);
  const nonce = body.nonce;
  if (typeof nonce !== "string" || nonce.length > 100) throw new HttpError(401, MISMATCH);
  const ok = await verifySignedMessage(
    deps.db, deps.rpc,
    { kind: user.kind, account: user.account, nonce, signature: body.signature, publicKey: body.publicKey, message: policyMessage(user.account, hash, nonce), purpose: purposeOf(a, hash) },
    deps.now.getTime(),
  );
  if (!ok) throw new HttpError(401, MISMATCH);
}

type PolicyRow = { policy: string; hash: string; updated_at: string };

async function loadPolicy(db: Db, owner: string): Promise<PolicyRow | null> {
  return db.prepare("SELECT policy, hash, updated_at FROM agent_policies WHERE owner = ?").bind(owner).first<PolicyRow>();
}
function parsedRow(r: PolicyRow): Policy {
  try {
    return JSON.parse(r.policy) as Policy;
  } catch {
    // Fail closed: a policy we cannot read must not silently lift the owner's limits.
    throw new HttpError(500, "Could not read your policy");
  }
}

export async function getPolicy(db: Db, user: User): Promise<PolicyView> {
  const r = await loadPolicy(db, user.account);
  return r ? { policy: parsedRow(r), hash: r.hash, updatedAt: r.updated_at } : { policy: null, hash: null, updatedAt: null };
}

/** Replace the owner's policy with the signed one. */
export async function savePolicy(deps: SignDeps, user: User, body: Signed & { policy?: unknown }): Promise<PolicyView> {
  const b = (isRec(body) ? body : {}) as Signed & { policy?: unknown };
  const a = await normalizeAction(deps.db, user, { kind: "policy", policy: b.policy });
  if (a.kind !== "policy") throw bad("Invalid policy.");
  await verifyChange(deps, user, a, b);
  const json = canonicalPolicyJson(a.policy), hash = policyHash(a.policy), ts = deps.now.toISOString();
  await deps.db
    .prepare("INSERT INTO agent_policies (owner, policy, hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET policy = excluded.policy, hash = excluded.hash, updated_at = excluded.updated_at")
    .bind(user.account, json, hash, ts)
    .run();
  return { policy: JSON.parse(json) as Policy, hash, updatedAt: ts };
}

type WhitelistRaw = { id: string; owner: string; label: string; destination_asset: string; recipient_type: WhitelistInput["recipientType"]; recipient: string; created_at: string };
const entryOf = (r: WhitelistRaw): WhitelistEntry => ({
  id: r.id, label: r.label, destinationAsset: r.destination_asset, recipientType: r.recipient_type, recipient: r.recipient, createdAt: r.created_at,
});

export async function listWhitelist(db: Db, user: User): Promise<WhitelistEntry[]> {
  const { results } = await db.prepare("SELECT * FROM whitelist WHERE owner = ? ORDER BY created_at, id").bind(user.account).all<WhitelistRaw>();
  return results.map((r) => entryOf({ ...r }));
}

/** Add a signed whitelist entry. The token must be listed and the recipient valid for it (as for payees). */
export async function addWhitelist(
  deps: SignDeps & { oneclick: { tokens(): Promise<OneClickToken[]> } }, user: User, body: Signed & { entry?: unknown },
): Promise<WhitelistEntry> {
  const b = (isRec(body) ? body : {}) as Signed & { entry?: unknown };
  const entry = normalizeEntry(b.entry);
  const dest = (await deps.oneclick.tokens()).find((t) => t.assetId === entry.destinationAsset);
  if (!dest) throw bad("That token is not supported.");
  if (entry.recipientType === "DESTINATION_CHAIN") {
    if (!supportedChain(dest.blockchain)) throw bad("That token is not supported.");
    if (!validDestination(dest.blockchain, entry.recipient)) throw bad(`Enter a valid ${dest.blockchain} address.`);
  } else {
    if (!validIntentsAccount(entry.recipient)) throw bad("Enter a valid NEAR account or lowercase 0x address.");
    if (entry.recipient === user.account) throw bad("Choose an account other than your own.");
  }
  if ((await whitelistIds(deps.db, user.account)).size >= MAX_WHITELIST) throw new HttpError(429, `You can whitelist at most ${MAX_WHITELIST} addresses.`);
  await verifyChange(deps, user, { kind: "whitelist_add", entry }, b);
  const id = crypto.randomUUID(), ts = deps.now.toISOString();
  const ins = await deps.db
    .prepare("INSERT INTO whitelist (id, owner, label, destination_asset, recipient_type, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(id, user.account, entry.label, entry.destinationAsset, entry.recipientType, entry.recipient, ts)
    .run();
  if (ins.meta.changes !== 1) throw new HttpError(409, "That address is already on your whitelist.");
  return { ...entry, id, createdAt: ts };
}

/** Remove a signed whitelist entry. Refused (409) while the sweep rule sends to it. */
export async function removeWhitelist(deps: SignDeps, user: User, body: Signed & { id?: unknown }): Promise<void> {
  const b = (isRec(body) ? body : {}) as Signed & { id?: unknown };
  const a = await normalizeAction(deps.db, user, { kind: "whitelist_remove", id: b.id });
  if (a.kind !== "whitelist_remove") throw new HttpError(404, "Whitelist entry not found");
  const exists = await deps.db.prepare("SELECT id FROM whitelist WHERE id = ? AND owner = ?").bind(a.id, user.account).first<{ id: string }>();
  if (!exists) throw new HttpError(404, "Whitelist entry not found");
  const p = await loadPolicy(deps.db, user.account);
  if (p && parsedRow(p).sweep?.whitelistId === a.id) throw new HttpError(409, "Your sweep rule uses this address. Change the rule first.");
  await verifyChange(deps, user, a, b);
  const r = await deps.db.prepare("DELETE FROM whitelist WHERE id = ? AND owner = ?").bind(a.id, user.account).run();
  if (r.meta.changes !== 1) throw new HttpError(404, "Whitelist entry not found");
}

/** Base units of `originAsset` that left or may still leave the owner's balance in non-swap transfers in the last 24 h. */
async function spentInWindow(db: Db, owner: string, originAsset: string, now: Date, committedOnly: boolean, exclude: string | null): Promise<bigint> {
  // Amounts are summed as bigint (SQL SUM would lose precision on 24-decimal tokens). Counted: every status
  // that may move funds (PROCESSING, SUCCESS and the in-flight 1Click statuses), plus unexpired unsigned
  // quotes: all of them normally, only those whose relay was attempted (upstream set, it may still land) when
  // committedOnly. REFUNDED/FAILED and expired unsigned quotes moved nothing. `exclude` leaves out the row
  // being submitted (its amount is passed separately). An attempted relay that is never refreshed drops out of
  // the count once its deadline passes (it may in theory still settle until the quote deadline + grace); a
  // refresh that sees it moves it to PENDING/PROCESSING/SUCCESS, which count again.
  // The window keys on created_at (quote time), not on when the transfer was signed or settled.
  const ts = now.toISOString();
  const { results } = await db
    .prepare(
      `SELECT amount FROM withdrawals WHERE owner = ? AND origin_asset = ? AND NOT (kind = 'swap' AND recipient = owner) AND created_at > ? AND deposit_address != ?
       AND (status NOT IN ('AWAITING_SIGNATURE', 'REFUNDED', 'FAILED')
            OR (status = 'AWAITING_SIGNATURE' AND json_extract(intent, '$.deadline') > ? AND (? = 0 OR upstream IS NOT NULL)))`,
    )
    .bind(owner, originAsset, new Date(now.getTime() - DAY_MS).toISOString(), exclude ?? "", ts, committedOnly ? 1 : 0)
    .all<{ amount: string }>();
  return results.reduce((n, r) => n + (/^[0-9]{1,78}$/.test(r.amount) ? BigInt(r.amount) : 0n), 0n);
}

/**
 * Spending limits for an outbound transfer of `amountLeaving` base units of `req.originAsset`. No policy (or
 * no `limits`) changes nothing; swaps (internal) are exempt. Per-transaction cap, rolling 24 h cap per origin
 * token, and `whitelistOnly` for withdraw, payroll and manual bills (a Manexus-link bill pays a verified
 * invoice owner and is exempt from the whitelist only). Throws 400.
 *
 * The transfer engine calls this before the quote (EXACT_INPUT with the amount, EXACT_OUTPUT with 0n: the
 * whitelist and an exhausted daily cap), after the quote on EXACT_OUTPUT's `amountIn`, and again in
 * submitTransfer just before the guarded claim with `committedOnly` (and once more after it, `dailyOnly`; see
 * there). The whitelist matches on destination asset, recipient type and recipient. Payroll lines are separate
 * transfers, so each line is capped and they accumulate in the 24 h window.
 */
export async function enforceLimits(
  deps: { db: Db; now: Date }, user: User,
  req: Pick<TransferRequest, "kind" | "originAsset" | "destinationAsset" | "recipientType" | "recipient" | "billId">,
  amountLeaving: bigint, opts: { committedOnly?: boolean; exclude?: string; dailyOnly?: boolean } = {},
): Promise<void> {
  // A swap stays in the owner's own Intents account (server/swaps.ts); anything sent elsewhere, including to
  // another chain, is limited.
  if (req.kind === "swap" && req.recipientType === "INTENTS" && req.recipient === user.account) return;
  const row = await loadPolicy(deps.db, user.account);
  const l = row ? parsedRow(row).limits : undefined;
  if (!l) return;
  if (!opts.dailyOnly && Object.hasOwn(l.perTx, req.originAsset) && amountLeaving > BigInt(l.perTx[req.originAsset])) throw bad(PER_TX_LIMIT);
  if (Object.hasOwn(l.daily, req.originAsset)) {
    const spent = await spentInWindow(deps.db, user.account, req.originAsset, deps.now, opts.committedOnly === true, opts.exclude ?? null);
    if (spent + amountLeaving > BigInt(l.daily[req.originAsset])) throw bad(DAILY_LIMIT);
  }
  if (opts.dailyOnly || !l.whitelistOnly) return;
  if (req.kind === "bill" && typeof req.billId === "string") {
    // Exempt only when this transfer pays exactly the imported invoice's owner in the invoice token.
    const b = await deps.db
      .prepare("SELECT source, destination_asset, recipient FROM bills WHERE id = ? AND owner = ?")
      .bind(req.billId, user.account)
      .first<{ source: string; destination_asset: string; recipient: string }>();
    if (b?.source === "manexus" && b.destination_asset === req.destinationAsset && b.recipient === req.recipient.trim()) return;
  }
  const hit = await deps.db
    .prepare("SELECT id FROM whitelist WHERE owner = ? AND destination_asset = ? AND recipient_type = ? AND recipient = ?")
    .bind(user.account, req.destinationAsset, req.recipientType, normRecipient(req.recipient.trim()))
    .first<{ id: string }>();
  if (!hit) throw bad(NOT_WHITELISTED);
}
