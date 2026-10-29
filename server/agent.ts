// The deterministic treasury agent. `evaluate` is a pure function of (policy, balances, bills, invoices,
// whitelist, now); `runAgent` stores its drafts as proposals. The agent never signs and never moves funds:
// a proposal only becomes a transfer when the owner approves it with their own signature (Task 3).
//
// Throttle choice: no extra column. A run is skipped when the owner's newest proposal row was written less than
// 60 s ago (`updated_at`, which inserts, expiries and dismissals all bump) unless `force`. A run that produces
// and changes nothing therefore re-evaluates on the next request, which is cheap (all queries are bounded).
import type { WhitelistEntry, Policy } from "./policy.ts";
import { getPolicy, listWhitelist } from "./policy.ts";
import { getBalances, type Balance } from "./balances.ts";
import { listBills, type BillRow } from "./bills.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { listIssuedInvoices } from "./invoices.ts";
import type { NearRpc } from "./near-rpc.ts";
import type { OneClickToken, SwapStatus } from "./oneclick.ts";
import { peekRow, refreshRow, unsignedForGoodRow, type TransferDeps, type TransferRow } from "./transfers.ts";
import type { InvoiceRow } from "../shared/invoice.ts";

type User = { account: string; kind: "near" | "evm" };
export type ProposalType = "convert" | "sweep" | "pay_bill" | "follow_up_invoice";
export type ProposalStatus = "proposed" | "executing" | "done" | "dismissed" | "expired";
export type ProposalDraft = { type: ProposalType; dedupKey: string; params: Record<string, string>; expiresAt: string };
export type Proposal = {
  id: string; type: ProposalType; dedupKey: string; params: Record<string, string>; status: ProposalStatus;
  depositAddress?: string; createdAt: string; updatedAt: string; expiresAt: string;
};
export type EvalInput = { now: Date; policy: Policy; balances: Balance[]; bills: BillRow[]; invoices: InvoiceRow[]; whitelist: WhitelistEntry[] };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const THROTTLE_MS = 60_000;
/** A forced run still waits this long after the owner's newest proposal write. */
export const FORCE_MIN_MS = 5_000;
/** Hard cap on drafts per evaluation, so open proposals stay well under the load limit below. */
export const MAX_DRAFTS = 200;
const MAX_OPEN = 1000;
const WRITE_CHUNK = 100;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** "12.34" -> 1234n. Anything that is not a plain two-decimal-or-fewer dollar string is not comparable (undefined). */
function usdCents(s: string | undefined): bigint | undefined {
  const m = s === undefined ? null : /^(\d{1,30})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0") : undefined;
}
const isUnits = (s: string) => /^\d{1,78}$/.test(s);
/** UTC midnight of a YYYY-MM-DD date, or NaN. */
const dayMs = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00.000Z`) : NaN);

export function evaluate(input: EvalInput): ProposalDraft[] {
  const { now, policy, balances, bills, invoices, whitelist } = input;
  const out: ProposalDraft[] = [];
  const bill: ProposalDraft[] = [], follow: ProposalDraft[] = [];
  const hourLater = new Date(now.getTime() + HOUR).toISOString();
  const today = dayMs(now.toISOString().slice(0, 10));

  const c = policy.convert;
  if (c?.enabled) {
    const min = BigInt(c.minUsdCents);
    for (const b of balances) {
      if (b.tokenId === c.targetTokenId || !isUnits(b.amount) || BigInt(b.amount) <= 0n) continue;
      const cents = usdCents(b.usd);
      if (cents === undefined || cents < min) continue;
      out.push({ type: "convert", dedupKey: `convert:${b.tokenId}`, params: { originAsset: b.tokenId, destinationAsset: c.targetTokenId, amount: b.amount }, expiresAt: hourLater });
    }
  }

  const s = policy.sweep;
  if (s?.enabled && whitelist.some((w) => w.id === s.whitelistId)) {
    const bal = balances.find((b) => b.tokenId === s.tokenId);
    if (bal && isUnits(bal.amount) && BigInt(bal.amount) > BigInt(s.thresholdUnits)) {
      const amount = BigInt(bal.amount) - BigInt(s.keepUnits);
      if (amount > 0n)
        out.push({ type: "sweep", dedupKey: `sweep:${s.tokenId}:${s.whitelistId}`, params: { originAsset: s.tokenId, amount: amount.toString(), whitelistId: s.whitelistId }, expiresAt: hourLater });
    }
  }

  const dues = new Map<string, number>();
  const r = policy.reminders;
  if (r) {
    for (const b of bills) {
      const due = dayMs(b.dueDate);
      if (b.status !== "scheduled" || Number.isNaN(due) || due > today + r.billDueDays * DAY) continue;
      // A long-overdue bill would otherwise be created already expired and re-created on every run.
      const expires = Math.max(due + DAY, now.getTime() + HOUR);
      bill.push({ type: "pay_bill", dedupKey: `bill:${b.id}`, params: { billId: b.id }, expiresAt: new Date(expires).toISOString() });
      dues.set(`bill:${b.id}`, due);
    }
    for (const i of invoices) {
      const due = dayMs(i.data.dueDate);
      if (i.status !== "issued" || Number.isNaN(due) || today - due < Math.max(r.invoiceOverdueDays, 1) * DAY) continue;
      dues.set(`invoice:${i.id}`, due);
      follow.push({ type: "follow_up_invoice", dedupKey: `invoice:${i.id}`, params: { invoiceId: i.id, publicId: i.publicId }, expiresAt: new Date(now.getTime() + 7 * DAY).toISOString() });
    }
  }
  // Priority when capped: sweep, convert, then bills and follow-ups by due date (oldest first, key as tiebreak).
  const byDue = (a: ProposalDraft, b: ProposalDraft) => dues.get(a.dedupKey)! - dues.get(b.dedupKey)! || (a.dedupKey < b.dedupKey ? -1 : 1);
  const sweepFirst = [...out.filter((d) => d.type === "sweep"), ...out.filter((d) => d.type === "convert")];
  return [...sweepFirst, ...bill.sort(byDue), ...follow.sort(byDue)].slice(0, MAX_DRAFTS);
}

export type ProposalRaw = Raw;
type Raw = { id: string; type: ProposalType; dedup_key: string; params: string; status: ProposalStatus; deposit_address: string | null; created_at: string; updated_at: string; expires_at: string };
export const COLS = "id, type, dedup_key, params, status, deposit_address, created_at, updated_at, expires_at";
export function view(r: Raw): Proposal {
  return {
    id: r.id, type: r.type, dedupKey: r.dedup_key, params: JSON.parse(r.params) as Record<string, string>, status: r.status,
    ...(r.deposit_address ? { depositAddress: r.deposit_address } : {}), createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
  };
}
export const sameParams = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

async function openProposals(db: Db, owner: string): Promise<Raw[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM agent_proposals WHERE owner = ? AND status IN ('proposed','executing') ORDER BY created_at, id LIMIT ${MAX_OPEN}`)
    .bind(owner)
    .all<Raw>();
  return results;
}

