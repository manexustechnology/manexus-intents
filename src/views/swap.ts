import { escapeHTML as esc } from "../../shared/text.ts";
import { baseUnits } from "../../shared/units.ts";
import { api, postJson } from "../api.ts";
import { registerKey, signAndSubmit, type TransferView } from "../sign-flow.ts";
import { NEAR_WALLETS, walletConnected, type NearWalletId, type Session } from "../wallet/index.ts";
import { countdown, msg } from "./transfer-ui.ts";
import { chainName } from "./withdraw.ts";

type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string };
type Token = { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number };
type Quote = { depositAddress: string; deadline: string; amountOutFormatted: string; intent: { standard: "nep413" | "erc191"; payload: unknown }; transfer: TransferView };
type Step =
  | { kind: "form" }
  | { kind: "review"; quote: Quote }
  | { kind: "register"; quote: Quote; publicKey: string; resolve: () => void; reject: (e: Error) => void }
  | { kind: "track"; t: TransferView };

const SLIPPAGES = [[50, "0.5 %"], [100, "1 %"], [300, "3 %"]] as const;
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const POLL_MS = 5_000;
const MAX_OPTIONS = 100;
const tokenLabel = (t: { symbol: string; blockchain: string }) => `${t.symbol} · ${chainName(t.blockchain)}`;

