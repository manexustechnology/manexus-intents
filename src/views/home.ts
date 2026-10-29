import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { displayStatus, type InvoiceRow } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { formatAmount } from "../../shared/units.ts";
import { api } from "../api.ts";
import type { Session } from "../wallet/index.ts";
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

export function mountHome(el: HTMLElement): () => void {
  let alive = true;
  el.innerHTML = `<div class="heading"><div><p class="eyebrow">OVERVIEW</p><h1>Home</h1><p class="muted" id="home-custody">Your funds are held in your own NEAR Intents account, controlled by your wallet.</p></div><div class="home-actions"><a class="primary" href="#/invoices/new">+ New invoice</a><a class="secondary" href="#/withdraw">Withdraw</a></div></div>
<section class="panel" aria-labelledby="home-balance-title"><p class="eyebrow" id="home-balance-title">TOTAL BALANCE</p><p class="home-total" id="home-total" role="status">Loading…</p><p class="muted"><small>USD values use a reference price and may differ from what you receive when withdrawing.</small></p><p class="error" id="home-balance-error" role="alert"></p><div class="home-cards" id="home-cards"></div></section>
<section class="panel" aria-labelledby="home-recv-title"><p class="eyebrow" id="home-recv-title">RECEIVABLES</p><div id="home-recv"><p class="muted">Loading…</p></div></section>
<section class="panel" aria-labelledby="home-recent-title"><div class="section-title"><p class="eyebrow" id="home-recent-title">RECENT INVOICES</p><a href="#/invoices">View all</a></div><div class="invoice-list" id="home-recent"><p class="muted">Loading…</p></div></section>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;

  api<Session>("/api/me").then(
    (s) => {
      if (alive) q("#home-custody").textContent = `Your funds are held in your own NEAR Intents account (${s.account}), controlled by your wallet.`;
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
        : `<p class="empty">No balance yet. Paid invoices land here.</p>`;
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
        : `<p class="empty">No invoices yet. Create your first one.</p>`;
    },
    (e: unknown) => {
      if (!alive) return;
      const msg = esc(e instanceof Error ? e.message : "Could not load invoices.");
      q("#home-recv").innerHTML = `<p class="error" role="alert">${msg}</p>`;
      q("#home-recent").innerHTML = "";
    },
  );
  return () => {
    alive = false;
  };
}
