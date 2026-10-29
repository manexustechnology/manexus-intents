import { escapeHTML as esc } from "../../shared/text.ts";
import { api, postJson } from "../api.ts";
import { registerKey, signAndSubmit, type TransferView } from "../sign-flow.ts";
import { NEAR_WALLETS, walletConnected, type NearWalletId, type Session } from "../wallet/index.ts";
import { amountLabel, billStatusBadge, dueChip, type Bill } from "./bills.ts";
import { countdown, msg } from "./transfer-ui.ts";
import { chainName, explorerLinks } from "./withdraw.ts";

type Detail = Bill & { transfer?: TransferView; vendorInvoiceStatus?: string; vendorOutcome?: string; extraPayment: boolean; refreshError?: string; pendingQuote?: Quote };
type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string };
type Quote = { depositAddress: string; deadline: string; amountOutFormatted: string; intent: { standard: "nep413" | "erc191"; payload: unknown }; transfer: TransferView };
type Step =
  | { kind: "view" }
  | { kind: "pick" }
  | { kind: "review"; quote: Quote; confirmed: boolean }
  | { kind: "register"; quote: Quote; publicKey: string; resolve: () => void; reject: (e: Error) => void };

const POLL_MS = 5_000;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TRANSFER_TEXT: Record<string, string> = {
  AWAITING_SIGNATURE: "Waiting for your signature", PENDING_DEPOSIT: "Submitted", KNOWN_DEPOSIT_TX: "Processing", INCOMPLETE_DEPOSIT: "Processing",
  PROCESSING: "Processing", SUCCESS: "Sent", REFUNDED: "Refunded to your NEAR Intents balance", FAILED: "Failed",
};

/** Where the vendor is paid: a chain address, or a Manexus/NEAR Intents account. */
function payee(b: Bill): { network: string; address: string } {
  if (b.source === "manexus") return { network: "NEAR Intents", address: `Manexus account ${b.recipient}` };
  if (b.recipientType === "INTENTS") return { network: "NEAR Intents", address: b.recipient };
  return { network: chainName(b.blockchain), address: b.recipient };
}

