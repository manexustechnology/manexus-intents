import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { getInvoiceByPublicId } from "./invoices.ts";
import type { OneClickToken, Quote, QuoteRequest, createOneClick } from "./oneclick.ts";
import { validDestination, validIntentsAccount } from "../shared/address.ts";
import type { InvoiceRow } from "../shared/invoice.ts";
import { formatAmount } from "../shared/units.ts";

/**
 * `failed`: upstream FAILED. `mismatch`: upstream SUCCESS whose executed quote does not match the invoice;
 * funds reached someone, so it needs review and is never reported to the payer as refunded.
 */
export type Outcome = "paid" | "duplicate" | "after_cancel" | "refunded" | "failed" | "mismatch";

export type AttemptRow = {
  depositAddress: string;
  depositMemo?: string;
  invoiceId: string;
  originAsset: string;
  amountIn: string;
  refundTo: string;
  deadline: string;
  status: string;
  outcome?: Outcome;
  amountOut?: string;
  upstream?: string;
  createdAt: string;
  updatedAt: string;
};

export type PaymentAttemptView = {
  symbol: string;
  blockchain: string;
  depositAddress: string;
  depositMemo?: string;
  originAsset: string;
  amountIn: string;
  amountInFormatted: string;
  deadline: string;
  status: string;
  outcome?: Outcome;
  expired: boolean;
};

type Raw = {
  deposit_address: string; deposit_memo: string | null; invoice_id: string; origin_asset: string; amount_in: string; refund_to: string;
  deadline: string; status: string; outcome: string | null; amount_out: string | null; upstream: string | null; created_at: string; updated_at: string;
};
const COLS = "deposit_address, deposit_memo, invoice_id, origin_asset, amount_in, refund_to, deadline, status, outcome, amount_out, upstream, created_at, updated_at";

