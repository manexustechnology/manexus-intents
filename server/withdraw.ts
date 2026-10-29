// Withdrawals from the owner's own intents.near balance to any supported chain.
// The server never signs: it asks 1Click for a quote and an unsigned intent, stores that exact intent,
// and later relays the owner's wallet signature over it. Every check fails closed.
import { supportedChain, validDestination } from "../shared/address.ts";
import { ED25519_KEY, ed25519KeyBytes, nonceBytes } from "../shared/intent-sign.ts";
import { formatAmount } from "../shared/units.ts";
import { base58 } from "@scure/base";
import { getBalances } from "./balances.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { NearRpc } from "./near-rpc.ts";
import type { OneClickToken, QuoteRequest, SwapStatus, createOneClick } from "./oneclick.ts";

type User = { account: string; kind: "near" | "evm" };
type Standard = "nep413" | "erc191";
type OneClick = Pick<ReturnType<typeof createOneClick>, "tokens" | "quote" | "generateIntent" | "submitIntent" | "status">;
export type WithdrawDeps = { db: Db; oneclick: OneClick; rpc: NearRpc; now: Date };

type Meta = {
  originSymbol: string; originDecimals: number;
  destinationSymbol: string; destinationBlockchain: string; destinationDecimals: number;
  amountOut: string; minAmountOut: string;
};
type StoredIntent = { standard: Standard; payload: unknown; deadline: string; meta: Meta };

export type WithdrawalStatus = "AWAITING_SIGNATURE" | SwapStatus["status"];

export type WithdrawalView = {
  depositAddress: string;
  originAsset: string; originSymbol: string; amount: string; amountFormatted: string;
  destinationAsset: string; destinationSymbol: string; destinationBlockchain: string; recipient: string;
  amountOut: string; amountOutFormatted: string; minAmountOut: string; minAmountOutFormatted: string;
  status: WithdrawalStatus; intentHash?: string; destinationTxHashes: string[];
  deadline: string; expired: boolean; createdAt: string; updatedAt: string; refreshError?: string;
};

export type WithdrawalQuote = {
  depositAddress: string; amountOut: string; amountOutFormatted: string; minAmountOut: string; deadline: string;
  intent: { standard: Standard; payload: unknown };
  withdrawal: WithdrawalView;
};

type Raw = {
  deposit_address: string; owner: string; origin_asset: string; destination_asset: string; amount: string; recipient: string;
  intent_hash: string | null; status: string; upstream: string | null; intent: string | null; created_at: string; updated_at: string;
};

