import { SETTLEMENT_TOKENS, settlementToken } from "../shared/assets.ts";
import { formatAmount } from "../shared/units.ts";
import type { Db } from "./db.ts";
import { listTransfers, type TransferKind } from "./transfers.ts";

export type ActivityType = "invoice_paid" | "payment_received_extra" | TransferKind;
export type ActivityItem = { at: string; type: ActivityType; title: string; amountFormatted: string; symbol: string; status: string; href: string };
export type MonthSummary = { month: string; tokens: { tokenId: string; symbol: string; received: string; sent: string; receivedFormatted: string; sentFormatted: string }[] };

type User = { account: string; kind: "near" | "evm" };
type Deps = { db: Db; now: Date };
type AttemptRow = { outcome: string; amount_out: string | null; updated_at: string; invoice_id: string; token_id: string; data: string };

const RECEIVED = "('paid','duplicate','after_cancel')";

function numberOf(data: string): string {
  try {
    const n = (JSON.parse(data) as { number?: unknown }).number;
    return typeof n === "string" && n ? n : "invoice";
  } catch {
    return "invoice";
  }
}

function clamp(limit: number): number {
  return Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
}

const HREF: Record<TransferKind, string> = { withdraw: "#/withdraw", swap: "#/swap", bill: "#/bills", payroll: "#/payroll" };
const hrefOf = (t: { kind: TransferKind; billId?: string; batchId?: string }) =>
  t.kind === "bill" && t.billId
    ? `#/bills/${encodeURIComponent(t.billId)}`
    : t.kind === "payroll" && t.batchId
      ? `#/payroll/${encodeURIComponent(t.batchId)}`
      : HREF[t.kind];

export async function listActivity(deps: Deps, user: User, limit = 50): Promise<ActivityItem[]> {
  const n = clamp(limit);
  const { results } = await deps.db
    .prepare(
      `SELECT a.outcome, a.amount_out, a.updated_at, a.invoice_id, i.token_id, i.data FROM payment_attempts a JOIN invoices i ON i.id = a.invoice_id
       WHERE a.invoice_id IN (SELECT id FROM invoices WHERE owner = ?) AND a.outcome IN ${RECEIVED} ORDER BY a.updated_at DESC, a.deposit_address LIMIT ?`,
    )
    .bind(user.account, n)
    .all<AttemptRow>();
  const items: ActivityItem[] = results.map((r) => {
    const t = SETTLEMENT_TOKENS.find((x) => x.tokenId === r.token_id);
    const extra = r.outcome !== "paid";
    return {
      at: r.updated_at,
      type: extra ? "payment_received_extra" : "invoice_paid",
      title: `${extra ? "Extra payment received" : "Payment received"} · ${numberOf(r.data)}`,
      amountFormatted: t && r.amount_out ? formatAmount(BigInt(r.amount_out), t.decimals) : "—",
      symbol: t?.symbol ?? "",
      status: r.outcome,
      href: `#/invoices/${encodeURIComponent(r.invoice_id)}`,
    };
  });
  for (const t of await listTransfers(deps, user, undefined, n)) {
    const title =
      t.kind === "withdraw" ? `Withdrawal to ${t.destinationBlockchain}` : t.kind === "swap" ? `Swap ${t.originSymbol} → ${t.destinationSymbol}` : t.kind === "bill" ? "Bill payment" : "Payroll";
    items.push({ at: t.createdAt, type: t.kind, title, amountFormatted: t.amountFormatted, symbol: t.originSymbol, status: t.status, href: hrefOf(t) });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, n);
}

/**
 * What a transfer actually took from the balance: `amount` (for EXACT_OUTPUT the quote's amountIn, which
 * includes the slippage buffer) less the `refundedAmount` 1Click reported, never below 0. Without a reported
 * refund the whole amount counts, buffer included.
 */
function netSent(amount: string, upstream: string | null): string {
  if (!/^\d+$/.test(amount)) return amount;
  let refunded: unknown;
  try {
    refunded = (JSON.parse(upstream ?? "null") as { refundedAmount?: unknown } | null)?.refundedAmount;
  } catch {
    return amount;
  }
  if (typeof refunded !== "string" || !/^\d+$/.test(refunded)) return amount;
  const net = BigInt(amount) - BigInt(refunded);
  return (net > 0n ? net : 0n).toString();
}

/** Received vs sent per settlement token in the current UTC month. Sums are bigint; tokens are never mixed. */
export async function monthSummary(deps: Deps, user: User): Promise<MonthSummary> {
  const y = deps.now.getUTCFullYear();
  const m = deps.now.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1)).toISOString();
  const to = new Date(Date.UTC(y, m + 1, 1)).toISOString();
  const recv = new Map<string, bigint>();
  const sent = new Map<string, bigint>();
  const add = (map: Map<string, bigint>, k: string, v: string | null) => {
    if (v && /^\d+$/.test(v)) map.set(k, (map.get(k) ?? 0n) + BigInt(v));
  };
  const a = await deps.db
    .prepare(
      `SELECT i.token_id AS token, a.amount_out AS amount FROM payment_attempts a JOIN invoices i ON i.id = a.invoice_id
       WHERE i.owner = ? AND a.outcome IN ${RECEIVED} AND a.updated_at >= ? AND a.updated_at < ?`,
    )
    .bind(user.account, from, to)
    .all<{ token: string; amount: string | null }>();
  for (const r of a.results) add(recv, r.token, r.amount);
  // A swap stays in the owner's own Intents account: an internal move, not money sent.
  const s = await deps.db
    .prepare(`SELECT origin_asset AS token, amount, upstream FROM withdrawals WHERE owner = ? AND status = 'SUCCESS' AND kind != 'swap' AND updated_at >= ? AND updated_at < ?`)
    .bind(user.account, from, to)
    .all<{ token: string; amount: string; upstream: string | null }>();
  for (const r of s.results) add(sent, r.token, netSent(r.amount, r.upstream));
  return {
    month: from.slice(0, 7),
    tokens: SETTLEMENT_TOKENS.map((t) => {
      const r = recv.get(t.tokenId) ?? 0n;
      const o = sent.get(t.tokenId) ?? 0n;
      return { tokenId: t.tokenId, symbol: settlementToken(t.tokenId).symbol, received: r.toString(), sent: o.toString(), receivedFormatted: formatAmount(r, t.decimals), sentFormatted: formatAmount(o, t.decimals) };
    }),
  };
}
