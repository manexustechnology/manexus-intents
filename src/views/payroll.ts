// #/payroll: saved payees, payout batches, and "New payout" from a CSV upload or saved payees.
// The CSV is parsed here only for the preview; the server re-parses the raw text it receives.
import { supportedChain } from "../../shared/address.ts";
import { INTENTS_CHAIN, MAX_CSV_BYTES, MAX_PAYROLL_LINES, parsePayrollCsv, payeeNameError, type LineError, type PayrollRow } from "../../shared/csv.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { validAmount } from "../../shared/units.ts";
import { api, ApiError, deleteJson, postJson } from "../api.ts";
import { msg } from "./transfer-ui.ts";
import { chainName } from "./withdraw.ts";

type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };
type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string };
type RecipientType = "DESTINATION_CHAIN" | "INTENTS";
export type Payee = { id: string; name: string; destinationAsset: string; recipientType: RecipientType; recipient: string; symbol: string; blockchain: string; decimals?: number };
type BatchItem = { id: string; title: string; originAsset: string; createdAt: string; total: number; sent: number };

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const MAX_OPTIONS = 100;
const TEMPLATE = "name,chain,token,address,amount";

/** "NEAR Intents account" or the chain name, for where a payee is paid. */
export const networkLabel = (recipientType: RecipientType, blockchain: string) => (recipientType === "INTENTS" ? "NEAR Intents account" : chainName(blockchain));