const QUOTE_MINUTES = 10;
const MAX_OPEN_QUOTES_PER_HOUR = 30;
const REFRESH_THROTTLE_MS = 5_000;
const STUCK_SUBMIT_MS = 120_000;
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const DIGITS = /^[1-9][0-9]{0,77}$/;
const INTENTS = "intents.near";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const badIntent = () => new HttpError(502, "NEAR Intents returned an unexpected withdrawal intent");
const parseJson = (s: unknown): unknown => {
  if (typeof s !== "string") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const time = (s: unknown) => (typeof s === "string" ? new Date(s).getTime() : NaN);
const sameSigner = (user: User, signer: unknown) =>
  typeof signer === "string" && (user.kind === "evm" ? signer.toLowerCase() === user.account.toLowerCase() : signer === user.account);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isRec(a) || !isRec(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** The signed intent body ({signer_id, deadline, intents, ...}) of a 1Click payload, or null if malformed. */
function intentBody(standard: string, payload: unknown): Rec | null {
  if (standard === "nep413") {
    if (!isRec(payload) || payload.recipient !== INTENTS || !nonceBytes(payload.nonce)) return null;
    const msg = parseJson(payload.message);
    return isRec(msg) ? msg : null;
  }
  if (standard === "erc191") {
    const msg = parseJson(payload);
    if (!isRec(msg) || msg.verifying_contract !== INTENTS || !nonceBytes(msg.nonce)) return null;
    return msg;
  }
  return null;
}

/**
 * The generated intent must do exactly one thing: transfer `amount` of `originAsset` from the owner's
 * Intents account to the quote's deposit address, signed as the owner, and not yet expired.
 */
function checkGeneratedIntent(user: User, standard: Standard, payload: unknown, w: { depositAddress: string; originAsset: string; amount: string; now: Date }): number {
  const body = intentBody(standard, payload);
  if (!body || !sameSigner(user, body.signer_id)) throw badIntent();
  const deadline = time(body.deadline);
  if (!(deadline > w.now.getTime())) throw badIntent();
  const list = body.intents;
  if (!Array.isArray(list) || list.length !== 1) throw badIntent();
  const it = list[0];
  if (!isRec(it) || Object.keys(it).some((k) => !["intent", "receiver_id", "tokens", "memo"].includes(k))) throw badIntent();
  if (it.intent !== "transfer" || it.receiver_id !== w.depositAddress || !isRec(it.tokens)) throw badIntent();
  const tokens = Object.entries(it.tokens);
  if (tokens.length !== 1 || tokens[0][0] !== w.originAsset || tokens[0][1] !== w.amount) throw badIntent();
  if (it.memo !== undefined && typeof it.memo !== "string") throw badIntent();
  return deadline;
}

function stored(r: Raw): StoredIntent {
  const s = parseJson(r.intent);
  if (!isRec(s) || (s.standard !== "nep413" && s.standard !== "erc191") || typeof s.deadline !== "string" || !isRec(s.meta))
    throw new HttpError(409, "Quote expired, request a new one");
  return s as unknown as StoredIntent;
}

function upstreamOf(r: Raw): Rec {
  const u = parseJson(r.upstream);
  return isRec(u) ? u : {};
}

function toView(r: Raw, now: Date): WithdrawalView {
  const s = stored(r);
  const m = s.meta;
  const u = upstreamOf(r);
  const hashes = Array.isArray(u.destinationTxHashes) ? u.destinationTxHashes.filter((h): h is string => typeof h === "string") : [];
  return {
    depositAddress: r.deposit_address,
    originAsset: r.origin_asset, originSymbol: m.originSymbol,
    amount: r.amount, amountFormatted: formatAmount(BigInt(r.amount), m.originDecimals),
    destinationAsset: r.destination_asset, destinationSymbol: m.destinationSymbol, destinationBlockchain: m.destinationBlockchain,
    recipient: r.recipient,
    amountOut: m.amountOut, amountOutFormatted: formatAmount(BigInt(m.amountOut), m.destinationDecimals),
    minAmountOut: m.minAmountOut, minAmountOutFormatted: formatAmount(BigInt(m.minAmountOut), m.destinationDecimals),
    status: r.status as WithdrawalStatus,
    ...(r.intent_hash ? { intentHash: r.intent_hash } : {}),
    destinationTxHashes: hashes,
    deadline: s.deadline,
    expired: r.status === "AWAITING_SIGNATURE" && time(s.deadline) <= now.getTime(),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function load(db: Db, user: User, depositAddress: unknown): Promise<Raw> {
  if (typeof depositAddress !== "string" || !depositAddress || depositAddress.length > 200) throw new HttpError(404, "Withdrawal not found");
  const r = await db.prepare("SELECT * FROM withdrawals WHERE deposit_address = ? AND owner = ?").bind(depositAddress, user.account).first<Raw>();
  if (!r) throw new HttpError(404, "Withdrawal not found");
  return { ...r };
}

export async function quoteWithdrawal(
  deps: WithdrawDeps,
  user: User,
  body: { originAsset: string; amount: string; destinationAsset: string; recipient: string },
): Promise<WithdrawalQuote> {
  const { db, oneclick, rpc, now } = deps;
  const b = (isRec(body) ? body : {}) as Rec;
  if (typeof b.originAsset !== "string" || typeof b.destinationAsset !== "string" || typeof b.recipient !== "string")
    throw new HttpError(400, "Choose a token, destination and address.");
  if (typeof b.amount !== "string" || !DIGITS.test(b.amount)) throw new HttpError(400, "Enter a valid positive amount.");
  const amount = b.amount;
  const recipient = b.recipient.trim();

  const balances = await getBalances({ db, rpc, oneclick }, user.account);
  const held = balances.find((x) => x.tokenId === b.originAsset);
  if (!held || BigInt(amount) > BigInt(held.amount)) throw new HttpError(400, "Amount exceeds your balance");

  const tokens: OneClickToken[] = await oneclick.tokens();
  const dest = tokens.find((t) => t.assetId === b.destinationAsset);
  if (!dest || !supportedChain(dest.blockchain)) throw new HttpError(400, "That destination token is not supported.");
  if (!validDestination(dest.blockchain, recipient)) throw new HttpError(400, `Enter a valid ${dest.blockchain} address.`);

  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE owner = ? AND status = 'AWAITING_SIGNATURE' AND created_at > ?")
    .bind(user.account, new Date(now.getTime() - 3_600_000).toISOString())
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_QUOTES_PER_HOUR) throw new HttpError(429, "Too many withdrawal quotes. Try again later.");

  const request: QuoteRequest = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: held.tokenId,
    depositType: "INTENTS",
    destinationAsset: dest.assetId,
    amount,
    refundTo: user.account,
    refundType: "INTENTS",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + QUOTE_MINUTES * 60_000).toISOString(),
    referral: "manexus",
  };
  const q = await oneclick.quote(request);
  const quoteDeadline = time(q.deadline);
  if (
    !q.depositAddress || q.depositAddress.length > 200 || q.amountIn !== amount ||
    !DIGITS.test(q.amountOut) || !/^[0-9]{1,78}$/.test(q.minAmountOut) || BigInt(q.minAmountOut) > BigInt(q.amountOut) ||
    !(quoteDeadline > now.getTime())
  )
    throw new HttpError(502, "NEAR Intents returned an unexpected response");

  const standard: Standard = user.kind === "near" ? "nep413" : "erc191";
  const intent = await oneclick.generateIntent({ depositAddress: q.depositAddress, signerId: user.account, standard });
  if (intent.standard !== standard) throw badIntent();
  const intentDeadline = checkGeneratedIntent(user, standard, intent.payload, { depositAddress: q.depositAddress, originAsset: held.tokenId, amount, now });

  const deadline = new Date(Math.min(quoteDeadline, intentDeadline)).toISOString();
  const meta: Meta = {
    originSymbol: held.symbol, originDecimals: held.decimals,
    destinationSymbol: dest.symbol, destinationBlockchain: dest.blockchain, destinationDecimals: dest.decimals,
    amountOut: q.amountOut, minAmountOut: q.minAmountOut,
  };
  const record: StoredIntent = { standard, payload: intent.payload, deadline, meta };
  const ts = now.toISOString();
  const ins = await db
    .prepare(
      `INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, intent_hash, status, upstream, intent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'AWAITING_SIGNATURE', NULL, ?, ?, ?) ON CONFLICT(deposit_address) DO NOTHING`,
    )
    .bind(q.depositAddress, user.account, held.tokenId, dest.assetId, amount, recipient, JSON.stringify(record), ts, ts)
    .run();
  if (ins.meta.changes !== 1) throw new HttpError(502, "NEAR Intents returned a deposit address that is already in use");

  const view = toView(await load(db, user, q.depositAddress), now);
  return {
    depositAddress: q.depositAddress,
    amountOut: q.amountOut,
    amountOutFormatted: view.amountOutFormatted,
    minAmountOut: q.minAmountOut,
    deadline,
    intent: { standard, payload: intent.payload },
    withdrawal: view,
  };
}

/** The signature part of signedData, validated for the stored standard. Throws 400 if malformed. */
function signatureFields(standard: Standard, sd: Rec): { public_key?: string; signature: string } {
  const bad = () => new HttpError(400, "Invalid signature");
  if (standard === "nep413") {
    const pk = sd.public_key, sig = sd.signature;
    if (typeof pk !== "string" || !ED25519_KEY.test(pk) || !ed25519KeyBytes(pk)) throw bad();
    if (typeof sig !== "string" || !sig.startsWith("ed25519:")) throw bad();
    try {
      if (base58.decode(sig.slice(8)).length !== 64) throw bad();
    } catch {
      throw bad();
    }
    return { public_key: pk, signature: sig };
  }
  if (sd.public_key !== undefined) throw bad();
  const sig = sd.signature;
  if (typeof sig !== "string" || !sig.startsWith("secp256k1:")) throw bad();
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(sig.slice(10));
  } catch {
    throw bad();
  }
  if (bytes.length !== 65 || bytes[64] > 1) throw bad();
  return { signature: sig };
}

