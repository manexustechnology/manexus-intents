// Payroll: saved payees and batch payouts from the owner's NEAR Intents balance. A batch is created
// from a CSV (re-parsed here, never trusted from the browser) or from saved payees, all-or-nothing.
// Each line is paid by its own EXACT_OUTPUT transfer through the generic engine: the payee receives
// exactly the line amount and the owner signs every line in their wallet. Line and batch status are
// derived from the line's latest transfer; a line is never quoted again once it may have moved funds.
import { supportedChain, validDestination, validIntentsAccount } from "../shared/address.ts";
import { SETTLEMENT_TOKENS } from "../shared/assets.ts";
import { MAX_PAYROLL_LINES, parsePayrollCsv, payeeNameError, recipientKey, type LineError } from "../shared/csv.ts";
import { baseUnits, formatAmount } from "../shared/units.ts";
import { getBalances } from "./balances.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { OneClickToken, createOneClick } from "./oneclick.ts";
import {
  openQuote,
  quoteTransfer,
  refreshTransfer,
  unsignedForGood,
  type OpenQuote,
  type RecipientType,
  type TransferDeps,
  type TransferQuote,
  type TransferView,
} from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };
type Rec = Record<string, unknown>;
type Tokens = { oneclick: Pick<ReturnType<typeof createOneClick>, "tokens"> };

export type Payee = {
  id: string; name: string; destinationAsset: string; recipientType: RecipientType; recipient: string; createdAt: string;
  /** Display fields; empty when the token is no longer listed. */
  symbol: string; blockchain: string; decimals?: number;
};

/** One line to pay, already in base units of `destinationAsset`. `line` is where errors point. */
export type BatchRowInput = { line: number; name: string; destinationAsset: string; recipientType: RecipientType; recipient: string; amount: string };

export type LineState = "unsent" | "awaiting" | "expired" | "checking" | "processing" | "sent" | "failed" | "refunded";
export type BatchLine = {
  n: number; name: string; destinationAsset: string; recipientType: RecipientType; recipient: string; amount: string;
  symbol: string; blockchain: string; decimals?: number; amountFormatted: string;
  depositAddress?: string; transfer?: TransferView; state: LineState;
  /** Whether `POST …/lines/<n>/quote` will accept this line now. */
  canQuote: boolean;
  /** The open unsigned quote for this line, to resume signing. */
  pendingQuote?: OpenQuote;
};
export type BatchSummary = { sent: number; processing: number; awaiting: number; failed: number; total: number };
export type Batch = { id: string; title: string; originAsset: string; originSymbol: string; createdAt: string };
export type BatchView = { batch: Batch; lines: BatchLine[]; summary: BatchSummary; refreshError?: string };
export type BatchListItem = { id: string; title: string; originAsset: string; createdAt: string; total: number; sent: number };

type PayeeRaw = { id: string; owner: string; name: string; destination_asset: string; recipient_type: RecipientType; recipient: string; created_at: string };
type BatchRaw = { id: string; owner: string; title: string; origin_asset: string; created_at: string };
type LineRaw = { batch_id: string; n: number; name: string; destination_asset: string; recipient_type: RecipientType; recipient: string; amount: string; deposit_address: string | null };

const MAX_PAYEES = 500;
const MAX_BATCHES = 1000;
const LIST_BATCHES = 100;
const MAX_TITLE = 100;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGITS = /^[1-9][0-9]{0,77}$/;
const LINE_SLIPPAGE_BPS = 100;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const batchNotFound = () => new HttpError(404, "Batch not found");
const invalidLines = (lineErrors: LineError[]) => new HttpError(400, "Fix the highlighted lines.", { lineErrors });

function tokenInfo(assetId: string, tokens: OneClickToken[]): { symbol: string; blockchain: string; decimals?: number } {
  const t = tokens.find((x) => x.assetId === assetId);
  if (t) return { symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals };
  const s = SETTLEMENT_TOKENS.find((x) => x.tokenId === assetId);
  return s ? { symbol: s.symbol, blockchain: "near", decimals: s.decimals } : { symbol: "", blockchain: "" };
}
const listedTokens = (deps: Tokens) => deps.oneclick.tokens().catch(() => [] as OneClickToken[]);

