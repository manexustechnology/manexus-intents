import { settlementToken } from "../shared/assets.ts";
import type { InvoiceRow, InvoiceStatus } from "../shared/invoice.ts";
import { formatAmount } from "../shared/units.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { getInvoice, getInvoiceByPublicId } from "./invoices.ts";
import type { OneClickToken, SwapStatus, createOneClick } from "./oneclick.ts";
import { listAttempts, toAttemptView, type AttemptRow, type Outcome, type PaymentAttemptView } from "./payments.ts";

export type Decision = { status: SwapStatus["status"]; outcome?: Outcome; amountOut?: string };

const DIGITS = /^[0-9]+$/;

/**
 * Pure verdict for one attempt from its 1Click status. This is the only function that may yield `paid`.
 * SUCCESS counts only if the quote that 1Click executed is exactly the one we asked for: EXACT_OUTPUT of
 * the invoice total in the invoice token into the owner's Intents account, delivered amount >= total.
 * A SUCCESS without the executed quote or a base-unit `amountOut` is not decided yet (re-checked on the
 * next refresh); a SUCCESS that definitely does not match is `mismatch`.
 */
export function decideOutcome(invoice: InvoiceRow, attempt: AttemptRow, s: SwapStatus): Decision {
  const base: Decision = { status: s.status, ...(s.amountOut !== undefined && DIGITS.test(s.amountOut) ? { amountOut: s.amountOut } : {}) };
  if (s.status === "REFUNDED") return { ...base, outcome: "refunded" };
  if (s.status === "FAILED") return { ...base, outcome: "failed" };
  if (s.status !== "SUCCESS") return base;

  const q = s.quoteRequest;
  if (!q || typeof s.amountOut !== "string" || !DIGITS.test(s.amountOut)) return base;
  const matches =
    attempt.invoiceId === invoice.id &&
    (s.depositAddress === undefined || s.depositAddress === attempt.depositAddress) &&
    q.swapType === "EXACT_OUTPUT" &&
    q.recipient === invoice.owner &&
    q.recipientType === "INTENTS" &&
    q.destinationAsset === invoice.tokenId &&
    q.amount === invoice.total &&
    DIGITS.test(invoice.total) &&
    BigInt(invoice.total) > 0n &&
    BigInt(s.amountOut) >= BigInt(invoice.total);
  if (!matches) return { ...base, outcome: "mismatch" };
  if (invoice.status === "issued") return { ...base, outcome: "paid" };
  if (invoice.status === "paid") return { ...base, outcome: invoice.paidBy === attempt.depositAddress ? "paid" : "duplicate" };
  if (invoice.status === "cancelled") return { ...base, outcome: "after_cancel" };
  return base;
}

type OneClick = Pick<ReturnType<typeof createOneClick>, "status" | "tokens">;
export type ReconcileDeps = { db: Db; oneclick: OneClick; now: Date };

const THROTTLE_MS = 5_000;
const EXPIRED_GRACE_MS = 24 * 3_600_000;

async function loadInvoice(db: Db, id: string): Promise<InvoiceRow> {
  const r = await db.prepare("SELECT owner FROM invoices WHERE id = ?").bind(id).first<{ owner: string }>();
  if (!r) throw new HttpError(404, "Invoice not found");
  return getInvoice(db, r.owner, id);
}

function trimmed(s: SwapStatus): string {
  const hs = (a: string[]) => a.slice(0, 10).map((h) => h.slice(0, 200));
  return JSON.stringify({
    status: s.status,
    updatedAt: s.updatedAt,
    ...(s.amountOut !== undefined ? { amountOut: s.amountOut } : {}),
    ...(s.refundedAmount !== undefined ? { refundedAmount: s.refundedAmount } : {}),
    originTxHashes: hs(s.originTxHashes),
    destinationTxHashes: hs(s.destinationTxHashes),
  });
}

function needsRefresh(a: AttemptRow, now: Date): boolean {
  if (a.outcome) return false;
  if (now.getTime() - new Date(a.updatedAt).getTime() < THROTTLE_MS) return false;
  // A quote nobody paid into: stop asking 1Click a day after it expired. In-flight statuses keep being checked.
  if (a.status === "PENDING_DEPOSIT" && new Date(a.deadline).getTime() + EXPIRED_GRACE_MS < now.getTime()) return false;
  return true;
}

/**
 * Lazily reconcile every open attempt of an invoice against 1Click. Attempts are processed oldest first;
 * the guarded UPDATE (status='issued') picks a single winner even across concurrent refreshes.
 * An upstream error leaves that attempt untouched; remaining attempts are still processed, then the
 * first error is rethrown.
 */
