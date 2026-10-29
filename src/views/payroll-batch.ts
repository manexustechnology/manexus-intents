// #/payroll/:id: a batch's lines with per-line status. Lines are sent strictly one at a time: quote
// line n → sign in the wallet → submit → next, so at most one unsigned quote is open per run. The run
// stops on the first error (wallet rejection, rate limit, …); lines already sent are never sent again,
// and a line whose quote is still open is resumed instead of re-quoted.
import { escapeHTML as esc } from "../../shared/text.ts";
import { api, postJson } from "../api.ts";
import { registerKey, signAndSubmit, type TransferView } from "../sign-flow.ts";
import { NEAR_WALLETS, walletConnected, type NearWalletId, type Session } from "../wallet/index.ts";
import { networkLabel } from "./payroll.ts";
import { msg } from "./transfer-ui.ts";

type LineState = "unsent" | "awaiting" | "expired" | "checking" | "processing" | "sent" | "failed" | "refunded";
type Quote = { depositAddress: string; deadline: string; intent: { standard: "nep413" | "erc191"; payload: unknown }; transfer: TransferView };
type Line = {
  n: number; name: string; recipientType: "DESTINATION_CHAIN" | "INTENTS"; recipient: string; symbol: string; blockchain: string; amountFormatted: string;
  transfer?: TransferView; state: LineState; canQuote: boolean; pendingQuote?: Quote;
};
type View = {
  batch: { id: string; title: string; originAsset: string; originSymbol: string; createdAt: string };
  lines: Line[]; summary: { sent: number; processing: number; awaiting: number; failed: number; total: number }; refreshError?: string;
};
type Target = "all" | "next" | number;
type Step =
  | { kind: "view" }
  | { kind: "confirm"; target: Target; confirmed: boolean }
  | { kind: "running"; text: string }
  | { kind: "register"; publicKey: string; resolve: () => void; reject: (e: Error) => void };

const POLL_MS = 5_000;
const STATE_LABEL: Record<LineState, string> = {
  unsent: "Not sent", awaiting: "Waiting for signature", expired: "Quote expired", checking: "Checking with NEAR Intents",
  processing: "Processing", sent: "Sent", failed: "Failed", refunded: "Refunded",
};
const STATE_CLASS: Record<LineState, string> = {
  unsent: "status-bill-scheduled", awaiting: "status-bill-paying", expired: "status-bill-scheduled", checking: "status-bill-paying",
  processing: "status-bill-paying", sent: "status-bill-paid", failed: "outcome-failed", refunded: "outcome-refunded",
};

/** The per-line button may (re)send this line now. */
const sendable = (l: Line) => l.canQuote || !!l.pendingQuote;
/** "Send next" / "Send all" pick only lines never sent or with an open quote; failed, refunded and
 * expired lines are retried only with their own button, so a bulk run never re-attempts a payment. */
const bulkSendable = (l: Line) => (l.state === "unsent" && l.canQuote) || !!l.pendingQuote;

/** "3/5 sent, 1 failed, 1 awaiting" (zero counts left out). */
export function progressText(s: View["summary"]): string {
  const parts = [`${s.sent}/${s.total} sent`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.processing) parts.push(`${s.processing} processing`);
  if (s.awaiting) parts.push(`${s.awaiting} awaiting`);
  return parts.join(", ");
}

