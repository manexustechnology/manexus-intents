import { supportedChain } from "../../shared/address.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { validAmount } from "../../shared/units.ts";
import { api, postJson } from "../api.ts";
import { msg } from "./transfer-ui.ts";
import { chainName } from "./withdraw.ts";

export type BillStatus = "scheduled" | "paying" | "paid" | "cancelled";
export type Bill = {
  id: string; vendor: string; reference: string; dueDate: string; destinationAsset: string; recipientType: "DESTINATION_CHAIN" | "INTENTS";
  recipient: string; amount: string; amountFormatted: string; symbol: string; blockchain: string; decimals?: number; source: "manual" | "manexus";
  vendorPublicId?: string; status: BillStatus; depositAddress?: string; overdue: boolean; createdAt: string; updatedAt: string;
};
type Draft = {
  vendor: string; reference: string; dueDate: string; destinationAsset: string; recipient: string; amount: string; amountFormatted: string; symbol: string; vendorPublicId: string;
};
type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };

export const BILL_STATUS_LABEL: Record<BillStatus, string> = { scheduled: "Scheduled", paying: "Paying", paid: "Paid", cancelled: "Cancelled" };
const SECTIONS: BillStatus[] = ["scheduled", "paying", "paid", "cancelled"];
const MAX_OPTIONS = 100;
const DAY_MS = 86_400_000;

/** Whole UTC days from `now` until `dueDate` (negative once past). */
export function daysUntil(dueDate: string, now = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(dueDate + "T00:00:00Z") - today) / DAY_MS);
}

/** "Overdue" / "Due today" / "Due in N days" chip for a scheduled bill; empty for any other status. */
export function dueChip(b: Pick<Bill, "status" | "dueDate">, now = new Date()): string {
  if (b.status !== "scheduled") return "";
  const d = daysUntil(b.dueDate, now);
  if (d < 0) return `<span class="badge status-overdue">Overdue</span>`;
  return `<span class="badge status-due">${d === 0 ? "Due today" : d === 1 ? "Due tomorrow" : `Due in ${d} days`}</span>`;
}

export const billStatusBadge = (s: BillStatus, extra = false) =>
  `<span class="badge status-bill-${s}">${s === "paid" ? "✓ " : ""}${esc(extra && s === "paid" ? "Paid — vendor reports extra payment" : BILL_STATUS_LABEL[s])}</span>`;

export const amountLabel = (b: Pick<Bill, "amountFormatted" | "symbol">) => (b.amountFormatted ? `${b.amountFormatted} ${b.symbol}` : "Unknown token");

export function mountBills(el: HTMLElement): () => void {
  let alive = true;
  el.innerHTML = `<div class="heading"><div><p class="eyebrow">PAY VENDORS</p><h1>Bills</h1><p class="muted">Pay vendors from your NEAR Intents balance. You sign every payment in your wallet.</p></div><a class="primary" href="#/bills/new">+ New bill</a></div>
<p class="error" id="bill-error" role="alert"></p><div id="bill-sections"><section class="panel"><p class="muted" role="status">Loading…</p></section></div>`;
  api<Bill[]>("/api/bills").then(
    (items) => {
      if (!alive) return;
      const box = el.querySelector<HTMLElement>("#bill-sections")!;
      if (!items.length) {
        box.innerHTML = `<section class="panel"><p class="empty">No bills yet. Paste a Manexus invoice link or enter a bill by hand.</p></section>`;
        return;
      }
      box.innerHTML = SECTIONS.map((s) => {
        const rows = items.filter((b) => b.status === s);
        if (!rows.length) return "";
        return `<section class="panel invoice-list" aria-labelledby="bills-${s}" id="bills-section-${s}"><p class="eyebrow" id="bills-${s}">${esc(BILL_STATUS_LABEL[s].toUpperCase())}</p>${rows
          .map(
            (b) =>
              `<a class="invoice-record" href="#/bills/${esc(encodeURIComponent(b.id))}"><strong>${esc(b.vendor)}</strong><span>${esc(b.reference || "No reference")}</span><span>${esc(amountLabel(b))}</span><small>${billStatusBadge(b.status)} ${dueChip(b)} Due ${esc(b.dueDate)}</small></a>`,
          )
          .join("")}</section>`;
      }).join("");
    },
    (e: unknown) => {
      if (!alive) return;
      el.querySelector<HTMLElement>("#bill-error")!.textContent = msg(e);
      el.querySelector<HTMLElement>("#bill-sections")!.innerHTML = "";
    },
  );
  return () => {
    alive = false;
  };
}

