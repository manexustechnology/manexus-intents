// Small helpers shared by the transfer views (withdraw, swap, bill pay, pay).
import { escapeHTML as esc } from "../../shared/text.ts";
import { ICONS } from "../icons.ts";

export const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Where the money starts and ends, e.g. USDC on Arbitrum → USDC in NEAR Intents. */
export function routeHtml(steps: { symbol: string; where: string }[]): string {
  const label = steps.map((x) => `${x.symbol} on ${x.where}`).join(", then ");
  return `<ol class="route" aria-label="Route: ${esc(label)}">${steps
    .map((x, i) => `<li>${i ? `<span class="route-arrow">${ICONS.arrowRight}</span>` : ""}<span class="route-step"><strong>${esc(x.symbol)}</strong><small>${esc(x.where)}</small></span></li>`)
    .join("")}</ol>`;
}

/** Empty-balance panel: says how funds arrive and offers the next step. `extra` goes after the call to action. */
export function emptyBalanceHtml(title: string, extra = "", id = ""): string {
  return `<section class="panel empty-state"${id ? ` id="${id}"` : ""}><h2>${title}</h2><p class="muted">Your NEAR Intents balance is empty. Create an invoice and share its payment link: your customer pays from any chain and the funds land here.</p><div class="invoice-actions"><a class="primary" href="#/invoices/new">Create an invoice</a>${extra}</div></section>`;
}

/** m:ss until `deadline` (never negative). */
export function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
