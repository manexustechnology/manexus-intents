import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { displayStatus, type InvoiceRow } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { formatAmount } from "../../shared/units.ts";
import { api } from "../api.ts";
import type { Session } from "../wallet/index.ts";
import { daysUntil, type Bill } from "./bills.ts";
import { statusChip, totalLabel } from "./invoices.ts";

type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string; usd?: string };

/** Sum of "123.45" strings, in cents, without floats. */
function sumUsd(values: string[]): string {
  const cents = values.reduce((n, v) => n + BigInt(v.replace(".", "")), 0n);
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function receivables(items: InvoiceRow[], now = new Date()): { totals: string[]; overdue: number; count: number } {
  const open = items.filter((i) => i.status === "issued");
  const sums = new Map<string, bigint>();
  for (const i of open) sums.set(i.tokenId, (sums.get(i.tokenId) ?? 0n) + BigInt(i.total));
  const totals = [...sums].flatMap(([tokenId, sum]) => {
    const t = SETTLEMENT_TOKENS.find((x) => x.tokenId === tokenId);
    return t ? [`${formatAmount(sum, t.decimals)} ${t.symbol}`] : [];
  });
  return { totals, overdue: open.filter((i) => displayStatus(i.status, i.data.dueDate, now) === "overdue").length, count: open.length };
}

/** Scheduled bills due within `days` (overdue included), summed per token, plus the overdue count. */
export function payables(bills: Bill[], now = new Date(), days = 14): { totals: string[]; overdue: number; due: number; count: number } {
  const open = bills.filter((b) => b.status === "scheduled");
  const soon = open.filter((b) => daysUntil(b.dueDate, now) <= days);
  const sums = new Map<string, { sum: bigint; symbol: string; decimals: number }>();
  for (const b of soon) {
    if (b.decimals === undefined) continue;
    // The same symbol exists on several chains (USDC on NEAR and on Arbitrum): name the chain when it is not NEAR.
    const label = b.blockchain && b.blockchain !== "near" ? `${b.symbol} (${b.blockchain})` : b.symbol;
    const cur = sums.get(b.destinationAsset) ?? { sum: 0n, symbol: label, decimals: b.decimals };
    cur.sum += BigInt(b.amount);
    sums.set(b.destinationAsset, cur);
  }
  const totals = [...sums.values()].map((t) => `${formatAmount(t.sum, t.decimals)} ${t.symbol}`);
  return { totals, overdue: open.filter((b) => daysUntil(b.dueDate, now) < 0).length, due: soon.length, count: open.length };
}

type ActivityItem = { at: string; type: string; title: string; amountFormatted: string; symbol: string; status: string; href: string };
type MonthSummary = { month: string; tokens: { tokenId: string; symbol: string; receivedFormatted: string; sentFormatted: string; received: string; sent: string }[] };
const ICONS: Record<string, string> = { invoice_paid: "↓", payment_received_extra: "↓", withdraw: "↑", swap: "⇄", bill: "↑", payroll: "↑" };
const STATUS_LABEL: Record<string, string> = { paid: "Received", duplicate: "Extra payment", after_cancel: "Extra payment", SUCCESS: "Completed", PROCESSING: "Processing", PENDING_DEPOSIT: "Processing", AWAITING_SIGNATURE: "Awaiting signature", FAILED: "Failed", REFUNDED: "Refunded", INCOMPLETE_DEPOSIT: "Incomplete" };

export function mountHome(el: HTMLElement): () => void {
  let alive = true;
  el.innerHTML = `<div class="heading"><div><p class="eyebrow">OVERVIEW</p><h1>Home</h1><p class="muted" id="home-custody">Your funds are held in your own NEAR Intents account, controlled by your wallet.</p></div><div class="home-actions"><a class="primary" href="#/invoices/new">+ New invoice</a><a class="secondary" href="#/withdraw">Withdraw</a></div></div>
<section class="panel" aria-labelledby="home-balance-title"><p class="eyebrow" id="home-balance-title">CASH</p><p class="home-total" id="home-total" role="status">Loading…</p><p class="muted"><small>USD values use a reference price and may differ from what you receive when withdrawing.</small></p><p class="error" id="home-balance-error" role="alert"></p><div class="home-cards" id="home-cards"></div></section>
<p class="home-agent" id="home-agent" hidden></p>
<div class="home-tiles"><section class="panel" aria-labelledby="home-recv-title"><p class="eyebrow" id="home-recv-title">RECEIVABLES</p><div id="home-recv"><p class="muted">Loading…</p></div></section>
<section class="panel" aria-labelledby="home-pay-title"><p class="eyebrow" id="home-pay-title">PAYABLES</p><div id="home-pay"><p class="muted">Loading…</p></div></section>
<section class="panel" aria-labelledby="home-month-title"><p class="eyebrow" id="home-month-title">THIS MONTH</p><div id="home-month"><p class="muted">Loading…</p></div></section></div>
<section class="panel" aria-labelledby="home-activity-title"><p class="eyebrow" id="home-activity-title">ACTIVITY</p><div class="activity-list" id="home-activity"><p class="muted">Loading…</p></div></section>
<section class="panel" aria-labelledby="home-recent-title"><div class="section-title"><p class="eyebrow" id="home-recent-title">RECENT INVOICES</p><a href="#/invoices">View all</a></div><div class="invoice-list" id="home-recent"><p class="muted">Loading…</p></div></section>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;

  api<Session>("/api/me").then(
    (s) => {
      if (alive) q("#home-custody").textContent = `Your funds are held in your own NEAR Intents account (${s.account}), controlled by your wallet.`;
    },
    () => {},
  );

  // The agent's open suggestions (the request also runs the throttled agent). Hidden on error or without rules.
  api<{ status: string }[]>("/api/agent/proposals").then(
    (list) => {
      if (!alive) return;
      const n = list.filter((p) => p.status === "proposed").length;
      const box = q("#home-agent");
      box.innerHTML = `<a class="secondary" href="#/agent">Agent suggestions (${n})</a>`;
      box.hidden = false;
    },
    () => {},
  );

  api<Balance[]>("/api/balances").then(
    (b) => {
      if (!alive) return;
      const priced = b.filter((x) => x.usd);
      q("#home-total").innerHTML = priced.length ? `$${esc(sumUsd(priced.map((x) => x.usd!)))} <small>reference price</small>` : b.length ? "No reference price available" : "$0.00";
      q("#home-cards").innerHTML = b.length
        ? b
            .map(
              (x) =>
                `<div class="home-card"><strong>${esc(x.formatted)} ${esc(x.symbol)}</strong><small>${esc(x.blockchain)}</small>${x.usd ? `<small>≈ $${esc(x.usd)} reference price</small>` : ""}</div>`,
            )
            .join("")
        : `<p class="empty">No balance yet. Paid invoices land here, whatever chain your customer pays from. <a href="#/invoices/new">Create an invoice</a>.</p>`;
    },
    (e: unknown) => {
      if (!alive) return;
      q("#home-total").textContent = "Unavailable";
      q("#home-balance-error").textContent = e instanceof Error ? e.message : "Could not read NEAR Intents balance";
    },
  );

  api<InvoiceRow[]>("/api/invoices").then(
    (items) => {
      if (!alive) return;
      const r = receivables(items);
      q("#home-recv").innerHTML = r.count
        ? `<p class="home-total">${r.totals.map(esc).join(" + ") || "—"}</p><p class="muted">${r.count} unpaid ${r.count === 1 ? "invoice" : "invoices"} · ${r.overdue} overdue</p><p class="fine">Payment status updates when you open an invoice.</p>`
        : `<p class="muted">Nothing outstanding.</p>`;
      const recent = items.slice(0, 5);
      q("#home-recent").innerHTML = recent.length
        ? recent
            .map(
              (i) =>
                `<a class="invoice-record" href="#/invoices/${esc(encodeURIComponent(i.id))}"><strong>${esc(i.data.number || "Untitled draft")}</strong><span>${esc(i.data.client || "No client")}</span><span>${esc(totalLabel(i))}</span><small>${statusChip(i)} Due ${esc(i.data.dueDate || "not set")}</small></a>`,
            )
            .join("")
        : `<p class="empty">No invoices yet. <a href="#/invoices/new">Create your first one</a>.</p>`;
    },
    (e: unknown) => {
      if (!alive) return;
      const msg = esc(e instanceof Error ? e.message : "Could not load invoices.");
      q("#home-recv").innerHTML = `<p class="error" role="alert">${msg}</p>`;
      q("#home-recent").innerHTML = "";
    },
  );
  api<Bill[]>("/api/bills?status=scheduled").then(
    (bills) => {
      if (!alive) return;
      const p = payables(bills);
      q("#home-pay").innerHTML = !p.count
        ? `<p class="muted">No scheduled bills</p>`
        : p.due
          ? `<p class="home-total">${p.totals.map(esc).join(" + ") || "—"}</p><p class="muted">${p.due} ${p.due === 1 ? "bill" : "bills"} due in the next 14 days · ${p.overdue} overdue</p><p class="fine"><a href="#/bills">View bills</a></p>`
          : `<p class="muted">Nothing due in the next 14 days.</p><p class="fine"><a href="#/bills">View bills</a></p>`;
    },
    (e: unknown) => {
      if (alive) q("#home-pay").innerHTML = `<p class="error" role="alert">${esc(e instanceof Error ? e.message : "Could not load bills.")}</p>`;
    },
  );
  api<MonthSummary>("/api/activity?summary=month").then(
    (m) => {
      if (!alive) return;
      const rows = m.tokens.filter((t) => t.received !== "0" || t.sent !== "0");
      q("#home-month").innerHTML = rows.length
        ? rows.map((t) => `<p><strong>${esc(t.symbol)}</strong> <span class="muted">received</span> ${esc(t.receivedFormatted)} · <span class="muted">sent</span> ${esc(t.sentFormatted)}</p>`).join("")
        : `<p class="muted">No activity this month.</p>`;
    },
    (e: unknown) => {
      if (alive) q("#home-month").innerHTML = `<p class="error" role="alert">${esc(e instanceof Error ? e.message : "Could not load this month.")}</p>`;
    },
  );

  api<ActivityItem[]>("/api/activity").then(
    (items) => {
      if (!alive) return;
      q("#home-activity").innerHTML = items.length
        ? items
            .map(
              (a) =>
                `<a class="activity-row" href="${esc(a.href)}"><span class="activity-icon" aria-hidden="true">${esc(ICONS[a.type] ?? "•")}</span><span><strong>${esc(a.title)}</strong><small>${esc(a.at.slice(0, 10))} · ${esc(STATUS_LABEL[a.status] ?? a.status)}</small></span><span class="activity-amount">${esc(a.amountFormatted)} ${esc(a.symbol)}</span></a>`,
            )
            .join("")
        : `<p class="empty">No activity yet.</p>`;
    },
    (e: unknown) => {
      if (alive) q("#home-activity").innerHTML = `<p class="error" role="alert">${esc(e instanceof Error ? e.message : "Could not load activity.")}</p>`;
    },
  );
  return () => {
    alive = false;
  };
}