export function mountPayrollBatch(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  let poll = 0;
  let view: View | null = null;
  let session: Session | null = null;
  let loadError = "";
  let error = "";
  let step: Step = { kind: "view" };
  let stop = false;
  let nearWallet: NearWalletId = "meteor-wallet";
  const id = params.id ?? "";
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  function targets(t: Target): Line[] {
    const lines = view?.lines ?? [];
    if (typeof t === "number") return lines.filter((l) => l.n === t && sendable(l));
    const s = lines.filter(bulkSendable);
    return t === "next" ? s.slice(0, 1) : s;
  }

  function draw() {
    if (loadError || !view) {
      el.innerHTML = `<div class="heading"><div><h1>Payout</h1><p class="muted"><a href="#/payroll">Back to payroll</a></p></div></div><section class="panel"><p class="error" role="alert">${esc(loadError || "Loading…")}</p></section>`;
      return;
    }
    const v = view;
    const running = step.kind === "running" || step.kind === "register";
    const any = v.lines.some(bulkSendable);
    const actions =
      step.kind === "view" && any
        ? `<div class="invoice-actions"><button class="textbutton" type="button" id="send-next">Send next</button><button class="primary" type="button" id="send-all">Send all</button></div>`
        : "";
    el.innerHTML = `<div class="heading"><div><p class="eyebrow">PAYOUT</p><h1>${esc(v.batch.title)}</h1><p class="muted">Paid from your ${esc(v.batch.originSymbol || "NEAR Intents")} balance · created ${esc(v.batch.createdAt.slice(0, 10))}</p></div><a class="textbutton" href="#/payroll">Back to payroll</a></div>
<section class="panel" id="batch-summary"><p class="invoice-total"><span>Progress</span><strong id="batch-progress" role="status">${esc(progressText(v.summary))}</strong></p>
${v.refreshError ? `<p class="error" role="alert">${esc(v.refreshError)}</p>` : ""}
${step.kind === "confirm" ? confirmHtml(step.target, step.confirmed) : ""}${step.kind === "running" ? `<p class="muted" id="batch-run" role="status">${esc(step.text)}</p><button class="textbutton" type="button" id="run-stop" ${stop ? "disabled" : ""}>${stop ? "Stopping after this line…" : "Stop after this line"}</button>` : ""}${step.kind === "register" ? registerHtml(step.publicKey) : ""}
<p class="error" id="batch-error" role="alert">${esc(error)}</p>${actions}</section>
<section class="panel"><div class="table-scroll"><table class="payroll-table" id="batch-lines"><thead><tr><th>#</th><th>Name</th><th>Receives</th><th>To</th><th>Status</th><th></th></tr></thead><tbody>${v.lines
      .map(
        (l) =>
          `<tr id="line-${esc(String(l.n))}"><td>${esc(String(l.n))}</td><td>${esc(l.name)}</td><td>${esc(l.amountFormatted ? `${l.amountFormatted} ${l.symbol}` : "Unknown token")}</td><td>${esc(networkLabel(l.recipientType, l.blockchain))}<br><code>${esc(l.recipient)}</code></td><td><span class="badge ${STATE_CLASS[l.state]}">${esc(STATE_LABEL[l.state])}</span></td><td>${
            !running && step.kind === "view" && sendable(l)
              ? `<button class="textbutton line-send" type="button" data-n="${esc(String(l.n))}">${l.state === "failed" || l.state === "refunded" || l.state === "expired" ? "Retry" : l.pendingQuote ? "Sign" : "Send"}</button>`
              : ""
          }</td></tr>`,
      )
      .join("")}</tbody></table></div>
<p class="fine">A line is sent only once. If a payment fails or is refunded, the funds return to your NEAR Intents balance and you can retry that line.</p></section>`;
    wire();
  }

  function confirmHtml(t: Target, confirmed: boolean): string {
    const k = targets(t).length;
    const needsNearWallet = session?.kind === "near" && !walletConnected(session);
    return `<div id="batch-confirm"><h2>Send ${k} ${k === 1 ? "payment" : "payments"}</h2>
<p class="muted">Your wallet asks you to sign each line separately. Each payee receives exactly the amount on their line; what you send includes a small buffer for price movement, and any unused part is refunded to your NEAR Intents balance.</p>
<label class="radio"><input type="checkbox" id="run-confirm" ${confirmed ? "checked" : ""}> I checked the names, networks and addresses</label>
${needsNearWallet ? `<label>Wallet<select id="batch-wallet">${NEAR_WALLETS.map((x) => `<option value="${x.id}" ${x.id === nearWallet ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
<div class="invoice-actions"><button class="textbutton" type="button" id="run-back">Back</button><button class="primary" type="button" id="run-start" ${confirmed ? "" : "disabled"}>Start sending</button></div></div>`;
  }

  function registerHtml(publicKey: string): string {
    return `<div id="batch-register"><h2>One-time setup: register your wallet key</h2>
<p class="muted">NEAR Intents accepts signatures from a named NEAR account only after the account registers its key. Your wallet will ask you to approve a call to <code>intents.near</code> <code>add_public_key</code> (1 yoctoNEAR plus gas) for key <code>${esc(publicKey)}</code>. This does not move your balance.</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="reg-cancel">Cancel</button><button class="primary" type="button" id="reg-approve">Approve key registration</button></div></div>`;
  }

  function wire() {
    q<HTMLButtonElement>("#send-next")?.addEventListener("click", () => void confirm("next"));
    q<HTMLButtonElement>("#send-all")?.addEventListener("click", () => void confirm("all"));
    el.querySelectorAll<HTMLButtonElement>(".line-send").forEach((b) => b.addEventListener("click", () => void confirm(Number(b.dataset.n))));
    if (step.kind === "confirm") {
      const s = step;
      const box = q<HTMLInputElement>("#run-confirm")!;
      box.onchange = () => {
        s.confirmed = box.checked;
        q<HTMLButtonElement>("#run-start")!.disabled = !s.confirmed;
      };
      const w = q<HTMLSelectElement>("#batch-wallet");
      if (w) w.onchange = () => (nearWallet = w.value as NearWalletId);
      q<HTMLButtonElement>("#run-back")!.onclick = () => {
        step = { kind: "view" };
        draw();
        schedulePoll();
      };
      q<HTMLButtonElement>("#run-start")!.onclick = () => {
        if (s.confirmed) void run(s.target);
      };
    } else if (step.kind === "running") {
      q<HTMLButtonElement>("#run-stop")!.onclick = () => {
        stop = true;
        draw();
      };
    } else if (step.kind === "register") {
      const s = step;
      q<HTMLButtonElement>("#reg-cancel")!.onclick = () => s.reject(new Error("Key registration cancelled. Nothing was sent for this line."));
      q<HTMLButtonElement>("#reg-approve")!.onclick = async () => {
        try {
          if (await registerKey(s.publicKey)) s.resolve();
          else error = "The key is not registered yet. Wait a few seconds and approve again.";
        } catch (e) {
          error = msg(e);
        }
        if (alive) draw();
      };
    }
  }

  async function confirm(t: Target) {
    window.clearTimeout(poll);
    error = "";
    try {
      session ??= await api<Session>("/api/me");
    } catch (e) {
      error = msg(e);
      return draw();
    }
    if (!alive) return;
    step = { kind: "confirm", target: t, confirmed: false };
    draw();
  }

  function setRunning(text: string) {
    step = { kind: "running", text };
    if (alive) draw();
  }

  /** Send the target lines one by one; stop on the first error or when asked. */
  async function run(t: Target) {
    if (!session) return;
    stop = false;
    error = "";
    const done = new Set<number>();
    const total = targets(t).length;
    let sent = 0;
    for (;;) {
      if (!alive || stop) break;
      const line = targets(t).find((l) => !done.has(l.n));
      if (!line) break;
      done.add(line.n);
      const label = `Line ${line.n} (${sent + 1} of ${total}) · ${line.name}`;
      try {
        let quote: Quote;
        if (line.pendingQuote) quote = line.pendingQuote;
        else {
          setRunning(`${label}: getting quote…`);
          quote = await postJson<Quote>(`/api/payroll/batches/${encodeURIComponent(id)}/lines/${line.n}/quote`, {});
        }
        if (!alive) return;
        const s = session;
        await signAndSubmit<TransferView>(
          quote,
          s,
          (st) => {
            if (st !== "key") setRunning(`${label}: ${st === "sign" ? "waiting for wallet…" : "submitting…"}`);
          },
          {
            nearWallet,
            confirmKeyRegistration: (publicKey) =>
              new Promise<void>((resolve, reject) => {
                step = { kind: "register", publicKey, resolve, reject };
                if (alive) draw();
              }),
          },
        );
        sent++;
      } catch (e) {
        error = `Stopped: ${msg(e)} Lines already sent stay sent.`;
        break;
      } finally {
        await load();
      }
      if (t !== "all") break;
    }
    step = { kind: "view" };
    stop = false;
    if (!alive) return;
    draw();
    schedulePoll();
  }

  function schedulePoll() {
    window.clearTimeout(poll);
    if (!view || step.kind !== "view") return;
    if (!view.lines.some((l) => l.state === "processing" || l.state === "checking")) return;
    poll = window.setTimeout(() => void reload(), POLL_MS);
  }

  async function load() {
    try {
      const v = await api<View>(`/api/payroll/batches/${encodeURIComponent(id)}`);
      if (!alive) return;
      view = v;
      loadError = "";
    } catch (e) {
      if (!alive) return;
      if (!view) loadError = msg(e);
    }
  }

  async function reload() {
    await load();
    if (!alive || step.kind !== "view") return;
    draw();
    schedulePoll();
  }

  void reload();
  return () => {
    alive = false;
    window.clearTimeout(poll);
    if (step.kind === "register") step.reject(new Error("Cancelled"));
  };
}
