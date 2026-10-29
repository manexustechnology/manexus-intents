import { SETTLEMENT_TOKENS, settlementToken } from "../../shared/assets.ts";
import { invoiceTotal, type InvoiceDraft, type InvoiceRow } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { formatAmount, baseUnits } from "../../shared/units.ts";
import { api, ApiError } from "../api.ts";
import { statusChip, totalLabel } from "./invoices.ts";

const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function blankDraft(): InvoiceDraft {
  const now = new Date();
  const due = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const rand = crypto.getRandomValues(new Uint8Array(2)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "").toUpperCase();
  return {
    number: `INV-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${rand}`,
    client: "",
    issuer: "",
    dueDate: due,
    tokenId: SETTLEMENT_TOKENS[0].tokenId,
    notes: "",
    items: [{ description: "", quantity: "1", unitPrice: "" }],
  };
}

function totalHtml(d: InvoiceDraft): string {
  try {
    const t = settlementToken(d.tokenId);
    return `<div class="invoice-total"><span>Total requested</span><strong>${esc(formatAmount(invoiceTotal(d), t.decimals))} ${esc(t.symbol)}</strong></div>`;
  } catch (e) {
    return `<p class="fine">${esc((e as Error).message)}</p>`;
  }
}

export function details(d: InvoiceDraft): string {
  const t = settlementToken(d.tokenId);
  const line = (l: InvoiceDraft["items"][number]) => {
    let lt = "";
    try {
      lt = formatAmount(baseUnits(l.unitPrice, t.decimals) * BigInt(l.quantity), t.decimals);
    } catch {
      lt = "";
    }
    return `<div class="invoice-line-view"><span>${esc(l.description)}</span><span>${esc(l.quantity)}</span><span>${esc(l.unitPrice)}</span><span>${esc(lt)}</span></div>`;
  };
  return `<div class="invoice-parties"><div><span class="eyebrow">FROM</span><strong>${esc(d.issuer)}</strong></div><div><span class="eyebrow">BILL TO</span><strong>${esc(d.client)}</strong></div><div><span class="eyebrow">DUE DATE (UTC)</span><strong>${esc(d.dueDate)}</strong></div></div><div class="invoice-lines-view"><div class="invoice-line-head"><span>Description</span><span>Qty</span><span>Unit price</span><span>Line total</span></div>${d.items.map(line).join("")}</div>${totalHtml(d)}${d.notes ? `<p class="invoice-note">${esc(d.notes)}</p>` : ""}`;
}

function editor(d: InvoiceDraft, isNew: boolean): string {
  return `<section class="panel invoice-editor"><div class="section-title"><h2>${isNew ? "New invoice" : "Edit draft"}</h2></div><form id="invoice-form" novalidate><div class="invoice-form-grid"><label>Invoice number<input id="invoice-number" maxlength="32" value="${esc(d.number)}"></label><label>Due date (UTC)<input id="invoice-due" type="date" value="${esc(d.dueDate)}"></label><label>Your business name<input id="invoice-issuer" maxlength="64" placeholder="Example Studio" value="${esc(d.issuer)}"></label><label>Client<input id="invoice-client" maxlength="64" placeholder="Demo Client" value="${esc(d.client)}"></label><label>Settlement token<select id="invoice-token">${SETTLEMENT_TOKENS.map((t) => `<option value="${esc(t.tokenId)}" ${t.tokenId === d.tokenId ? "selected" : ""}>${esc(t.symbol)}</option>`).join("")}</select></label></div><h3>Line items</h3><p class="fine">Prices are in the settlement token. Whole quantities only; maximum 10 lines.</p><div id="invoice-edit-lines">${d.items.map((l, i) => `<div class="invoice-edit-line"><label>Description ${i + 1}<input data-line="description" maxlength="100" value="${esc(l.description)}"></label><label>Quantity ${i + 1}<input data-line="quantity" inputmode="numeric" maxlength="5" value="${esc(l.quantity)}"></label><label>Unit price ${i + 1}<input data-line="unitPrice" inputmode="decimal" maxlength="32" value="${esc(l.unitPrice)}"></label><button type="button" class="textbutton" data-remove="${i}" aria-label="Remove line ${i + 1}" ${d.items.length === 1 ? "disabled" : ""}>Remove</button></div>`).join("")}</div><button class="textbutton" type="button" id="invoice-add-line" ${d.items.length >= 10 ? "disabled" : ""}>+ Add line item</button><label>Notes<textarea id="invoice-notes" rows="3" maxlength="280">${esc(d.notes)}</textarea></label><div id="invoice-totals">${totalHtml(d)}</div><p class="fine">Issuing locks the invoice and makes its payment link live. Payment goes to your own account; Manexus never holds funds.</p><p class="error" id="invoice-error" role="alert"></p><div class="invoice-actions"><button class="textbutton" type="button" id="invoice-save">Save draft</button><button class="primary" type="submit">Issue invoice</button></div></form></section>`;
}

