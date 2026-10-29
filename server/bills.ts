// Bills the owner pays from their own NEAR Intents balance. A bill is either entered by hand (any
// supported token and recipient) or imported from another Manexus user's invoice link. Paying a bill is
// an EXACT_OUTPUT transfer through the generic engine: the vendor receives exactly `amount`; the owner
// signs the intent in their wallet. For an imported invoice the same deposit address is also recorded as
// a payment attempt on the vendor's invoice, so the vendor's own reconciliation marks it paid.
import { supportedChain, validDestination, validIntentsAccount } from "../shared/address.ts";
import { SETTLEMENT_TOKENS } from "../shared/assets.ts";
import { validDate, type InvoiceRow, type InvoiceStatus } from "../shared/invoice.ts";
import { baseUnits, formatAmount } from "../shared/units.ts";
import { getBalances } from "./balances.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { getInvoiceByPublicId, getPublicInvoice } from "./invoices.ts";
import type { OneClickToken, createOneClick } from "./oneclick.ts";
import { createIntentsPaymentQuote, type Outcome } from "./payments.ts";
import { refreshInvoice } from "./reconcile.ts";
import {
  openQuote,
  prepareTransfer,
  quoteTransfer,
  refreshTransfer,
  unsignedForGood,
  SLIPPAGE_BPS,
  type OpenQuote,
  type RecipientType,
  type TransferDeps,
  type TransferQuote,
  type TransferRequest,
  type TransferView,
} from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };

