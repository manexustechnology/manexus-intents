import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { displayStatus, STATUS_LABEL, type DisplayStatus, type InvoiceRow } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { formatAmount } from "../../shared/units.ts";
import { api } from "../api.ts";

const FILTERS: ("all" | DisplayStatus)[] = ["all", "draft", "issued", "overdue", "paid", "cancelled"];

export function totalLabel(inv: InvoiceRow): string {
  const t = SETTLEMENT_TOKENS.find((x) => x.tokenId === inv.tokenId);
  if (!t || inv.total === "0") return "Incomplete";
  return `${formatAmount(BigInt(inv.total), t.decimals)} ${t.symbol}`;
}

export function statusChip(inv: InvoiceRow): string {
  const s = displayStatus(inv.status, inv.data.dueDate);
  const title = s === "paid" && inv.paidAt ? ` title="Verified on NEAR Intents ${esc(inv.paidAt.slice(0, 10))}"` : "";
  return `<span class="badge status-${s}"${title}>${s === "paid" ? "✓ " : ""}${esc(STATUS_LABEL[s])}</span>`;
}

const NEAR_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** NEAR transaction hashes as NearBlocks links; anything that is not a NEAR hash is shown as plain text. */
export function txLinks(hashes: string[]): string {
  return hashes
    .map((h) =>
      NEAR_TX.test(h)
        ? `<a href="https://nearblocks.io/txns/${encodeURIComponent(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 8))}…</a>`
        : `<code>${esc(h)}</code>`,
    )
    .join(" ");
}

export function mountInvoices(el: HTMLElement): () => void {
  let alive = true;
  let filter: (typeof FILTERS)[number] = "all";
  let items: InvoiceRow[] = [];
  el.innerHTML = `<div class="heading"><div><p class="eyebrow">GET PAID IN STABLECOINS</p><h1>Invoices</h1><p class="muted">Payments settle straight into your own NEAR Intents account.</p></div><a class="primary" href="#/invoices/new">+ New invoice</a></div>
<div class="invoice-toolbar"><label>Filter<select id="invoice-filter" aria-label="Filter by status">${FILTERS.map((f) => `<option value="${f}">${f === "all" ? "All" : STATUS_LABEL[f]}</option>`).join("")}</select></label></div>
<p class="fine">Payment status updates when you open an invoice.</p>
<p class="error" id="invoice-error" role="alert"></p>
<section class="panel invoice-list" id="invoice-rows"><p class="muted" role="status">Loading…</p></section>`;
  const rows = el.querySelector<HTMLElement>("#invoice-rows")!;

  function draw() {
    const now = new Date();
    const visible = items.filter((i) => filter === "all" || displayStatus(i.status, i.data.dueDate, now) === filter);
    rows.innerHTML = visible.length
      ? visible
          .map(
            (i) =>
              `<a class="invoice-record" href="#/invoices/${esc(encodeURIComponent(i.id))}"><strong>${esc(i.data.number || "Untitled draft")}</strong><span>${esc(i.data.client || "No client")}</span><span>${esc(totalLabel(i))}</span><small>${statusChip(i)} Due ${esc(i.data.dueDate || "not set")}</small></a>`,
          )
          .join("")
      : `<p class="empty">${items.length ? "No invoices in this view." : `No invoices yet. <a href="#/invoices/new">Create your first one</a>.`}</p>`;
  }

  el.querySelector<HTMLSelectElement>("#invoice-filter")!.onchange = (e) => {
    filter = (e.target as HTMLSelectElement).value as typeof filter;
    draw();
  };
  api<InvoiceRow[]>("/api/invoices").then(
    (r) => {
      if (!alive) return;
      items = r;
      draw();
    },
    (e: unknown) => {
      if (!alive) return;
      rows.innerHTML = "";
      el.querySelector("#invoice-error")!.textContent = e instanceof Error ? e.message : "Could not load invoices.";
    },
  );
  return () => {
    alive = false;
  };
}
