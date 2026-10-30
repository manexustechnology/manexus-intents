import { supportedChain } from "../../shared/address.ts";
import type { PublicInvoice } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { api } from "../api.ts";
import { details } from "./invoice-detail.ts";
import { txLinks } from "./invoices.ts";
import { routeHtml } from "./transfer-ui.ts";
import { chainName } from "./withdraw.ts";

type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };
type Attempt = {
  symbol: string; blockchain: string;
  depositAddress: string; depositMemo?: string; originAsset: string; amountIn: string; amountInFormatted: string;
  deadline: string; status: string; outcome?: string; expired: boolean; destinationTxHashes?: string[];
};
type StatusResponse = { invoiceStatus: PublicInvoice["status"]; attempts: Attempt[]; refreshError?: string };

const POLL_MS = 10_000;
const OPEN = new Set(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS"]);
/** Still waiting on 1Click: no recorded outcome and not an expired, unfunded quote. */
const active = (a: Attempt) => !a.outcome && !a.expired && OPEN.has(a.status);
/** Funds were seen; instructions are no longer needed. */
const settling = (a: Attempt) => a.status === "KNOWN_DEPOSIT_TX" || a.status === "PROCESSING" || a.status === "SUCCESS";

const MISMATCH = "This payment could not be matched to the invoice. Contact the business before paying again.";
const EXTRA = "Your payment was received by the business as an extra payment. Contact them to arrange a refund.";
/** Notice for the payer's own attempt once it has an outcome that is not a plain paid/refunded/failed. */
const ownNotice = (a: Attempt | undefined) =>
  a?.outcome === "mismatch" ? MISMATCH : a?.outcome === "duplicate" || a?.outcome === "after_cancel" ? EXTRA : "";

const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
const label = (t: Token) => `${t.symbol} · ${t.blockchain}`;

function store(key: string, v?: Attempt | null): Attempt | null {
  try {
    if (v === undefined) return JSON.parse(sessionStorage.getItem(key) ?? "null") as Attempt | null;
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  return null;
}

function readDismissed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function mountPay(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  let timer = 0;
  let pollTimer = 0;
  const publicId = params.publicId;
  const key = `manexus:pay:${publicId}`;
  const base = `/api/public/invoices/${encodeURIComponent(publicId)}`;
  let inv: PublicInvoice | null = null;
  let tokens: Token[] = [];
  let attempt: Attempt | null = null;
  let attempts: Attempt[] = [];
  let notice = "";
  /** About this browser's own attempt; shown on every panel, including paid and cancelled. */
  let own = "";
  const dismissedKey = `${key}:dismissed`;
  const dismissed = readDismissed(dismissedKey);
  let error = "";
  let busy = false;
  let chosen = "";
  let refund = "";
  let search = "";

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);

  function draw() {
    window.clearInterval(timer);
    if (!inv) {
      el.innerHTML = `<div class="heading"><div><h1>Invoice unavailable</h1><p class="error" role="alert">${esc(error)}</p></div></div>`;
      return;
    }
    const head = `<div class="heading"><div><p class="eyebrow">INVOICE ${esc(inv.data.number)}</p><h1>Pay ${esc(inv.totalFormatted)} ${esc(inv.symbol)}</h1><p class="muted">Paid to ${esc(inv.payTo)} on NEAR Intents</p></div></div>`;
    const summary = `<section class="panel">${details(inv.data)}</section>`;
    const ownAlert = own ? `<p class="error" role="alert">${esc(own)}</p>` : "";
    let body = "";
    if (inv.status === "paid") body = paid(ownAlert);
    else if (inv.status === "cancelled") body = `<section class="panel"><h2>Cancelled</h2>${ownAlert}<p class="muted">This invoice was cancelled and can no longer be paid.</p></section>`;
    else if (attempt && active(attempt)) body = settling(attempt) ? processing(attempt) : instructions(attempt);
    else body = form(attempt?.expired ?? false);
    el.innerHTML = `${head}${summary}${body}`;
    wire();
  }

  function paid(ownAlert: string): string {
    const hashes = attempts.find((a) => a.outcome === "paid")?.destinationTxHashes ?? [];
    return `<section class="panel"><h2>Paid — thank you</h2>${ownAlert}<p class="muted">This invoice has been paid. Thank you.</p>${hashes.length ? `<p class="fine">Settlement on NEAR: ${txLinks(hashes)}</p>` : ""}</section>`;
  }

  function processing(a: Attempt): string {
    return `<section class="panel pay-instructions"><div class="section-title"><h2>Processing</h2></div><p class="muted" role="status">Your deposit${a.amountInFormatted ? ` of ${esc(a.amountInFormatted)} ${esc(a.symbol)}` : ""} was received and is being settled. This usually takes a few minutes. You can keep this page open.</p></section>`;
  }

  function form(expired: boolean): string {
    const q = search.trim().toLowerCase();
    const list = tokens.filter((t) => supportedChain(t.blockchain) && (!q || label(t).toLowerCase().includes(q)));
    const t = tokenOf(chosen);
    return `<section class="panel"><div class="section-title"><h2>Pay with</h2></div>${expired ? `<p class="error" role="alert">Your previous payment instructions expired. Do not send funds to the old address. Get new instructions below.</p>` : notice ? `<p class="error" role="alert">${esc(notice)}</p>` : ""}<form id="pay-form" novalidate>
<label>Search token or chain<input id="pay-search" autocomplete="off" placeholder="e.g. USDC or arb" value="${esc(search)}"></label>
<label>Token<select id="pay-token" size="6">${list.map((x) => `<option value="${esc(x.assetId)}" ${x.assetId === chosen ? "selected" : ""}>${esc(label(x))}</option>`).join("")}</select></label>
<label>${t ? `Refund address on ${esc(t.blockchain)}` : "Refund address"}<input id="pay-refund" autocomplete="off" spellcheck="false" value="${esc(refund)}" ${t ? "" : "disabled"}></label>
<p class="fine">If the payment cannot complete, your funds are returned to this address on the chain you pay from. Double-check it.</p>
<p class="error" id="pay-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>Get payment instructions</button></form></section>`;
  }

  function instructions(a: Attempt): string {
    const done = a.status !== "PENDING_DEPOSIT";
    return `<section class="panel pay-instructions"><div class="section-title"><h2>Send payment</h2></div>
${a.amountInFormatted ? `<p class="invoice-total"><span>Send exactly</span><strong id="pay-amount">${esc(a.amountInFormatted)} ${esc(a.symbol)}</strong></p>
<p class="muted">on ${esc(a.blockchain)}</p>
${inv ? routeHtml([{ symbol: a.symbol, where: chainName(a.blockchain) }, { symbol: inv.symbol, where: "NEAR Intents" }]) : ""}` : `<p class="error" role="alert">The amount for these instructions is unavailable right now. Do not send funds until it is shown. Reload to try again.</p>`}
${a.status === "INCOMPLETE_DEPOSIT" ? `<p class="error" role="alert">The deposit received is less than required. Send the remaining amount before the deadline, or it will be refunded.</p>` : ""}
<div class="pay-field"><span class="eyebrow">DEPOSIT ADDRESS</span><code id="pay-address">${esc(a.depositAddress)}</code><button class="textbutton" type="button" data-copy="${esc(a.depositAddress)}">Copy address</button></div>
${a.depositMemo ? `<div class="pay-field"><span class="eyebrow">MEMO (REQUIRED)</span><code id="pay-memo">${esc(a.depositMemo)}</code><button class="textbutton" type="button" data-copy="${esc(a.depositMemo)}">Copy memo</button></div>` : ""}
<p class="fine">Send exactly this amount from the selected chain. Unused amount is refunded to your refund address.</p>
${done ? `<p class="muted" role="status">Status: ${esc(a.status.replaceAll("_", " ").toLowerCase())}</p>` : `<p class="muted" role="status">Expires in <strong id="pay-countdown">${esc(countdown(a.deadline))}</strong></p>`}
<details><summary>I've sent it</summary><form id="tx-form" novalidate><label>Transaction hash<input id="tx-hash" autocomplete="off" spellcheck="false"></label><p class="error" id="tx-error" role="alert"></p><p class="fine" id="tx-ok" role="status"></p><button class="textbutton" type="submit">Submit transaction hash</button></form></details>
<button class="textbutton" type="button" id="pay-restart">Start over</button></section>`;
  }

  function wire() {
    const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
    q<HTMLInputElement>("#pay-search")?.addEventListener("input", (e) => {
      search = (e.target as HTMLInputElement).value;
      refund = q<HTMLInputElement>("#pay-refund")!.value;
      draw();
      const next = q<HTMLInputElement>("#pay-search")!;
      next.focus();
      next.setSelectionRange(search.length, search.length);
    });
    q<HTMLSelectElement>("#pay-token")?.addEventListener("change", (e) => {
      chosen = (e.target as HTMLSelectElement).value;
      refund = q<HTMLInputElement>("#pay-refund")!.value;
      error = "";
      draw();
      q<HTMLInputElement>("#pay-refund")?.focus();
    });
    q<HTMLFormElement>("#pay-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      refund = q<HTMLInputElement>("#pay-refund")!.value.trim();
      if (!chosen) return fail("Choose a token to pay with.");
      if (!refund) return fail("Enter a refund address.");
      busy = true;
      error = "";
      draw();
      try {
        attempt = await post<Attempt>(`${base}/quote`, { originAsset: chosen, refundTo: refund });
        attempts = [attempt, ...attempts.filter((a) => a.depositAddress !== attempt!.depositAddress)];
        notice = "";
        own = "";
        store(key, attempt);
      } catch (err) {
        error = (err as Error).message;
      }
      busy = false;
      if (alive) {
        draw();
        schedule();
      }
    });
    el.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy!);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed. Select the text instead.";
        }
      };
    });
    q("#pay-restart")?.addEventListener("click", () => {
      if (attempt) {
        dismissed.add(attempt.depositAddress);
        try {
          sessionStorage.setItem(dismissedKey, JSON.stringify([...dismissed].slice(-20)));
        } catch {
          /* storage unavailable */
        }
      }
      attempt = null;
      store(key, null);
      draw();
    });
    q<HTMLFormElement>("#tx-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hash = q<HTMLInputElement>("#tx-hash")!.value.trim();
      q("#tx-error")!.textContent = "";
      q("#tx-ok")!.textContent = "";
      if (!hash) {
        q("#tx-error")!.textContent = "Paste your transaction hash.";
        return;
      }
      try {
        await post(`${base}/deposit`, { depositAddress: attempt!.depositAddress, txHash: hash });
        if (alive) q("#tx-ok")!.textContent = "Thanks. We will match it as soon as it confirms.";
      } catch (err) {
        if (alive) q("#tx-error")!.textContent = (err as Error).message;
      }
    });
    const cd = q("#pay-countdown");
    if (cd && attempt) {
      timer = window.setInterval(() => {
        if (!attempt) return;
        if (new Date(attempt.deadline).getTime() <= Date.now()) {
          attempt = { ...attempt, expired: true, depositAddress: "", depositMemo: undefined };
          store(key, null);
          draw();
        } else cd.textContent = countdown(attempt.deadline);
      }, 1000);
    }
  }

  function fail(msg: string) {
    error = msg;
    const box = el.querySelector("#pay-error");
    if (box) box.textContent = msg;
  }

  /** Keep display fields we already have when the server cannot format them (e.g. token list unavailable). */
  function merge(prev: Attempt | null | undefined, next: Attempt): Attempt {
    if (!prev || prev.depositAddress !== next.depositAddress || next.amountInFormatted) return next;
    return { ...next, amountInFormatted: prev.amountInFormatted, symbol: prev.symbol, blockchain: prev.blockchain };
  }

  /** Apply a status response. Picks the newest open attempt on first load; afterwards only follows the current one. */
  function apply(st: StatusResponse, initial: boolean) {
    attempts = st.attempts;
    if (inv) inv = { ...inv, status: st.invoiceStatus };
    if (initial) {
      const saved = store(key);
      own = ownNotice(st.attempts.find((a) => a.depositAddress === saved?.depositAddress));
      const cur = st.attempts.find((a) => active(a) && !dismissed.has(a.depositAddress));
      attempt = cur ? merge(saved, cur) : null;
      // Keep it while it explains this browser's own payment, so the notice survives a reload.
      if (!attempt && saved && !own) store(key, null);
      const latest = st.attempts.find((a) => !dismissed.has(a.depositAddress));
      if (!attempt && latest?.outcome === "refunded") notice = "Your last payment was refunded to your refund address. You can try again below.";
      else if (!attempt && latest?.outcome === "failed") notice = "Your last payment could not be completed. Any funds are returned to your refund address.";
      else if (!attempt && latest?.outcome === "mismatch") notice = MISMATCH;
      if (own) notice = own;
    } else if (attempt) {
      const cur = st.attempts.find((a) => a.depositAddress === attempt!.depositAddress);
      if (cur) {
        attempt = merge(attempt, cur);
        if (cur.outcome === "refunded") notice = "Your payment was refunded to your refund address. You can try again below.";
        else if (cur.outcome === "failed") notice = "Your payment could not be completed. Any funds are returned to your refund address.";
        own = ownNotice(cur);
        if (own) notice = own;
        if (!active(attempt) && !own) store(key, null);
      }
    }
  }

  const signature = () =>
    JSON.stringify([inv?.status, attempt?.status, attempt?.outcome, attempt?.expired, attempt?.amountInFormatted, notice, own, attempts.find((a) => a.outcome === "paid")?.destinationTxHashes]);

  function schedule() {
    window.clearTimeout(pollTimer);
    if (!alive || inv?.status !== "issued" || !attempts.some(active)) return;
    pollTimer = window.setTimeout(poll, POLL_MS);
  }

  async function poll() {
    const st = await api<StatusResponse>(`${base}/status`).catch(() => null);
    if (!alive) return;
    if (st) {
      const before = signature();
      apply(st, false);
      if (signature() !== before) draw();
    }
    schedule();
  }

  void (async () => {
    try {
      const [i, t, st] = await Promise.all([
        api<PublicInvoice>(base),
        api<Token[]>("/api/tokens").catch(() => [] as Token[]),
        api<StatusResponse>(`${base}/status`).catch(() => null),
      ]);
      if (!alive) return;
      inv = i;
      tokens = t;
      if (st) apply(st, true);
      else {
        // Status unavailable: fall back to the instructions this browser last saw.
        const saved = store(key);
        if (saved && new Date(saved.deadline).getTime() > Date.now() && saved.status === "PENDING_DEPOSIT") {
          attempt = saved;
          attempts = [saved];
        } else if (saved) store(key, null);
      }
      if (!tokens.length && inv.status === "issued") error = "Could not load the list of tokens. Reload to try again.";
    } catch (e) {
      error = (e as Error).message;
    }
    if (alive) {
      draw();
      schedule();
    }
  })();

  return () => {
    alive = false;
    window.clearInterval(timer);
    window.clearTimeout(pollTimer);
  };
}
