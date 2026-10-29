import { supportedChain } from "../../shared/address.ts";
import { erc191SignedData, nep413SignArgs, nep413SignedData, type Nep413Payload } from "../../shared/intent-sign.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { baseUnits } from "../../shared/units.ts";
import { api, postJson } from "../api.ts";
import {
  ensureWallet, NEAR_WALLETS, nearPublicKey, registerIntentsKey, signErc191, signNep413, walletConnected,
  type NearWalletId, type Session,
} from "../wallet/index.ts";

type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string };
type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };
type Withdrawal = {
  depositAddress: string; originSymbol: string; amountFormatted: string;
  destinationSymbol: string; destinationBlockchain: string; recipient: string;
  amountOutFormatted: string; minAmountOutFormatted: string;
  status: string; intentHash?: string; destinationTxHashes: string[]; deadline: string; expired: boolean; createdAt: string; refreshError?: string;
};
type Quote = { depositAddress: string; deadline: string; intent: { standard: "nep413" | "erc191"; payload: unknown }; withdrawal: Withdrawal };

const CHAINS: Record<string, string> = {
  near: "NEAR", eth: "Ethereum", arb: "Arbitrum", base: "Base", op: "Optimism", pol: "Polygon", bsc: "BNB Smart Chain",
  avax: "Avalanche", gnosis: "Gnosis", sol: "Solana", btc: "Bitcoin", tron: "Tron",
};
export const chainName = (c: string) => (CHAINS[c] ? `${CHAINS[c]} (${c})` : c);

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const EXPLORERS: Record<string, [RegExp, string]> = {
  near: [/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "https://nearblocks.io/txns/"],
  eth: [EVM_TX, "https://etherscan.io/tx/"], arb: [EVM_TX, "https://arbiscan.io/tx/"], base: [EVM_TX, "https://basescan.org/tx/"],
  op: [EVM_TX, "https://optimistic.etherscan.io/tx/"], pol: [EVM_TX, "https://polygonscan.com/tx/"], bsc: [EVM_TX, "https://bscscan.com/tx/"],
  avax: [EVM_TX, "https://snowtrace.io/tx/"], gnosis: [EVM_TX, "https://gnosisscan.io/tx/"],
  sol: [/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "https://solscan.io/tx/"], btc: [/^[0-9a-f]{64}$/, "https://mempool.space/tx/"],
  tron: [/^[0-9a-f]{64}$/, "https://tronscan.org/#/transaction/"],
};
export function explorerLinks(chain: string, hashes: string[]): string {
  const e = EXPLORERS[chain];
  return hashes
    .map((h) =>
      e && e[0].test(h)
        ? `<a href="${esc(e[1] + encodeURIComponent(h))}" target="_blank" rel="noopener noreferrer">View on explorer (${esc(h.slice(0, 10))}…)</a>`
        : `<code>${esc(h)}</code>`,
    )
    .join(" ");
}