export function mountBill(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  let tick = 0;
  let poll = 0;
  let bill: Detail | null = null;
  let session: Session | null = null;
  let balances: Balance[] = [];
  let origin = "";
  let loadError = "";
  let error = "";
  let busy = "";
  let step: Step = { kind: "view" };
  let nearWallet: NearWalletId = "meteor-wallet";
  const id = params.id ?? "";
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  function draw() {
    window.clearInterval(tick);
    if (loadError || !bill) {
      el.innerHTML = `<div class="heading"><div><h1>Bill</h1><p class="muted"><a href="#/bills">Back to bills</a></p></div></div><section class="panel"><p class="error" role="alert">${esc(loadError || "Loading…")}</p></section>`;
      return;
    }
    const b = bill;
    const p = payee(b);
    let action = "";
    if (step.kind === "pick") action = pickHtml();
    else if (step.kind === "review") action = reviewHtml(b, step.quote, step.confirmed);
    else if (step.kind === "register") action = registerHtml(step.publicKey);
    else action = statusHtml(b);
    el.innerHTML = `<div class="heading"><div><p class="eyebrow">BILL</p><h1>${esc(b.vendor)}</h1><p class="muted">${billStatusBadge(b.status, b.extraPayment)} ${dueChip(b)} <span>Due ${esc(b.dueDate)}</span></p></div><a class="textbutton" href="#/bills">Back to bills</a></div>
<section class="panel" id="bill-summary"><div class="pay-field"><span class="eyebrow">REFERENCE</span><strong>${esc(b.reference || "No reference")}</strong></div>
<div class="pay-field"><span class="eyebrow">VENDOR RECEIVES</span><strong id="bill-amount">${esc(amountLabel(b))}</strong></div>
<div class="pay-field"><span class="eyebrow">NETWORK</span><strong>${esc(p.network)}</strong></div>
<div class="pay-field"><span class="eyebrow">PAYS TO</span><code>${esc(p.address)}</code></div>
${b.source === "manexus" ? `<p class="fine">Imported from a Manexus invoice. The vendor's invoice is marked paid when this payment settles.</p>` : ""}</section>
${action}`;
    wire();
  }

  function statusHtml(b: Detail): string {
    const t = b.transfer;
    const tText = t ? (TRANSFER_TEXT[t.status] ?? t.status) : "";
    const refresh = b.refreshError ? `<p class="error" role="alert">${esc(b.refreshError)}</p>` : "";
    if (b.status === "paid") {
      const links = t && t.destinationTxHashes.length && b.recipientType === "DESTINATION_CHAIN" ? `<p>${explorerLinks(t.destinationBlockchain, t.destinationTxHashes)}</p>` : "";
      return `<section class="panel" id="bill-status"><h2>${b.extraPayment ? "Paid — vendor reports extra payment" : "Paid"}</h2>
${t ? `<p class="muted" role="status">You sent ${esc(t.amountFormatted)} ${esc(t.originSymbol)}; the vendor received ${esc(amountLabel(b))}.</p>` : ""}
${b.extraPayment ? `<p class="fine">The payment arrived after the vendor's invoice was already paid or cancelled. Contact the vendor to settle the extra payment.</p>` : ""}${links}${refresh}</section>`;
    }
    if (b.status === "cancelled") return `<section class="panel" id="bill-status"><h2>Cancelled</h2><p class="muted">This bill will not be paid.</p></section>`;
    if (b.status === "paying" && t) {
      const unsigned = t.status === "AWAITING_SIGNATURE";
      return `<section class="panel" id="bill-status"><h2>Payment in progress</h2><p class="muted" role="status" id="bill-transfer-status">${esc(t.amountFormatted)} ${esc(t.originSymbol)} → ${esc(amountLabel(b))}: ${esc(tText)}.</p>
${unsigned && b.pendingQuote?.depositAddress === t.depositAddress ? `<div class="invoice-actions"><button class="primary" type="button" id="bill-resume">Review and sign</button></div>` : ""}
${unsigned ? `<p class="fine">If you left before signing, this quote expires in <span id="bill-countdown">${countdown(t.deadline)}</span>; you can then request a new one.</p>` : `<p class="fine">This usually takes a few minutes. You can leave this page.</p>`}${refresh}<p class="error" id="bill-detail-error" role="alert">${esc(error)}</p></section>`;
    }
    const last = t && (t.status === "FAILED" || t.status === "REFUNDED") ? `<p class="fine" id="bill-last">The last payment attempt ${t.status === "REFUNDED" ? "was refunded to your NEAR Intents balance" : "failed"}. You can pay again.</p>` : "";
    return `<section class="panel" id="bill-status">${last}${refresh}<p class="error" id="bill-detail-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="bill-cancel" ${busy ? "disabled" : ""}>Cancel bill</button><button class="primary" type="button" id="bill-pay" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Pay from balance"}</button></div></section>`;
  }

  function pickHtml(): string {
    if (!balances.length)
      return `<section class="panel" id="bill-pick"><h2>Nothing to pay with yet</h2><p class="muted">Your NEAR Intents balance is empty. Paid invoices land there.</p><button class="textbutton" type="button" id="bill-pick-back">Back</button></section>`;
    return `<section class="panel" id="bill-pick"><h2>Pay from balance</h2><label>Pay with<select id="bill-origin">${balances
      .map((x) => `<option value="${esc(x.tokenId)}" ${x.tokenId === origin ? "selected" : ""}>${esc(x.formatted)} ${esc(x.symbol)} (${esc(chainName(x.blockchain))})</option>`)
      .join("")}</select></label>
<p class="fine">The vendor receives exactly ${esc(amountLabel(bill!))}. The quote shows how much you send.</p>
<p class="error" id="bill-detail-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="bill-pick-back" ${busy ? "disabled" : ""}>Back</button><button class="primary" type="button" id="bill-quote" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Get quote"}</button></div></section>`;
  }

  function reviewHtml(b: Detail, qt: Quote, confirmed: boolean): string {
    const t = qt.transfer;
    const p = payee(b);
    const needsNearWallet = session?.kind === "near" && !walletConnected(session);
    return `<section class="panel" id="bill-review"><div class="section-title"><h2>Review payment</h2><span class="muted">Quote expires in <span id="bill-countdown">${countdown(qt.deadline)}</span></span></div>