/** The owner's open (proposed or executing) proposals. */
export async function listProposals(db: Db, user: User): Promise<Proposal[]> {
  return (await openProposals(db, user.account)).map(view);
}

export type AgentDeps = {
  db: Db; rpc: NearRpc;
  /** With `status`, executing proposals' transfers are also refreshed from 1Click (a few per run). */
  oneclick: { tokens(): Promise<OneClickToken[]>; status?(depositAddress: string): Promise<SwapStatus> };
  now: Date;
};

/**
 * The inputs `evaluate` reads, loaded with bounded queries. `balances: false` skips the balance read (bills and
 * invoices drafts do not depend on it), `reminders: false` skips bills and invoices (convert/sweep do not).
 */
export async function loadEvalInput(
  deps: AgentDeps, user: User, policy: Policy, need: { balances: boolean; reminders: boolean } = { balances: true, reminders: true },
): Promise<EvalInput> {
  const { db, now } = deps;
  const owner = user.account;
  const balances = need.balances ? await getBalances({ db, rpc: deps.rpc, oneclick: deps.oneclick }, owner) : [];
  const whitelist = await listWhitelist(db, user);
  const bills: BillRow[] = [];
  let invoices: InvoiceRow[] = [];
  if (need.reminders && policy.reminders) {
    bills.push(...(await listBills(db, owner, "scheduled", 0)));
    if (bills.length === 100) bills.push(...(await listBills(db, owner, "scheduled", 1)));
    invoices = await listIssuedInvoices(db, owner);
  }
  return { now, policy, balances, bills, invoices, whitelist };
}

