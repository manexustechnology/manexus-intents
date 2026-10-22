import { escapeHTML as esc, requestHash } from "./domain.ts";
import {
  ASSETS,
  INVOICE_KEY,
  assetFor,
  cancelInvoice,
  formatAmount,
  invoiceTotals,
  issueInvoice,
  lifecycle,
  listInvoices,
  newInvoice,
  parseSnapshot,
  saveInvoice,
  snapshotHash,
  updateInvoice,
  type Invoice,
  type InvoiceData,
  type Snapshot,
} from "./invoice.ts";
const CURRENT = "manexus-invoice-current-v1";
export function mountInvoices(
  container: HTMLElement,
  navigate: (tab: string) => void,
): () => boolean {
  let current: Invoice | undefined,
    notice = "",
    unsaved = false,
    filter = "all";
  const field = (id: string) =>
    container.querySelector<HTMLInputElement>("#" + id)!;
  const announce = (text: string) => {
    notice = text;
    const target = container.querySelector("#invoice-notice");
    if (target) target.textContent = text;
    const recovery = container.querySelector<HTMLElement>("#invoice-recovery");
    if (recovery) recovery.hidden = !unsaved;
  };
  const read = () => listInvoices(localStorage);
  const displayStatus = (invoice: Invoice) =>
    lifecycle(invoice) === "issued"
      ? "Issued · unpaid / unverified"
      : lifecycle(invoice) === "overdue"
        ? "Overdue · unpaid / unverified"
        : invoice.status === "cancelled"
          ? "Cancelled locally"
          : "Draft";
  function persist(next: Invoice, expected: number | null) {
    current = saveInvoice(localStorage, next, expected);
    try {
      localStorage.setItem(CURRENT, next.id);
    } catch {
      /* Record itself is saved; selection persistence is optional. */
    }
    unsaved = false;
    return current;
  }
  function newDraft() {
    try {
      if (unsaved)
        throw Error(
          "Unsaved changes remain. Resolve the save error or reload invoices before creating another draft.",
        );
      persist(newInvoice(), null);
      notice =
        "New draft created locally. Use fictional labels and public test addresses only.";
      draw();
    } catch (e) {
      announce((e as Error).message);
    }
  }
  function totals(data: InvoiceData) {
    try {
      const t = invoiceTotals(data),
        a = assetFor(data.asset);
      return `<div class="invoice-total"><span>Total requested</span><strong>${esc(t.formatted)} ${esc(a.symbol)}${a.chain === "base-sepolia" ? " (test)" : ""}</strong></div><p class="fine">One asset per invoice. No taxes, discounts, currency conversion or network fees are calculated.</p>`;
    } catch (e) {
      return `<p class="fine">${esc((e as Error).message)}</p>`;
    }
  }
  function header() {
    return `<div class="heading"><div><p class="eyebrow">FROM REQUEST TO RECORD</p><h1>Invoices, without the guesswork.</h1><p class="muted">Build a clear request. Keep its payment status honest.</p></div><span class="badge">Local prototype · synthetic data only</span></div>`;
  }
  function details(data: InvoiceData) {
    const a = assetFor(data.asset),
      t = invoiceTotals(data);
    return `<div class="invoice-parties"><div><span class="eyebrow">FROM</span><strong>${esc(data.issuer)}</strong></div><div><span class="eyebrow">BILL TO</span><strong>${esc(data.client)}</strong></div><div><span class="eyebrow">DUE DATE</span><strong>${esc(data.dueDate)}</strong></div></div><div class="invoice-lines-view"><div class="invoice-line-head"><span>Description</span><span>Qty</span><span>Unit price</span><span>Line total</span></div>${data.items.map((line, i) => `<div class="invoice-line-view"><span>${esc(line.description)}</span><span>${esc(line.quantity)}</span><span>${esc(line.unitPrice)}</span><span>${esc(formatAmount(t.lines[i], a.decimals))}</span></div>`).join("")}</div>${totals(data)}<p class="fine">Requested asset and network</p><strong>${esc(a.label)}</strong><p class="fine">Public receiving address · ownership unverified</p><code class="invoice-address">${esc(data.address)}</code>${data.notes ? `<p class="invoice-note">${esc(data.notes)}</p>` : ""}`;
  }
  function routeTools(data: InvoiceData, target: HTMLElement) {
    target.innerHTML = `<h3>Explore a funding route</h3><p class="fine">The Swap workspace has public NEAR Intents dry quotes for Arbitrum USDC → wNEAR on NEAR or XAUT on Ethereum. These are independent route previews, not a quote to settle this invoice. Other invoice assets remain request-only here. No invoice labels, line items or address are sent to the quote provider.</p><button class="textbutton" id="invoice-routes">Open read-only quotes & simulation ↗</button><p class="fine">NEAR Intents has no testnet. The cross-chain walkthrough is explicitly simulated and cannot change invoice status.</p>${data.asset === "ETH:base-sepolia" ? '<button class="textbutton" id="invoice-testnet">Open separate testnet payment preview ↗</button><p class="fine">This opens a public request in Payments without connecting or sending. Its test receipt is not automatically reconciled to this invoice; the invoice stays unverified.</p>' : ""}`;
    target
      .querySelector("#invoice-routes")!
      .addEventListener("click", () => navigate("swap"));
    target.querySelector("#invoice-testnet")?.addEventListener("click", () => {
      try {
        const amount = invoiceTotals(data).formatted;
        location.hash = requestHash({
          address: data.address,
          amount,
          chain: "base-sepolia",
          symbol: "ETH",
        });
      } catch {
        announce(
          "The separate test-payment preview supports at most 8 decimal places. This invoice remains unverified.",
        );
      }
    });
  }
  function shareView(snapshot: Snapshot) {
    const data = snapshot.data;
    container.innerHTML =
      header() +
      `<p id="invoice-notice" role="status"></p><section class="notice"><strong>Unverified invoice snapshot · payment not verified</strong><p>This link is editable by anyone who has it. It does not authenticate the issuer, recipient, amount or payment status. Verify details with the requester through a trusted channel. Local cancellation or later changes cannot revoke a shared snapshot.</p></section><article class="panel invoice-document"><div class="section-title"><div><p class="eyebrow">SHARED REQUEST · NOT A RECEIPT</p><h2>${esc(data.number)}</h2></div><span class="badge">${data.dueDate < new Date().toISOString().slice(0, 10) ? "Past due date · unverified" : "Issued snapshot · unverified"}</span></div><p class="fine">Snapshot issued ${esc(snapshot.issuedAt)}. No live invoice database.</p>${details(data)}<button class="disabled full" disabled>Mainnet invoice payment unavailable</button></article><section class="panel invoice-route" id="invoice-route"></section><button class="textbutton" id="my-invoices">My local invoices</button>`;
    routeTools(data, container.querySelector("#invoice-route")!);
    container.querySelector("#my-invoices")!.addEventListener("click", () => {
      history.replaceState(null, "", location.pathname + location.search);
      draw();
    });
  }
  function readForm(): InvoiceData {
    const lines = Array.from(
      container.querySelectorAll<HTMLElement>(".invoice-edit-line"),
    ).map((row) => ({
      description: row.querySelector<HTMLInputElement>(
        "[data-line=description]",
      )!.value,
      quantity: row.querySelector<HTMLInputElement>("[data-line=quantity]")!
        .value,
      unitPrice: row.querySelector<HTMLInputElement>("[data-line=unitPrice]")!
        .value,
    }));
    return {
      number: field("invoice-number").value,
      issuer: field("invoice-issuer").value,
      client: field("invoice-client").value,
      dueDate: field("invoice-due").value,
      asset: field("invoice-asset").value,
      address: field("invoice-address").value,
      notes: field("invoice-notes").value,
      items: lines,
    };
  }
  function saveDraft() {
    if (!current || current.status !== "draft") return false;
    try {
      const data = readForm();
      current = { ...current, data };
      unsaved = true;
      persist(updateInvoice(current, data), current.revision);
      announce("Draft saved in this browser. No invoice was sent.");
      container.querySelector("#invoice-totals")!.innerHTML = totals(data);
      return true;
    } catch (e) {
      unsaved = true;
      announce((e as Error).message);
      return false;
    }
  }
  function editView(invoice: Invoice) {
    const d = invoice.data;
    return `<section class="panel invoice-editor"><div class="section-title"><h2>Edit draft</h2><span class="badge">Autosaved locally</span></div><form id="invoice-form" novalidate><div class="invoice-form-grid"><label>Invoice number<input id="invoice-number" maxlength="32" value="${esc(d.number)}"></label><label>Due date (UTC)<input id="invoice-due" type="date" value="${esc(d.dueDate)}"></label><label>Issuer label · fictional<input id="invoice-issuer" maxlength="64" placeholder="Example Studio" value="${esc(d.issuer)}"></label><label>Client label · fictional<input id="invoice-client" maxlength="64" placeholder="Demo Client" value="${esc(d.client)}"></label><label>Requested asset and network<select id="invoice-asset">${ASSETS.map((a) => `<option value="${a.key}" ${a.key === d.asset ? "selected" : ""}>${a.label}</option>`).join("")}</select></label><label>Public receiving address<input id="invoice-address" maxlength="64" spellcheck="false" placeholder="Address for the selected network" value="${esc(d.address)}"></label></div><h3>Line items</h3><p class="fine">All prices use the selected token, not USD. Whole quantities only; maximum 10 lines.</p><div id="invoice-edit-lines">${d.items.map((line, i) => `<div class="invoice-edit-line"><label>Description ${i + 1}<input data-line="description" maxlength="100" value="${esc(line.description)}"></label><label>Quantity ${i + 1}<input data-line="quantity" inputmode="numeric" maxlength="5" value="${esc(line.quantity)}"></label><label>Unit price ${i + 1}<input data-line="unitPrice" inputmode="decimal" maxlength="32" value="${esc(line.unitPrice)}"></label><button type="button" class="textbutton" data-remove="${i}" aria-label="Remove line ${i + 1}" ${d.items.length === 1 ? "disabled" : ""}>Remove</button></div>`).join("")}</div><button class="textbutton" type="button" id="invoice-add-line" ${d.items.length === 10 ? "disabled" : ""}>+ Add line item</button><label>Notes · no sensitive information<textarea id="invoice-notes" rows="3" maxlength="280">${esc(d.notes)}</textarea></label><div id="invoice-totals">${totals(d)}</div><p class="fine">Issuing locks the draft locally. Preview only: issuing does not send a message or prove payment; legal/tax compliance is not assessed.</p><button class="primary full" type="submit">Issue preview invoice</button></form></section>`;
  }
  function issuedView(invoice: Invoice) {
    return `<article class="panel invoice-document"><div class="section-title"><h2>${esc(invoice.data.number)}</h2><span class="badge">${displayStatus(invoice)}</span></div><p class="fine">Issued locally ${esc(invoice.issuedAt!)}. Content is locked; duplicate to make a new draft.</p>${details(invoice.data)}<p class="notice">Payment not verified. There is no “mark paid” control, automatic settlement, or invoice reconciliation in this prototype.</p>${invoice.status === "issued" ? `<label class="confirm-label"><input type="checkbox" id="invoice-share-consent"> I understand the link exposes all invoice contents. I used synthetic labels and a public address.</label><button class="primary full" id="invoice-share" disabled>Create shareable snapshot link</button><div id="invoice-share-result"></div><label class="confirm-label"><input type="checkbox" id="invoice-cancel-consent"> Cancel locally. Existing links cannot be revoked; recipients must be told separately.</label><button class="textbutton" id="invoice-cancel" disabled>Cancel invoice locally</button>` : '<p class="fine">Cancelled in this browser only. Existing shared links remain unverified snapshots and cannot learn about this cancellation.</p>'}<button class="textbutton" id="invoice-duplicate">Duplicate as new draft</button></article>`;
  }
  function draw() {
    if (location.hash.startsWith("#invoice=")) {
      try {
        shareView(parseSnapshot(location.hash));
      } catch (e) {
        container.innerHTML =
          header() +
          `<section class="panel"><h2>Cannot open this invoice</h2><p role="alert">${esc((e as Error).message)}</p><p>No local invoice was changed and no payment was made.</p><button class="textbutton" id="my-invoices">My local invoices</button></section>`;
        container
          .querySelector("#my-invoices")!
          .addEventListener("click", () => {
            history.replaceState(null, "", location.pathname + location.search);
            draw();
          });
      }
      return;
    }
    let items: Invoice[];
    try {
      items = read();
      if (!current) {
        const id = localStorage.getItem(CURRENT);
        current = items.find((i) => i.id === id) ?? items[0];
      }
    } catch (e) {
      container.innerHTML =
        header() +
        `<section class="panel"><h2>Local invoices unavailable</h2><p role="alert">${esc((e as Error).message)}</p><p>Existing storage was not overwritten. Other app sections remain available.</p></section>`;
      return;
    }
    const visible = items.filter(
      (i) => filter === "all" || lifecycle(i) === filter,
    );
    container.innerHTML =
      header() +
      `<div class="invoice-toolbar"><button id="invoice-new" class="primary">+ New invoice</button><button id="invoice-reload" class="textbutton">Reload invoices</button><label>Filter status<select id="invoice-filter">${["all", "draft", "issued", "overdue", "cancelled"].map((s) => `<option ${s === filter ? "selected" : ""}>${s}</option>`).join("")}</select></label></div><p class="fine">Saved only in this browser · no team sync, email delivery, backups or payment verification. Use synthetic records, not real client data.</p><p id="invoice-notice" role="status" class="invoice-notice">${esc(notice)}</p><div id="invoice-recovery" hidden><label class="confirm-label"><input id="invoice-discard-confirm" type="checkbox"> Discard my unsaved edits and load the last stored version.</label><button id="invoice-discard" class="textbutton" disabled>Discard unsaved edits & reload</button></div><div class="invoice-layout"><section class="panel invoice-list"><h2>Your invoice records</h2><p class="fine">${items.length} local records · ${items.filter((i) => i.status === "issued").length} issued / unverified</p>${
        visible.length
          ? visible
              .map((i) => {
                let total = "Incomplete draft";
                try {
                  total =
                    invoiceTotals(i.data).formatted +
                    " " +
                    assetFor(i.data.asset).symbol;
                } catch {}
                return `<button class="invoice-record ${current?.id === i.id ? "selected" : ""}" data-invoice="${i.id}"><strong>${esc(i.data.number || "Untitled draft")}</strong><span>${esc(i.data.client || "No client label")}</span><span>${esc(total)}</span><small>${displayStatus(i)}</small></button>`;
              })
              .join("")
          : '<p class="empty">No invoices in this view.</p>'
      }</section><div>${current ? (current.status === "draft" ? editView(current) : issuedView(current)) : '<section class="panel empty-invoices"><span class="big-icon">▤</span><h2>Start with a clear request.</h2><p class="muted">Create a draft with line items, one asset, a due date and a receiving address.</p></section>'}${current && current.status === "issued" ? '<section id="invoice-route" class="panel invoice-route"></section>' : ""}</div></div>`;
    container.querySelector<HTMLInputElement>(
      "#invoice-discard-confirm",
    )!.onchange = (e) =>
      ((
        container.querySelector("#invoice-discard") as HTMLButtonElement
      ).disabled = !(e.target as HTMLInputElement).checked);
    container
      .querySelector("#invoice-discard")!
      .addEventListener("click", () => {
        unsaved = false;
        current = undefined;
        notice = "Unsaved edits discarded. Loaded the last stored version.";
        draw();
      });
    container
      .querySelector("#invoice-new")!
      .addEventListener("click", newDraft);
    container
      .querySelector("#invoice-reload")!
      .addEventListener("click", () => {
        if (unsaved) {
          announce(
            "Unsaved edits remain. Reload the page only if you intend to discard them.",
          );
          return;
        }
        current = undefined;
        notice = "Loaded saved records from this browser.";
        draw();
      });
    container.querySelector<HTMLSelectElement>("#invoice-filter")!.onchange = (
      e,
    ) => {
      if (unsaved) {
        announce("Resolve unsaved changes before changing the view.");
        return;
      }
      filter = (e.target as HTMLSelectElement).value;
      draw();
    };
    container.querySelectorAll<HTMLButtonElement>("[data-invoice]").forEach(
      (b) =>
        (b.onclick = () => {
          if (unsaved) {
            announce("Resolve unsaved changes before leaving this draft.");
            return;
          }
          current = read().find((i) => i.id === b.dataset.invoice);
          if (current) {
            try {
              localStorage.setItem(CURRENT, current.id);
            } catch {
              /* Selection is optional; invoice content is unchanged. */
            }
          }
          notice = "";
          draw();
        }),
    );
    if (current?.status === "draft") {
      container
        .querySelector("#invoice-form")!
        .addEventListener("input", saveDraft);
      container
        .querySelector("#invoice-form")!
        .addEventListener("change", saveDraft);
      container
        .querySelector("#invoice-form")!
        .addEventListener("submit", (e) => {
          e.preventDefault();
          if (!saveDraft()) return;
          try {
            persist(issueInvoice(current!), current!.revision);
            notice =
              "Invoice issued locally. Unpaid / unverified. Nothing was sent.";
            draw();
          } catch (e) {
            announce((e as Error).message);
          }
        });
      container
        .querySelector("#invoice-add-line")!
        .addEventListener("click", () => {
          if (!saveDraft() || current!.data.items.length >= 10) return;
          try {
            persist(
              updateInvoice(current!, {
                ...current!.data,
                items: [
                  ...current!.data.items,
                  { description: "", quantity: "1", unitPrice: "" },
                ],
              }),
              current!.revision,
            );
            draw();
          } catch (e) {
            announce((e as Error).message);
          }
        });
      container.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach(
        (b) =>
          (b.onclick = () => {
            if (!saveDraft() || current!.data.items.length <= 1) return;
            try {
              persist(
                updateInvoice(current!, {
                  ...current!.data,
                  items: current!.data.items.filter(
                    (_, i) => i !== Number(b.dataset.remove),
                  ),
                }),
                current!.revision,
              );
              draw();
            } catch (e) {
              announce((e as Error).message);
            }
          }),
      );
    }
    if (current && current.status !== "draft") {
      container
        .querySelector("#invoice-duplicate")!
        .addEventListener("click", () => {
          try {
            const draft = newInvoice();
            draft.data = structuredClone(current!.data);
            draft.data.number =
              draft.data.number.slice(0, 22) + "-copy-" + draft.id.slice(0, 4);
            persist(draft, null);
            notice =
              "A separate draft was created. The original record and shared links are unchanged.";
            draw();
          } catch (e) {
            announce((e as Error).message);
          }
        });
    }
    if (current?.status === "issued") {
      routeTools(current.data, container.querySelector("#invoice-route")!);
      container.querySelector<HTMLInputElement>(
        "#invoice-share-consent",
      )!.onchange = (e) =>
        ((
          container.querySelector("#invoice-share") as HTMLButtonElement
        ).disabled = !(e.target as HTMLInputElement).checked);
      container
        .querySelector("#invoice-share")!
        .addEventListener("click", () => {
          try {
            const latest = read().find((i) => i.id === current!.id);
            if (
              !latest ||
              latest.status !== "issued" ||
              latest.revision !== current!.revision
            )
              throw Error("Invoice changed. Reload before sharing.");
            const url =
              location.origin + location.pathname + snapshotHash(current!);
            container.querySelector("#invoice-share-result")!.innerHTML =
              `<label>Shareable invoice snapshot<input id="invoice-link" readonly value="${esc(url)}"></label><button class="textbutton" id="invoice-copy">Copy link</button><a class="textbutton" href="${esc(url)}" target="_blank" rel="noreferrer">Open request preview ↗</a><p class="fine">Anyone with this unsigned link can read or change its contents. Changes/cancellation in this browser will not update it.</p>`;
            container
              .querySelector("#invoice-copy")!
              .addEventListener("click", async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  announce(
                    "Invoice snapshot link copied. No message was sent.",
                  );
                } catch {
                  field("invoice-link").select();
                  announce("Select and copy the link above.");
                }
              });
          } catch (e) {
            announce((e as Error).message);
          }
        });
      container.querySelector<HTMLInputElement>(
        "#invoice-cancel-consent",
      )!.onchange = (e) =>
        ((
          container.querySelector("#invoice-cancel") as HTMLButtonElement
        ).disabled = !(e.target as HTMLInputElement).checked);
      container
        .querySelector("#invoice-cancel")!
        .addEventListener("click", () => {
          try {
            persist(cancelInvoice(current!), current!.revision);
            notice =
              "Cancelled locally. Existing snapshot links remain accessible and unverified.";
            draw();
          } catch (e) {
            announce((e as Error).message);
          }
        });
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === INVOICE_KEY)
      announce(
        "Invoice storage changed in another tab. Reload invoices before editing or sharing.",
      );
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (unsaved) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("beforeunload", beforeUnload);
  draw();
  return () => {
    if (unsaved) {
      announce(
        "Unsaved invoice edits remain. Resolve the save error or explicitly discard them before leaving.",
      );
      return false;
    }
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("beforeunload", beforeUnload);
    return true;
  };
}