/**
 * Relay the owner's signature over the stored intent. Ordering: all checks, then a guarded
 * AWAITING_SIGNATURE→PROCESSING update (only one concurrent submit can win), then submitIntent.
 * If submitIntent fails, the row goes back to AWAITING_SIGNATURE with the error recorded: the same
 * payload (same nonce) can be retried, and intents.near rejects a nonce it has already executed,
 * so a retry can never move funds twice. A recorded attempt keeps the row visible and refreshable.
 */
export async function submitWithdrawal(deps: WithdrawDeps, user: User, body: { depositAddress: string; signedData: unknown }): Promise<WithdrawalView> {
  const { db, oneclick, now } = deps;
  const sd = isRec(body) ? body.signedData : undefined;
  if (!isRec(sd) || typeof sd.standard !== "string") throw new HttpError(400, "Invalid signature");
  const row = await load(db, user, (body as Rec).depositAddress);
  if (row.status !== "AWAITING_SIGNATURE") throw new HttpError(409, "This withdrawal was already submitted");
  const s = stored(row);
  if (!(time(s.deadline) > now.getTime())) throw new HttpError(409, "Quote expired, request a new one");
  if (sd.standard !== s.standard) throw new HttpError(403, "Signature does not match this withdrawal");
  if (!deepEqual(sd.payload, s.payload)) throw new HttpError(403, "Signed intent does not match this withdrawal");
  if (!sameSigner(user, intentBody(s.standard, s.payload)?.signer_id)) throw new HttpError(403, "Signed intent is not for your account");
  const sig = signatureFields(s.standard, sd);
  const signedData = { standard: s.standard, payload: s.payload, ...sig };

  const ts = now.toISOString();
  const claim = await db
    .prepare("UPDATE withdrawals SET status = 'PROCESSING', updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'AWAITING_SIGNATURE'")
    .bind(ts, row.deposit_address, user.account)
    .run();
  if (claim.meta.changes !== 1) throw new HttpError(409, "This withdrawal was already submitted");

  let intentHash: string;
  try {
    ({ intentHash } = await oneclick.submitIntent(signedData));
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "NEAR Intents is unreachable";
    await db
      .prepare(
        "UPDATE withdrawals SET status = 'AWAITING_SIGNATURE', upstream = ?, updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'PROCESSING' AND intent_hash IS NULL",
      )
      .bind(JSON.stringify({ submitError: msg.slice(0, 200), submitAttemptedAt: ts }), ts, row.deposit_address, user.account)
      .run();
    throw e instanceof HttpError ? e : new HttpError(502, msg);
  }
  await db
    .prepare("UPDATE withdrawals SET intent_hash = ?, upstream = NULL, updated_at = ? WHERE deposit_address = ? AND owner = ?")
    .bind(intentHash.slice(0, 200), ts, row.deposit_address, user.account)
    .run();
  return toView(await load(db, user, row.deposit_address), now);
}

