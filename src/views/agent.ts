// Treasury agent: an inbox of suggestions computed by the server from the owner's rules, the rules editor and
// the recipient whitelist. The agent never moves funds: approving a suggestion requests a quote that the owner
// reviews and signs in their wallet, and every rule or whitelist change is signed as a message.
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import { mergeDraft, policyChanges } from "../../shared/policy-diff.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { baseUnits, formatAmount } from "../../shared/units.ts";
import { api, ApiError, postJson } from "../api.ts";
import { registerKey, signAndSubmit, type TransferView } from "../sign-flow.ts";
import { signPolicyChallenge, type PolicyChallenge, type Session } from "../wallet/index.ts";
import { daysUntil, type Bill } from "./bills.ts";
import { usdValue } from "./swap.ts";
import { countdown, msg } from "./transfer-ui.ts";
import { chainName } from "./withdraw.ts";

export type Proposal = {
  id: string; type: "convert" | "sweep" | "pay_bill" | "follow_up_invoice"; dedupKey: string; params: Record<string, string>;
  status: "proposed" | "executing" | "done" | "dismissed" | "expired"; depositAddress?: string; createdAt: string; updatedAt: string; expiresAt: string;
};
export type Policy = {
  version: 1;
  convert?: { enabled: boolean; targetTokenId: string; minUsdCents: number };
  sweep?: { enabled: boolean; tokenId: string; thresholdUnits: string; keepUnits: string; whitelistId: string };
  limits?: { perTx: Record<string, string>; daily: Record<string, string>; whitelistOnly: boolean };
  reminders?: { billDueDays: number; invoiceOverdueDays: number };
};
export type WhitelistEntry = { id: string; label: string; destinationAsset: string; recipientType: "DESTINATION_CHAIN" | "INTENTS"; recipient: string; createdAt: string };
type Balance = { tokenId: string; symbol: string; blockchain: string; decimals: number; amount: string; formatted: string; usd?: string };
type Token = { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number };
type InvoiceLite = { id: string; publicId: string; status: string; data: { number: string; client: string; dueDate: string } };
type Quote = { depositAddress: string; deadline: string; amountOutFormatted: string; intent: { standard: "nep413" | "erc191"; payload: unknown }; transfer: TransferView };

export type ReasonContext = {
  balances: Balance[]; tokens: Token[]; bills: Pick<Bill, "id" | "vendor" | "reference" | "dueDate" | "amountFormatted" | "symbol">[];
  invoices: InvoiceLite[]; whitelist: WhitelistEntry[]; policy: Policy | null; now?: Date;
};

type TokenInfo = { symbol: string; decimals: number; price?: number };
function tokenInfo(ctx: Pick<ReasonContext, "balances" | "tokens">, id: string): TokenInfo | undefined {
  const b = ctx.balances.find((x) => x.tokenId === id);
  const t = ctx.tokens.find((x) => x.assetId === id);
  const s = SETTLEMENT_TOKENS.find((x) => x.tokenId === id);
  if (b) return { symbol: b.symbol, decimals: b.decimals, price: t?.price };
  if (t) return { symbol: t.symbol, decimals: t.decimals, price: t.price };
  return s ? { symbol: s.symbol, decimals: s.decimals } : undefined;
}
const units = (amount: string, t: TokenInfo | undefined) => (t && /^\d+$/.test(amount) ? `${formatAmount(BigInt(amount), t.decimals)} ${t.symbol}` : "an amount of an unknown token");

/** Plain-language reason for a suggestion, computed from its params and the owner's own data (plain text, escape when rendering). */
export function proposalReason(p: Pick<Proposal, "type" | "params">, ctx: ReasonContext): string {
  const x = p.params;
  if (p.type === "convert") {
    const o = tokenInfo(ctx, x.originAsset), d = tokenInfo(ctx, x.destinationAsset);
    const held = ctx.balances.find((b) => b.tokenId === x.originAsset);
    const usd = held && held.amount === x.amount && held.usd ? held.usd : o && /^\d+$/.test(x.amount) ? usdValue(BigInt(x.amount), o.decimals, o.price) : undefined;
    return `Convert ${units(x.amount, o)} → ${d?.symbol ?? "a stablecoin"}${usd ? ` (≈ $${usd} reference price)` : ""}`;
  }
  if (p.type === "sweep") {
    const t = tokenInfo(ctx, x.originAsset);
    const to = ctx.whitelist.find((w) => w.id === x.whitelistId)?.label ?? "your whitelisted address";
    const keep = ctx.policy?.sweep?.tokenId === x.originAsset ? ctx.policy.sweep.keepUnits : undefined;
    if (x.limitedByCap === "true") return `Sweep ${units(x.amount, t)} to ${to} (limited by your per-transaction cap)`;
    return `Sweep ${units(x.amount, t)} to ${to}${keep !== undefined ? ` (keeps ${units(keep, t)})` : ""}`;
  }
  if (p.type === "pay_bill") {
    const b = ctx.bills.find((y) => y.id === x.billId);
    return b ? `Pay bill ${b.reference || "without reference"} to ${b.vendor} (due ${b.dueDate})` : "Pay a scheduled bill";
  }
  const inv = ctx.invoices.find((i) => i.id === x.invoiceId);
  if (!inv) return "An invoice is overdue — send the pay link";
  const late = -daysUntil(inv.data.dueDate, ctx.now ?? new Date());
  return `Invoice ${inv.data.number || "without number"} is ${late} ${late === 1 ? "day" : "days"} overdue — send the pay link`;
}

/** "12.34" → 1234; undefined if not a dollar amount with at most two decimals. */
export function dollarsToCents(s: string): number | undefined {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : undefined;
}
const centsToDollars = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

