// Outbound transfers from the owner's own intents.near balance: withdrawals, swaps, bill payments and
// payroll lines. The server never signs: it asks 1Click for a quote and an unsigned intent, stores that
// exact intent, and later relays the owner's wallet signature over it. Every check fails closed.
// Rows live in the `withdrawals` table (migration 0003 adds kind/reference/batch_id/bill_id).
import { supportedChain, validDestination, validIntentsAccount } from "../shared/address.ts";
import { ED25519_KEY, ed25519KeyBytes, nonceBytes } from "../shared/intent-sign.ts";
import { formatAmount } from "../shared/units.ts";
import { base58 } from "@scure/base";
import { getBalances, type Balance } from "./balances.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { NearRpc } from "./near-rpc.ts";
import type { OneClickToken, Quote, QuoteRequest, SwapStatus, createOneClick } from "./oneclick.ts";
import { enforceLimits } from "./policy.ts";

type User = { account: string; kind: "near" | "evm" };
type Standard = "nep413" | "erc191";
type OneClick = Pick<ReturnType<typeof createOneClick>, "tokens" | "quote" | "generateIntent" | "submitIntent" | "status">;
export type TransferDeps = { db: Db; oneclick: OneClick; rpc: NearRpc; now: Date };

export const TRANSFER_KINDS = ["withdraw", "swap", "bill", "payroll"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS";
export const SLIPPAGE_BPS = [50, 100, 300] as const;

/**
 * What to send. `amount` is in base units: of the origin asset for EXACT_INPUT, of the destination
 * asset (what the recipient receives) for EXACT_OUTPUT.
 */
export type TransferRequest = {
  kind: TransferKind;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  swapType: SwapType;
  recipientType: RecipientType;
  recipient: string;
  slippageBps?: (typeof SLIPPAGE_BPS)[number];
  reference?: string;
  batchId?: string;
  billId?: string;
};

type Meta = {
  originSymbol: string; originDecimals: number;
  destinationSymbol: string; destinationBlockchain: string; destinationDecimals: number;
  amountOut: string; minAmountOut: string;
  // Absent on Plan 1 rows, which were all EXACT_INPUT to a destination chain.
  swapType?: SwapType; recipientType?: RecipientType;
  // The two deadlines `deadline` is the earlier of. Absent on rows stored before they were recorded.
  intentDeadline?: string; quoteDeadline?: string;
};
type StoredIntent = { standard: Standard; payload: unknown; deadline: string; meta: Meta };

export type TransferStatus = "AWAITING_SIGNATURE" | SwapStatus["status"];

export type TransferView = {
  depositAddress: string;
  originAsset: string; originSymbol: string; amount: string; amountFormatted: string;
  destinationAsset: string; destinationSymbol: string; destinationBlockchain: string; recipient: string;
  amountOut: string; amountOutFormatted: string; minAmountOut: string; minAmountOutFormatted: string;
  status: TransferStatus; intentHash?: string; destinationTxHashes: string[];
  deadline: string; expired: boolean; expiredUnsubmitted?: boolean; createdAt: string; updatedAt: string; refreshError?: string;
  kind: TransferKind; swapType: SwapType; recipientType: RecipientType; reference?: string; batchId?: string; billId?: string;
};

export type TransferQuote = {
  depositAddress: string; amountOut: string; amountOutFormatted: string; minAmountOut: string; deadline: string;
  intent: { standard: Standard; payload: unknown };
  transfer: TransferView;
  /** Same as `transfer`; kept for the Plan 1 withdraw route and view. */
  withdrawal: TransferView;
};

/** A stored `withdrawals` row, for callers that load several at once (see `refreshRow`). */
export type TransferRow = Raw;
type Raw = {
  deposit_address: string; owner: string; origin_asset: string; destination_asset: string; amount: string; recipient: string;
  intent_hash: string | null; status: string; upstream: string | null; intent: string | null; created_at: string; updated_at: string;
  kind: TransferKind; reference: string | null; batch_id: string | null; bill_id: string | null;
};

const QUOTE_MINUTES = 10;
const MAX_OPEN_QUOTES_PER_HOUR = 30;
const REFRESH_THROTTLE_MS = 5_000;
const STUCK_SUBMIT_MS = 120_000;
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const DIGITS = /^[1-9][0-9]{0,77}$/;
const INTENTS = "intents.near";
const MAX_REFERENCE = 200;
const MAX_ID = 100;
const NOUN: Record<TransferKind, string> = { withdraw: "withdrawal", swap: "swap", bill: "payment", payroll: "payment" };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const badIntent = (kind: TransferKind) => new HttpError(502, `NEAR Intents returned an unexpected ${NOUN[kind]} intent`);
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
function checkGeneratedIntent(
  user: User, standard: Standard, payload: unknown, w: { kind: TransferKind; depositAddress: string; originAsset: string; amount: string; now: Date },
): number {
  const bad = () => badIntent(w.kind);
  const body = intentBody(standard, payload);
  if (!body || !sameSigner(user, body.signer_id)) throw bad();
  const deadline = time(body.deadline);
  if (!(deadline > w.now.getTime())) throw bad();
  const list = body.intents;
  if (!Array.isArray(list) || list.length !== 1) throw bad();
  const it = list[0];
  if (!isRec(it) || Object.keys(it).some((k) => !["intent", "receiver_id", "tokens", "memo"].includes(k))) throw bad();
  if (it.intent !== "transfer" || it.receiver_id !== w.depositAddress || !isRec(it.tokens)) throw bad();
  const tokens = Object.entries(it.tokens);
  if (tokens.length !== 1 || tokens[0][0] !== w.originAsset || tokens[0][1] !== w.amount) throw bad();
  if (it.memo !== undefined && typeof it.memo !== "string") throw bad();
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

function toView(r: Raw, now: Date): TransferView {
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
    status: r.status as TransferStatus,
    ...(r.intent_hash ? { intentHash: r.intent_hash } : {}),
    destinationTxHashes: hashes,
    deadline: s.deadline,
    expired: r.status === "AWAITING_SIGNATURE" && time(s.deadline) <= now.getTime(),
    ...(r.status === "FAILED" && u.stuckSubmit === true ? { expiredUnsubmitted: true } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
    kind: r.kind,
    swapType: m.swapType ?? "EXACT_INPUT",
    recipientType: m.recipientType ?? "DESTINATION_CHAIN",
    ...(r.reference != null ? { reference: r.reference } : {}),
    ...(r.batch_id != null ? { batchId: r.batch_id } : {}),
    ...(r.bill_id != null ? { billId: r.bill_id } : {}),
  };
}

async function load(db: Db, user: User, depositAddress: unknown): Promise<Raw> {
  if (typeof depositAddress !== "string" || !depositAddress || depositAddress.length > 200) throw new HttpError(404, "Transfer not found");
  const r = await db.prepare("SELECT * FROM withdrawals WHERE deposit_address = ? AND owner = ?").bind(depositAddress, user.account).first<Raw>();
  if (!r) throw new HttpError(404, "Transfer not found");
  return { ...r };
}

/** A request that passed every check that does not need the quote, plus the 1Click quote request for it. */
type Checked = {
  kind: TransferKind; swapType: SwapType; recipientType: RecipientType;
  amount: string; recipient: string; reference: string | null; batchId: string | null; billId: string | null;
  held: Balance; dest: OneClickToken; request: QuoteRequest;
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function optionalId(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > MAX_ID || !ID.test(v)) throw new HttpError(400, `Invalid ${what}.`);
  return v;
}

/** Everything about `input` that can be checked before asking 1Click: shape, balance, destination, recipient, rate limit. */
async function checkRequest(deps: TransferDeps, user: User, input: TransferRequest): Promise<Checked> {
  const { db, oneclick, rpc, now } = deps;
  const b = (isRec(input) ? input : {}) as Rec;
  if (!(TRANSFER_KINDS as readonly unknown[]).includes(b.kind)) throw new HttpError(400, "Unknown transfer type.");
  const kind = b.kind as TransferKind;
  if (b.swapType !== "EXACT_INPUT" && b.swapType !== "EXACT_OUTPUT") throw new HttpError(400, "Unknown swap type.");
  if (b.recipientType !== "DESTINATION_CHAIN" && b.recipientType !== "INTENTS") throw new HttpError(400, "Unknown recipient type.");
  const swapType: SwapType = b.swapType, recipientType: RecipientType = b.recipientType;
  const slippage = b.slippageBps === undefined ? 100 : b.slippageBps;
  if (!(SLIPPAGE_BPS as readonly unknown[]).includes(slippage)) throw new HttpError(400, "Choose a slippage of 0.5%, 1% or 3%.");
  let reference: string | null = null;
  if (b.reference !== undefined && b.reference !== null) {
    if (typeof b.reference !== "string" || b.reference.length > MAX_REFERENCE) throw new HttpError(400, `Keep the reference under ${MAX_REFERENCE} characters.`);
    reference = b.reference.trim() || null;
  }
  const batchId = optionalId(b.batchId, "batch");
  const billId = optionalId(b.billId, "bill");
  if (typeof b.originAsset !== "string" || typeof b.destinationAsset !== "string" || typeof b.recipient !== "string")
    throw new HttpError(400, "Choose a token, destination and address.");
  if (typeof b.amount !== "string" || !DIGITS.test(b.amount)) throw new HttpError(400, "Enter a valid positive amount.");
  const amount = b.amount;
  const recipient = b.recipient.trim();

  // The origin must be a token the owner holds. EXACT_INPUT sends `amount` of it; for EXACT_OUTPUT the
  // amount sent is only known from the quote and is checked against this balance there.
  const balances = await getBalances({ db, rpc, oneclick }, user.account);
  const held = balances.find((x) => x.tokenId === b.originAsset);
  if (!held || (swapType === "EXACT_INPUT" && BigInt(amount) > BigInt(held.amount))) throw new HttpError(400, "Amount exceeds your balance");

  const tokens: OneClickToken[] = await oneclick.tokens();
  const dest = tokens.find((t) => t.assetId === b.destinationAsset);
  if (recipientType === "DESTINATION_CHAIN") {
    if (!dest || !supportedChain(dest.blockchain)) throw new HttpError(400, "That destination token is not supported.");
    if (!validDestination(dest.blockchain, recipient)) throw new HttpError(400, `Enter a valid ${dest.blockchain} address.`);
  } else {
    if (!dest) throw new HttpError(400, "That destination token is not supported.");
    if (!validIntentsAccount(recipient)) throw new HttpError(400, "Enter a valid NEAR account or lowercase 0x address.");
  }

  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE owner = ? AND status = 'AWAITING_SIGNATURE' AND created_at > ?")
    .bind(user.account, new Date(now.getTime() - 3_600_000).toISOString())
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_QUOTES_PER_HOUR) throw new HttpError(429, `Too many ${NOUN[kind]} quotes. Try again later.`);

  // Spending limits (server/policy.ts). EXACT_INPUT: the amount that leaves is known now. EXACT_OUTPUT: it is
  // the quote's amountIn, checked again in prepareChecked; here 0n still checks the whitelist and refuses
  // when the 24 h cap is already used up, before asking 1Click.
  await enforceLimits(deps, user, { kind, originAsset: held.tokenId, destinationAsset: dest.assetId, recipientType, recipient, billId: billId ?? undefined }, swapType === "EXACT_INPUT" ? BigInt(amount) : 0n);

  const request: QuoteRequest = {
    dry: false,
    swapType,
    slippageTolerance: slippage as number,
    originAsset: held.tokenId,
    depositType: "INTENTS",
    destinationAsset: dest.assetId,
    amount,
    refundTo: user.account,
    refundType: "INTENTS",
    recipient,
    recipientType,
    deadline: new Date(now.getTime() + QUOTE_MINUTES * 60_000).toISOString(),
    referral: "manexus",
  };
  return { kind, swapType, recipientType, amount, recipient, reference, batchId, billId, held, dest, request };
}

/** Check the 1Click quote against the request and the balance, fetch and check the unsigned intent, store the row. */
async function prepareChecked(deps: TransferDeps, user: User, c: Checked, q: Quote): Promise<TransferQuote> {
  const { db, oneclick, now } = deps;
  const quoteDeadline = time(q.deadline);
  if (
    !isRec(q) || typeof q.depositAddress !== "string" || !q.depositAddress || q.depositAddress.length > 200 ||
    typeof q.amountIn !== "string" || typeof q.amountOut !== "string" || typeof q.minAmountOut !== "string" ||
    !DIGITS.test(q.amountOut) || !/^[0-9]{1,78}$/.test(q.minAmountOut) || BigInt(q.minAmountOut) > BigInt(q.amountOut) ||
    !(quoteDeadline > now.getTime())
  )
    throw new HttpError(502, "NEAR Intents returned an unexpected response");
  // What the intent transfers out of the owner's account.
  let sent: string;
  if (c.swapType === "EXACT_INPUT") {
    if (q.amountIn !== c.amount) throw new HttpError(502, "NEAR Intents returned an unexpected response");
    sent = c.amount;
  } else {
    if (!DIGITS.test(q.amountIn)) throw new HttpError(502, "NEAR Intents returned an unexpected response");
    if (BigInt(q.amountIn) > BigInt(c.held.amount)) throw new HttpError(400, "Amount exceeds your balance");
    if (BigInt(q.amountOut) < BigInt(c.amount)) throw new HttpError(502, "NEAR Intents returned an unexpected response");
    // The recipient must never receive less than the bill/payroll amount, even at the slippage floor.
    if (BigInt(q.minAmountOut) < BigInt(c.amount)) throw new HttpError(502, "NEAR Intents returned an unexpected response");
    sent = q.amountIn;
    await enforceLimits(deps, user, { kind: c.kind, originAsset: c.held.tokenId, destinationAsset: c.dest.assetId, recipientType: c.recipientType, recipient: c.recipient, billId: c.billId ?? undefined }, BigInt(sent));
  }

  const standard: Standard = user.kind === "near" ? "nep413" : "erc191";
  const intent = await oneclick.generateIntent({ depositAddress: q.depositAddress, signerId: user.account, standard });
  if (intent.standard !== standard) throw badIntent(c.kind);
  const intentDeadline = checkGeneratedIntent(user, standard, intent.payload, {
    kind: c.kind, depositAddress: q.depositAddress, originAsset: c.held.tokenId, amount: sent, now,
  });

  const deadline = new Date(Math.min(quoteDeadline, intentDeadline)).toISOString();
  const meta: Meta = {
    originSymbol: c.held.symbol, originDecimals: c.held.decimals,
    destinationSymbol: c.dest.symbol, destinationBlockchain: c.dest.blockchain, destinationDecimals: c.dest.decimals,
    amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    swapType: c.swapType, recipientType: c.recipientType,
    intentDeadline: new Date(intentDeadline).toISOString(), quoteDeadline: new Date(quoteDeadline).toISOString(),
  };
  const record: StoredIntent = { standard, payload: intent.payload, deadline, meta };
  const ts = now.toISOString();
  const ins = await db
    .prepare(
      `INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, intent_hash, status, upstream, intent, created_at, updated_at, kind, reference, batch_id, bill_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'AWAITING_SIGNATURE', NULL, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deposit_address) DO NOTHING`,
    )
    .bind(q.depositAddress, user.account, c.held.tokenId, c.dest.assetId, sent, c.recipient, JSON.stringify(record), ts, ts, c.kind, c.reference, c.batchId, c.billId)
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
    transfer: view,
    withdrawal: view,
  };
}

