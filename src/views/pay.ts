import { supportedChain } from "../../shared/address.ts";
import type { PublicInvoice } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { api } from "../api.ts";
import { details } from "./invoice-detail.ts";

type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };
type Attempt = {
  depositAddress: string; depositMemo?: string; originAsset: string; amountIn: string; amountInFormatted: string;
  deadline: string; status: string; outcome?: string; expired: boolean;
};

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

function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function mountPay(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  let timer = 0;
  const publicId = params.publicId;
  const key = `manexus:pay:${publicId}`;
  const base = `/api/public/invoices/${encodeURIComponent(publicId)}`;
  let inv: PublicInvoice | null = null;
  let tokens: Token[] = [];
  let attempt: Attempt | null = null;
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
    let body = "";
    if (inv.status === "paid") body = `<section class="panel"><h2>Paid</h2><p class="muted">This invoice has been paid. Thank you.</p></section>`;
    else if (inv.status === "cancelled") body = `<section class="panel"><h2>Cancelled</h2><p class="muted">This invoice was cancelled and can no longer be paid.</p></section>`;
    else if (attempt && !attempt.expired) body = instructions(attempt);
    else body = form(attempt?.expired ?? false);
    el.innerHTML = `${head}${summary}${body}`;
    wire();
  }

  function form(expired: boolean): string {
    const q = search.trim().toLowerCase();
    const list = tokens.filter((t) => supportedChain(t.blockchain) && (!q || label(t).toLowerCase().includes(q)));
    const t = tokenOf(chosen);
    return `<section class="panel"><div class="section-title"><h2>Pay with</h2></div>${expired ? `<p class="error" role="alert">Your previous payment instructions expired. Do not send funds to the old address. Get new instructions below.</p>` : ""}<form id="pay-form" novalidate>
<label>Search token or chain<input id="pay-search" autocomplete="off" placeholder="e.g. USDC or arb" value="${esc(search)}"></label>
<label>Token<select id="pay-token" size="6">${list.map((x) => `<option value="${esc(x.assetId)}" ${x.assetId === chosen ? "selected" : ""}>${esc(label(x))}</option>`).join("")}</select></label>
<label>${t ? `Refund address on ${esc(t.blockchain)}` : "Refund address"}<input id="pay-refund" autocomplete="off" spellcheck="false" value="${esc(refund)}" ${t ? "" : "disabled"}></label>
<p class="fine">If the payment cannot complete, your funds are returned to this address on the chain you pay from. Double-check it.</p>
<p class="error" id="pay-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>Get payment instructions</button></form></section>`;
  }

  function instructions(a: Attempt): string {
    const t = tokenOf(a.originAsset);
    const done = a.status !== "PENDING_DEPOSIT";
    return `<section class="panel pay-instructions"><div class="section-title"><h2>Send payment</h2></div>
<p class="invoice-total"><span>Send exactly</span><strong id="pay-amount">${esc(a.amountInFormatted)} ${esc(t?.symbol ?? "")}</strong></p>
<p class="muted">on ${esc(t?.blockchain ?? "the selected chain")}</p>
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
        store(key, attempt);
      } catch (err) {
        error = (err as Error).message;
      }
      busy = false;
      if (alive) draw();
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

  void (async () => {
    try {
      const [i, t] = await Promise.all([api<PublicInvoice>(base), api<Token[]>("/api/tokens").catch(() => [] as Token[])]);
      if (!alive) return;
      inv = i;
      tokens = t;
      const saved = store(key);
      if (saved && new Date(saved.deadline).getTime() > Date.now() && saved.status === "PENDING_DEPOSIT") attempt = saved;
      else if (saved) store(key, null);
      if (!tokens.length && i.status === "issued") error = "Could not load the list of tokens. Reload to try again.";
    } catch (e) {
      error = (e as Error).message;
    }
    if (alive) draw();
  })();

  return () => {
    alive = false;
    window.clearInterval(timer);
  };
}