export const BILL_STATUSES = ["scheduled", "paying", "paid", "cancelled"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
export type BillSource = "manual" | "manexus";

export type BillRow = {
  id: string; owner: string; vendor: string; reference: string; dueDate: string;
  destinationAsset: string; recipientType: RecipientType; recipient: string;
  /** What the vendor receives, in base units of `destinationAsset`. */
  amount: string;
  source: BillSource; vendorPublicId?: string; status: BillStatus; depositAddress?: string;
  createdAt: string; updatedAt: string;
};

/** Prefill for a bill imported from a Manexus invoice link. */
export type BillDraft = {
  vendor: string; reference: string; dueDate: string; destinationAsset: string; recipientType: "INTENTS"; recipient: string;
  amount: string; amountFormatted: string; symbol: string; source: "manexus"; vendorPublicId: string;
};

/** `decimals` and `amountFormatted` are absent/empty when the token is unknown (token list unavailable or delisted). */
export type BillView = BillRow & { symbol: string; blockchain: string; decimals?: number; amountFormatted: string; overdue: boolean };
export type BillDetail = BillView & {
  transfer?: TransferView;
  vendorInvoiceStatus?: InvoiceStatus;
  vendorOutcome?: Outcome;
  /** The bill was paid, but the vendor invoice had already been paid or cancelled (duplicate/after_cancel). */
  extraPayment: boolean;
  refreshError?: string;
  /** The open unsigned quote (owner only), so the payment can be resumed after leaving the page. */
  pendingQuote?: OpenQuote;
};

type Raw = {
  id: string; owner: string; vendor: string; reference: string; due_date: string; destination_asset: string; recipient_type: RecipientType;
  recipient: string; amount: string; source: BillSource; vendor_public_id: string | null; status: BillStatus; deposit_address: string | null;
  created_at: string; updated_at: string;
};
type Rec = Record<string, unknown>;
type Tokens = { oneclick: Pick<ReturnType<typeof createOneClick>, "tokens"> };

const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 100;
const MAX_BILLS = 1000;
const PAGE = 100;
const BILL_SLIPPAGE_BPS = 100;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const notFound = () => new HttpError(404, "Bill not found");
const vendorGone = () => new HttpError(409, "The vendor invoice is no longer payable");
const duplicateBill = () => new HttpError(409, "You already have an open bill for this invoice");
const linkError = () => new HttpError(400, "Paste a Manexus invoice link");
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function fromRaw(r: Raw): BillRow {
  return {
    id: r.id, owner: r.owner, vendor: r.vendor, reference: r.reference, dueDate: r.due_date,
    destinationAsset: r.destination_asset, recipientType: r.recipient_type, recipient: r.recipient, amount: r.amount,
    source: r.source, ...(r.vendor_public_id ? { vendorPublicId: r.vendor_public_id } : {}), status: r.status,
    ...(r.deposit_address ? { depositAddress: r.deposit_address } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Token details for display; settlement tokens are known even when the token list is unavailable. */
function tokenInfo(assetId: string, tokens: OneClickToken[]): { symbol: string; blockchain: string; decimals?: number } {
  const t = tokens.find((x) => x.assetId === assetId);
  if (t) return t;
  const s = SETTLEMENT_TOKENS.find((x) => x.tokenId === assetId);
  return s ? { symbol: s.symbol, blockchain: "near", decimals: s.decimals } : { symbol: "", blockchain: "" };
}

/** Rows with display fields. An unknown token shows no formatted amount rather than raw base units. */
export function billViews(rows: BillRow[], tokens: OneClickToken[], now: Date): BillView[] {
  const today = now.toISOString().slice(0, 10);
  return rows.map((b) => {
    const t = tokenInfo(b.destinationAsset, tokens);
    return {
      ...b, symbol: t.symbol, blockchain: t.blockchain, ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
      amountFormatted: t.decimals === undefined ? "" : formatAmount(BigInt(b.amount), t.decimals),
      overdue: b.status === "scheduled" && b.dueDate < today,
    };
  });
}

export async function getBill(db: Db, owner: string, id: string): Promise<BillRow> {
  if (typeof id !== "string" || !ID.test(id)) throw notFound();
  const r = await db.prepare("SELECT * FROM bills WHERE id = ? AND owner = ?").bind(id, owner).first<Raw>();
  if (!r) throw notFound();
  return fromRaw({ ...r });
}

/** Valid `?status=` filter, or 400. Undefined/empty means every status. */
export function parseBillStatus(v: unknown): BillStatus | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!(BILL_STATUSES as readonly unknown[]).includes(v)) throw new HttpError(400, "Unknown bill status.");
  return v as BillStatus;
}

/** The owner's bills, soonest due first, 100 per page. */
export async function listBills(db: Db, owner: string, status?: BillStatus, page = 0): Promise<BillRow[]> {
  const s = parseBillStatus(status);
  const p = Number.isInteger(page) && page >= 0 && page < MAX_BILLS / PAGE ? page : 0;
  const { results } = await db
    .prepare(`SELECT * FROM bills WHERE owner = ?${s ? " AND status = ?" : ""} ORDER BY due_date, created_at, id LIMIT ? OFFSET ?`)
    .bind(...(s ? [owner, s] : [owner]), PAGE, p * PAGE)
    .all<Raw>();
  return results.map((r) => fromRaw({ ...r }));
}

/** Public id from `https://<this origin>/#/pay/<publicId>` or a bare public id; anything else is 400. */
function parseLink(link: unknown, origin: string): string {
  if (typeof link !== "string" || link.length > 300) throw linkError();
  const s = link.trim();
  if (PUBLIC_ID.test(s)) return s;
  const prefix = `${origin}/#/pay/`;
  if (!s.startsWith(prefix)) throw linkError();
  const id = s.slice(prefix.length).replace(/\/$/, "");
  if (!PUBLIC_ID.test(id)) throw linkError();
  return id;
}

/** The vendor invoice behind a public id, if this user can still pay it. */
async function payableVendorInvoice(db: Db, user: User, publicId: string): Promise<InvoiceRow> {
  const inv = await getInvoiceByPublicId(db, publicId);
  if (inv.owner === user.account) throw new HttpError(400, "This is your own invoice");
  if (inv.status !== "issued" || !/^[1-9][0-9]*$/.test(inv.total)) throw vendorGone();
  return inv;
}

export async function importManexusInvoice(deps: { db: Db; origin: string }, user: User, link: string): Promise<BillDraft> {
  const publicId = parseLink(link, deps.origin);
  await payableVendorInvoice(deps.db, user, publicId);
  const p = await getPublicInvoice(deps.db, publicId);
  return {
    vendor: p.data.issuer, reference: p.data.number, dueDate: p.dueDate, destinationAsset: p.tokenId, recipientType: "INTENTS", recipient: p.payTo,
    amount: p.total, amountFormatted: p.totalFormatted, symbol: p.symbol, source: "manexus", vendorPublicId: p.publicId,
  };
}

type Fields = Omit<BillRow, "id" | "owner" | "status" | "depositAddress" | "createdAt" | "updatedAt">;

function dueDateOf(v: unknown): string {
  if (typeof v !== "string" || !validDate(v)) throw new HttpError(400, "Choose a valid due date.");
  return v;
}

/** Every field of a manual bill, validated. `amount` is entered as a decimal of the destination token. */
async function manualFields(deps: Tokens, user: User, b: Rec): Promise<Fields> {
  if (!text(b.vendor, MAX_TEXT) || !b.vendor.trim()) throw new HttpError(400, `Enter the vendor name (up to ${MAX_TEXT} characters).`);
  const reference = b.reference === undefined ? "" : b.reference;
  if (!text(reference, MAX_TEXT)) throw new HttpError(400, `Keep the reference under ${MAX_TEXT} characters.`);
  const dueDate = dueDateOf(b.dueDate);
  const recipientType = b.recipientType === undefined ? "DESTINATION_CHAIN" : b.recipientType;
  if (recipientType !== "DESTINATION_CHAIN" && recipientType !== "INTENTS") throw new HttpError(400, "Unknown recipient type.");
  if (typeof b.destinationAsset !== "string" || typeof b.recipient !== "string") throw new HttpError(400, "Choose a token and enter the vendor's address.");
  const dest = (await deps.oneclick.tokens()).find((t) => t.assetId === b.destinationAsset);
  if (!dest) throw new HttpError(400, "That destination token is not supported.");
  const recipient = b.recipient.trim();
  if (recipientType === "DESTINATION_CHAIN") {
    if (!supportedChain(dest.blockchain)) throw new HttpError(400, "That destination token is not supported.");
    if (!validDestination(dest.blockchain, recipient)) throw new HttpError(400, `Enter a valid ${dest.blockchain} address.`);
  } else {
    if (!validIntentsAccount(recipient)) throw new HttpError(400, "Enter a valid NEAR account or lowercase 0x address.");
    if (recipient === user.account) throw new HttpError(400, "Choose a vendor account other than your own.");
  }
  let amount: bigint;
  try {
    if (typeof b.amount !== "string") throw Error();
    amount = baseUnits(b.amount.trim(), dest.decimals);
  } catch {
    throw new HttpError(400, `Enter the amount the vendor receives, with at most ${dest.decimals} decimals.`);
  }
  return {
    vendor: b.vendor.trim(), reference: reference.trim(), dueDate, destinationAsset: dest.assetId, recipientType, recipient,
    amount: amount.toString(), source: "manual",
  };
}

/** A Manexus bill: every payment field comes from the vendor invoice; only the due date may be chosen. */
async function manexusFields(db: Db, user: User, b: Rec): Promise<Fields> {
  if (typeof b.vendorPublicId !== "string" || !PUBLIC_ID.test(b.vendorPublicId)) throw linkError();
  const inv = await payableVendorInvoice(db, user, b.vendorPublicId);
  return {
    vendor: inv.data.issuer, reference: inv.data.number, dueDate: b.dueDate === undefined ? inv.data.dueDate : dueDateOf(b.dueDate),
    destinationAsset: inv.tokenId, recipientType: "INTENTS", recipient: inv.owner, amount: inv.total, source: "manexus", vendorPublicId: inv.publicId,
  };
}

export async function createBill(deps: { db: Db; now: Date } & Tokens, user: User, body: unknown): Promise<BillRow> {
  const { db, now } = deps;
  const b = isRec(body) ? body : {};
  const source = b.source === undefined ? "manual" : b.source;
  if (source !== "manual" && source !== "manexus") throw new HttpError(400, "Unknown bill source.");
  const f = source === "manexus" ? await manexusFields(db, user, b) : await manualFields(deps, user, b);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM bills WHERE owner = ?").bind(user.account).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_BILLS) throw new HttpError(429, `You can keep at most ${MAX_BILLS} bills.`);
  if (f.vendorPublicId) {
    const open = await db
      .prepare("SELECT id FROM bills WHERE owner = ? AND vendor_public_id = ? AND status != 'cancelled'")
      .bind(user.account, f.vendorPublicId)
      .first<{ id: string }>();
    if (open) throw duplicateBill();
  }
  const id = crypto.randomUUID();
  const ts = now.toISOString();
  const insert = db
    .prepare(
      `INSERT INTO bills (id, owner, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, vendor_public_id, status, deposit_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, ?, ?)`,
    )
    .bind(id, user.account, f.vendor, f.reference, f.dueDate, f.destinationAsset, f.recipientType, f.recipient, f.amount, f.source, f.vendorPublicId ?? null, ts, ts);
  try {
    await insert.run();
  } catch (e) {
    // bills_open_vendor: a concurrent import of the same invoice won.
    if (f.vendorPublicId && /UNIQUE/i.test(String((e as Error)?.message))) throw duplicateBill();
    throw e;
  }
  return getBill(db, user.account, id);
}

/** Edit a scheduled bill. A manual bill is revalidated in full; a Manexus bill only changes its due date. */
export async function updateBill(deps: { db: Db; now: Date } & Tokens, user: User, id: string, body: unknown): Promise<BillRow> {
  const { db, now } = deps;
  const cur = await getBill(db, user.account, id);
  if (cur.status !== "scheduled") throw new HttpError(409, "Only scheduled bills can be edited.");
  const b = isRec(body) ? body : {};
  const f: Fields = cur.source === "manexus" ? { ...cur, dueDate: dueDateOf(b.dueDate) } : await manualFields(deps, user, b);
  const r = await db
    .prepare(
      `UPDATE bills SET vendor = ?, reference = ?, due_date = ?, destination_asset = ?, recipient_type = ?, recipient = ?, amount = ?, updated_at = ?
       WHERE id = ? AND owner = ? AND status = 'scheduled'`,
    )
    .bind(f.vendor, f.reference, f.dueDate, f.destinationAsset, f.recipientType, f.recipient, f.amount, now.toISOString(), id, user.account)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "Only scheduled bills can be edited.");
  return getBill(db, user.account, id);
}

export async function cancelBill(deps: { db: Db; now: Date }, user: User, id: string): Promise<BillRow> {
  await getBill(deps.db, user.account, id);
  const r = await deps.db
    .prepare("UPDATE bills SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner = ? AND status = 'scheduled'")
    .bind(deps.now.toISOString(), id, user.account)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "Only scheduled bills can be cancelled.");
  return getBill(deps.db, user.account, id);
}