export async function refreshInvoice(deps: ReconcileDeps, invoiceId: string): Promise<void> {
  const { db, oneclick, now } = deps;
  const at = now.toISOString();
  const open = (await listAttempts(db, invoiceId))
    .filter((a) => needsRefresh(a, now))
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.depositAddress < y.depositAddress ? -1 : 1));
  let firstError: unknown;
  for (const a of open) {
    let s: SwapStatus;
    try {
      s = await oneclick.status(a.depositAddress, a.depositMemo);
    } catch (e) {
      firstError ??= e;
      continue;
    }
    let inv = await loadInvoice(db, invoiceId);
    let d = decideOutcome(inv, a, s);
    if (d.outcome === "paid" && inv.status === "issued") {
      const r = await db
        .prepare("UPDATE invoices SET status='paid', paid_at=?, paid_by=?, updated_at=? WHERE id=? AND status='issued'")
        .bind(at, a.depositAddress, at, invoiceId)
        .run();
      if (r.meta.changes !== 1) {
        inv = await loadInvoice(db, invoiceId);
        d = decideOutcome(inv, a, s);
      }
    }
    if (d.outcome === "mismatch")
      console.warn(`reconcile: SUCCESS for ${a.depositAddress} on invoice ${invoiceId} does not match the invoice; not marked paid, needs review`);
    // Never overwrite an outcome another refresh already recorded.
    await db
      .prepare("UPDATE payment_attempts SET status=?, outcome=?, amount_out=?, upstream=?, updated_at=? WHERE deposit_address=? AND outcome IS NULL")
      .bind(d.status, d.outcome ?? null, d.amountOut ?? a.amountOut ?? null, trimmed(s), at, a.depositAddress)
      .run();
  }
  if (firstError !== undefined) throw firstError;
}

export type PublicAttemptView = PaymentAttemptView & { destinationTxHashes: string[] };
export type OwnerAttemptView = PublicAttemptView & {
  originTxHashes: string[];
  amountOut?: string;
  amountOutFormatted?: string;
  refundTo: string;
  createdAt: string;
};
export type StatusResult<T> = { invoiceStatus: InvoiceStatus; attempts: T[]; refreshError?: string };

function upstreamOf(a: AttemptRow): { originTxHashes: string[]; destinationTxHashes: string[] } {
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : []);
  try {
    const u = JSON.parse(a.upstream ?? "{}") as Record<string, unknown>;
    return { originTxHashes: strs(u.originTxHashes), destinationTxHashes: strs(u.destinationTxHashes) };
  } catch {
    return { originTxHashes: [], destinationTxHashes: [] };
  }
}

/**
 * If the origin token is unknown (delisted, or the token list is unavailable) we cannot format the amount,
 * so symbol/blockchain/amountInFormatted are "" rather than showing raw base units as if formatted.
 * The raw `amountIn` and `originAsset` stay available.
 */
function publicView(a: AttemptRow, now: Date, tokens: OneClickToken[]): PublicAttemptView {
  const t = tokens.find((x) => x.assetId === a.originAsset);
  const v = t
    ? toAttemptView(a, now, t)
    : { ...toAttemptView(a, now, { symbol: "", blockchain: "", decimals: 0 }), amountInFormatted: "" };
  return { ...v, destinationTxHashes: upstreamOf(a).destinationTxHashes };
}

async function refreshSoft(deps: ReconcileDeps, invoiceId: string): Promise<string | undefined> {
  try {
    await refreshInvoice(deps, invoiceId);
    return undefined;
  } catch (e) {
    if (e instanceof HttpError && e.status === 502) return "Could not reach NEAR Intents. Payment status may be out of date.";
    throw e;
  }
}

const tokensOrEmpty = (oc: OneClick) => oc.tokens().catch(() => [] as OneClickToken[]);

export async function publicStatus(deps: ReconcileDeps, publicId: string): Promise<StatusResult<PublicAttemptView>> {
  const inv = await getInvoiceByPublicId(deps.db, publicId);
  const refreshError = await refreshSoft(deps, inv.id);
  const [fresh, rows, tokens] = await Promise.all([loadInvoice(deps.db, inv.id), listAttempts(deps.db, inv.id), tokensOrEmpty(deps.oneclick)]);
  return {
    invoiceStatus: fresh.status,
    attempts: rows.map((a) => publicView(a, deps.now, tokens)),
    ...(refreshError ? { refreshError } : {}),
  };
}

export async function ownerPayments(deps: ReconcileDeps, owner: string, id: string): Promise<StatusResult<OwnerAttemptView>> {
  const inv = await getInvoice(deps.db, owner, id);
  const refreshError = await refreshSoft(deps, inv.id);
  const [fresh, rows, tokens] = await Promise.all([getInvoice(deps.db, owner, id), listAttempts(deps.db, inv.id), tokensOrEmpty(deps.oneclick)]);
  const decimals = settlementToken(fresh.tokenId).decimals;
  return {
    invoiceStatus: fresh.status,
    attempts: rows.map((a) => ({
      ...publicView(a, deps.now, tokens),
      originTxHashes: upstreamOf(a).originTxHashes,
      ...(a.amountOut && DIGITS.test(a.amountOut) ? { amountOut: a.amountOut, amountOutFormatted: formatAmount(BigInt(a.amountOut), decimals) } : {}),
      refundTo: a.refundTo,
      createdAt: a.createdAt,
    })),
    ...(refreshError ? { refreshError } : {}),
  };
}