function trimmed(s: SwapStatus): string {
  const hs = (a: string[]) => a.slice(0, 10).map((h) => h.slice(0, 200));
  return JSON.stringify({
    status: s.status, updatedAt: s.updatedAt,
    ...(s.amountOut !== undefined ? { amountOut: s.amountOut } : {}),
    ...(s.refundedAmount !== undefined ? { refundedAmount: s.refundedAmount } : {}),
    originTxHashes: hs(s.originTxHashes), destinationTxHashes: hs(s.destinationTxHashes),
  });
}

/** Current status from 1Click. Upstream errors return the stored state with `refreshError`. */
export async function refreshWithdrawal(deps: WithdrawDeps, user: User, depositAddress: string): Promise<WithdrawalView> {
  const { db, oneclick, now } = deps;
  const row = await load(db, user, depositAddress);
  const attempted = row.status !== "AWAITING_SIGNATURE" || upstreamOf(row).submitAttemptedAt !== undefined;
  const fresh = now.getTime() - time(row.updated_at) < REFRESH_THROTTLE_MS;
  if (!attempted || TERMINAL.has(row.status) || fresh) return toView(row, now);
  let s: SwapStatus;
  try {
    s = await oneclick.status(row.deposit_address);
  } catch (e) {
    return { ...toView(row, now), refreshError: e instanceof HttpError ? e.message : "NEAR Intents is unreachable" };
  }
  if (s.depositAddress !== undefined && s.depositAddress !== row.deposit_address) return { ...toView(row, now), refreshError: "NEAR Intents returned an unexpected response" };
  // Until 1Click has seen the transfer, keep our own state: an unsigned/failed-submit row stays
  // AWAITING_SIGNATURE, and a submit still in flight (PROCESSING, no intent hash yet) stays PROCESSING
  // so that submit's failure revert (which requires PROCESSING) still applies.
  const unseen = s.status === "PENDING_DEPOSIT";
  const hold = unseen && (row.status === "AWAITING_SIGNATURE" || (row.status === "PROCESSING" && row.intent_hash == null));
  const ts = now.toISOString();
  // A submit that never finished (worker died mid-relay) would be held PROCESSING forever: once the quote is
  // long past its deadline nothing can still be in flight, so close it out. Guarded so a late submit result wins.
  if (hold && row.status === "PROCESSING" && now.getTime() > time(stored(row).deadline) + STUCK_SUBMIT_MS) {
    await db
      .prepare("UPDATE withdrawals SET status = 'FAILED', upstream = ?, updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'PROCESSING' AND intent_hash IS NULL")
      .bind(trimmed(s), ts, row.deposit_address, user.account)
      .run();
    return toView(await load(db, user, row.deposit_address), now);
  }
  const status = hold ? row.status : s.status;
  await db
    .prepare("UPDATE withdrawals SET status = ?, upstream = ?, updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = ?")
    .bind(status, hold ? row.upstream : trimmed(s), ts, row.deposit_address, user.account, row.status)
    .run();
  return toView(await load(db, user, row.deposit_address), now);
}