/** Refresh the bill's latest transfer and move a paying bill to paid or back to scheduled (guarded). */
async function sync(deps: TransferDeps, user: User, bill: BillRow): Promise<{ bill: BillRow; transfer?: TransferView }> {
  if (!bill.depositAddress) return { bill };
  let transfer: TransferView;
  try {
    transfer = await refreshTransfer(deps, user, bill.depositAddress);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { bill };
    throw e;
  }
  if (bill.status !== "paying") return { bill, transfer };
  let next: BillStatus | null = null;
  if (transfer.status === "SUCCESS") next = "paid";
  else if (transfer.status === "FAILED" || transfer.status === "REFUNDED" || (await unsignedForGood(deps, user, transfer))) next = "scheduled";
  if (!next) return { bill, transfer };
  await deps.db
    .prepare("UPDATE bills SET status = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'paying' AND deposit_address = ?")
    .bind(next, deps.now.toISOString(), bill.id, user.account, bill.depositAddress)
    .run();
  return { bill: await getBill(deps.db, user.account, bill.id), transfer };
}

/** Link a just-stored transfer to the bill (scheduled → paying). If another quote won, drop ours unsigned. */
async function markPaying(deps: TransferDeps, user: User, billId: string, qt: TransferQuote): Promise<void> {
  const r = await deps.db
    .prepare("UPDATE bills SET status = 'paying', deposit_address = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'scheduled'")
    .bind(qt.depositAddress, deps.now.toISOString(), billId, user.account)
    .run();
  if (r.meta.changes === 1) return;
  await deps.db
    .prepare("DELETE FROM withdrawals WHERE deposit_address = ? AND owner = ? AND status = 'AWAITING_SIGNATURE' AND upstream IS NULL")
    .bind(qt.depositAddress, user.account)
    .run();
  throw new HttpError(409, "This bill changed elsewhere. Reload and try again.");
}

