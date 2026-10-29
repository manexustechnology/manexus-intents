import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { getInvoiceByPublicId } from "./invoices.ts";
import type { OneClickToken, QuoteRequest, createOneClick } from "./oneclick.ts";
import { validDestination } from "../shared/address.ts";
import { formatAmount } from "../shared/units.ts";

export type Outcome = "paid" | "duplicate" | "after_cancel" | "refunded" | "failed";

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

/** Payer-facing view. Decimals are not stored, so amountInFormatted comes from `decimals` when known. */
export function toAttemptView(row: AttemptRow, now: Date, decimals?: number): PaymentAttemptView {
  const expired = row.status === "PENDING_DEPOSIT" && new Date(row.deadline).getTime() < now.getTime();
  return {
    depositAddress: expired ? "" : row.depositAddress,
    ...(!expired && row.depositMemo ? { depositMemo: row.depositMemo } : {}),
    originAsset: row.originAsset,
    amountIn: row.amountIn,
    amountInFormatted: decimals === undefined ? row.amountIn : formatAmount(BigInt(row.amountIn), decimals),
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

export async function createPaymentQuote(
  deps: Deps,
  publicId: string,
  body: { originAsset: string; refundTo: string },
): Promise<PaymentAttemptView> {
  const { db, oneclick, now } = deps;
  const inv = await getInvoiceByPublicId(db, publicId);
  if (inv.status !== "issued" || !/^[1-9][0-9]*$/.test(inv.total)) throw notPayable();
  if (typeof body?.originAsset !== "string" || typeof body?.refundTo !== "string") throw new HttpError(400, "Choose a token and enter a refund address.");

  const count = await db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE invoice_id = ?").bind(inv.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTEMPTS) throw new HttpError(429, "Too many payment attempts for this invoice. Try again later.");

  const token: OneClickToken | undefined = (await oneclick.tokens()).find((t) => t.assetId === body.originAsset);
  if (!token) throw new HttpError(400, "That token is not supported.");
  const refundTo = body.refundTo.trim();
  if (!validDestination(token.blockchain, refundTo)) throw new HttpError(400, `Enter a valid ${token.blockchain} refund address.`);

  const request: QuoteRequest = {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: token.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: inv.tokenId,
    amount: inv.total,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: inv.owner,
    recipientType: "INTENTS",
    deadline: new Date(now.getTime() + QUOTE_MINUTES * 60_000).toISOString(),
    referral: "manexus",
  };
  const q = await oneclick.quote(request);
  if (!q.depositAddress) throw new HttpError(502, "NEAR Intents returned an unexpected response");

  const row: AttemptRow = {
    depositAddress: q.depositAddress,
    ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
    invoiceId: inv.id, originAsset: token.assetId, amountIn: q.amountIn, refundTo, deadline: q.deadline, status: "PENDING_DEPOSIT",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  await saveAttempt(db, row);
  return toAttemptView(row, now, token.decimals);
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