/** Why this recipient cannot be paid `dest`, or null. INTENTS recipients may not be the owner's own account. */
function recipientError(user: User, dest: OneClickToken, recipientType: unknown, recipient: string): string | null {
  if (recipientType === "DESTINATION_CHAIN") {
    if (!supportedChain(dest.blockchain)) return "That token is not supported";
    if (!validDestination(dest.blockchain, recipient)) return `Enter a valid ${dest.blockchain} address`;
    return null;
  }
  if (recipientType === "INTENTS") {
    if (!validIntentsAccount(recipient)) return "Enter a valid NEAR account or lowercase 0x address";
    if (recipient === user.account) return "Choose an account other than your own";
    return null;
  }
  return "Unknown recipient type";
}

// --- saved payees ---

function payeeOf(r: PayeeRaw, tokens: OneClickToken[]): Payee {
  return {
    id: r.id, name: r.name, destinationAsset: r.destination_asset, recipientType: r.recipient_type, recipient: r.recipient, createdAt: r.created_at,
    ...tokenInfo(r.destination_asset, tokens),
  };
}

export async function listPayees(deps: { db: Db } & Tokens, user: User): Promise<Payee[]> {
  const { results } = await deps.db.prepare("SELECT * FROM payees WHERE owner = ? ORDER BY name, created_at, id LIMIT ?").bind(user.account, MAX_PAYEES).all<PayeeRaw>();
  if (!results.length) return [];
  const tokens = await listedTokens(deps);
  return results.map((r) => payeeOf({ ...r }, tokens));
}

export async function createPayee(deps: { db: Db; now: Date } & Tokens, user: User, body: unknown): Promise<Payee> {
  const b = isRec(body) ? body : {};
  if (typeof b.name !== "string") throw new HttpError(400, "Enter a name");
  const nameError = payeeNameError(b.name);
  if (nameError) throw new HttpError(400, nameError);
  if (typeof b.destinationAsset !== "string" || typeof b.recipient !== "string") throw new HttpError(400, "Choose a token and enter the address.");
  const tokens = await deps.oneclick.tokens();
  const dest = tokens.find((t) => t.assetId === b.destinationAsset);
  if (!dest) throw new HttpError(400, "That token is not supported");
  const recipient = b.recipient.trim();
  const err = recipientError(user, dest, b.recipientType, recipient);
  if (err) throw new HttpError(400, err);
  const n = await deps.db.prepare("SELECT COUNT(*) AS n FROM payees WHERE owner = ?").bind(user.account).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PAYEES) throw new HttpError(429, `You can save at most ${MAX_PAYEES} payees.`);
  const id = crypto.randomUUID();
  await deps.db
    .prepare("INSERT INTO payees (id, owner, name, destination_asset, recipient_type, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user.account, b.name.trim(), dest.assetId, b.recipientType, recipient, deps.now.toISOString())
    .run();
  const r = await deps.db.prepare("SELECT * FROM payees WHERE id = ? AND owner = ?").bind(id, user.account).first<PayeeRaw>();
  return payeeOf({ ...r! }, tokens);
}

export async function deletePayee(db: Db, user: User, id: unknown): Promise<void> {
  if (typeof id !== "string" || !ID.test(id)) throw new HttpError(404, "Payee not found");
  const r = await db.prepare("DELETE FROM payees WHERE id = ? AND owner = ?").bind(id, user.account).run();
  if (r.meta.changes !== 1) throw new HttpError(404, "Payee not found");
}

// --- batches ---

function titleOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(v))
    throw new HttpError(400, `Enter a title (up to ${MAX_TITLE} characters).`);
  return v.trim();
}

/**
 * Store a batch of already-converted rows. Every row is validated again (token listed, recipient valid
 * for it, amount in base units, name rules, no duplicates); any invalid row rejects the whole batch.
 * Lines paid in the origin token itself must fit the balance together; other lines are checked per
 * line against the quote's `amountIn` when they are sent.
 */