const STATUS_TEXT: Record<string, string> = {
  AWAITING_SIGNATURE: "Not submitted", PENDING_DEPOSIT: "Submitted", KNOWN_DEPOSIT_TX: "Processing", INCOMPLETE_DEPOSIT: "Processing",
  PROCESSING: "Processing", SUCCESS: "Done", REFUNDED: "Refunded to your NEAR Intents balance", FAILED: "Failed",
};
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const POLL_MS = 5_000;
const MAX_OPTIONS = 100;

type Flow =
  | { kind: "none" }
  | { kind: "review"; p: Proposal; quote: Quote }
  | { kind: "register"; p: Proposal; quote: Quote; publicKey: string; resolve: () => void; reject: (e: Error) => void }
  | { kind: "track"; p: Proposal; t: TransferView }
  | { kind: "followup"; p: Proposal; payUrl: string };
type SignStep = { where: "rules" | "whitelist"; title: string; challenge: PolicyChallenge; /** Pre-escaped HTML shown above the message. */ intro?: string; submit: (signed: { nonce: string; signature: string; publicKey?: string }) => Promise<void> };

export function mountAgent(el: HTMLElement): () => void {
  let alive = true;
  let tick = 0, poll = 0;
  let session: Session | null = null;
  let proposals: Proposal[] = [];
  let policy: Policy | null = null;
  /** An AI draft shown in the Rules form for review. Never saved until the owner signs it like any other edit. */
  let draft: Policy | null = null;
  let aiConfigured = false;
  let aiSummary: { text: string } | { error: string } | "loading" | null = null;
  let draftState: { busy: boolean; error: string; notes: string } = { busy: false, error: "", notes: "" };
  let draftText = "";
  let whitelist: WhitelistEntry[] = [];
  let balances: Balance[] = [];
  let tokens: Token[] = [];
  let bills: Bill[] = [];
  let invoices: InvoiceLite[] = [];
  let flow: Flow = { kind: "none" };
  let signStep: SignStep | null = null;
  let inboxError = "", rulesError = "", wlError = "", rulesNote = "", wlNote = "";
  let busy = "";
  const payFrom = new Map<string, string>();
  const wlForm = { label: "", search: "", dest: "", type: "DESTINATION_CHAIN" as WhitelistEntry["recipientType"], recipient: "" };

  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const ctx = (): ReasonContext => ({ balances, tokens, bills, invoices, whitelist, policy });
  const info = (id: string) => tokenInfo({ balances, tokens }, id);
  const label = (id: string) => {
    const t = tokens.find((x) => x.assetId === id);
    const i = info(id);
    return t ? `${t.symbol} · ${chainName(t.blockchain)}` : i ? i.symbol : id;
  };
  /** Tokens offered for rules and caps: the owner's balances, the settlement tokens and any already in the policy. */
  const ruleTokens = (): string[] => {
    const ids = new Set<string>([...SETTLEMENT_TOKENS.map((t) => t.tokenId), ...balances.map((b) => b.tokenId)]);
    const cur = draft ?? policy;
    if (cur?.sweep) ids.add(cur.sweep.tokenId);
    for (const k of Object.keys(cur?.limits?.perTx ?? {})) ids.add(k);
    for (const k of Object.keys(cur?.limits?.daily ?? {})) ids.add(k);
    return [...ids];
  };

  el.innerHTML = `<div class="heading"><div><p class="eyebrow">TREASURY</p><h1>Agent</h1><p class="muted">The agent suggests actions from your rules. It never moves funds on its own: you review each suggestion and sign it in your wallet.</p></div><div class="home-actions"><button class="secondary" type="button" id="ag-run">Run agent now</button></div></div>
<section class="panel" aria-labelledby="ag-inbox-title"><div class="section-title"><h2 id="ag-inbox-title">Inbox</h2></div><div id="ag-inbox"><p class="muted" role="status">Loading…</p></div></section>
<section class="panel" aria-labelledby="ag-ai-title"><div class="section-title"><h2 id="ag-ai-title">AI summary · NEAR AI Cloud</h2><button class="secondary" type="button" id="ag-ai-refresh" hidden>Refresh</button></div><div id="ag-ai-summary"></div></section>
<section class="panel" aria-labelledby="ag-rules-title"><h2 id="ag-rules-title">Rules</h2><p class="muted">Changing your rules or limits needs a signature from your wallet. Signing a message does not send a transaction.</p><div id="ag-ai-draft"></div><div id="ag-rules"><p class="muted">Loading…</p></div><div id="ag-rules-sign"></div></section>
<section class="panel" aria-labelledby="ag-wl-title"><h2 id="ag-wl-title">Whitelist</h2><p class="muted">Addresses the agent may sweep to, and the only recipients allowed when "whitelisted recipients only" is on. Each change is signed in your wallet.</p><div id="ag-wl"><p class="muted">Loading…</p></div><div id="ag-wl-sign"></div></section>`;

  // --- inbox ---

  function drawInbox() {
    window.clearInterval(tick);
    const box = q("#ag-inbox")!;
    if (flow.kind === "review") box.innerHTML = reviewHtml(flow.p, flow.quote);
    else if (flow.kind === "register") box.innerHTML = registerHtml(flow.publicKey);
    else if (flow.kind === "track") box.innerHTML = trackHtml(flow.p, flow.t);
    else if (flow.kind === "followup") box.innerHTML = followHtml(flow.p, flow.payUrl);
    else box.innerHTML = listHtml();
    wireInbox();
  }

  function listHtml(): string {
    const err = `<p class="error" id="ag-inbox-error" role="alert">${esc(inboxError)}</p>`;
    if (!policy) return `${err}<p class="empty">No rules yet. Set up your rules below and the agent will suggest actions here.</p>`;
    if (!proposals.length) return `${err}<p class="empty">No suggestions right now.</p>`;
    return `${err}<div class="agent-list">${proposals.map(cardHtml).join("")}</div>`;
  }

  function cardHtml(p: Proposal): string {
    const reason = esc(proposalReason(p, ctx()));
    const id = esc(p.id);
    if (p.status === "executing")
      return `<article class="agent-card" data-proposal="${id}"><p class="agent-reason">${reason}</p><p class="fine"><span class="badge">In progress</span> Waiting for your signature or for NEAR Intents to finish. Unsigned quotes expire after a few minutes and the suggestion comes back.</p></article>`;
    let extra = "";
    if (p.type === "pay_bill") {
      const b = bills.find((x) => x.id === p.params.billId);
      const sel = payFrom.get(p.id) ?? (balances.find((x) => b && x.symbol === b.symbol) ?? balances[0])?.tokenId ?? "";
      payFrom.set(p.id, sel);
      extra = `${b ? `<p class="fine">Amount: ${esc(b.amountFormatted)} ${esc(b.symbol)}</p>` : ""}<label>Pay from<select class="ag-payfrom" data-proposal="${id}">${balances
        .map((x) => `<option value="${esc(x.tokenId)}" ${x.tokenId === sel ? "selected" : ""}>${esc(x.formatted)} ${esc(x.symbol)} (${esc(chainName(x.blockchain))})</option>`)
        .join("")}</select></label>`;
    }
    const approve = p.type === "follow_up_invoice" ? "Get pay link" : "Approve";
    return `<article class="agent-card" data-proposal="${id}"><p class="agent-reason">${reason}</p>${extra}<div class="invoice-actions"><button class="textbutton ag-dismiss" type="button" data-proposal="${id}" ${busy ? "disabled" : ""}>Dismiss</button><button class="primary ag-approve" type="button" data-proposal="${id}" ${busy ? "disabled" : ""}>${approve}</button></div></article>`;
  }

  function reviewHtml(p: Proposal, qt: Quote): string {
    const t = qt.transfer;
    const where = t.kind === "swap" ? "The converted tokens stay in your NEAR Intents account." : `Sends to ${esc(t.recipient)} on ${esc(chainName(t.destinationBlockchain))}.`;
    return `<div id="ag-review"><p class="agent-reason">${esc(proposalReason(p, ctx()))}</p><div class="section-title"><h3>Review</h3><span class="muted">Quote expires in <span id="ag-countdown">${countdown(qt.deadline)}</span></span></div>
<p class="invoice-total"><span>You send</span><strong id="ag-send">${esc(t.amountFormatted)} ${esc(t.originSymbol)}</strong></p>
<p class="invoice-total"><span>${t.kind === "swap" ? "You receive" : "Recipient gets"}</span><strong id="ag-receive">≈ ${esc(qt.amountOutFormatted)} ${esc(t.destinationSymbol)}</strong></p>
<p class="fine" id="ag-min">Minimum: ${esc(t.minAmountOutFormatted)} ${esc(t.destinationSymbol)}. If the price moves further than the slippage, the transfer is refunded to your NEAR Intents balance.</p>
<p class="fine">${where}</p>
<p class="error" id="ag-flow-error" role="alert">${esc(inboxError)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="ag-back" ${busy ? "disabled" : ""}>Back</button><button class="primary" type="button" id="ag-sign" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Sign in wallet"}</button></div></div>`;
  }

  function registerHtml(publicKey: string): string {
    return `<div id="ag-register"><h3>One-time setup: register your wallet key</h3>
<p class="muted">NEAR Intents accepts signatures from a named NEAR account only after the account registers its key. Your wallet will ask you to approve a call to <code>intents.near</code> <code>add_public_key</code> for key <code>${esc(publicKey)}</code>. This does not move your balance.</p>
<p class="error" id="ag-flow-error" role="alert">${esc(inboxError)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="ag-reg-cancel" ${busy ? "disabled" : ""}>Cancel</button><button class="primary" type="button" id="ag-reg" ${busy ? "disabled" : ""}>${busy ? esc(busy) : "Approve key registration"}</button></div></div>`;
  }

  function trackHtml(p: Proposal, t: TransferView): string {
    const text = STATUS_TEXT[t.status] ?? t.status;
    return `<div id="ag-track"><p class="agent-reason">${esc(proposalReason(p, ctx()))}</p><h3 id="ag-track-status" role="status">${esc(text)}</h3>
<p class="muted">${esc(t.amountFormatted)} ${esc(t.originSymbol)} → ${esc(t.destinationSymbol)}</p>
${!TERMINAL.has(t.status) ? `<p class="fine">This usually takes a few minutes. You can leave this page.</p>` : ""}
${t.refreshError ? `<p class="error" role="alert">${esc(t.refreshError)}</p>` : ""}
<button class="secondary" type="button" id="ag-done">Back to inbox</button></div>`;
  }

  function followHtml(p: Proposal, payUrl: string): string {
    return `<div id="ag-follow"><p class="agent-reason">${esc(proposalReason(p, ctx()))}</p><p class="muted">Send this pay link to your client. The suggestion is marked as followed up.</p>
<p><code id="ag-pay-url">${esc(payUrl)}</code></p><div class="invoice-actions"><button class="textbutton" type="button" id="ag-copy">Copy link</button><button class="secondary" type="button" id="ag-done">Back to inbox</button></div></div>`;
  }

  function setInboxError(e: string) {
    inboxError = e;
    const n = q("#ag-flow-error") ?? q("#ag-inbox-error");
    if (n) n.textContent = e;
  }

  function wireInbox() {
    const byId = (id: string | undefined) => proposals.find((p) => p.id === id);
    el.querySelectorAll<HTMLButtonElement>(".ag-approve").forEach((b) => (b.onclick = () => { const p = byId(b.dataset.proposal); if (p) void approve(p); }));
    el.querySelectorAll<HTMLButtonElement>(".ag-dismiss").forEach((b) => (b.onclick = () => { const p = byId(b.dataset.proposal); if (p) void dismiss(p); }));
    el.querySelectorAll<HTMLSelectElement>(".ag-payfrom").forEach((s) => (s.onchange = () => payFrom.set(s.dataset.proposal ?? "", s.value)));
    q<HTMLButtonElement>("#ag-done")?.addEventListener("click", () => {
      flow = { kind: "none" };
      inboxError = "";
      void loadProposals(false);
    });
    q<HTMLButtonElement>("#ag-copy")?.addEventListener("click", () => {
      if (flow.kind === "followup") void navigator.clipboard?.writeText(flow.payUrl).catch(() => {});
    });
    if (flow.kind === "review") {
      const f = flow;
      tick = window.setInterval(() => {
        const c = q("#ag-countdown");
        if (c) c.textContent = countdown(f.quote.deadline);
        if (new Date(f.quote.deadline).getTime() <= Date.now() && !busy) {
          flow = { kind: "none" };
          inboxError = "Quote expired. Approve again for a new one.";
          void loadProposals(false);
        }
      }, 1000);
      q<HTMLButtonElement>("#ag-back")!.onclick = () => {
        flow = { kind: "none" };
        inboxError = "";
        void loadProposals(false);
      };
      q<HTMLButtonElement>("#ag-sign")!.onclick = () => void sign(f.p, f.quote);
    }
    if (flow.kind === "register") {
      const f = flow;
      q<HTMLButtonElement>("#ag-reg-cancel")!.onclick = () => f.reject(new Error("Key registration cancelled. Nothing was sent."));
      q<HTMLButtonElement>("#ag-reg")!.onclick = async () => {
        busy = "Waiting for wallet…";
        inboxError = "";
        drawInbox();
        try {
          const ok = await registerKey(f.publicKey);
          busy = "";
          if (!ok) {
            inboxError = "The key is not registered yet. Wait a few seconds and approve again.";
            drawInbox();
            return;
          }
          f.resolve();
        } catch (e) {
          busy = "";
          inboxError = msg(e);
          if (alive) drawInbox();
        }
      };
    }
  }

  async function approve(p: Proposal) {
    busy = "Getting quote…";
    inboxError = "";
    drawInbox();
    try {
      const body = p.type === "pay_bill" ? { originAsset: payFrom.get(p.id) } : {};
      const out = await postJson<Quote | { followUp: { payUrl: string } }>(`/api/agent/proposals/${encodeURIComponent(p.id)}/approve`, body);
      if (!alive) return;
      busy = "";
      flow = "followUp" in out ? { kind: "followup", p, payUrl: out.followUp.payUrl } : { kind: "review", p, quote: out };
      drawInbox();
    } catch (e) {
      if (!alive) return;
      busy = "";
      inboxError = msg(e);
      // An out-of-date suggestion is gone: refresh the list (the error stays visible).
      if (e instanceof ApiError && e.status === 409) await loadProposals(false, true);
      else drawInbox();
    }
  }

  async function dismiss(p: Proposal) {
    busy = "…";
    inboxError = "";
    drawInbox();
    try {
      await postJson(`/api/agent/proposals/${encodeURIComponent(p.id)}/dismiss`, {});
      proposals = proposals.filter((x) => x.id !== p.id);
    } catch (e) {
      inboxError = msg(e);
    }
    busy = "";
    if (alive) drawInbox();
  }

  async function sign(p: Proposal, quote: Quote) {
    if (!session) return;
    busy = "Waiting for wallet…";
    inboxError = "";
    drawInbox();
    try {
      const t = await signAndSubmit<TransferView>(
        quote, session,
        (st) => {
          if (st === "key" || !alive) return;
          flow = { kind: "review", p, quote };
          busy = st === "sign" ? "Waiting for wallet…" : "Submitting…";
          drawInbox();
        },
        {
          confirmKeyRegistration: (publicKey) =>
            new Promise<void>((resolve, reject) => {
              busy = "";
              inboxError = "";
              flow = { kind: "register", p, quote, publicKey, resolve, reject };
              drawInbox();
            }),
        },
      );
      if (!alive) return;
      busy = "";
      flow = { kind: "track", p, t };
      drawInbox();
      schedulePoll();
    } catch (e) {
      if (!alive) return;
      busy = "";
      inboxError = msg(e);
      flow = { kind: "review", p, quote };
      drawInbox();
    }
  }

  function schedulePoll() {
    window.clearTimeout(poll);
    if (flow.kind !== "track" || TERMINAL.has(flow.t.status)) return;
    const dep = flow.t.depositAddress;
    poll = window.setTimeout(async () => {
      try {
        const t = await api<TransferView>(`/api/transfers/${encodeURIComponent(dep)}`);
        if (!alive || flow.kind !== "track" || flow.t.depositAddress !== dep) return;
        flow = { kind: "track", p: flow.p, t };
        drawInbox();
      } catch {
        /* keep polling */
      }
      if (alive) schedulePoll();
    }, POLL_MS);
  }

  async function loadProposals(force: boolean, keepError = false) {
    try {
      const list = await api<Proposal[]>(`/api/agent/proposals${force ? "?force=1" : ""}`);
      if (!alive) return;
      proposals = list;
      if (!keepError) inboxError = "";
    } catch (e) {
      if (!alive) return;
      inboxError = msg(e);
    }
    if (flow.kind === "none") drawInbox();
  }

  q<HTMLButtonElement>("#ag-run")!.onclick = async () => {
    const b = q<HTMLButtonElement>("#ag-run")!;
    b.disabled = true;
    flow = { kind: "none" };
    await loadProposals(true);
    b.disabled = false;
  };

  // --- signed changes (rules and whitelist) ---

  function signHtml(s: SignStep): string {
    return `<div class="sign-step" id="ag-sign-step"><h3>${esc(s.title)}</h3><p class="muted">Your wallet will ask you to sign this message. It authorizes this change only and does not send a transaction or move funds.</p>
${s.intro ?? ""}<pre class="sign-message" id="ag-sign-message">${esc(s.challenge.message)}</pre>
<p class="error" id="ag-sign-error" role="alert"></p>
<div class="invoice-actions"><button class="textbutton" type="button" id="ag-sign-cancel">Cancel</button><button class="primary" type="button" id="ag-sign-go">Sign in wallet</button></div></div>`;
  }

  function drawSign() {
    q("#ag-rules-sign")!.innerHTML = signStep?.where === "rules" ? signHtml(signStep) : "";
    q("#ag-wl-sign")!.innerHTML = signStep?.where === "whitelist" ? signHtml(signStep) : "";
    if (!signStep) return;
    const s = signStep;
    q<HTMLButtonElement>("#ag-sign-cancel")!.onclick = () => {
      signStep = null;
      drawSign();
    };
    const go = q<HTMLButtonElement>("#ag-sign-go")!;
    go.onclick = async () => {
      if (!session) return;
      go.disabled = true;
      go.textContent = "Waiting for wallet…";
      try {
        const signed = await signPolicyChallenge(session, s.challenge);
        go.textContent = "Saving…";
        await s.submit(signed);
        if (!alive) return;
        signStep = null;
        drawSign();
      } catch (e) {
        if (!alive) return;
        go.disabled = false;
        go.textContent = "Sign in wallet";
        const n = q("#ag-sign-error");
        if (n) n.textContent = msg(e);
      }
    };
    q("#ag-sign-step")?.scrollIntoView?.({ block: "nearest" });
  }

  async function startChange(where: SignStep["where"], title: string, action: unknown, submit: SignStep["submit"], intro?: string) {
    if (where === "rules") rulesError = rulesNote = "";
    else wlError = wlNote = "";
    try {
      const challenge = await postJson<PolicyChallenge>("/api/agent/policy/challenge", action);
      if (!alive) return;
      signStep = { where, title, challenge, submit, ...(intro ? { intro } : {}) };
      drawSign();
    } catch (e) {
      if (where === "rules") rulesError = msg(e);
      else wlError = msg(e);
      if (where === "rules") setText("#ag-rules-error", rulesError);
      else setText("#ag-wl-error", wlError);
    }
  }
  const setText = (sel: string, t: string) => {
    const n = q(sel);
    if (n) n.textContent = t;
  };

  // --- AI (optional; every result is escaped text, a draft only fills the form and is never saved by itself) ---

  function drawAiDraft() {
    const box = q("#ag-ai-draft");
    if (!box) return;
    if (!aiConfigured) {
      box.innerHTML = `<p class="fine muted">AI features are not configured.</p>`;
      return;
    }
    const d = draftState;
    box.innerHTML = `<form id="ag-ai-form" novalidate><label for="ag-ai-text">Describe your rules</label>
<textarea id="ag-ai-text" rows="3" maxlength="1000" placeholder="e.g. Convert anything worth over $50 to USDC and remind me about bills 3 days early">${esc(draftText)}</textarea>
<button class="secondary" type="submit" ${d.busy ? "disabled" : ""}>${d.busy ? "Drafting…" : "Draft rules"}</button></form>
<p class="error" role="alert">${esc(d.error)}</p>${d.notes ? `<p class="fine" role="status">${esc(d.notes)} Review and sign to save.</p>` : ""}`;
    const ta = q<HTMLTextAreaElement>("#ag-ai-text")!;
    ta.oninput = () => (draftText = ta.value);
    q<HTMLFormElement>("#ag-ai-form")!.onsubmit = (e) => {
      e.preventDefault();
      void requestDraft();
    };
  }

  async function requestDraft() {
    draftText = q<HTMLTextAreaElement>("#ag-ai-text")!.value;
    draftState = { busy: true, error: "", notes: "" };
    drawAiDraft();
    try {
      const out = await postJson<{ policy: Policy; notes?: string }>("/api/agent/policy/draft", { text: draftText });
      if (!alive) return;
      // The draft only carries the sections the owner asked to change; every other saved section is kept.
      draft = mergeDraft(policy, out.policy);
      // The model's notes are untrusted text: labelled as the AI's and always escaped when drawn.
      draftState = { busy: false, error: "", notes: out.notes ? `AI note: ${out.notes}` : "Draft loaded into the rules below." };
      rulesError = "";
      rulesNote = "AI draft loaded. Review it, then save and sign.";
      drawRules();
    } catch (err) {
      if (!alive) return;
      draftState = { busy: false, error: msg(err), notes: "" };
    }
    drawAiDraft();
  }

  function drawAiSummary() {
    const box = q("#ag-ai-summary");
    const btn = q<HTMLButtonElement>("#ag-ai-refresh");
    if (!box || !btn) return;
    btn.hidden = !aiConfigured;
    if (!aiConfigured) {
      box.innerHTML = `<p class="fine muted">AI features are not configured.</p>`;
      return;
    }
    box.innerHTML =
      aiSummary === "loading" || aiSummary === null
        ? `<p class="muted" role="status">Summarising…</p>`
        : "error" in aiSummary
          ? `<p class="muted" role="status">${esc(aiSummary.error)}</p>`
          : `<p>${esc(aiSummary.text)}</p><p class="fine muted">Written by an AI from totals only. Check the numbers above.</p>`;
    btn.disabled = aiSummary === "loading";
  }

  async function loadSummary(refresh: boolean) {
    aiSummary = "loading";
    drawAiSummary();
    try {
      const out = await api<{ text: string }>(`/api/agent/summary${refresh ? "?refresh=1" : ""}`);
      if (alive) aiSummary = { text: out.text };
    } catch (err) {
      if (alive) aiSummary = { error: msg(err) };
    }
    if (alive) drawAiSummary();
  }
  q<HTMLButtonElement>("#ag-ai-refresh")!.onclick = () => void loadSummary(true);

  async function loadAi() {
    try {
      aiConfigured = (await api<{ configured: boolean }>("/api/agent/ai-status")).configured === true;
    } catch {
      aiConfigured = false;
    }
    if (!alive) return;
    drawAiDraft();
    drawAiSummary();
    if (aiConfigured) void loadSummary(false);
  }

  // --- rules ---

  function amountField(id: string, units: string | undefined, tokenId: string | undefined): string {
    const t = tokenId ? info(tokenId) : undefined;
    const v = units && t ? formatAmount(BigInt(units), t.decimals) : "";
    return `<input id="${id}" inputmode="decimal" autocomplete="off" value="${esc(v)}">`;
  }

  function drawRules() {
    const p = draft ?? policy;
    const c = p?.convert, s = p?.sweep, l = p?.limits, r = p?.reminders;
    const opts = (ids: string[], sel: string | undefined) => ids.map((id) => `<option value="${esc(id)}" ${id === sel ? "selected" : ""}>${esc(label(id))}</option>`).join("");
    const capRows = ruleTokens()
      .map((id) => {
        const t = info(id);
        const v = (rec: Record<string, string> | undefined) => (rec && Object.hasOwn(rec, id) && t ? formatAmount(BigInt(rec[id]), t.decimals) : "");
        return `<tr><th scope="row">${esc(label(id))}</th><td><input class="ag-cap-tx" data-token="${esc(id)}" inputmode="decimal" aria-label="Per-transaction limit for ${esc(label(id))}" value="${esc(v(l?.perTx))}"></td><td><input class="ag-cap-day" data-token="${esc(id)}" inputmode="decimal" aria-label="24-hour limit for ${esc(label(id))}" value="${esc(v(l?.daily))}"></td></tr>`;
      })
      .join("");
    q("#ag-rules")!.innerHTML = `<form id="ag-rules-form" novalidate>
<fieldset><legend>Convert to a stablecoin</legend>
<label class="radio"><input type="checkbox" id="ag-convert-on" ${c?.enabled ? "checked" : ""}> Suggest converting other tokens (only those with a reference price)</label>
<label>Convert to<select id="ag-convert-target">${opts(SETTLEMENT_TOKENS.map((t) => t.tokenId), c?.targetTokenId)}</select></label>
<label>Only when worth at least (USD)<input id="ag-convert-min" inputmode="decimal" value="${esc(centsToDollars(c?.minUsdCents ?? 1000))}"></label></fieldset>
<fieldset><legend>Sweep to a whitelisted address</legend>
<label class="radio"><input type="checkbox" id="ag-sweep-on" ${s?.enabled ? "checked" : ""}> Suggest sweeping the excess above a threshold</label>
<label>Token<select id="ag-sweep-token">${opts(ruleTokens(), s?.tokenId)}</select></label>
<label>When the balance is above${amountField("ag-sweep-threshold", s?.thresholdUnits, s?.tokenId)}</label>
<label>Keep${amountField("ag-sweep-keep", s?.keepUnits, s?.tokenId)}</label>
<label>Send to<select id="ag-sweep-to"><option value="">Choose a whitelisted address</option>${whitelist.map((w) => `<option value="${esc(w.id)}" ${w.id === s?.whitelistId ? "selected" : ""}>${esc(w.label)}</option>`).join("")}</select></label></fieldset>
<fieldset><legend>Reminders</legend>
<label class="radio"><input type="checkbox" id="ag-remind-on" ${r ? "checked" : ""}> Suggest paying bills and following up on overdue invoices</label>
<label>Bills due within (days, 0–30)<input id="ag-bill-days" inputmode="numeric" value="${r?.billDueDays ?? 3}"></label>
<label>Invoices overdue by at least (days, 0–90)<input id="ag-invoice-days" inputmode="numeric" value="${r?.invoiceOverdueDays ?? 7}"></label></fieldset>
<fieldset><legend>Spending limits</legend><p class="fine">Apply to every withdrawal, bill and payroll payment (not to swaps inside your account). Leave blank for no limit.</p>
<div class="table-scroll"><table class="ag-caps"><thead><tr><th scope="col">Token</th><th scope="col">Per transaction</th><th scope="col">Per 24 hours</th></tr></thead><tbody>${capRows}</tbody></table></div>
<label class="radio"><input type="checkbox" id="ag-wl-only" ${l?.whitelistOnly ? "checked" : ""}> Whitelisted recipients only (withdrawals, manual bills, payroll)</label></fieldset>
<p class="error" id="ag-rules-error" role="alert">${esc(rulesError)}</p><p class="fine" id="ag-rules-note" role="status">${esc(rulesNote)}</p>
<div class="invoice-actions"><button class="textbutton" type="button" id="ag-rules-discard" ${draft ? "" : "hidden"}>Discard draft</button><button class="primary" type="submit">Save rules</button></div></form>`;
    const form = q<HTMLFormElement>("#ag-rules-form")!;
    const discard = q<HTMLButtonElement>("#ag-rules-discard")!;
    // Any unsaved edit (or a loaded AI draft) can be thrown away; the form then shows the saved policy again.
    form.oninput = form.onchange = () => (discard.hidden = false);
    discard.onclick = () => {
      draft = null;
      draftState.notes = "";
      rulesError = "";
      rulesNote = "Draft discarded. These are your saved rules.";
      if (signStep?.where === "rules") {
        signStep = null;
        drawSign();
      }
      drawAiDraft();
      drawRules();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      let next: Policy;
      try {
        next = readRules();
      } catch (err) {
        rulesError = msg(err);
        setText("#ag-rules-error", rulesError);
        return;
      }
      // What this change does to the saved rules, with a warning for anything it removes or loosens.
      const diff = policyChanges(policy, next);
      const intro = (diff.changed.length ? `<p class="fine" id="ag-sign-changes">${draft ? "This draft changes" : "This changes"}: ${esc(diff.changed.join(", "))}</p>` : "")
        + (diff.loosened.length ? `<div class="sign-warning" id="ag-sign-loosened" role="alert">${diff.loosened.map((w) => `<p>⚠ ${esc(w)}</p>`).join("")}</div>` : "");
      void startChange("rules", "Sign your new rules", { kind: "policy", policy: next }, async (signed) => {
        const saved = await api<{ policy: Policy }>("/api/agent/policy", { method: "PUT", body: JSON.stringify({ policy: next, ...signed }) });
        policy = saved.policy;
        draft = null;
        draftState.notes = "";
        drawAiDraft();
        rulesNote = "Rules saved.";
        drawRules();
        void loadProposals(true);
      }, intro);
    };
  }

  function readRules(): Policy {
    const val = (id: string) => q<HTMLInputElement>(`#${id}`)!.value.trim();
    const on = (id: string) => q<HTMLInputElement>(`#${id}`)!.checked;
    const toUnits = (v: string, tokenId: string, what: string) => {
      const t = info(tokenId);
      if (!t) throw new Error(`Unknown token for ${what}.`);
      try {
        return baseUnits(v, t.decimals).toString();
      } catch {
        throw new Error(`Enter a valid amount for ${what}.`);
      }
    };
    const days = (v: string, max: number, what: string) => {
      if (!/^\d{1,2}$/.test(v) || Number(v) > max) throw new Error(`${what} must be a whole number from 0 to ${max}.`);
      return Number(v);
    };
    const out: Policy = { version: 1 };
    if (on("ag-convert-on")) {
      const cents = dollarsToCents(val("ag-convert-min"));
      if (cents === undefined) throw new Error("Enter the minimum in dollars, e.g. 10.00.");
      out.convert = { enabled: true, targetTokenId: q<HTMLSelectElement>("#ag-convert-target")!.value, minUsdCents: cents };
    }
    if (on("ag-sweep-on")) {
      const tokenId = q<HTMLSelectElement>("#ag-sweep-token")!.value;
      const whitelistId = q<HTMLSelectElement>("#ag-sweep-to")!.value;
      if (!whitelistId) throw new Error("Choose a whitelisted address to sweep to.");
      const thresholdUnits = toUnits(val("ag-sweep-threshold"), tokenId, "the sweep threshold");
      const keepUnits = val("ag-sweep-keep") ? toUnits(val("ag-sweep-keep"), tokenId, "the amount to keep") : "0";
      if (BigInt(keepUnits) >= BigInt(thresholdUnits)) throw new Error("The amount to keep must be below the sweep threshold.");
      out.sweep = { enabled: true, tokenId, thresholdUnits, keepUnits, whitelistId };
    }
    if (on("ag-remind-on")) out.reminders = { billDueDays: days(val("ag-bill-days"), 30, "Bill reminder days"), invoiceOverdueDays: days(val("ag-invoice-days"), 90, "Invoice reminder days") };
    const perTx: Record<string, string> = {}, daily: Record<string, string> = {};
    el.querySelectorAll<HTMLInputElement>(".ag-cap-tx").forEach((i) => { if (i.value.trim()) perTx[i.dataset.token!] = toUnits(i.value.trim(), i.dataset.token!, "a per-transaction limit"); });
    el.querySelectorAll<HTMLInputElement>(".ag-cap-day").forEach((i) => { if (i.value.trim()) daily[i.dataset.token!] = toUnits(i.value.trim(), i.dataset.token!, "a 24-hour limit"); });
    const whitelistOnly = on("ag-wl-only");
    if (whitelistOnly || Object.keys(perTx).length || Object.keys(daily).length) out.limits = { perTx, daily, whitelistOnly };
    return out;
  }

  // --- whitelist ---

  function destOptions(): Token[] {
    const s = wlForm.search.trim().toLowerCase();
    const shown = tokens.filter((t) => !s || `${t.symbol} ${t.blockchain}`.toLowerCase().includes(s)).slice(0, MAX_OPTIONS);
    if (wlForm.dest && !shown.some((t) => t.assetId === wlForm.dest)) wlForm.dest = "";
    return shown;
  }

  function drawWhitelist() {
    const rows = whitelist.length
      ? `<div class="agent-list">${whitelist
          .map(
            (w) =>
              `<div class="agent-card wl-entry"><p><strong>${esc(w.label)}</strong></p><p class="fine">${esc(label(w.destinationAsset))} · ${w.recipientType === "INTENTS" ? "NEAR Intents account" : "Address on the token's chain"}</p><p><code>${esc(w.recipient)}</code></p><div class="invoice-actions"><button class="textbutton ag-wl-remove" type="button" data-id="${esc(w.id)}">Remove</button></div></div>`,
          )
          .join("")}</div>`
      : `<p class="empty">No whitelisted addresses yet.</p>`;
    q("#ag-wl")!.innerHTML = `${rows}<form id="ag-wl-form" novalidate><h3>Add an address</h3>
<label>Label<input id="ag-wl-label" maxlength="60" autocomplete="off" value="${esc(wlForm.label)}" placeholder="e.g. Exchange deposit"></label>
<label>Search token or chain<input id="ag-wl-search" autocomplete="off" value="${esc(wlForm.search)}" placeholder="e.g. USDC or arb"></label>
<label>Token received<select id="ag-wl-dest" size="5">${destOptions().map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === wlForm.dest ? "selected" : ""}>${esc(t.symbol)} · ${esc(chainName(t.blockchain))}</option>`).join("")}</select></label>
<label>Recipient type<select id="ag-wl-type"><option value="DESTINATION_CHAIN" ${wlForm.type === "DESTINATION_CHAIN" ? "selected" : ""}>Address on the token's chain</option><option value="INTENTS" ${wlForm.type === "INTENTS" ? "selected" : ""}>NEAR Intents account</option></select></label>
<label>Address<input id="ag-wl-recipient" autocomplete="off" value="${esc(wlForm.recipient)}"></label>
<p class="error" id="ag-wl-error" role="alert">${esc(wlError)}</p><p class="fine" id="ag-wl-note" role="status">${esc(wlNote)}</p>
<button class="primary" type="submit">Add to whitelist</button></form>`;
    el.querySelectorAll<HTMLButtonElement>(".ag-wl-remove").forEach(
      (b) =>
        (b.onclick = () => {
          const w = whitelist.find((x) => x.id === b.dataset.id);
          if (!w) return;
          void startChange("whitelist", `Sign: remove ${w.label}`, { kind: "whitelist_remove", id: w.id }, async (signed) => {
            await api("/api/agent/whitelist", { method: "DELETE", body: JSON.stringify({ id: w.id, ...signed }) });
            whitelist = whitelist.filter((x) => x.id !== w.id);
            wlNote = "Address removed.";
            drawWhitelist();
            drawRules();
          });
        }),
    );
    q<HTMLInputElement>("#ag-wl-label")!.oninput = (e) => (wlForm.label = (e.target as HTMLInputElement).value);
    q<HTMLInputElement>("#ag-wl-recipient")!.oninput = (e) => (wlForm.recipient = (e.target as HTMLInputElement).value);
    q<HTMLSelectElement>("#ag-wl-type")!.onchange = (e) => (wlForm.type = (e.target as HTMLSelectElement).value as WhitelistEntry["recipientType"]);
    q<HTMLSelectElement>("#ag-wl-dest")!.onchange = (e) => (wlForm.dest = (e.target as HTMLSelectElement).value);
    const search = q<HTMLInputElement>("#ag-wl-search")!;
    search.oninput = () => {
      wlForm.search = search.value;
      const pos = search.selectionStart;
      drawWhitelist();
      const n = q<HTMLInputElement>("#ag-wl-search")!;
      n.focus();
      n.setSelectionRange(pos, pos);
    };
    q<HTMLFormElement>("#ag-wl-form")!.onsubmit = (e) => {
      e.preventDefault();
      const entry = { label: wlForm.label.trim(), destinationAsset: wlForm.dest, recipientType: wlForm.type, recipient: wlForm.recipient.trim() };
      if (!entry.label) return setText("#ag-wl-error", (wlError = "Enter a label."));
      if (!entry.destinationAsset) return setText("#ag-wl-error", (wlError = "Choose the token the address receives."));
      if (!entry.recipient) return setText("#ag-wl-error", (wlError = "Enter the address."));
      void startChange("whitelist", `Sign: add ${entry.label}`, { kind: "whitelist_add", entry }, async (signed) => {
        const added = await postJson<WhitelistEntry>("/api/agent/whitelist", { entry, ...signed });
        whitelist = [...whitelist, added];
        Object.assign(wlForm, { label: "", recipient: "", dest: "", search: "" });
        wlNote = "Address added.";
        drawWhitelist();
        drawRules();
      });
    };
  }

  async function load() {
    const opt = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    try {
      const [s, pol, wl, b, t, bl, inv] = await Promise.all([
        api<Session>("/api/me"),
        api<{ policy: Policy | null }>("/api/agent/policy"),
        api<WhitelistEntry[]>("/api/agent/whitelist"),
        opt(api<Balance[]>("/api/balances"), [] as Balance[]),
        opt(api<Token[]>("/api/tokens"), [] as Token[]),
        // Scheduled bills, plus those being paid (a bill an approved suggestion is paying).
        opt(Promise.all([api<Bill[]>("/api/bills?status=scheduled"), api<Bill[]>("/api/bills?status=paying")]).then(([a, b]) => [...a, ...b]), [] as Bill[]),
        opt(api<InvoiceLite[]>("/api/invoices"), [] as InvoiceLite[]),
      ]);
      if (!alive) return;
      session = s;
      policy = pol.policy;
      whitelist = wl;
      balances = b;
      tokens = t;
      bills = bl;
      invoices = inv;
    } catch (e) {
      if (!alive) return;
      const m = esc(msg(e));
      q("#ag-rules")!.innerHTML = `<p class="error" role="alert">${m}</p>`;
      q("#ag-wl")!.innerHTML = "";
      inboxError = msg(e);
      drawInbox();
      return;
    }
    drawRules();
    drawWhitelist();
    void loadAi();
    await loadProposals(false);
  }

  void load();
  return () => {
    alive = false;
    window.clearInterval(tick);
    window.clearTimeout(poll);
    if (flow.kind === "register") flow.reject(new Error("Cancelled"));
  };
}