export function mountPayroll(el: HTMLElement): () => void {
  let alive = true;
  let tokens: Token[] = [];
  let balances: Balance[] = [];
  let payees: Payee[] = [];
  let batches: BatchItem[] | null = null;
  let loadError = "";
  let tab: "csv" | "payees" = "csv";
  const draft = { title: "", origin: "" };
  let csvText = "";
  let csvName = "";
  let preview: { rows: PayrollRow[]; errors: LineError[] } | null = null;
  let serverErrors: LineError[] = [];
  let batchError = "";
  let busy = "";
  const picks = new Map<string, string>(); // payee id → amount
  const payeeForm = { name: "", search: "", dest: "", mode: "DESTINATION_CHAIN" as RecipientType, recipient: "" };
  let payeeError = "";
  let payeeBusy = "";
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);

  function draw() {
    el.innerHTML = `<div class="heading"><div><p class="eyebrow">PAY PEOPLE</p><h1>Payroll</h1><p class="muted">Pay a team from your NEAR Intents balance. You sign every payment in your wallet, one line at a time.</p></div></div>
${loadError ? `<p class="error" role="alert">${esc(loadError)}</p>` : ""}
<section class="panel" aria-labelledby="payouts-h"><h2 id="payouts-h">Payouts</h2><div id="batch-list">${batchesHtml()}</div></section>
<section class="panel" id="new-payout" aria-labelledby="new-payout-h"><h2 id="new-payout-h">New payout</h2>${newPayoutHtml()}</section>
<section class="panel" id="payees" aria-labelledby="payees-h"><h2 id="payees-h">Saved payees</h2>${payeesHtml()}</section>`;
    wire();
  }

  function batchesHtml(): string {
    if (batches === null) return `<p class="muted" role="status">Loading…</p>`;
    if (!batches.length) return `<p class="empty">No payouts yet. Upload a CSV or pick saved payees below.</p>`;
    return `<div class="invoice-list">${batches
      .map(
        (b) =>
          `<a class="invoice-record" href="#/payroll/${esc(encodeURIComponent(b.id))}"><strong>${esc(b.title)}</strong><span>${esc(`${b.sent}/${b.total} sent`)}</span><small>${esc(b.createdAt.slice(0, 10))}</small></a>`,
      )
      .join("")}</div>`;
  }

  function newPayoutHtml(): string {
    const origin = balances.length
      ? `<select id="batch-origin">${balances
          .map((x) => `<option value="${esc(x.tokenId)}" ${x.tokenId === draft.origin ? "selected" : ""}>${esc(x.formatted)} ${esc(x.symbol)} (${esc(chainName(x.blockchain))})</option>`)
          .join("")}</select>`
      : `<p class="muted">Your NEAR Intents balance is empty. Paid invoices land there.</p>`;
    const tabs = `<div class="tabs" role="tablist"><button type="button" role="tab" id="tab-csv" aria-selected="${tab === "csv"}" aria-controls="payout-panel">Upload CSV</button><button type="button" role="tab" id="tab-payees" aria-selected="${tab === "payees"}" aria-controls="payout-panel">Saved payees</button></div>`;
    return `<div class="invoice-form-grid"><label>Title<input id="batch-title" maxlength="100" placeholder="e.g. October payroll" value="${esc(draft.title)}"></label><label>Pay from${origin}</label></div>
${tabs}<div id="payout-panel" role="tabpanel">${tab === "csv" ? csvHtml() : picksHtml()}</div>
<p class="fine">Each payee receives exactly the amount on their line. What you send per line includes a small buffer for price movement; any unused part is refunded to your NEAR Intents balance.</p>
<p class="error" id="batch-error" role="alert">${esc(batchError)}</p>
<button class="primary" type="button" id="batch-create" ${canCreate() ? "" : "disabled"}>${busy ? esc(busy) : "Create payout"}</button>`;
  }

  function csvHtml(): string {
    return `<label>CSV file<input type="file" id="csv-file" accept=".csv,text/csv"></label>
<p class="fine">Columns: <code>${TEMPLATE}</code>. Use <code>${INTENTS_CHAIN}</code> as the chain to pay a NEAR Intents account. Up to ${MAX_PAYROLL_LINES} lines and 64 KB. Amounts are what each person receives.</p>
${csvName ? `<p class="muted" id="csv-name">${esc(csvName)}</p>` : ""}${previewHtml()}`;
  }

  function allErrors(): LineError[] {
    return [...(preview?.errors ?? []), ...serverErrors];
  }

  function previewHtml(): string {
    if (!preview) return "";
    const errs = allErrors();
    const byLine = new Map<number, string[]>();
    for (const e of errs) byLine.set(e.line, [...(byLine.get(e.line) ?? []), e.message]);
    const items: { line: number; html: string }[] = preview.rows.map((r) => {
      const m = byLine.get(r.line);
      byLine.delete(r.line);
      return {
        line: r.line,
        html: `<tr${m ? ' class="line-error"' : ""}><td>${esc(String(r.line))}</td><td>${esc(r.name)}</td><td>${esc(`${r.amountFormatted} ${r.symbol}`)}</td><td>${esc(networkLabel(r.recipientType, r.chain))}<br><code>${esc(r.recipient)}</code>${m ? `<br><span class="error">${esc(m.join("; "))}</span>` : ""}</td></tr>`,
      };
    });
    for (const [line, m] of byLine)
      items.push({ line, html: `<tr class="line-error"><td>${esc(line ? String(line) : "File")}</td><td colspan="3"><span class="error">${esc(m.join("; "))}</span></td></tr>` });
    items.sort((a, b) => a.line - b.line);
    const bad = new Set(errs.map((e) => e.line)).size;
    const summary = bad ? `${bad} ${bad === 1 ? "line needs" : "lines need"} fixing. Nothing is created until every line is valid.` : `${preview.rows.length} ${preview.rows.length === 1 ? "line" : "lines"} ready.`;
    return `<p class="${bad ? "error" : "muted"}" id="csv-summary" role="status">${esc(summary)}</p>
<div class="table-scroll"><table class="payroll-table" id="csv-preview"><thead><tr><th>Line</th><th>Name</th><th>Receives</th><th>To</th></tr></thead><tbody>${items.map((i) => i.html).join("")}</tbody></table></div>`;
  }

  function picksHtml(): string {
    if (!payees.length) return `<p class="empty">No saved payees yet. Add them below.</p>`;
    return `<div class="payment-list" id="pick-list">${payees
      .map((p, i) => {
        const checked = picks.has(p.id);
        const err = serverErrors.filter((e) => e.line === pickedIds().indexOf(p.id) + 1 && checked).map((e) => e.message).join("; ");
        return `<div class="payment-row${err ? " line-error" : ""}"><label class="radio"><input type="checkbox" class="pick" data-id="${esc(p.id)}" data-i="${i}" ${checked ? "checked" : ""}> ${esc(p.name)} · ${esc(p.symbol || "Unknown token")} · ${esc(networkLabel(p.recipientType, p.blockchain))}</label>
${checked ? `<label>Amount ${esc(p.name)} receives${p.symbol ? ` (${esc(p.symbol)})` : ""}<input class="pick-amount" data-id="${esc(p.id)}" inputmode="decimal" autocomplete="off" value="${esc(picks.get(p.id) ?? "")}"></label>` : ""}
${err ? `<span class="error">${esc(err)}</span>` : ""}</div>`;
      })
      .join("")}</div>`;
  }

  function pickedIds(): string[] {
    return payees.filter((p) => picks.has(p.id)).map((p) => p.id);
  }

  function canCreate(): boolean {
    if (busy || !draft.origin) return false;
    if (tab === "csv") return !!preview && preview.rows.length > 0 && preview.errors.length === 0;
    return picks.size > 0;
  }

  function payeesHtml(): string {
    const list = payees.length
      ? `<div class="payment-list" id="payee-list">${payees
          .map(
            (p) =>
              `<div class="payment-row"><strong>${esc(p.name)}</strong><span>${esc(p.symbol || "Unknown token")} · ${esc(networkLabel(p.recipientType, p.blockchain))}</span><code>${esc(p.recipient)}</code><div><button type="button" class="textbutton payee-delete" data-id="${esc(p.id)}">Delete</button></div></div>`,
          )
          .join("")}</div>`
      : `<p class="empty" id="payee-list">No saved payees.</p>`;
    const s = payeeForm.search.trim().toLowerCase();
    const label = (t: Token) => `${t.symbol} · ${chainName(t.blockchain)}`;
    const matches = tokens.filter((t) => supportedChain(t.blockchain) && (!s || label(t).toLowerCase().includes(s) || t.blockchain.includes(s)));
    const shown = matches.slice(0, MAX_OPTIONS);
    const d = tokenOf(payeeForm.dest);
    const where = payeeForm.mode === "INTENTS" ? "NEAR Intents account" : d ? `Address on ${chainName(d.blockchain)}` : "Address";
    return `${list}<form id="payee-add" novalidate><h3>Add a payee</h3><div class="invoice-form-grid">
<label>Name<input id="payee-name" maxlength="64" value="${esc(payeeForm.name)}"></label>
<label>Pay to<select id="payee-mode"><option value="DESTINATION_CHAIN" ${payeeForm.mode === "DESTINATION_CHAIN" ? "selected" : ""}>An address on a chain</option><option value="INTENTS" ${payeeForm.mode === "INTENTS" ? "selected" : ""}>A NEAR Intents account</option></select></label></div>
<label>Search token or chain<input id="payee-search" autocomplete="off" placeholder="e.g. USDC or arb" value="${esc(payeeForm.search)}"></label>
<label>Receives<select id="payee-dest" size="5">${shown.map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === payeeForm.dest ? "selected" : ""}>${esc(label(t))}</option>`).join("")}</select></label>
<label>${esc(where)}<input id="payee-recipient" autocomplete="off" spellcheck="false" value="${esc(payeeForm.recipient)}"></label>
<p class="fine">Funds sent to a wrong address or network usually cannot be recovered.</p>
<p class="error" id="payee-error" role="alert">${esc(payeeError)}</p>
<button class="primary" type="submit" ${payeeBusy ? "disabled" : ""}>${payeeBusy ? esc(payeeBusy) : "Save payee"}</button></form>`;
  }

  function refreshCreate() {
    const b = q<HTMLButtonElement>("#batch-create");
    if (b) b.disabled = !canCreate();
  }

  function parseCsv() {
    serverErrors = [];
    preview = csvText ? parsePayrollCsv(csvText, tokens) : null;
  }

  function wire() {
    const title = q<HTMLInputElement>("#batch-title")!;
    title.oninput = () => (draft.title = title.value);
    const origin = q<HTMLSelectElement>("#batch-origin");
    if (origin) origin.onchange = () => (draft.origin = origin.value);
    q<HTMLButtonElement>("#tab-csv")!.onclick = () => {
      tab = "csv";
      serverErrors = [];
      batchError = "";
      draw();
    };
    q<HTMLButtonElement>("#tab-payees")!.onclick = () => {
      tab = "payees";
      serverErrors = [];
      batchError = "";
      draw();
    };
    const file = q<HTMLInputElement>("#csv-file");
    if (file)
      file.onchange = async () => {
        const f = file.files?.[0];
        if (!f) return;
        batchError = "";
        if (f.size > MAX_CSV_BYTES) {
          csvText = "";
          csvName = f.name;
          preview = { rows: [], errors: [{ line: 0, message: "The file is larger than 64 KB." }] };
          serverErrors = [];
          return draw();
        }
        csvName = f.name;
        csvText = await f.text();
        if (!alive) return;
        parseCsv();
        draw();
      };
    el.querySelectorAll<HTMLInputElement>(".pick").forEach((c) => {
      c.onchange = () => {
        if (c.checked) picks.set(c.dataset.id!, "");
        else picks.delete(c.dataset.id!);
        serverErrors = [];
        draw();
      };
    });
    el.querySelectorAll<HTMLInputElement>(".pick-amount").forEach((a) => {
      a.oninput = () => picks.set(a.dataset.id!, a.value);
    });
    q<HTMLButtonElement>("#batch-create")!.onclick = () => void create();

    el.querySelectorAll<HTMLButtonElement>(".payee-delete").forEach((b) => {
      b.onclick = () => void removePayee(b.dataset.id!);
    });
    const name = q<HTMLInputElement>("#payee-name")!;
    name.oninput = () => (payeeForm.name = name.value);
    const recipient = q<HTMLInputElement>("#payee-recipient")!;
    recipient.oninput = () => (payeeForm.recipient = recipient.value);
    const mode = q<HTMLSelectElement>("#payee-mode")!;
    mode.onchange = () => {
      payeeForm.mode = mode.value === "INTENTS" ? "INTENTS" : "DESTINATION_CHAIN";
      draw();
    };
    const search = q<HTMLInputElement>("#payee-search")!;
    search.oninput = () => {
      payeeForm.search = search.value;
      const pos = search.selectionStart;
      draw();
      const s = q<HTMLInputElement>("#payee-search")!;
      s.focus();
      s.setSelectionRange(pos, pos);
    };
    const dest = q<HTMLSelectElement>("#payee-dest")!;
    dest.onchange = () => {
      payeeForm.dest = dest.value;
      draw();
    };
    q<HTMLFormElement>("#payee-add")!.onsubmit = (e) => {
      e.preventDefault();
      void addPayee();
    };
  }

  function setBatchError(m: string) {
    batchError = m;
    const n = q("#batch-error");
    if (n) n.textContent = m;
  }

  async function create() {
    if (!draft.title.trim()) return setBatchError("Enter a title.");
    if (!draft.origin) return setBatchError("Choose a balance to pay from.");
    let body: Record<string, unknown>;
    if (tab === "csv") {
      if (!preview || preview.errors.length || !preview.rows.length) return setBatchError("Upload a CSV with no errors.");
      body = { title: draft.title.trim(), originAsset: draft.origin, csv: csvText };
    } else {
      const ids = pickedIds();
      for (const id of ids) {
        const p = payees.find((x) => x.id === id)!;
        const a = (picks.get(id) ?? "").trim();
        if (p.decimals === undefined || !validAmount(a, p.decimals))
          return setBatchError(`Enter the amount ${p.name} receives${p.decimals !== undefined ? `, with at most ${p.decimals} decimals` : ""}.`);
      }
      body = { title: draft.title.trim(), originAsset: draft.origin, payeeIds: ids, amounts: ids.map((id) => (picks.get(id) ?? "").trim()) };
    }
    busy = "Creating…";
    batchError = "";
    serverErrors = [];
    draw();
    try {
      const v = await postJson<{ batch: { id: string } }>("/api/payroll/batches", body);
      if (!alive) return;
      location.hash = `#/payroll/${encodeURIComponent(v.batch.id)}`;
      return;
    } catch (e) {
      batchError = msg(e);
      const le = e instanceof ApiError ? (e.body as { lineErrors?: unknown } | null)?.lineErrors : undefined;
      if (Array.isArray(le))
        serverErrors = le.filter((x): x is LineError => !!x && typeof x.line === "number" && typeof x.message === "string");
      if (tab === "csv" && !preview && serverErrors.length) preview = { rows: [], errors: [] };
    }
    busy = "";
    if (alive) draw();
  }

  function setPayeeError(m: string) {
    payeeError = m;
    const n = q("#payee-error");
    if (n) n.textContent = m;
  }

  async function addPayee() {
    const nameErr = payeeNameError(payeeForm.name);
    if (nameErr) return setPayeeError(nameErr);
    const d = tokenOf(payeeForm.dest);
    if (!d) return setPayeeError("Choose the token the payee receives.");
    if (!payeeForm.recipient.trim()) return setPayeeError("Enter the address.");
    payeeBusy = "Saving…";
    payeeError = "";
    draw();
    try {
      const p = await postJson<Payee>("/api/payroll/payees", { name: payeeForm.name.trim(), destinationAsset: d.assetId, recipientType: payeeForm.mode, recipient: payeeForm.recipient.trim() });
      if (!alive) return;
      payees = [...payees, p].sort((a, b) => a.name.localeCompare(b.name));
      Object.assign(payeeForm, { name: "", recipient: "" });
    } catch (e) {
      payeeError = msg(e);
    }
    payeeBusy = "";
    if (alive) draw();
  }

  async function removePayee(id: string) {
    payeeError = "";
    try {
      await deleteJson(`/api/payroll/payees?id=${encodeURIComponent(id)}`);
      if (!alive) return;
      payees = payees.filter((p) => p.id !== id);
      picks.delete(id);
    } catch (e) {
      payeeError = msg(e);
    }
    if (alive) draw();
  }

  draw();
  Promise.all([
    api<BatchItem[]>("/api/payroll/batches"),
    api<Payee[]>("/api/payroll/payees"),
    api<Token[]>("/api/tokens").catch(() => [] as Token[]),
    api<Balance[]>("/api/balances").catch((e: unknown) => {
      loadError = msg(e);
      return [] as Balance[];
    }),
  ]).then(
    ([b, p, t, bal]) => {
      if (!alive) return;
      batches = b;
      payees = p;
      tokens = t;
      balances = bal;
      draft.origin = (balances.find((x) => x.tokenId === USDC) ?? balances[0])?.tokenId ?? "";
      if (csvText) parseCsv();
      draw();
    },
    (e: unknown) => {
      if (!alive) return;
      loadError = msg(e);
      batches = [];
      draw();
    },
  );
  return () => {
    alive = false;
  };
}