export async function createBatch(
  deps: TransferDeps, user: User, input: { title: string; originAsset: string; rows: BatchRowInput[] },
): Promise<BatchView> {
  const { db, now } = deps;
  const i = isRec(input) ? input : ({} as Rec);
  const title = titleOf(i.title);
  if (typeof i.originAsset !== "string") throw new HttpError(400, "Choose a token from your balance.");
  const originAsset = i.originAsset;
  const rows = i.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, "Add at least one line.");
  if (rows.length > MAX_PAYROLL_LINES) throw new HttpError(400, `A payout can have at most ${MAX_PAYROLL_LINES} lines.`);

  const tokens = await deps.oneclick.tokens();
  const errors: LineError[] = [];
  const seen = new Map<string, number>();
  const clean: Omit<BatchRowInput, "line">[] = [];
  rows.forEach((raw: unknown, k) => {
    const r = isRec(raw) ? raw : {};
    const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line >= 0 ? r.line : k + 1;
    const fail = (message: string) => errors.push({ line, message });
    if (typeof r.name !== "string") return fail("Enter a name");
    const nameError = payeeNameError(r.name);
    if (nameError) return fail(nameError);
    const dest = tokens.find((t) => t.assetId === r.destinationAsset);
    if (!dest) return fail("That token is not supported");
    if (typeof r.recipient !== "string") return fail("Enter the address");
    const recipient = r.recipient.trim();
    const err = recipientError(user, dest, r.recipientType, recipient);
    if (err) return fail(err);
    if (typeof r.amount !== "string" || !DIGITS.test(r.amount)) return fail("Enter a valid positive amount");
    const key = recipientKey(dest.assetId, r.recipientType as string, recipient);
    const first = seen.get(key);
    if (first !== undefined) return fail(`Same chain, token and address as line ${first}`);
    seen.set(key, line);
    clean.push({ name: r.name.trim(), destinationAsset: dest.assetId, recipientType: r.recipientType as RecipientType, recipient, amount: r.amount });
  });
  if (errors.length) throw invalidLines(errors);

  const held = (await getBalances(deps, user.account)).find((b) => b.tokenId === originAsset);
  if (!held) throw new HttpError(400, "Choose a token from your balance.");
  const sameToken = clean.filter((r) => r.destinationAsset === originAsset).reduce((s, r) => s + BigInt(r.amount), 0n);
  if (sameToken > BigInt(held.amount)) throw new HttpError(400, "Batch exceeds your balance");

  const n = await db.prepare("SELECT COUNT(*) AS n FROM payroll_batches WHERE owner = ?").bind(user.account).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_BATCHES) throw new HttpError(429, `You can keep at most ${MAX_BATCHES} payouts.`);

  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO payroll_batches (id, owner, title, origin_asset, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, user.account, title, originAsset, now.toISOString()).run();
  // One statement for every line (D1 caps bound parameters per query; a single INSERT is atomic).
  let inserted = 0;
  try {
    const r = await db
      .prepare(
        `INSERT INTO payroll_lines (batch_id, n, name, destination_asset, recipient_type, recipient, amount, deposit_address)
         SELECT ?, CAST(j.key AS INTEGER) + 1, json_extract(j.value, '$.name'), json_extract(j.value, '$.destinationAsset'),
                json_extract(j.value, '$.recipientType'), json_extract(j.value, '$.recipient'), json_extract(j.value, '$.amount'), NULL
         FROM json_each(?) AS j`,
      )
      .bind(id, JSON.stringify(clean))
      .run();
    inserted = r.meta.changes;
  } finally {
    if (inserted !== clean.length) {
      await db.prepare("DELETE FROM payroll_lines WHERE batch_id = ?").bind(id).run();
      await db.prepare("DELETE FROM payroll_batches WHERE id = ? AND owner = ?").bind(id, user.account).run();
    }
  }
  if (inserted !== clean.length) throw new HttpError(500, "Could not save the payout");
  return getBatch(deps, user, id);
}

/** Rows from a CSV upload (`csv`) or from saved payees (`payeeIds` with matching decimal `amounts`). */
async function rowsFromBody(deps: TransferDeps, user: User, b: Rec): Promise<BatchRowInput[]> {
  if (typeof b.csv === "string") {
    const { rows, errors } = parsePayrollCsv(b.csv, await deps.oneclick.tokens());
    if (errors.length) throw invalidLines(errors);
    return rows.map((r) => ({ line: r.line, name: r.name, destinationAsset: r.destinationAsset, recipientType: r.recipientType, recipient: r.recipient, amount: r.amount }));
  }
  const ids = b.payeeIds, amounts = b.amounts;
  if (!Array.isArray(ids) || !Array.isArray(amounts) || ids.length !== amounts.length) throw new HttpError(400, "Upload a CSV file or choose payees.");
  if (ids.length === 0) throw new HttpError(400, "Add at least one line.");
  if (ids.length > MAX_PAYROLL_LINES) throw new HttpError(400, `A payout can have at most ${MAX_PAYROLL_LINES} lines.`);
  const tokens = await deps.oneclick.tokens();
  const errors: LineError[] = [];
  const rows: BatchRowInput[] = [];
  for (let k = 0; k < ids.length; k++) {
    const line = k + 1;
    const id = ids[k];
    const p = typeof id === "string" && ID.test(id) ? await deps.db.prepare("SELECT * FROM payees WHERE id = ? AND owner = ?").bind(id, user.account).first<PayeeRaw>() : null;
    if (!p) {
      errors.push({ line, message: "Payee not found" });
      continue;
    }
    const dest = tokens.find((t) => t.assetId === p.destination_asset);
    if (!dest) {
      errors.push({ line, message: "That token is not supported" });
      continue;
    }
    let amount: bigint;
    try {
      if (typeof amounts[k] !== "string") throw Error();
      amount = baseUnits((amounts[k] as string).trim(), dest.decimals);
    } catch {
      errors.push({ line, message: `Enter a positive amount with at most ${dest.decimals} decimals` });
      continue;
    }
    rows.push({ line, name: p.name, destinationAsset: p.destination_asset, recipientType: p.recipient_type, recipient: p.recipient, amount: amount.toString() });
  }
  if (errors.length) throw invalidLines(errors);
  return rows;
}