export function mountNewBill(el: HTMLElement): () => void {
  let alive = true;
  let tab: "link" | "manual" = "link";
  let tokens: Token[] = [];
  let error = "";
  let busy = "";
  let draft: Draft | null = null;
  const link = { value: "", dueDate: "" };
  const form = { vendor: "", reference: "", dueDate: "", search: "", dest: "", recipient: "", amount: "" };
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);
  const tokenLabel = (t: Token) => `${t.symbol} · ${chainName(t.blockchain)}`;

  function draw() {
    const tabs = `<div class="tabs" role="tablist"><button type="button" role="tab" id="tab-link" aria-selected="${tab === "link"}" aria-controls="bill-panel">Paste Manexus invoice link</button><button type="button" role="tab" id="tab-manual" aria-selected="${tab === "manual"}" aria-controls="bill-panel">Manual</button></div>`;
    el.innerHTML = `<div class="heading"><div><p class="eyebrow">PAY VENDORS</p><h1>New bill</h1><p class="muted">Bills are paid from your NEAR Intents balance when you choose to pay them.</p></div><a class="textbutton" href="#/bills">Back to bills</a></div>
<section class="panel">${tabs}<div id="bill-panel" role="tabpanel">${tab === "link" ? linkHtml() : manualHtml()}</div></section>`;
    wire();
  }

  function linkHtml(): string {
    if (!draft)
      return `<form id="bill-import" novalidate><label>Manexus invoice link<input id="bill-link" autocomplete="off" spellcheck="false" placeholder="${esc(location.origin)}/#/pay/…" value="${esc(link.value)}"></label>
<p class="fine">Paste the payment link your vendor shared. The amount and payee come from their Manexus invoice.</p>
<p class="error" id="bill-form-error" role="alert">${esc(error)}</p><button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Import invoice"}</button></form>`;
    const d = draft;
    return `<form id="bill-save-import" novalidate><div class="invoice-form-grid">
<label>Vendor<input id="bill-vendor" value="${esc(d.vendor)}" readonly></label>
<label>Invoice number<input id="bill-reference" value="${esc(d.reference)}" readonly></label>
<label>Vendor receives<input id="bill-amount" value="${esc(d.amountFormatted)} ${esc(d.symbol)}" readonly></label>
<label>Pays to<input id="bill-recipient" value="Manexus account ${esc(d.recipient)}" readonly></label>
<label>Due date<input id="bill-due" type="date" value="${esc(link.dueDate || d.dueDate)}"></label></div>
<p class="fine">These details come from the vendor's invoice and cannot be edited here.</p>
<p class="error" id="bill-form-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="bill-import-again" ${busy ? "disabled" : ""}>Use another link</button><button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Save bill"}</button></div></form>`;
  }

  function manualHtml(): string {
    const s = form.search.trim().toLowerCase();
    const matches = tokens.filter((t) => supportedChain(t.blockchain) && (!s || tokenLabel(t).toLowerCase().includes(s) || t.blockchain.includes(s)));
    const shown = matches.slice(0, MAX_OPTIONS);
    const d = tokenOf(form.dest);
    return `<form id="bill-manual" novalidate><div class="invoice-form-grid">
<label>Vendor<input id="bill-vendor" maxlength="100" value="${esc(form.vendor)}"></label>
<label>Reference<input id="bill-reference" maxlength="100" placeholder="Their invoice number" value="${esc(form.reference)}"></label>
<label>Due date<input id="bill-due" type="date" value="${esc(form.dueDate)}"></label></div>
<label>Search token or chain the vendor receives<input id="bill-search" autocomplete="off" placeholder="e.g. USDC or arb" value="${esc(form.search)}"></label>
<label>Vendor receives<select id="bill-dest" size="6">${shown
      .map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === form.dest ? "selected" : ""}>${esc(tokenLabel(t))}</option>`)
      .join("")}</select></label>