const STATUS_TEXT: Record<string, string> = {
  AWAITING_SIGNATURE: "Not submitted",
  PENDING_DEPOSIT: "Submitted",
  KNOWN_DEPOSIT_TX: "Processing",
  INCOMPLETE_DEPOSIT: "Processing",
  PROCESSING: "Processing",
  SUCCESS: "Sent",
  REFUNDED: "Refunded to your NEAR Intents balance",
  FAILED: "Failed",
};
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const POLL_MS = 5_000;
const tokenLabel = (t: { symbol: string; blockchain: string }) => `${t.symbol} · ${chainName(t.blockchain)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Step =
  | { kind: "form" }
  | { kind: "review"; quote: Quote; confirmed: boolean }
  | { kind: "register"; quote: Quote; publicKey: string; resolve: () => void; reject: (e: Error) => void }
  | { kind: "track"; w: Withdrawal };

export function mountWithdraw(el: HTMLElement): () => void {
  let alive = true;
  let tick = 0;
  let poll = 0;
  let session: Session | null = null;
  let balances: Balance[] = [];
  let tokens: Token[] = [];
  let history: Withdrawal[] = [];
  let loadError = "";
  let error = "";
  let busy = "";
  let step: Step = { kind: "form" };
  const form = { origin: "", amount: "", search: "", dest: "", recipient: "" };
  let nearWallet: NearWalletId = "meteor-wallet";

  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const balanceOf = (id: string) => balances.find((b) => b.tokenId === id);
  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  function draw() {
    window.clearInterval(tick);
    const head = `<div class="heading"><div><p class="eyebrow">MOVE FUNDS</p><h1>Withdraw</h1><p class="muted">Send funds from your NEAR Intents balance to any supported chain or exchange address. You sign every withdrawal in your wallet.</p></div></div>`;
    let body: string;
    if (loadError) body = `<section class="panel"><p class="error" role="alert">${esc(loadError)}</p></section>`;
    else if (step.kind === "form") body = formHtml();
    else if (step.kind === "review") body = reviewHtml(step.quote, step.confirmed);
    else if (step.kind === "register") body = registerHtml(step.publicKey);
    else body = trackHtml(step.w);
    el.innerHTML = `${head}${body}${historyHtml()}`;
    wire();
  }

  function formHtml(): string {
    const b = balanceOf(form.origin);
    const s = form.search.trim().toLowerCase();
    const dests = tokens.filter((t) => supportedChain(t.blockchain) && (!s || tokenLabel(t).toLowerCase().includes(s) || t.blockchain.includes(s)));
    const d = tokenOf(form.dest);
    if (!balances.length)
      return `<section class="panel"><h2>Nothing to withdraw yet</h2><p class="muted">Your NEAR Intents balance is empty. Paid invoices land there.</p></section>`;
    return `<section class="panel"><form id="wd-form" novalidate>
<label>From your balance<select id="wd-origin"><option value="">Choose a balance</option>${balances
      .map((x) => `<option value="${esc(x.tokenId)}" ${x.tokenId === form.origin ? "selected" : ""}>${esc(x.formatted)} ${esc(x.symbol)} (${esc(chainName(x.blockchain))})</option>`)
      .join("")}</select></label>