function notScheduled(status: BillStatus): HttpError {
  if (status === "paid") return new HttpError(409, "This bill is already paid.");
  if (status === "paying") return new HttpError(409, "A payment for this bill is in progress.");
  return new HttpError(409, "This bill is cancelled.");
}

/**
 * Quote paying a scheduled bill from the owner's balance token `originAsset`. Returns the unsigned intent
 * to sign; the bill is `paying` until its transfer settles or the quote expires unsigned.
 */
export async function quoteBillPayment(deps: TransferDeps, user: User, billId: string, body: { originAsset: string }): Promise<TransferQuote> {
  let bill = await getBill(deps.db, user.account, billId);
  if (bill.status === "paying") bill = (await sync(deps, user, bill)).bill;
  if (bill.status !== "scheduled") throw notScheduled(bill.status);
  const originAsset = isRec(body) ? body.originAsset : undefined;
  if (typeof originAsset !== "string") throw new HttpError(400, "Choose a token from your balance.");
  // Refuse a token the owner does not hold before asking 1Click (the engine re-checks against the quote).
  const held = (await getBalances(deps, user.account)).find((b) => b.tokenId === originAsset);
  if (!held) throw new HttpError(400, "Amount exceeds your balance");
  const reference = bill.reference || undefined;

  if (bill.source === "manual") {
    const qt = await quoteTransfer(deps, user, {
      kind: "bill", billId: bill.id, swapType: "EXACT_OUTPUT", originAsset, amount: bill.amount, destinationAsset: bill.destinationAsset,
      recipientType: bill.recipientType, recipient: bill.recipient, slippageBps: BILL_SLIPPAGE_BPS, reference,
    });
    await markPaying(deps, user, bill.id, qt);
    return qt;
  }

  const publicId = bill.vendorPublicId ?? "";
  const inv = await getInvoiceByPublicId(deps.db, publicId).catch(() => null);
  if (!inv || inv.status !== "issued") throw vendorGone();
  if (inv.total !== bill.amount || inv.owner !== bill.recipient || inv.tokenId !== bill.destinationAsset) throw vendorGone();
  return createIntentsPaymentQuote(deps, publicId, { originAsset, payer: user.account }, async (q, _inv, request) => {
    // The transfer request is the vendor quote request, field for field (prepareTransfer's contract).
    const slippage = request.slippageTolerance as (typeof SLIPPAGE_BPS)[number];
    const req: TransferRequest = {
      kind: "bill", billId: bill.id, originAsset: request.originAsset, destinationAsset: request.destinationAsset, amount: request.amount,
      swapType: request.swapType, recipientType: request.recipientType, recipient: request.recipient, slippageBps: slippage, reference,
    };
    const qt = await prepareTransfer(deps, user, req, q);
    await markPaying(deps, user, bill.id, qt);
    return qt;
  });
}