/** An approval that never stored its quote (worker died mid-approve) is released after this long. */
export const STUCK_APPROVE_MS = 120_000;
const MAX_EXECUTING = 50;
const MAX_REFRESH = 5;
type ExecRow = Partial<TransferRow> & { p_id: string; p_updated_at: string; p_dep: string | null };

/**
 * Executing proposals follow their transfer: SUCCESS → done; FAILED/REFUNDED, or an unsigned quote that can no
 * longer move funds (`unsignedForGoodRow`, the bill/payroll re-quote rule) → proposed again. One query loads them
 * with their transfers; at most MAX_REFRESH stale transfers are refreshed from 1Click; one batch writes.
 */
async function settleExecuting(deps: AgentDeps, user: User): Promise<void> {
  const { db, now } = deps;
  const owner = user.account;
  const { results } = await db
    .prepare(
      `SELECT p.id AS p_id, p.updated_at AS p_updated_at, p.deposit_address AS p_dep, w.* FROM agent_proposals p
       LEFT JOIN withdrawals w ON w.deposit_address = p.deposit_address AND w.owner = p.owner
       WHERE p.owner = ? AND p.status = 'executing' ORDER BY p.updated_at, p.id LIMIT ${MAX_EXECUTING}`,
    )
    .bind(owner)
    .all<ExecRow>();
  if (!results.length) return;
  const ts = now.toISOString();
  const set = (id: string, status: "done" | "proposed") =>
    db.prepare("UPDATE agent_proposals SET status = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'executing'").bind(status, ts, id, owner);
  const stmts = [];
  let refreshed = 0;
  for (const r of results) {
    if (!r.p_dep) {
      if (now.getTime() - Date.parse(r.p_updated_at) > STUCK_APPROVE_MS) stmts.push(set(r.p_id, "proposed"));
      continue;
    }
    if (!r.deposit_address) { stmts.push(set(r.p_id, "proposed")); continue; }
    const { p_id: _i, p_updated_at: _u, p_dep: _d, ...rest } = r;
    let row = rest as TransferRow;
    let t;
    try {
      const peek = peekRow(row, now);
      t = peek.view;
      if (peek.stale && deps.oneclick.status && refreshed < MAX_REFRESH) {
        refreshed++;
        ({ view: t, row } = await refreshRow(deps as unknown as TransferDeps, user, row));
      }
    } catch {
      continue; // unreadable row: leave it executing
    }
    if (t.status === "SUCCESS") stmts.push(set(r.p_id, "done"));
    else if (t.status === "FAILED" || t.status === "REFUNDED" || unsignedForGoodRow(row, t, now)) stmts.push(set(r.p_id, "proposed"));
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * Evaluate the owner's rules and store the result: new drafts become `proposed`; open `proposed` rows whose
 * basis changed (key no longer produced, different params, or past `expires_at`) are expired. `executing` rows
 * are never expired here: they follow their transfer (`settleExecuting`, run first, even when throttled). A
 * draft the owner dismissed with identical params is not proposed again. One batch writes everything; at most
 * 14 queries plus up to 5 transfer refreshes and 1 batch for executing proposals (12 for 50 bills / 100
 * invoices / 20 balances), the write batch chunked at 100 statements. A balances failure is 502 and nothing is written.
 */
export async function runAgent(deps: AgentDeps, user: User, opts: { force?: boolean } = {}): Promise<Proposal[]> {
  const { db, now } = deps;
  const owner = user.account;
  const { policy } = await getPolicy(db, user);
  if (!policy) return [];
  // 60 s throttle; `force` still enforces a hard 5 s minimum between runs per owner. Read before settling, so
  // the settle writes themselves do not throttle this run.
  const last = await db.prepare("SELECT MAX(updated_at) AS t FROM agent_proposals WHERE owner = ?").bind(owner).first<{ t: string | null }>();
  await settleExecuting(deps, user);
  {
    const t = last?.t ? Date.parse(last.t) : NaN;
    if (!Number.isNaN(t) && now.getTime() - t < (opts.force ? FORCE_MIN_MS : THROTTLE_MS) && now.getTime() >= t) return listProposals(db, user);
  }
  const drafts = evaluate(await loadEvalInput(deps, user, policy));

  const open = await openProposals(db, owner);
  const { results: dismissed } = await db
    // Only the LATEST dismissal per key blocks: X -> dismissed, Y -> dismissed, X again is proposed (latest is Y).
    .prepare(
      `SELECT dedup_key, params FROM agent_proposals a WHERE owner = ? AND status = 'dismissed' AND updated_at =
       (SELECT MAX(updated_at) FROM agent_proposals b WHERE b.owner = a.owner AND b.dedup_key = a.dedup_key AND b.status = 'dismissed') LIMIT 500`,
    )
    .bind(owner)
    .all<{ dedup_key: string; params: string }>();
  const ts = now.toISOString();
  const stmts = [];
  const keep = new Set<string>();
  for (const o of open) {
    const d = drafts.find((x) => x.dedupKey === o.dedup_key);
    if (o.status === "executing") { keep.add(o.dedup_key); continue; }
    if (d && sameParams(d.params, JSON.parse(o.params) as Record<string, string>) && Date.parse(o.expires_at) > now.getTime()) { keep.add(o.dedup_key); continue; }
    stmts.push(db.prepare("UPDATE agent_proposals SET status = 'expired', updated_at = ? WHERE id = ? AND owner = ? AND status = 'proposed'").bind(ts, o.id, owner));
  }
  for (const d of drafts) {
    if (keep.has(d.dedupKey)) continue;
    if (dismissed.some((x) => x.dedup_key === d.dedupKey && sameParams(d.params, JSON.parse(x.params) as Record<string, string>))) continue;
    stmts.push(
      db.prepare("INSERT INTO agent_proposals (id, owner, type, dedup_key, params, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), owner, d.type, d.dedupKey, JSON.stringify(d.params), ts, ts, d.expiresAt),
    );
  }
  // Chunked for D1; ON CONFLICT DO NOTHING / status guards make a retry after a partial failure idempotent.
  for (let i = 0; i < stmts.length; i += WRITE_CHUNK) await db.batch(stmts.slice(i, i + WRITE_CHUNK));
  return listProposals(db, user);
}

/** proposed → dismissed for the owner's own proposal. 404 if it is not theirs, 409 if it is no longer `proposed`. */
export async function dismissProposal(db: Db, user: User, id: string, now = new Date()): Promise<Proposal> {
  if (!ID.test(id)) throw new HttpError(404, "Proposal not found");
  const r = await db
    .prepare("UPDATE agent_proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND owner = ? AND status = 'proposed'")
    .bind(now.toISOString(), id, user.account)
    .run();
  const cur = await db.prepare(`SELECT ${COLS} FROM agent_proposals WHERE id = ? AND owner = ?`).bind(id, user.account).first<Raw>();
  if (!cur) throw new HttpError(404, "Proposal not found");
  if (r.meta.changes !== 1) throw new HttpError(409, "This proposal is no longer open");
  return view(cur);
}