<label>Amount${b ? ` (${esc(b.symbol)})` : ""}<span class="amountrow"><input id="wd-amount" inputmode="decimal" autocomplete="off" value="${esc(form.amount)}" ${b ? "" : "disabled"}><button class="textbutton" type="button" id="wd-max" ${b ? "" : "disabled"}>Max</button></span></label>
${b ? `<p class="fine">Available: ${esc(b.formatted)} ${esc(b.symbol)}</p>` : ""}
<label>Search destination token or chain<input id="wd-search" autocomplete="off" placeholder="e.g. USDC or arb" value="${esc(form.search)}"></label>
<label>Receive as<select id="wd-dest" size="6">${dests
      .map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === form.dest ? "selected" : ""}>${esc(tokenLabel(t))}</option>`)
      .join("")}</select></label>
<label>${d ? `Destination address on ${esc(chainName(d.blockchain))}` : "Destination address"}<input id="wd-recipient" autocomplete="off" spellcheck="false" value="${esc(form.recipient)}"></label>
<p class="fine">Exchange deposit address or your wallet; check the network matches.</p>
<p class="error" id="wd-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Review withdrawal"}</button></form></section>`;
  }

  function reviewHtml(qt: Quote, confirmed: boolean): string {
    const w = qt.withdrawal;
    const chain = chainName(w.destinationBlockchain);
    const needsNearWallet = session?.kind === "near" && !walletConnected(session);
    return `<section class="panel" id="wd-review"><div class="section-title"><h2>Review withdrawal</h2><span class="muted">Quote expires in <span id="wd-countdown">${countdown(qt.deadline)}</span></span></div>
<div class="pay-field"><span class="eyebrow">NETWORK</span><strong id="wd-network">${esc(chain)}</strong></div>
<div class="pay-field"><span class="eyebrow">DESTINATION ADDRESS</span><code id="wd-address">${esc(w.recipient)}</code></div>
<p class="invoice-total"><span>You send</span><strong id="wd-send">${esc(w.amountFormatted)} ${esc(w.originSymbol)}</strong></p>
<p class="invoice-total"><span>You receive</span><strong id="wd-receive">≈ ${esc(w.amountOutFormatted)} ${esc(w.destinationSymbol)}</strong></p>
<p class="fine" id="wd-min">Minimum received: ${esc(w.minAmountOutFormatted)} ${esc(w.destinationSymbol)} on ${esc(chain)}. Funds sent to a wrong address or network usually cannot be recovered.</p>
<label class="radio"><input type="checkbox" id="wd-confirm" ${confirmed ? "checked" : ""}> I confirm this address is on ${esc(chain)}</label>
${needsNearWallet ? `<label>Wallet<select id="wd-wallet">${NEAR_WALLETS.map((x) => `<option value="${x.id}" ${x.id === nearWallet ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
<p class="error" id="wd-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="wd-back" ${busy ? "disabled" : ""}>Back</button><button class="primary" type="button" id="wd-sign" ${confirmed && !busy ? "" : "disabled"}>${busy ? esc(busy) : "Sign in wallet"}</button></div></section>`;
  }

  function registerHtml(publicKey: string): string {
    return `<section class="panel" id="wd-register"><h2>One-time setup: register your wallet key</h2>
<p class="muted">NEAR Intents accepts signatures from a named NEAR account only after the account registers its key. Your wallet will ask you to approve a call to <code>intents.near</code> <code>add_public_key</code> (1 yoctoNEAR plus gas) for key <code>${esc(publicKey)}</code>. This does not move your balance.</p>
<p class="error" id="wd-error" role="alert">${esc(error)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="wd-reg-cancel" ${busy ? "disabled" : ""}>Cancel</button><button class="primary" type="button" id="wd-reg" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Approve key registration"}</button></div></section>`;
  }

  function trackHtml(w: Withdrawal): string {
    const chain = chainName(w.destinationBlockchain);
    const done = w.status === "SUCCESS";
    const text = STATUS_TEXT[w.status] ?? w.status;
    return `<section class="panel" id="wd-track"><h2>${done ? "Withdrawal sent" : esc(text)}</h2>
<p class="muted" role="status" id="wd-status">${esc(w.amountFormatted)} ${esc(w.originSymbol)} → ${esc(w.destinationSymbol)} to <code>${esc(w.recipient)}</code> on ${esc(chain)}: ${esc(text)}.</p>
${!TERMINAL.has(w.status) ? `<p class="fine">This usually takes a few minutes. You can leave this page; the status is kept in your withdrawal history.</p>` : ""}
${done && w.destinationTxHashes.length ? `<p id="wd-links">${explorerLinks(w.destinationBlockchain, w.destinationTxHashes)}</p>` : ""}
${w.refreshError ? `<p class="error" role="alert">${esc(w.refreshError)}</p>` : ""}
${TERMINAL.has(w.status) ? `<button class="primary" type="button" id="wd-new">New withdrawal</button>` : ""}</section>`;
  }

  function historyHtml(): string {
    if (!history.length) return "";
    return `<section class="panel" aria-labelledby="wd-history-title"><p class="eyebrow" id="wd-history-title">WITHDRAWAL HISTORY</p><div class="payment-list" id="wd-history">${history
      .map(
        (w) =>
          `<div class="payment-row"><span>${esc(new Date(w.createdAt).toLocaleString())}</span><span>${esc(w.amountFormatted)} ${esc(w.originSymbol)} → ${esc(w.destinationSymbol)} (${esc(chainName(w.destinationBlockchain))})</span><code title="${esc(w.recipient)}">${esc(w.recipient.length > 20 ? `${w.recipient.slice(0, 8)}…${w.recipient.slice(-6)}` : w.recipient)}</code><span class="pill">${esc(STATUS_TEXT[w.status] ?? w.status)}</span>${w.status === "SUCCESS" ? explorerLinks(w.destinationBlockchain, w.destinationTxHashes) : ""}</div>`,
      )
      .join("")}</div></section>`;
  }

  function setError(e: string) {
    error = e;
    const n = q("#wd-error");
    if (n) n.textContent = e;
  }

  function wire() {
    if (step.kind === "form") wireForm();
    else if (step.kind === "review") wireReview(step);
    else if (step.kind === "register") wireRegister(step);
    else if (step.kind === "track") {
      q<HTMLButtonElement>("#wd-new")?.addEventListener("click", () => {
        step = { kind: "form" };
        error = "";
        void reload();
      });
    }
  }

  function wireForm() {
    const f = q<HTMLFormElement>("#wd-form");
    if (!f) return;
    q<HTMLSelectElement>("#wd-origin")!.onchange = (e) => {
      form.origin = (e.target as HTMLSelectElement).value;
      form.amount = "";
      draw();
    };
    q<HTMLInputElement>("#wd-amount")!.oninput = (e) => (form.amount = (e.target as HTMLInputElement).value.trim());
    q<HTMLButtonElement>("#wd-max")!.onclick = () => {
      const b = balanceOf(form.origin);
      if (b) form.amount = b.formatted;
      draw();
    };
    const search = q<HTMLInputElement>("#wd-search")!;
    search.oninput = () => {
      form.search = search.value;
      const pos = search.selectionStart;
      draw();
      const s = q<HTMLInputElement>("#wd-search")!;
      s.focus();
      s.setSelectionRange(pos, pos);
    };
    q<HTMLSelectElement>("#wd-dest")!.onchange = (e) => {
      form.dest = (e.target as HTMLSelectElement).value;
      draw();
    };
    q<HTMLInputElement>("#wd-recipient")!.oninput = (e) => (form.recipient = (e.target as HTMLInputElement).value);
    f.onsubmit = (e) => {
      e.preventDefault();
      void requestQuote();
    };
  }

  async function requestQuote() {
    const b = balanceOf(form.origin);
    const d = tokenOf(form.dest);
    if (!b) return setError("Choose a balance to withdraw from.");
    let units: bigint;
    try {
      units = baseUnits(form.amount, b.decimals);
    } catch (e) {
      return setError(msg(e));
    }
    if (units > BigInt(b.amount)) return setError("Amount exceeds your balance");
    if (!d) return setError("Choose the token and network to receive.");
    if (!form.recipient.trim()) return setError(`Enter the destination address on ${chainName(d.blockchain)}.`);
    busy = "Getting quote…";
    error = "";
    draw();
    try {
      const quote = await postJson<Quote>("/api/withdrawals/quote", {
        originAsset: b.tokenId, amount: units.toString(), destinationAsset: d.assetId, recipient: form.recipient.trim(),
      });
      if (!alive) return;
      step = { kind: "review", quote, confirmed: false };
    } catch (e) {
      error = msg(e);
    }
    busy = "";
    if (alive) draw();
  }

  function wireReview(s: Extract<Step, { kind: "review" }>) {
    tick = window.setInterval(() => {
      const c = q("#wd-countdown");
      if (c) c.textContent = countdown(s.quote.deadline);
      if (new Date(s.quote.deadline).getTime() <= Date.now() && !busy) {
        step = { kind: "form" };
        error = "Quote expired, request a new one";
        draw();
      }
    }, 1000);
    const box = q<HTMLInputElement>("#wd-confirm")!;
    box.onchange = () => {
      s.confirmed = box.checked;
      q<HTMLButtonElement>("#wd-sign")!.disabled = !box.checked || !!busy;
    };
    const wsel = q<HTMLSelectElement>("#wd-wallet");
    if (wsel) wsel.onchange = () => (nearWallet = wsel.value as NearWalletId);
    q<HTMLButtonElement>("#wd-back")!.onclick = () => {
      step = { kind: "form" };
      error = "";
      draw();
    };
    q<HTMLButtonElement>("#wd-sign")!.onclick = () => {
      if (!s.confirmed) return;
      void sign(s.quote);
    };
  }

  /** Pause on the registration screen until the key is registered (or the user cancels). */
  async function ensureKey(quote: Quote, publicKey: string): Promise<void> {
    const st = await api<{ registered: boolean }>(`/api/withdrawals/key-status?publicKey=${encodeURIComponent(publicKey)}`);
    if (st.registered) return;
    await new Promise<void>((resolve, reject) => {
      busy = "";
      error = "";
      step = { kind: "register", quote, publicKey, resolve, reject };
      draw();
    });
  }

  function wireRegister(s: Extract<Step, { kind: "register" }>) {
    q<HTMLButtonElement>("#wd-reg-cancel")!.onclick = () => s.reject(new Error("Key registration cancelled. Nothing was sent."));
    q<HTMLButtonElement>("#wd-reg")!.onclick = async () => {
      busy = "Waiting for wallet…";
      error = "";
      draw();
      try {
        await registerIntentsKey(s.publicKey);
        const st = await api<{ registered: boolean }>(`/api/withdrawals/key-status?publicKey=${encodeURIComponent(s.publicKey)}`);
        busy = "";
        if (!st.registered) {
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
      await ensureWallet(session, nearWallet);
      let signedData: unknown;
      if (quote.intent.standard === "erc191") {
        if (typeof quote.intent.payload !== "string") throw new Error("Invalid intent payload.");
        signedData = erc191SignedData(quote.intent.payload, await signErc191(quote.intent.payload));
      } else {
        const payload = quote.intent.payload as Nep413Payload;
        // Register before signing when the wallet reports its key; otherwise check the key that signed.
        const known = await nearPublicKey();
        if (known) await ensureKey(quote, known);
        step = { kind: "review", quote, confirmed: true };
        busy = "Waiting for wallet…";
        draw();
        const signed = await signNep413(nep413SignArgs(payload));
        if (signed.publicKey !== known) {
          await ensureKey(quote, signed.publicKey);
          step = { kind: "review", quote, confirmed: true };
        }
        signedData = nep413SignedData(payload, signed);
      }
      busy = "Submitting…";
      if (alive) draw();
      const w = await postJson<Withdrawal>("/api/withdrawals/submit", { depositAddress: quote.depositAddress, signedData });
      if (!alive) return;
      busy = "";
      step = { kind: "track", w };
      history = [w, ...history.filter((h) => h.depositAddress !== w.depositAddress)];
      draw();
      schedulePoll();
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
    if (step.kind !== "track" || TERMINAL.has(step.w.status)) return;
    const dep = step.w.depositAddress;
    poll = window.setTimeout(async () => {
      try {
        const w = await api<Withdrawal>(`/api/withdrawals/${encodeURIComponent(dep)}`);
        if (!alive || step.kind !== "track" || step.w.depositAddress !== dep) return;
        step = { kind: "track", w };
        history = history.map((h) => (h.depositAddress === dep ? w : h));
        draw();
      } catch {
        /* keep polling */
      }
      if (alive) schedulePoll();
    }, POLL_MS);
  }

  async function reload() {
    try {
      const [s, b, t, h] = await Promise.all([
        api<Session>("/api/me"),
        api<Balance[]>("/api/balances"),
        api<Token[]>("/api/tokens"),
        api<Withdrawal[]>("/api/withdrawals"),
      ]);
      if (!alive) return;
      session = s;
      balances = b;
      tokens = t;
      history = h;
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