/** `amountOut` per 1 unit of the origin token, from base units, with 6 fractional digits (truncated). */
export function swapRate(amountIn: bigint, originDecimals: number, amountOut: bigint, destDecimals: number): string {
  if (amountIn <= 0n) return "0.000000";
  const r = (amountOut * 10n ** BigInt(originDecimals) * 1_000_000n) / (amountIn * 10n ** BigInt(destDecimals));
  return `${r / 1_000_000n}.${(r % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Dollar value (cents, integer math) of `units` at a token's reference price; undefined without a usable price. */
export function usdValue(units: bigint, decimals: number, price: number | undefined): string | undefined {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined;
  const cents = (units * BigInt(Math.round(price * 1e6))) / (10n ** BigInt(decimals) * 10_000n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

const STATUS_TEXT: Record<string, string> = {
  AWAITING_SIGNATURE: "Not submitted", PENDING_DEPOSIT: "Submitted", KNOWN_DEPOSIT_TX: "Processing", INCOMPLETE_DEPOSIT: "Processing",
  PROCESSING: "Processing", SUCCESS: "Swapped", REFUNDED: "Refunded to your NEAR Intents balance", FAILED: "Failed",
};

export function mountSwap(el: HTMLElement): () => void {
  let alive = true;
  let tick = 0;
  let poll = 0;
  let session: Session | null = null;
  let balances: Balance[] = [];
  let tokens: Token[] = [];
  let loadError = "";
  let error = "";
  let busy = "";
  let step: Step = { kind: "form" };
  const form = { origin: "", amount: "", search: "", dest: "", slippage: 100 };
  let nearWallet: NearWalletId = "meteor-wallet";

  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const balanceOf = (id: string) => balances.find((b) => b.tokenId === id);
  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  function draw() {
    window.clearInterval(tick);
    const head = `<div class="heading"><div><p class="eyebrow">MOVE FUNDS</p><h1>Swap</h1><p class="muted">Swap one balance for another token. The swapped tokens stay in your NEAR Intents account. You sign every swap in your wallet.</p></div></div>`;
    let body: string;
    if (loadError) body = `<section class="panel"><p class="error" role="alert">${esc(loadError)}</p></section>`;
    else if (step.kind === "form") body = formHtml();
    else if (step.kind === "review") body = reviewHtml(step.quote);
    else if (step.kind === "register") body = registerHtml(step.publicKey);
    else body = trackHtml(step.t);
    el.innerHTML = `${head}${body}`;
    wire();
  }

  function formHtml(): string {
    if (!balances.length)
      return `<section class="panel"><h2>Nothing to swap yet</h2><p class="muted">Your NEAR Intents balance is empty. Paid invoices land there.</p></section>`;
    const b = balanceOf(form.origin);
    const s = form.search.trim().toLowerCase();
    const matches = tokens.filter((t) => t.assetId !== form.origin && (!s || tokenLabel(t).toLowerCase().includes(s) || t.blockchain.includes(s)));
    const shown = matches.slice(0, MAX_OPTIONS);
    return `<section class="panel"><form id="sw-form" novalidate>
<label>From your balance<select id="sw-origin"><option value="">Choose a balance</option>${balances
      .map((x) => `<option value="${esc(x.tokenId)}" ${x.tokenId === form.origin ? "selected" : ""}>${esc(x.formatted)} ${esc(x.symbol)} (${esc(chainName(x.blockchain))})</option>`)
      .join("")}</select></label>
<label>Amount${b ? ` (${esc(b.symbol)})` : ""}<span class="amountrow"><input id="sw-amount" inputmode="decimal" autocomplete="off" value="${esc(form.amount)}" ${b ? "" : "disabled"}><button class="textbutton" type="button" id="sw-max" ${b ? "" : "disabled"}>Max</button></span></label>
${b ? `<p class="fine">Available: ${esc(b.formatted)} ${esc(b.symbol)}</p>` : ""}
<label>Search token or chain to receive<input id="sw-search" autocomplete="off" placeholder="e.g. wNEAR or arb" value="${esc(form.search)}"></label>
<label>Swap to<select id="sw-dest" size="6">${shown
      .map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === form.dest ? "selected" : ""}>${esc(tokenLabel(t))}</option>`)
      .join("")}</select></label>
${matches.length > shown.length ? `<p class="fine">Showing the first ${MAX_OPTIONS} matches. Type to narrow the list.</p>` : ""}
<fieldset class="slippage"><legend>Slippage tolerance</legend>${SLIPPAGES.map(
      ([bps, label]) => `<label class="radio"><input type="radio" name="sw-slip" value="${bps}" ${form.slippage === bps ? "checked" : ""}> ${label}</label>`,
    ).join("")}</fieldset>
<p class="error" id="sw-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Get quote"}</button></form></section>`;
  }

  function reviewHtml(qt: Quote): string {
    const t = qt.transfer;
    const o = tokenOf(t.originAsset);
    const d = tokenOf(t.destinationAsset);
    const ob = balanceOf(t.originAsset);
    const od = ob?.decimals ?? o?.decimals;
    const needsNearWallet = session?.kind === "near" && !walletConnected(session);
    const usd = (units: string, dec: number | undefined, price: number | undefined) => {
      const v = dec === undefined ? undefined : usdValue(BigInt(units), dec, price);
      return v ? ` <small class="muted">≈ $${esc(v)} reference price</small>` : "";
    };
    const rate = od !== undefined && d ? `<p class="fine" id="sw-rate">1 ${esc(t.originSymbol)} ≈ ${esc(swapRate(BigInt(t.amount), od, BigInt(t.amountOut), d.decimals))} ${esc(t.destinationSymbol)}</p>` : "";
    return `<section class="panel" id="sw-review"><div class="section-title"><h2>Review swap</h2><span class="muted">Quote expires in <span id="sw-countdown">${countdown(qt.deadline)}</span></span></div>
<p class="invoice-total"><span>You send</span><strong id="sw-send">${esc(t.amountFormatted)} ${esc(t.originSymbol)}</strong>${usd(t.amount, od, o?.price)}</p>
<p class="invoice-total"><span>You receive</span><strong id="sw-receive">≈ ${esc(qt.amountOutFormatted)} ${esc(t.destinationSymbol)}</strong>${usd(t.amountOut, d?.decimals, d?.price)}</p>
<p class="fine" id="sw-min">Minimum received: ${esc(t.minAmountOutFormatted)} ${esc(t.destinationSymbol)}. If the price moves further than your slippage, the swap is refunded to your NEAR Intents balance.</p>
${rate}
<p class="fine">The swapped tokens stay in your NEAR Intents account.</p>
${needsNearWallet ? `<label>Wallet<select id="sw-wallet">${NEAR_WALLETS.map((x) => `<option value="${x.id}" ${x.id === nearWallet ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
<p class="error" id="sw-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="sw-back" ${busy ? "disabled" : ""}>Back</button><button class="primary" type="button" id="sw-sign" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Sign in wallet"}</button></div></section>`;
  }

  function registerHtml(publicKey: string): string {
    return `<section class="panel" id="sw-register"><h2>One-time setup: register your wallet key</h2>
<p class="muted">NEAR Intents accepts signatures from a named NEAR account only after the account registers its key. Your wallet will ask you to approve a call to <code>intents.near</code> <code>add_public_key</code> (1 yoctoNEAR plus gas) for key <code>${esc(publicKey)}</code>. This does not move your balance.</p>
<p class="error" id="sw-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="sw-reg-cancel" ${busy ? "disabled" : ""}>Cancel</button><button class="primary" type="button" id="sw-reg" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Approve key registration"}</button></div></section>`;
  }

  function trackHtml(t: TransferView): string {
    const done = t.status === "SUCCESS";
    const text = STATUS_TEXT[t.status] ?? t.status;
    return `<section class="panel" id="sw-track"><h2>${done ? "Swapped — new balance on Home" : esc(text)}</h2>
<p class="muted" role="status" id="sw-status">${esc(t.amountFormatted)} ${esc(t.originSymbol)} → ${esc(t.destinationSymbol)}: ${esc(text)}.</p>
${t.expiredUnsubmitted ? `<p class="fine">Not submitted — the quote expired. No funds moved; request a new quote.</p>` : ""}
${!TERMINAL.has(t.status) ? `<p class="fine">This usually takes a few minutes. You can leave this page.</p>` : ""}
${done ? `<p class="fine">The swapped tokens stay in your NEAR Intents account. <a href="#/">See your new balance on Home</a>.</p>` : ""}
${t.refreshError ? `<p class="error" role="alert">${esc(t.refreshError)}</p>` : ""}
${TERMINAL.has(t.status) ? `<button class="primary" type="button" id="sw-new">New swap</button>` : ""}</section>`;
  }

  function setError(e: string) {
    error = e;
    const n = q("#sw-error");
    if (n) n.textContent = e;
  }

  function wire() {
    if (step.kind === "form") wireForm();
    else if (step.kind === "review") wireReview(step);
    else if (step.kind === "register") wireRegister(step);
    else if (step.kind === "track") {
      q<HTMLButtonElement>("#sw-new")?.addEventListener("click", () => {
        step = { kind: "form" };
        form.amount = "";
        error = "";
        void reload();
      });
    }
  }

  function wireForm() {
    const f = q<HTMLFormElement>("#sw-form");
    if (!f) return;
    q<HTMLSelectElement>("#sw-origin")!.onchange = (e) => {
      form.origin = (e.target as HTMLSelectElement).value;
      form.amount = "";
      if (form.dest === form.origin) form.dest = "";
      draw();
    };
    q<HTMLInputElement>("#sw-amount")!.oninput = (e) => (form.amount = (e.target as HTMLInputElement).value.trim());
    q<HTMLButtonElement>("#sw-max")!.onclick = () => {
      const b = balanceOf(form.origin);
      if (b) form.amount = b.formatted;
      draw();
    };
    const search = q<HTMLInputElement>("#sw-search")!;
    search.oninput = () => {
      form.search = search.value;
      const pos = search.selectionStart;
      draw();
      const s = q<HTMLInputElement>("#sw-search")!;
      s.focus();
      s.setSelectionRange(pos, pos);
    };
    q<HTMLSelectElement>("#sw-dest")!.onchange = (e) => (form.dest = (e.target as HTMLSelectElement).value);
    el.querySelectorAll<HTMLInputElement>('input[name="sw-slip"]').forEach((r) => (r.onchange = () => (form.slippage = Number(r.value))));
    f.onsubmit = (e) => {
      e.preventDefault();
      void requestQuote();
    };
  }

  async function requestQuote() {
    const b = balanceOf(form.origin);
    const d = tokenOf(form.dest);
    if (!b) return setError("Choose a balance to swap from.");
    let units: bigint;
    try {
      units = baseUnits(form.amount, b.decimals);
    } catch (e) {
      return setError(msg(e));
    }
    if (units > BigInt(b.amount)) return setError("Amount exceeds your balance");
    if (!d) return setError("Choose the token to swap to.");
    if (d.assetId === b.tokenId) return setError("Choose two different tokens");
    busy = "Getting quote…";
    error = "";
    draw();
    try {
      const quote = await postJson<Quote>("/api/swaps/quote", {
        originAsset: b.tokenId, destinationAsset: d.assetId, amount: units.toString(), slippageBps: form.slippage,
      });
      if (!alive) return;
      step = { kind: "review", quote };
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  function wireReview(s: Extract<Step, { kind: "review" }>) {
    tick = window.setInterval(() => {
      const c = q("#sw-countdown");
      if (c) c.textContent = countdown(s.quote.deadline);
      if (new Date(s.quote.deadline).getTime() <= Date.now() && !busy) {
        step = { kind: "form" };
        error = "Quote expired, request a new one";
        draw();
      }
    }, 1000);
    const wsel = q<HTMLSelectElement>("#sw-wallet");
    if (wsel) wsel.onchange = () => (nearWallet = wsel.value as NearWalletId);
    q<HTMLButtonElement>("#sw-back")!.onclick = () => {
      step = { kind: "form" };
      error = "";
      draw();
    };
    q<HTMLButtonElement>("#sw-sign")!.onclick = () => void sign(s.quote);
  }

  function wireRegister(s: Extract<Step, { kind: "register" }>) {
    q<HTMLButtonElement>("#sw-reg-cancel")!.onclick = () => s.reject(new Error("Key registration cancelled. Nothing was sent."));
    q<HTMLButtonElement>("#sw-reg")!.onclick = async () => {
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

  async function sign(quote: Quote) {
    if (!session) return;
    busy = "Waiting for wallet…";
    error = "";
    draw();
    try {
      const t = await signAndSubmit<TransferView>(
        quote,
        session,
        (st) => {
          if (st === "key" || !alive) return;
          step = { kind: "review", quote };
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
      step = { kind: "track", t };
      draw();
      schedulePoll();
    } catch (e) {
      if (!alive) return;
      busy = "";
      error = msg(e);
      step = { kind: "review", quote };
      draw();
    }
  }

  function schedulePoll() {
    window.clearTimeout(poll);
    if (step.kind !== "track" || TERMINAL.has(step.t.status)) return;
    const dep = step.t.depositAddress;
    poll = window.setTimeout(async () => {
      try {
        const t = await api<TransferView>(`/api/transfers/${encodeURIComponent(dep)}`);
        if (!alive || step.kind !== "track" || step.t.depositAddress !== dep) return;
        step = { kind: "track", t };
        draw();
      } catch {
        /* keep polling */
      }
      if (alive) schedulePoll();
    }, POLL_MS);
  }

  async function reload() {
    try {
      const [s, b, t] = await Promise.all([api<Session>("/api/me"), api<Balance[]>("/api/balances"), api<Token[]>("/api/tokens")]);
      if (!alive) return;
      session = s;
      balances = b;
      tokens = t;
      loadError = "";
      if (!balanceOf(form.origin)) form.origin = balances.length === 1 ? balances[0].tokenId : "";
    } catch (e) {
      if (!alive) return;
      loadError = msg(e);
    }
    draw();
  }

  void reload();
  return () => {
    alive = false;
    window.clearInterval(tick);
    window.clearTimeout(poll);
    if (step.kind === "register") step.reject(new Error("Cancelled"));
  };
}