<div class="pay-field"><span class="eyebrow">VENDOR</span><strong id="rv-vendor">${esc(b.vendor)}</strong></div>
<div class="pay-field"><span class="eyebrow">NETWORK</span><strong id="rv-network">${esc(p.network)}</strong></div>
<div class="pay-field"><span class="eyebrow">ADDRESS</span><code id="rv-address">${esc(p.address)}</code></div>
<p class="invoice-total"><span>Vendor receives</span><strong id="rv-receive">${esc(amountLabel(b))}</strong></p>
<p class="invoice-total"><span>You send</span><strong id="rv-send">≈ ${esc(t.amountFormatted)} ${esc(t.originSymbol)}</strong></p>
<p class="fine" id="rv-buffer">What you send includes a small buffer for price movement. Any unused part is refunded to your NEAR Intents balance.</p>
<label class="radio"><input type="checkbox" id="rv-confirm" ${confirmed ? "checked" : ""}> I checked the vendor and ${b.source === "manexus" ? "account" : `that the address is on ${esc(p.network)}`}</label>
${needsNearWallet ? `<label>Wallet<select id="bill-wallet">${NEAR_WALLETS.map((x) => `<option value="${x.id}" ${x.id === nearWallet ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
<p class="error" id="bill-detail-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="bill-review-back" ${busy ? "disabled" : ""}>Back</button><button class="primary" type="button" id="bill-sign" ${confirmed && !busy ? "" : "disabled"}>${busy ? esc(busy) : "Sign in wallet"}</button></div></section>`;
  }

  function registerHtml(publicKey: string): string {
    return `<section class="panel" id="bill-register"><h2>One-time setup: register your wallet key</h2>
<p class="muted">NEAR Intents accepts signatures from a named NEAR account only after the account registers its key. Your wallet will ask you to approve a call to <code>intents.near</code> <code>add_public_key</code> (1 yoctoNEAR plus gas) for key <code>${esc(publicKey)}</code>. This does not move your balance.</p>
<p class="error" id="bill-detail-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="bill-reg-cancel" ${busy ? "disabled" : ""}>Cancel</button><button class="primary" type="button" id="bill-reg" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Approve key registration"}</button></div></section>`;
  }

  function setError(e: string) {
    error = e;
    const n = q("#bill-detail-error");
    if (n) n.textContent = e;
  }

  function wire() {
    if (step.kind === "view") {
      q<HTMLButtonElement>("#bill-pay")?.addEventListener("click", () => void startPay());
      q<HTMLButtonElement>("#bill-cancel")?.addEventListener("click", () => void cancel());
      q<HTMLButtonElement>("#bill-resume")?.addEventListener("click", async () => {
        const quote = bill?.pendingQuote;
        if (!quote) return;
        window.clearTimeout(poll); // a poll would reset the review
        try {
          session ??= await api<Session>("/api/me");
        } catch (e) {
          return setError(msg(e));
        }
        if (!alive) return;
        step = { kind: "review", quote, confirmed: false };
        error = "";
        draw();
      });
      const c = q("#bill-countdown");
      if (c && bill?.transfer) {
        const deadline = bill.transfer.deadline;
        tick = window.setInterval(() => {
          const n = q("#bill-countdown");
          if (n) n.textContent = countdown(deadline);
        }, 1000);
      }
    } else if (step.kind === "pick") {
      const sel = q<HTMLSelectElement>("#bill-origin");
      if (sel) sel.onchange = () => (origin = sel.value);
      q<HTMLButtonElement>("#bill-pick-back")!.onclick = () => {
        step = { kind: "view" };
        error = "";
        draw();
      };
      q<HTMLButtonElement>("#bill-quote")?.addEventListener("click", () => void requestQuote());
    } else if (step.kind === "review") {
      const s = step;
      tick = window.setInterval(() => {
        const n = q("#bill-countdown");
        if (n) n.textContent = countdown(s.quote.deadline);
        if (new Date(s.quote.deadline).getTime() <= Date.now() && !busy) {
          error = "Quote expired, request a new one";
          void reload();
        }
      }, 1000);
      const box = q<HTMLInputElement>("#rv-confirm")!;
      box.onchange = () => {
        s.confirmed = box.checked;
        const btn = q<HTMLButtonElement>("#bill-sign");
        if (btn) btn.disabled = !s.confirmed || !!busy;
      };
      const wsel = q<HTMLSelectElement>("#bill-wallet");
      if (wsel) wsel.onchange = () => (nearWallet = wsel.value as NearWalletId);
      q<HTMLButtonElement>("#bill-review-back")!.onclick = () => {
        error = "";
        void reload();
      };
      q<HTMLButtonElement>("#bill-sign")!.onclick = () => {
        if (s.confirmed) void sign(s.quote);
      };
    } else if (step.kind === "register") {
      const s = step;
      q<HTMLButtonElement>("#bill-reg-cancel")!.onclick = () => s.reject(new Error("Key registration cancelled. Nothing was sent."));
      q<HTMLButtonElement>("#bill-reg")!.onclick = async () => {
        busy = "Waiting for wallet…";
        error = "";
        draw();
        try {
          const registered = await registerKey(s.publicKey);
          busy = "";
          if (!registered) {
            error = "The key is not registered yet. Wait a few seconds and approve again, or try again later.";
            draw();
            return;
          }
          s.resolve();
        } catch (e) {
          busy = "";
          error = msg(e);
          if (alive) draw();
        }
      };
    }
  }

  async function startPay() {
    busy = "Loading balances…";
    error = "";
    draw();
    try {
      const [s, b] = await Promise.all([api<Session>("/api/me"), api<Balance[]>("/api/balances")]);
      if (!alive) return;
      session = s;
      balances = b;
      if (!balances.some((x) => x.tokenId === origin)) origin = (balances.find((x) => x.tokenId === USDC) ?? balances[0])?.tokenId ?? "";
      step = { kind: "pick" };
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  async function requestQuote() {
    if (!origin) return setError("Choose a balance to pay from.");
    busy = "Getting quote…";
    error = "";
    draw();
    try {
      const quote = await postJson<Quote>(`/api/bills/${encodeURIComponent(id)}/quote`, { originAsset: origin });
      if (!alive) return;
      step = { kind: "review", quote, confirmed: false };
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  async function cancel() {
    busy = "Cancelling…";
    error = "";
    draw();
    try {
      await postJson(`/api/bills/${encodeURIComponent(id)}/cancel`, {});
      busy = "";
      await reload();
      return;
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  async function sign(quote: Quote) {
    if (!session) return;
    busy = "Waiting for wallet…";
    error = "";
    draw();
    try {
      await signAndSubmit<TransferView>(
        quote,
        session,
        (st) => {
          if (st === "key" || !alive) return;
          if (step.kind !== "review") step = { kind: "review", quote, confirmed: true };
          busy = st === "sign" ? "Waiting for wallet…" : "Submitting…";
          draw();
        },
        {
          nearWallet,
          confirmKeyRegistration: (publicKey) =>
            new Promise<void>((resolve, reject) => {
              busy = "";
              error = "";
              step = { kind: "register", quote, publicKey, resolve, reject };
              draw();
            }),
        },
      );
      if (!alive) return;
      busy = "";
      await reload();
    } catch (e) {
      if (!alive) return;
      busy = "";
      error = msg(e);
      step = { kind: "review", quote, confirmed: true };
      draw();
    }
  }

  function schedulePoll() {
    window.clearTimeout(poll);
    if (!bill || bill.status !== "paying" || step.kind !== "view") return;
    poll = window.setTimeout(() => void reload(), POLL_MS);
  }

  async function reload() {
    try {
      const b = await api<Detail>(`/api/bills/${encodeURIComponent(id)}`);
      if (!alive) return;
      bill = b;
      loadError = "";
      step = { kind: "view" };
    } catch (e) {
      if (!alive) return;
      if (!bill) loadError = msg(e);
    }
    draw();
    schedulePoll();
  }

  void reload();
  return () => {
    alive = false;
    window.clearInterval(tick);
    window.clearTimeout(poll);
    if (step.kind === "register") step.reject(new Error("Cancelled"));
  };
}