function fromRaw(r: Raw): AttemptRow {
  return {
    depositAddress: r.deposit_address,
    ...(r.deposit_memo ? { depositMemo: r.deposit_memo } : {}),
    invoiceId: r.invoice_id, originAsset: r.origin_asset, amountIn: r.amount_in, refundTo: r.refund_to, deadline: r.deadline, status: r.status,
    ...(r.outcome ? { outcome: r.outcome as Outcome } : {}),
    ...(r.amount_out ? { amountOut: r.amount_out } : {}),
    ...(r.upstream ? { upstream: r.upstream } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listAttempts(db: Db, invoiceId: string): Promise<AttemptRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM payment_attempts WHERE invoice_id = ? ORDER BY created_at DESC, deposit_address`)
    .bind(invoiceId)
    .all<Raw>();
  return results.map(fromRaw);
}

export async function saveAttempt(db: Db, a: AttemptRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_attempts (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deposit_address) DO UPDATE SET deposit_memo = excluded.deposit_memo, status = excluded.status, outcome = excluded.outcome,
         amount_out = excluded.amount_out, upstream = excluded.upstream, updated_at = excluded.updated_at`,
    )
    .bind(
      a.depositAddress, a.depositMemo ?? null, a.invoiceId, a.originAsset, a.amountIn, a.refundTo, a.deadline, a.status,
      a.outcome ?? null, a.amountOut ?? null, a.upstream ?? null, a.createdAt, a.updatedAt,
    )
    .run();
}

/** Payer-facing view. Decimals are not stored, so the caller supplies the origin token. */
export function toAttemptView(row: AttemptRow, now: Date, origin: { symbol: string; blockchain: string; decimals: number }): PaymentAttemptView {
  const expired = row.status === "PENDING_DEPOSIT" && new Date(row.deadline).getTime() < now.getTime();
  return {
    symbol: origin.symbol,
    blockchain: origin.blockchain,
    depositAddress: expired ? "" : row.depositAddress,
    ...(!expired && row.depositMemo ? { depositMemo: row.depositMemo } : {}),
    originAsset: row.originAsset,
    amountIn: row.amountIn,
    amountInFormatted: formatAmount(BigInt(row.amountIn), origin.decimals),
    deadline: row.deadline,
    status: row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    expired,
  };
}

type Deps = { db: Db; oneclick: Pick<ReturnType<typeof createOneClick>, "tokens" | "quote" | "submitDeposit">; now: Date };

const MAX_ATTEMPTS = 20;
const QUOTE_MINUTES = 30;
const notPayable = () => new HttpError(409, "This invoice is not payable");
const badQuote = () => new HttpError(502, "NEAR Intents returned an unexpected response");

/** The invoice row, if it can still be paid (issued, positive total). */
async function payableInvoice(db: Db, publicId: string): Promise<InvoiceRow> {
  const inv = await getInvoiceByPublicId(db, publicId);
  if (inv.status !== "issued" || !/^[1-9][0-9]*$/.test(inv.total)) throw notPayable();
  return inv;
}

async function checkAttemptLimit(db: Db, invoiceId: string): Promise<void> {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE invoice_id = ?").bind(invoiceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTEMPTS) throw new HttpError(429, "Too many payment attempts for this invoice. Try again later.");
}

/** Slippage of every invoice payment quote, in basis points. */
export const INVOICE_SLIPPAGE_BPS = 100;

/**
 * The one quote request that pays an invoice: EXACT_OUTPUT of the invoice total in the invoice token into
 * the owner's Intents account (what `decideOutcome` checks). Only where the payer's funds come from and
 * where a refund goes differ between a payer depositing on a chain and a payer paying from Intents.
 */
export function invoiceQuoteRequest(
  inv: InvoiceRow,
  from: { originAsset: string; source: "ORIGIN_CHAIN" | "INTENTS"; refundTo: string },
  now: Date,
): QuoteRequest {
  return {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: INVOICE_SLIPPAGE_BPS,
    originAsset: from.originAsset,
    depositType: from.source,
    destinationAsset: inv.tokenId,
    amount: inv.total,
    refundTo: from.refundTo,
    refundType: from.source,
    recipient: inv.owner,
    recipientType: "INTENTS",
    deadline: new Date(now.getTime() + QUOTE_MINUTES * 60_000).toISOString(),
    referral: "manexus",
  };
}

function checkInvoiceQuote(inv: InvoiceRow, q: Quote): void {
  if (
    !q.depositAddress ||
    !/^[0-9]+$/.test(q.amountIn) ||
    !/^[0-9]+$/.test(q.amountOut) ||
    BigInt(q.amountOut) < BigInt(inv.total) ||
    Number.isNaN(new Date(q.deadline).getTime())
  )
    throw badQuote();
}

function attemptFor(inv: InvoiceRow, q: Quote, originAsset: string, refundTo: string, now: Date): AttemptRow {
  return {
    depositAddress: q.depositAddress,
    ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
    invoiceId: inv.id, originAsset, amountIn: q.amountIn, refundTo, deadline: q.deadline, status: "PENDING_DEPOSIT",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

export async function createPaymentQuote(
  deps: Deps,
  publicId: string,
  body: { originAsset: string; refundTo: string },
): Promise<PaymentAttemptView> {
  const { db, oneclick, now } = deps;
  const inv = await payableInvoice(db, publicId);
  if (typeof body?.originAsset !== "string" || typeof body?.refundTo !== "string") throw new HttpError(400, "Choose a token and enter a refund address.");
  await checkAttemptLimit(db, inv.id);

  const token: OneClickToken | undefined = (await oneclick.tokens()).find((t) => t.assetId === body.originAsset);
  if (!token) throw new HttpError(400, "That token is not supported.");
  const refundTo = body.refundTo.trim();
  if (!validDestination(token.blockchain, refundTo)) throw new HttpError(400, `Enter a valid ${token.blockchain} refund address.`);

  const q = await oneclick.quote(invoiceQuoteRequest(inv, { originAsset: token.assetId, source: "ORIGIN_CHAIN", refundTo }, now));
  checkInvoiceQuote(inv, q);
  const row = attemptFor(inv, q, token.assetId, refundTo, now);
  await saveAttempt(db, row);
  return toAttemptView(row, now, token);
}

/**
 * Pay an invoice from the payer's own NEAR Intents balance (a Manexus bill). Quotes the same request as
 * `createPaymentQuote` with depositType/refundType INTENTS and refunds to the payer's Intents account,
 * stores the payment attempt on the invoice (so the vendor's reconciliation sees the payment), then hands
 * the quote to `prepare` (which stores the payer's transfer). If `prepare` fails, the attempt is deleted:
 * nothing was deposited into it yet.
 */
export async function createIntentsPaymentQuote<T>(
  deps: { db: Db; oneclick: Pick<ReturnType<typeof createOneClick>, "quote">; now: Date },
  publicId: string,
  body: { originAsset: string; payer: string },
  prepare: (q: Quote, inv: InvoiceRow, request: QuoteRequest) => Promise<T>,
): Promise<T> {
  const { db, oneclick, now } = deps;
  const inv = await payableInvoice(db, publicId);
  if (typeof body?.originAsset !== "string" || !body.originAsset || body.originAsset.length > 200) throw new HttpError(400, "Choose a token from your balance.");
  if (typeof body.payer !== "string" || !validIntentsAccount(body.payer)) throw new HttpError(400, "Enter a valid NEAR account or lowercase 0x address.");
  if (body.payer === inv.owner) throw new HttpError(400, "This is your own invoice");
  await checkAttemptLimit(db, inv.id);

  const request = invoiceQuoteRequest(inv, { originAsset: body.originAsset, source: "INTENTS", refundTo: body.payer }, now);
  const q = await oneclick.quote(request);
  checkInvoiceQuote(inv, q);
  // Never let the cleanup below touch an attempt that existed before this request.
  if (await db.prepare("SELECT 1 AS x FROM payment_attempts WHERE deposit_address = ?").bind(q.depositAddress).first())
    throw new HttpError(502, "NEAR Intents returned a deposit address that is already in use");
  await saveAttempt(db, attemptFor(inv, q, body.originAsset, body.payer, now));
  try {
    return await prepare(q, inv, request);
  } catch (e) {
    await db.prepare("DELETE FROM payment_attempts WHERE deposit_address = ? AND invoice_id = ? AND outcome IS NULL").bind(q.depositAddress, inv.id).run();
    throw e;
  }
}

export async function submitDepositTx(deps: Deps, publicId: string, body: { depositAddress: string; txHash: string }): Promise<void> {
  const inv = await getInvoiceByPublicId(deps.db, publicId);
  const { depositAddress, txHash } = body ?? ({} as typeof body);
  if (typeof depositAddress !== "string" || typeof txHash !== "string") throw new HttpError(400, "Invalid request");
  const hash = txHash.trim();
  if (!hash || hash.length > 200 || /\s/.test(hash)) throw new HttpError(400, "Enter a valid transaction hash.");
  const a = await deps.db.prepare("SELECT invoice_id FROM payment_attempts WHERE deposit_address = ?").bind(depositAddress).first<{ invoice_id: string }>();
  if (!a || a.invoice_id !== inv.id) throw new HttpError(404, "Payment not found");
  await deps.oneclick.submitDeposit(hash, depositAddress);
}