/**
 * Store a transfer for a 1Click quote the caller already obtained. The request and the quote are
 * checked exactly as in `quoteTransfer`.
 *
 * Callers MUST obtain `q` from a QuoteRequest equal to `req`: same originAsset, destinationAsset,
 * amount, swapType, recipient, recipientType and slippage, with depositType and refundType INTENTS and
 * refundTo the owner. The 1Click Quote does not echo the recipient, destination asset or swap type,
 * and the generated intent binds only origin, amount and deposit address, so those fields of `req`
 * are stored on trust.
 */
export async function prepareTransfer(deps: TransferDeps, user: User, req: TransferRequest, q: Quote): Promise<TransferQuote> {
  return prepareChecked(deps, user, await checkRequest(deps, user, req), q);
}

/** Quote `req` with 1Click and store the unsigned intent the owner must sign. */
export async function quoteTransfer(deps: TransferDeps, user: User, req: TransferRequest): Promise<TransferQuote> {
  const c = await checkRequest(deps, user, req);
  return prepareChecked(deps, user, c, await deps.oneclick.quote(c.request));
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
export async function submitTransfer(deps: TransferDeps, user: User, body: { depositAddress: string; signedData: unknown }): Promise<TransferView> {
  const { db, oneclick, now } = deps;
  const sd = isRec(body) ? body.signedData : undefined;
  if (!isRec(sd) || typeof sd.standard !== "string") throw new HttpError(400, "Invalid signature");
  const row = await load(db, user, (body as Rec).depositAddress);
  const noun = NOUN[row.kind] ?? "transfer";
  if (row.status !== "AWAITING_SIGNATURE") throw new HttpError(409, `This ${noun} was already submitted`);
  const s = stored(row);
  if (!(time(s.deadline) > now.getTime())) throw new HttpError(409, "Quote expired, request a new one");
  if (sd.standard !== s.standard) throw new HttpError(403, `Signature does not match this ${noun}`);
  if (!deepEqual(sd.payload, s.payload)) throw new HttpError(403, `Signed intent does not match this ${noun}`);
  if (!sameSigner(user, intentBody(s.standard, s.payload)?.signer_id)) throw new HttpError(403, "Signed intent is not for your account");
  const sig = signatureFields(s.standard, sd);
  const signedData = { standard: s.standard, payload: s.payload, ...sig };
  // A Manexus bill pays a vendor invoice: refuse to relay once the vendor cancelled it or it was paid
  // since the quote (a payment that lands anyway is reconciled on the vendor side as duplicate/after_cancel).
  if (row.kind === "bill" && row.bill_id != null) {
    const b = await db
      .prepare("SELECT b.source AS source, i.status AS invoice_status FROM bills b LEFT JOIN invoices i ON i.public_id = b.vendor_public_id WHERE b.id = ? AND b.owner = ?")
      .bind(row.bill_id, user.account)
      .first<{ source: string; invoice_status: string | null }>();
    if (b && b.source === "manexus" && b.invoice_status !== "issued") throw new HttpError(409, "The vendor invoice is no longer payable");
  }

  // Spending limits again, against what is committed now. Two quotes taken in parallel can each pass the
  // quote-time 24 h check (neither saw the other's row); here only transfers already relayed (or in flight)
  // count (plus unsigned quotes whose relay was attempted), not other unsigned quotes, so the first one signed
  // wins and the next is refused. Two submits running concurrently between this read and the claim are caught
  // by the recount after the claim. The policy and whitelist are also re-read, so a tightened cap or a removed
  // whitelist entry blocks an older quote.
  const limitReq = {
    kind: row.kind, originAsset: row.origin_asset, destinationAsset: row.destination_asset,
    recipientType: s.meta.recipientType ?? ("DESTINATION_CHAIN" as const), recipient: row.recipient, billId: row.bill_id ?? undefined,
  };
  await enforceLimits(deps, user, limitReq, BigInt(row.amount), { committedOnly: true, exclude: row.deposit_address });

  // See the updated_at INVARIANT above unsignedForGood: `ts` is checked-unexpired, so these writes stay <= deadline.
  const ts = now.toISOString();
  const claim = await db
    .prepare("UPDATE withdrawals SET status = 'PROCESSING', updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'AWAITING_SIGNATURE'")
    .bind(ts, row.deposit_address, user.account)
    .run();
  if (claim.meta.changes !== 1) throw new HttpError(409, `This ${noun} was already submitted`);
  // Recount with this row now PROCESSING (so counted once, amount 0n): a concurrent submit that claimed in the
  // meantime is visible now. Over the cap → undo the claim (nothing was relayed; upstream left as it was, so a
  // refused row is not mistaken for an attempted relay) and refuse. Truly simultaneous submits may both be
  // refused; neither moves funds and the owner can sign again.
  try {
    await enforceLimits(deps, user, limitReq, 0n, { committedOnly: true, dailyOnly: true });
  } catch (e) {
    await db
      .prepare("UPDATE withdrawals SET status = 'AWAITING_SIGNATURE', updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'PROCESSING' AND intent_hash IS NULL")
      .bind(ts, row.deposit_address, user.account)
      .run();
    throw e;
  }

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
    // If the stuck-submit rule already failed this row while the relay was in flight, the intent is live: track it again.
    .prepare(
      "UPDATE withdrawals SET intent_hash = ?, upstream = NULL, status = CASE WHEN status = 'FAILED' THEN 'PROCESSING' ELSE status END, updated_at = ? WHERE deposit_address = ? AND owner = ?",
    )
    // Overlap (theoretical): once the stuck-submit rule marked this row FAILED, a bill or payroll line may
    // already have been re-quoted, and this revival makes the original transfer live again next to the new
    // quote (both could pay). It needs a relay still in flight STUCK_SUBMIT_MS past the stored deadline that
    // then executes; intents.near refuses an intent after its own deadline, which bounds that window.
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

/** Whether `refreshTransfer` would ask 1Click about this row now: relay attempted, not terminal, not throttled. */
function stale(row: Raw, now: Date): boolean {
  const attempted = row.status !== "AWAITING_SIGNATURE" || upstreamOf(row).submitAttemptedAt !== undefined;
  const fresh = now.getTime() - time(row.updated_at) < REFRESH_THROTTLE_MS;
  return attempted && !TERMINAL.has(row.status) && !fresh;
}

/** The stored view of a loaded row and whether `refreshRow` would ask 1Click about it now. No query. */
export function peekRow(row: TransferRow, now: Date): { view: TransferView; stale: boolean } {
  return { view: toView(row, now), stale: stale(row, now) };
}

/**
 * When this row was last checked with 1Click: its updated_at, or a later failed check (`checkedAttemptAt`,
 * which never touches updated_at). Lets a caller that refreshes a few rows per call rotate failing ones back.
 */
export function lastChecked(row: TransferRow): string {
  const c = upstreamOf(row).checkedAttemptAt;
  return typeof c === "string" && c > row.updated_at ? c : row.updated_at;
}

/** The stored view without asking 1Click, and whether a `refreshTransfer` would ask it now. 404 when unknown. */
export async function peekTransfer(deps: Pick<TransferDeps, "db" | "now">, user: User, depositAddress: string): Promise<{ view: TransferView; stale: boolean }> {
  return peekRow(await load(deps.db, user, depositAddress), deps.now);
}

/** Current status from 1Click. Upstream errors return the stored state with `refreshError`. */
export async function refreshTransfer(deps: TransferDeps, user: User, depositAddress: string): Promise<TransferView> {
  return (await refreshRow(deps, user, await load(deps.db, user, depositAddress))).view;
}

/**
 * `refreshTransfer` for a row the caller already loaded (owner-scoped): at most one query, and the row as
 * stored afterwards. A failed check records `checkedAttemptAt` in upstream and leaves updated_at alone.
 */
export async function refreshRow(deps: TransferDeps, user: User, row: TransferRow): Promise<{ view: TransferView; row: TransferRow }> {
  const { db, oneclick, now } = deps;
  if (row.owner !== user.account) throw new HttpError(404, "Transfer not found");
  if (!stale(row, now)) return { view: toView(row, now), row };
  const ts = now.toISOString();
  const failed = async (refreshError: string) => {
    await db
      .prepare(
        "UPDATE withdrawals SET upstream = json_set(COALESCE(upstream, '{}'), '$.checkedAttemptAt', ?) WHERE deposit_address = ? AND owner = ? AND status = ? AND json_valid(COALESCE(upstream, '{}'))",
      )
      .bind(ts, row.deposit_address, user.account, row.status)
      .run();
    return { view: { ...toView(row, now), refreshError }, row };
  };
  // The row as stored after a guarded UPDATE … RETURNING; reloaded only when a concurrent writer won.
  const after = async (r: Raw | null) => {
    const next = r ? { ...r } : await load(db, user, row.deposit_address);
    return { view: toView(next, now), row: next };
  };
  let s: SwapStatus;
  try {
    s = await oneclick.status(row.deposit_address);
  } catch (e) {
    return failed(e instanceof HttpError ? e.message : "NEAR Intents is unreachable");
  }
  if (s.depositAddress !== undefined && s.depositAddress !== row.deposit_address) return failed("NEAR Intents returned an unexpected response");
  // Until 1Click has seen the transfer, keep our own state: an unsigned/failed-submit row stays
  // AWAITING_SIGNATURE, and a submit still in flight (PROCESSING, no intent hash yet) stays PROCESSING
  // so that submit's failure revert (which requires PROCESSING) still applies.
  const unseen = s.status === "PENDING_DEPOSIT";
  const hold = unseen && (row.status === "AWAITING_SIGNATURE" || (row.status === "PROCESSING" && row.intent_hash == null));
  // A submit that never finished (worker died mid-relay) would be held PROCESSING forever: once the quote is
  // long past its deadline nothing should still be in flight, so close it out with an explicit marker. A submit
  // that completes after this still records its intent hash and moves the row back to PROCESSING.
  if (hold && row.status === "PROCESSING" && now.getTime() > time(stored(row).deadline) + STUCK_SUBMIT_MS) {
    return after(
      await db
        .prepare(
          "UPDATE withdrawals SET status = 'FAILED', upstream = ?, updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = 'PROCESSING' AND intent_hash IS NULL RETURNING *",
        )
        .bind(JSON.stringify({ ...JSON.parse(trimmed(s)), stuckSubmit: true }), ts, row.deposit_address, user.account)
        .first<Raw>(),
    );
  }
  // A successful 1Click read: the only writer allowed to stamp updated_at after the deadline (INVARIANT above unsignedForGood).
  const status = hold ? row.status : s.status;
  return after(
    await db
      .prepare("UPDATE withdrawals SET status = ?, upstream = ?, updated_at = ? WHERE deposit_address = ? AND owner = ? AND status = ? RETURNING *")
      .bind(status, hold ? row.upstream : trimmed(s), ts, row.deposit_address, user.account, row.status)
      .first<Raw>(),
  );
}

// INVARIANT (updated_at): only a successful upstream read (refreshTransfer after oneclick.status) may write
// updated_at with a time after the quote deadline. Every other writer — the INSERT at quote time and the four
// submitTransfer updates, which all stamp `ts` taken after the "unexpired" check — writes a time at or before the
// deadline. unsignedForGood relies on this: an updated_at past deadline + SUBMIT_GRACE_MS proves 1Click was
// asked after the grace period and still had not seen the transfer. Bill and payroll re-quotes (double-pay
// protection) depend on it, so do not add a writer that stamps updated_at later without a real 1Click read.
/** A failed relay may still have reached NEAR Intents: wait this long past the deadline before calling it unsigned. */
export const SUBMIT_GRACE_MS = 120_000;

/**
 * Whether an AWAITING_SIGNATURE transfer can no longer move funds: expired, and no relay possibly in
 * flight. Pass a view fresh from `refreshTransfer`. Used before a bill or payroll line is quoted again.
 */
export async function unsignedForGood(deps: Pick<TransferDeps, "db" | "now">, user: User, t: TransferView): Promise<boolean> {
  if (t.status !== "AWAITING_SIGNATURE" || !t.expired) return false;
  const r = await deps.db
    .prepare("SELECT upstream, intent FROM withdrawals WHERE deposit_address = ? AND owner = ?")
    .bind(t.depositAddress, user.account)
    .first<{ upstream: string | null; intent: string | null }>();
  return unsignedForGoodRow(r ?? { upstream: null, intent: null }, t, deps.now);
}

/** `unsignedForGood` for the row `t` was built from (fresh from `refreshRow`). No query. */
export function unsignedForGoodRow(row: Pick<TransferRow, "upstream" | "intent">, t: TransferView, now: Date): boolean {
  if (t.status !== "AWAITING_SIGNATURE" || !t.expired) return false;
  let attempted = true; // unreadable upstream: assume a relay was attempted
  try {
    const u: unknown = JSON.parse(row.upstream ?? "null");
    attempted = isRec(u) && u.submitAttemptedAt !== undefined;
  } catch {
    /* keep attempted */
  }
  if (!attempted) return true;
  // A relay was attempted and may have landed. Only a successful 1Click check made after the grace period
  // (refreshTransfer's hold path writes updated_at on each one; errors and throttled reads do not) proves
  // it did not. The grace runs from the later of the intent and quote deadlines: we assume 1Click may still
  // execute a relayed intent until its quote deadline (docs/NEAR-INTENTS.md). Older rows only stored the
  // earlier one, `deadline`.
  const s = parseJson(row.intent);
  const m = isRec(s) && isRec(s.meta) ? s.meta : {};
  const later = [m.intentDeadline, m.quoteDeadline].map(time).filter(Number.isFinite);
  const graceEnd = Math.max(time(t.deadline), ...later) + SUBMIT_GRACE_MS;
  return !t.refreshError && now.getTime() > graceEnd && time(t.updatedAt) > graceEnd;
}

/** An unsigned, unexpired quote the owner can resume signing after leaving the page. */
export type OpenQuote = { depositAddress: string; deadline: string; amountOutFormatted: string; intent: { standard: Standard; payload: unknown }; transfer: TransferView };

/** The stored intent of `t` when it is still waiting for the owner's signature and unexpired, else undefined. */
export async function openQuote(db: Db, user: User, t: TransferView | undefined): Promise<OpenQuote | undefined> {
  if (!t || t.status !== "AWAITING_SIGNATURE" || t.expired) return undefined;
  const r = await db.prepare("SELECT intent FROM withdrawals WHERE deposit_address = ? AND owner = ?").bind(t.depositAddress, user.account).first<{ intent: string | null }>();
  return openQuoteRow(r, t);
}

/** `openQuote` for the row `t` was built from. No query. */
export function openQuoteRow(row: Pick<TransferRow, "intent"> | null, t: TransferView | undefined): OpenQuote | undefined {
  if (!t || t.status !== "AWAITING_SIGNATURE" || t.expired) return undefined;
  const s = parseJson(row?.intent ?? null);
  if (!isRec(s) || (s.standard !== "nep413" && s.standard !== "erc191")) return undefined;
  return { depositAddress: t.depositAddress, deadline: t.deadline, amountOutFormatted: t.amountOutFormatted, intent: { standard: s.standard, payload: s.payload }, transfer: t };
}

/** Valid `?kind=` filter value, or 400. Undefined/empty means every kind. */
export function parseKind(v: unknown): TransferKind | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!(TRANSFER_KINDS as readonly unknown[]).includes(v)) throw new HttpError(400, "Unknown transfer type.");
  return v as TransferKind;
}

/** History: everything that was ever submitted (unsigned quotes moved no funds and are hidden), optionally of one kind. */
export async function listTransfers(deps: Pick<TransferDeps, "db" | "now">, user: User, kind?: TransferKind, limit = 50): Promise<TransferView[]> {
  const k = parseKind(kind);
  const { results } = await deps.db
    .prepare(
      `SELECT * FROM withdrawals WHERE owner = ?${k ? " AND kind = ?" : ""} AND (status != 'AWAITING_SIGNATURE' OR upstream IS NOT NULL) ORDER BY created_at DESC, deposit_address LIMIT ?`,
    )
    .bind(...(k ? [user.account, k, limit] : [user.account, limit]))
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