/** `POST /api/payroll/batches`: `{ title, originAsset, csv }` or `{ title, originAsset, payeeIds, amounts }`. */
export async function createBatchFromBody(deps: TransferDeps, user: User, body: unknown): Promise<BatchView> {
  const b = isRec(body) ? body : {};
  const title = titleOf(b.title);
  if (typeof b.originAsset !== "string") throw new HttpError(400, "Choose a token from your balance.");
  const rows = await rowsFromBody(deps, user, b);
  return createBatch(deps, user, { title, originAsset: b.originAsset, rows });
}

async function loadBatch(db: Db, user: User, id: unknown): Promise<BatchRaw> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw batchNotFound();
  const r = await db.prepare("SELECT * FROM payroll_batches WHERE id = ? AND owner = ?").bind(id, user.account).first<BatchRaw>();
  if (!r) throw batchNotFound();
  return { ...r };
}

export async function listBatches(deps: { db: Db }, user: User): Promise<BatchListItem[]> {
  const { results } = await deps.db
    .prepare(
      `SELECT b.id AS id, b.title AS title, b.origin_asset AS origin_asset, b.created_at AS created_at, COUNT(l.n) AS total,
              SUM(CASE WHEN w.status = 'SUCCESS' THEN 1 ELSE 0 END) AS sent
       FROM payroll_batches b JOIN payroll_lines l ON l.batch_id = b.id
       LEFT JOIN withdrawals w ON w.deposit_address = l.deposit_address AND w.owner = b.owner
       WHERE b.owner = ? GROUP BY b.id ORDER BY b.created_at DESC, b.id LIMIT ?`,
    )
    .bind(user.account, LIST_BATCHES)
    .all<{ id: string; title: string; origin_asset: string; created_at: string; total: number; sent: number | null }>();
  return results.map((r) => ({ id: r.id, title: r.title, originAsset: r.origin_asset, createdAt: r.created_at, total: Number(r.total), sent: Number(r.sent ?? 0) }));
}

/** The line's latest transfer, refreshed from NEAR Intents; undefined when it has none. */
async function lineTransfer(deps: TransferDeps, user: User, l: LineRaw): Promise<TransferView | undefined> {
  if (!l.deposit_address) return undefined;
  try {
    return await refreshTransfer(deps, user, l.deposit_address);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return undefined;
    throw e;
  }
}

/**
 * Where a line stands, from its latest transfer. A line may be quoted (again) only when it has no
 * transfer, its transfer FAILED or was REFUNDED, or its quote expired unsigned for good (bills' rule:
 * after a failed relay, only a successful 1Click check past the grace period proves nothing landed).
 */
async function lineState(deps: TransferDeps, user: User, t: TransferView | undefined): Promise<{ state: LineState; canQuote: boolean }> {
  if (!t) return { state: "unsent", canQuote: true };
  switch (t.status) {
    case "SUCCESS":
      return { state: "sent", canQuote: false };
    case "FAILED":
      return { state: "failed", canQuote: true };
    case "REFUNDED":
      return { state: "refunded", canQuote: true };
    case "AWAITING_SIGNATURE":
      if (!t.expired) return { state: "awaiting", canQuote: false };
      return (await unsignedForGood(deps, user, t)) ? { state: "expired", canQuote: true } : { state: "checking", canQuote: false };
    default:
      return { state: "processing", canQuote: false };
  }
}