/** History: everything that was ever submitted (unsigned quotes moved no funds and are hidden). */
export async function listWithdrawals(deps: Pick<WithdrawDeps, "db" | "now">, user: User): Promise<WithdrawalView[]> {
  const { results } = await deps.db
    .prepare(
      "SELECT * FROM withdrawals WHERE owner = ? AND (status != 'AWAITING_SIGNATURE' OR upstream IS NOT NULL) ORDER BY created_at DESC, deposit_address LIMIT 50",
    )
    .bind(user.account)
    .all<Raw>();
  return results.map((r) => toView({ ...r }, deps.now));
}

/**
 * Whether intents.near will accept NEP-413 signatures from `publicKey` for this account.
 * EVM accounts and a NEAR implicit account signing with its own key need no registration; named
 * NEAR accounts must have called intents.near `add_public_key` (docs/NEAR-INTENTS.md).
 */
export async function keyStatus(deps: { rpc: NearRpc }, user: User, publicKey: string): Promise<{ required: boolean; registered: boolean }> {
  if (user.kind === "evm") return { required: false, registered: true };
  const bytes = typeof publicKey === "string" ? ed25519KeyBytes(publicKey) : null;
  if (!bytes) throw new HttpError(400, "Invalid public key");
  const hexKey = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  if (/^[0-9a-f]{64}$/.test(user.account) && hexKey === user.account) return { required: false, registered: true };
  let has: unknown;
  try {
    has = await deps.rpc.viewFunction<unknown>(INTENTS, "has_public_key", { account_id: user.account, public_key: publicKey });
  } catch {
    throw new HttpError(502, "Could not check key registration on NEAR Intents");
  }
  if (typeof has !== "boolean") throw new HttpError(502, "Could not check key registration on NEAR Intents");
  return { required: true, registered: has };
}