/**
 * The bill with its latest transfer, refreshed from NEAR Intents. For a Manexus bill the vendor invoice is
 * reconciled too (`refreshInvoice`, the only path to the vendor's `paid`).
 */
export async function refreshBill(deps: TransferDeps, user: User, id: string): Promise<BillDetail> {
  const { bill, transfer } = await sync(deps, user, await getBill(deps.db, user.account, id));
  let refreshError = transfer?.refreshError;
  let vendorInvoiceStatus: InvoiceStatus | undefined;
  let vendorOutcome: Outcome | undefined;
  if (bill.source === "manexus" && bill.vendorPublicId) {
    const inv = await getInvoiceByPublicId(deps.db, bill.vendorPublicId).catch(() => null);
    if (inv) {
      if (bill.depositAddress) {
        try {
          await refreshInvoice(deps, inv.id);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 502)) throw e;
          refreshError ??= "Could not reach NEAR Intents. Payment status may be out of date.";
        }
      }
      const fresh = await getInvoiceByPublicId(deps.db, bill.vendorPublicId);
      vendorInvoiceStatus = fresh.status;
      if (bill.depositAddress) {
        const a = await deps.db
          .prepare("SELECT outcome FROM payment_attempts WHERE deposit_address = ? AND invoice_id = ?")
          .bind(bill.depositAddress, inv.id)
          .first<{ outcome: string | null }>();
        if (a?.outcome) vendorOutcome = a.outcome as Outcome;
      }
    }
  }
  const pendingQuote = bill.status === "paying" ? await openQuote(deps.db, user, transfer) : undefined;
  const tokens = await deps.oneclick.tokens().catch(() => [] as OneClickToken[]);
  const [view] = billViews([bill], tokens, deps.now);
  return {
    ...view,
    ...(transfer ? { transfer } : {}),
    ...(vendorInvoiceStatus ? { vendorInvoiceStatus } : {}),
    ...(vendorOutcome ? { vendorOutcome } : {}),
    extraPayment: bill.status === "paid" && (vendorOutcome === "duplicate" || vendorOutcome === "after_cancel"),
    ...(refreshError ? { refreshError } : {}),
    ...(pendingQuote ? { pendingQuote } : {}),
  };
}