${matches.length > shown.length ? `<p class="fine">Showing the first ${MAX_OPTIONS} matches. Type to narrow the list.</p>` : ""}
<label>${d ? `Vendor address on ${esc(chainName(d.blockchain))}` : "Vendor address"}<input id="bill-recipient" autocomplete="off" spellcheck="false" value="${esc(form.recipient)}"></label>
<p class="fine" id="bill-network-hint">${d ? `Enter an address on ${esc(chainName(d.blockchain))}. Funds sent to a wrong address or network usually cannot be recovered.` : "Choose the token first; the address must be on its network."}</p>
<label>Amount the vendor receives${d ? ` (${esc(d.symbol)})` : ""}<input id="bill-amount" inputmode="decimal" autocomplete="off" value="${esc(form.amount)}"></label>
<p class="error" id="bill-form-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Save bill"}</button></form>`;
  }

  function setError(e: string) {
    error = e;
    const n = q("#bill-form-error");
    if (n) n.textContent = e;
  }

  async function save(body: unknown) {
    busy = "Saving…";
    error = "";
    draw();
    try {
      const b = await postJson<Bill>("/api/bills", body);
      if (!alive) return;
      location.hash = `#/bills/${encodeURIComponent(b.id)}`;
      return;
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  function wire() {
    q<HTMLButtonElement>("#tab-link")!.onclick = () => {
      tab = "link";
      error = "";
      draw();
    };
    q<HTMLButtonElement>("#tab-manual")!.onclick = () => {
      tab = "manual";
      error = "";
      draw();
    };
    const imp = q<HTMLFormElement>("#bill-import");
    if (imp) {
      q<HTMLInputElement>("#bill-link")!.oninput = (e) => (link.value = (e.target as HTMLInputElement).value);
      imp.onsubmit = async (e) => {
        e.preventDefault();
        if (!link.value.trim()) return setError("Paste a Manexus invoice link");
        busy = "Importing…";
        error = "";
        draw();
        try {
          const d = await postJson<Draft>("/api/bills/import", { link: link.value.trim() });
          if (!alive) return;
          draft = d;
          link.dueDate = d.dueDate;
        } catch (err) {
          error = msg(err);
        }
        busy = "";
        if (alive) draw();
      };
    }
    const saveImp = q<HTMLFormElement>("#bill-save-import");
    if (saveImp && draft) {
      const d = draft;
      q<HTMLInputElement>("#bill-due")!.onchange = (e) => (link.dueDate = (e.target as HTMLInputElement).value);
      q<HTMLButtonElement>("#bill-import-again")!.onclick = () => {
        draft = null;
        error = "";
        draw();
      };
      saveImp.onsubmit = (e) => {
        e.preventDefault();
        void save({ source: "manexus", vendorPublicId: d.vendorPublicId, dueDate: link.dueDate || d.dueDate });
      };
    }
    const man = q<HTMLFormElement>("#bill-manual");
    if (man) {
      const bind = (id: string, key: "vendor" | "reference" | "recipient" | "amount") =>
        (q<HTMLInputElement>(id)!.oninput = (e) => (form[key] = (e.target as HTMLInputElement).value));
      bind("#bill-vendor", "vendor");
      bind("#bill-reference", "reference");
      bind("#bill-recipient", "recipient");
      bind("#bill-amount", "amount");
      q<HTMLInputElement>("#bill-due")!.onchange = (e) => (form.dueDate = (e.target as HTMLInputElement).value);
      const search = q<HTMLInputElement>("#bill-search")!;
      search.oninput = () => {
        form.search = search.value;
        const pos = search.selectionStart;
        draw();
        const s = q<HTMLInputElement>("#bill-search")!;
        s.focus();
        s.setSelectionRange(pos, pos);
      };
      q<HTMLSelectElement>("#bill-dest")!.onchange = (e) => {
        form.dest = (e.target as HTMLSelectElement).value;
        draw();
      };
      man.onsubmit = (e) => {
        e.preventDefault();
        const d = tokenOf(form.dest);
        if (!form.vendor.trim()) return setError("Enter the vendor name.");
        if (!form.dueDate) return setError("Choose a due date.");
        if (!d) return setError("Choose the token the vendor receives.");
        if (!form.recipient.trim()) return setError("Enter the vendor's address.");
        if (!validAmount(form.amount.trim(), d.decimals)) return setError(`Enter the amount the vendor receives, with at most ${d.decimals} decimals.`);
        void save({
          source: "manual", vendor: form.vendor.trim(), reference: form.reference.trim(), dueDate: form.dueDate, destinationAsset: d.assetId,
          recipientType: "DESTINATION_CHAIN", recipient: form.recipient.trim(), amount: form.amount.trim(),
        });
      };
    }
  }

  draw();
  api<Token[]>("/api/tokens").then(
    (t) => {
      if (!alive) return;
      tokens = t;
      if (tab === "manual") draw();
    },
    (e: unknown) => {
      if (alive && tab === "manual") setError(msg(e));
    },
  );
  return () => {
    alive = false;
  };
}