export function mountInvoice(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  const isNew = params.id === "new";
  let inv: InvoiceRow | null = null;
  let draft: InvoiceDraft = blankDraft();

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const fail = (e: unknown) => {
    const box = el.querySelector("#invoice-error");
    if (box) box.textContent = e instanceof Error ? e.message : "Something went wrong.";
  };
  const heading = (title: string, chip = "") =>
    `<div class="heading"><div><p class="eyebrow"><a href="#/invoices">← Invoices</a></p><h1>${esc(title)}</h1></div>${chip}</div>`;

  function readForm(): InvoiceDraft {
    return {
      number: q<HTMLInputElement>("#invoice-number").value,
      dueDate: q<HTMLInputElement>("#invoice-due").value,
      issuer: q<HTMLInputElement>("#invoice-issuer").value,
      client: q<HTMLInputElement>("#invoice-client").value,
      tokenId: q<HTMLSelectElement>("#invoice-token").value,
      notes: q<HTMLTextAreaElement>("#invoice-notes").value,
      items: Array.from(el.querySelectorAll<HTMLElement>(".invoice-edit-line")).map((row) => ({
        description: row.querySelector<HTMLInputElement>("[data-line=description]")!.value,
        quantity: row.querySelector<HTMLInputElement>("[data-line=quantity]")!.value,
        unitPrice: row.querySelector<HTMLInputElement>("[data-line=unitPrice]")!.value,
      })),
    };
  }

  /** Persist the form: create on first save, otherwise PUT with the current revision. */
  async function save(): Promise<InvoiceRow> {
    draft = readForm();
    inv = inv
      ? await api<InvoiceRow>(`/api/invoices/${encodeURIComponent(inv.id)}`, { method: "PUT", body: JSON.stringify({ revision: inv.revision, data: draft }) })
      : await post<InvoiceRow>("/api/invoices", draft);
    return inv;
  }

  function drawEditor() {
    el.innerHTML = heading(isNew && !inv ? "New invoice" : draft.number || "Draft", inv ? statusChip(inv) : "") + editor(draft, isNew && !inv);
    const form = q<HTMLFormElement>("#invoice-form");
    form.addEventListener("input", () => {
      q("#invoice-totals").innerHTML = totalHtml(readForm());
    });
    const reshape = (items: InvoiceDraft["items"]) => {
      draft = { ...readForm(), items };
      drawEditor();
    };
    q("#invoice-add-line").onclick = () => reshape([...readForm().items, { description: "", quantity: "1", unitPrice: "" }]);
    el.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach(
      (b) => (b.onclick = () => reshape(readForm().items.filter((_, i) => i !== Number(b.dataset.remove)))),
    );
    q("#invoice-save").onclick = async () => {
      try {
        const saved = await save();
        if (isNew) location.replace(`#/invoices/${encodeURIComponent(saved.id)}`);
        else {
          drawEditor();
          q("#invoice-error").textContent = "Draft saved.";
        }
      } catch (e) {
        fail(e);
      }
    };
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const saved = await save();
        const issued = await post<InvoiceRow>(`/api/invoices/${encodeURIComponent(saved.id)}/issue`);
        inv = issued;
        if (isNew) location.replace(`#/invoices/${encodeURIComponent(issued.id)}`);
        else drawView();
      } catch (e) {
        // A failed issue leaves a saved draft; resubmitting updates it rather than creating another.
        fail(e);
      }
    });
  }

  function drawView() {
    const i = inv!;
    const link = `${location.origin}${location.pathname}#/pay/${encodeURIComponent(i.publicId)}`;
    el.innerHTML =
      heading(i.data.number, statusChip(i)) +
      `<article class="panel invoice-document"><p class="fine">Amount ${esc(totalLabel(i))}${i.issuedAt ? ` · issued ${esc(i.issuedAt.slice(0, 10))}` : ""}${i.paidAt ? ` · paid ${esc(i.paidAt.slice(0, 10))}` : ""}</p>${details(i.data)}${
        i.status === "issued" || i.status === "paid"
          ? `<label>Payment link<input id="invoice-link" readonly value="${esc(link)}"></label><div class="invoice-actions"><button class="primary" id="invoice-copy">Copy payment link</button>${i.status === "issued" ? `<button class="textbutton" id="invoice-cancel">Cancel invoice</button>` : ""}</div>`
          : i.status === "cancelled"
            ? `<p class="fine">This invoice was cancelled. Its payment link no longer accepts payment.</p>`
            : ""
      }<p class="error" id="invoice-error" role="alert"></p><div class="invoice-actions"><button class="textbutton" id="invoice-duplicate">Duplicate as new draft</button></div></article>`;
    el.querySelector<HTMLButtonElement>("#invoice-copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
        q("#invoice-error").textContent = "Payment link copied.";
      } catch {
        q<HTMLInputElement>("#invoice-link").select();
        q("#invoice-error").textContent = "Select and copy the link above.";
      }
    });
    el.querySelector<HTMLButtonElement>("#invoice-cancel")?.addEventListener("click", async () => {
      if (!confirm("Cancel this invoice? Its payment link will stop accepting payment.")) return;
      try {
        inv = await post<InvoiceRow>(`/api/invoices/${encodeURIComponent(i.id)}/cancel`);
        if (alive) drawView();
      } catch (e) {
        fail(e);
      }
    });
    q("#invoice-duplicate").onclick = async () => {
      try {
        const d = i.data;
        const copy = await post<InvoiceRow>("/api/invoices", { ...d, number: `${d.number.slice(0, 26)}-${crypto.randomUUID().slice(0, 4)}` });
        location.hash = `#/invoices/${encodeURIComponent(copy.id)}`;
      } catch (e) {
        fail(e);
      }
    };
  }

  if (isNew) drawEditor();
  else {
    el.innerHTML = `<p class="muted" role="status">Loading…</p>`;
    api<InvoiceRow>(`/api/invoices/${encodeURIComponent(params.id)}`).then(
      (r) => {
        if (!alive) return;
        inv = r;
        draft = r.data;
        if (r.status === "draft") drawEditor();
        else drawView();
      },
      (e: unknown) => {
        if (!alive) return;
        el.innerHTML = `<div class="heading"><div><h1>${e instanceof ApiError && e.status === 404 ? "Invoice not found" : "Could not load invoice"}</h1><p class="muted"><a href="#/invoices">Back to invoices</a></p></div></div>`;
      },
    );
  }
  return () => {
    alive = false;
  };
}