function summaryOf(lines: { state: LineState }[]): BatchSummary {
  const s: BatchSummary = { sent: 0, processing: 0, awaiting: 0, failed: 0, total: lines.length };
  for (const l of lines) {
    if (l.state === "sent") s.sent++;
    else if (l.state === "processing" || l.state === "checking") s.processing++;
    else if (l.state === "failed" || l.state === "refunded") s.failed++;
    else s.awaiting++;
  }
  return s;
}

async function lineRows(db: Db, batchId: string): Promise<LineRaw[]> {
  const { results } = await db.prepare("SELECT * FROM payroll_lines WHERE batch_id = ? ORDER BY n").bind(batchId).all<LineRaw>();
  return results.map((r) => ({ ...r, n: Number(r.n) }));
}

/** The batch with every line's latest transfer (refreshed) and the derived summary. */
export async function getBatch(deps: TransferDeps, user: User, id: string): Promise<BatchView> {
  const b = await loadBatch(deps.db, user, id);
  const raws = await lineRows(deps.db, b.id);
  const tokens = await listedTokens(deps);
  const lines: BatchLine[] = [];
  let refreshError: string | undefined;
  for (const l of raws) {
    const transfer = await lineTransfer(deps, user, l);
    refreshError ??= transfer?.refreshError;
    const { state, canQuote } = await lineState(deps, user, transfer);
    const t = tokenInfo(l.destination_asset, tokens);
    const pendingQuote = await openQuote(deps.db, user, transfer);
    lines.push({
      n: l.n, name: l.name, destinationAsset: l.destination_asset, recipientType: l.recipient_type, recipient: l.recipient, amount: l.amount,
      symbol: t.symbol, blockchain: t.blockchain, ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
      amountFormatted: t.decimals === undefined ? "" : formatAmount(BigInt(l.amount), t.decimals),
      ...(l.deposit_address ? { depositAddress: l.deposit_address } : {}),
      ...(transfer ? { transfer } : {}),
      state, canQuote,
      ...(pendingQuote ? { pendingQuote } : {}),
    });
  }
  return {
    batch: { id: b.id, title: b.title, originAsset: b.origin_asset, originSymbol: tokenInfo(b.origin_asset, tokens).symbol, createdAt: b.created_at },
    lines,
    summary: summaryOf(lines),
    ...(refreshError ? { refreshError } : {}),
  };
}

/**
 * Quote paying line `n` from the batch's origin token. Refused with 409 "Already sent" unless the line
 * may be quoted (see `lineState`); a re-quote replaces the line's deposit address under a guarded update,
 * so concurrent quotes leave at most one signable intent per line.
 */
export async function quoteBatchLine(deps: TransferDeps, user: User, batchId: string, n: number): Promise<TransferQuote> {
  const b = await loadBatch(deps.db, user, batchId);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAYROLL_LINES) throw new HttpError(404, "Line not found");
  const l = await deps.db.prepare("SELECT * FROM payroll_lines WHERE batch_id = ? AND n = ?").bind(b.id, n).first<LineRaw>();
  if (!l) throw new HttpError(404, "Line not found");
  const line: LineRaw = { ...l, n: Number(l.n) };
  const { canQuote } = await lineState(deps, user, await lineTransfer(deps, user, line));
  if (!canQuote) throw new HttpError(409, "Already sent");

  const qt = await quoteTransfer(deps, user, {
    kind: "payroll", batchId: b.id, reference: `${b.title} · ${line.name}`, swapType: "EXACT_OUTPUT",
    originAsset: b.origin_asset, destinationAsset: line.destination_asset, amount: line.amount,
    recipientType: line.recipient_type, recipient: line.recipient, slippageBps: LINE_SLIPPAGE_BPS,
  });
  const r = await deps.db
    .prepare("UPDATE payroll_lines SET deposit_address = ? WHERE batch_id = ? AND n = ? AND deposit_address IS ?")
    .bind(qt.depositAddress, b.id, n, line.deposit_address)
    .run();
  if (r.meta.changes !== 1) {
    // Another quote for this line won: drop ours while it is still unsigned.
    await deps.db
      .prepare("DELETE FROM withdrawals WHERE deposit_address = ? AND owner = ? AND status = 'AWAITING_SIGNATURE' AND upstream IS NULL")
      .bind(qt.depositAddress, user.account)
      .run();
    throw new HttpError(409, "This line changed elsewhere. Reload and try again.");
  }
  return qt;
}
