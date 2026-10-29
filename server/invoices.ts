import { base64urlnopad } from "@scure/base";
import { settlementToken } from "../shared/assets.ts";
import { invoiceTotal, readDraft, validateDraft, type InvoiceDraft, type InvoiceRow, type InvoiceStatus, type PublicInvoice } from "../shared/invoice.ts";
import { formatAmount } from "../shared/units.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

type Raw = {
  id: string; public_id: string; owner: string; status: InvoiceStatus; token_id: string; data: string; total: string;
  revision: number; created_at: string; updated_at: string; issued_at: string | null; paid_at: string | null; paid_by: string | null;
};

const COLS = "id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at, issued_at, paid_at, paid_by";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function row(r: Raw): InvoiceRow {
  const out: InvoiceRow = {
    id: r.id, publicId: r.public_id, owner: r.owner, status: r.status, tokenId: r.token_id,
    data: JSON.parse(r.data) as InvoiceDraft, total: r.total, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (r.issued_at) out.issuedAt = r.issued_at;
  if (r.paid_at) out.paidAt = r.paid_at;
  if (r.paid_by) out.paidBy = r.paid_by;
  return out;
}

function checkedDraft(v: unknown): InvoiceDraft {
  try {
    return readDraft(v);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Total in base units, or "0" while the draft is still incomplete. */
function draftTotal(d: InvoiceDraft): string {
  try {
    return invoiceTotal(d).toString();
  } catch {
    return "0";
  }
}

function tokenOf(d: InvoiceDraft): string {
  try {
    settlementToken(d.tokenId);
  } catch {
    throw new HttpError(400, "Choose USDC or USDT.");
  }
  return d.tokenId;
}

export async function createInvoice(db: Db, owner: string, input: unknown, now: string): Promise<InvoiceRow> {
  const d = checkedDraft(input);
  const id = crypto.randomUUID();
  const publicId = base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(16)));
  await db
    .prepare(`INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?)`)
    .bind(id, publicId, owner, tokenOf(d), JSON.stringify(d), draftTotal(d), now, now)
    .run();
  return getInvoice(db, owner, id);
}

export async function listInvoices(db: Db, owner: string): Promise<InvoiceRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM invoices WHERE owner = ? ORDER BY updated_at DESC, created_at DESC LIMIT 200`)
    .bind(owner)
    .all<Raw>();
  return results.map(row);
}

export async function getInvoice(db: Db, owner: string, id: string): Promise<InvoiceRow> {
  if (!ID.test(id)) throw new HttpError(404, "Invoice not found");
  const r = await db.prepare(`SELECT ${COLS} FROM invoices WHERE id = ? AND owner = ?`).bind(id, owner).first<Raw>();
  if (!r) throw new HttpError(404, "Invoice not found");
  return row(r);
}

export async function updateInvoice(db: Db, owner: string, id: string, revision: number, input: unknown, now: string): Promise<InvoiceRow> {
  const cur = await getInvoice(db, owner, id);
  if (cur.status !== "draft") throw new HttpError(409, "Only drafts can be edited.");
  if (!Number.isInteger(revision) || cur.revision !== revision) throw new HttpError(409, "This invoice changed elsewhere. Reload and try again.");
  const d = checkedDraft(input);
  const r = await db
    .prepare(`UPDATE invoices SET data = ?, token_id = ?, total = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner = ? AND status = 'draft' AND revision = ?`)
    .bind(JSON.stringify(d), tokenOf(d), draftTotal(d), now, id, owner, revision)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "This invoice changed elsewhere. Reload and try again.");
  return getInvoice(db, owner, id);
}

export async function issueInvoice(db: Db, owner: string, id: string, now: string): Promise<InvoiceRow> {
  const cur = await getInvoice(db, owner, id);
  if (cur.status !== "draft") throw new HttpError(409, "Only drafts can be issued.");
  let total: bigint;
  let d: InvoiceDraft;
  try {
    d = validateDraft(cur.data);
    total = invoiceTotal(d);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const r = await db
    .prepare(`UPDATE invoices SET status = 'issued', data = ?, token_id = ?, total = ?, revision = revision + 1, issued_at = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'draft' AND revision = ?`)
    .bind(JSON.stringify(d), d.tokenId, total.toString(), now, now, id, owner, cur.revision)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "This invoice changed elsewhere. Reload and try again.");
  return getInvoice(db, owner, id);
}

export async function cancelInvoice(db: Db, owner: string, id: string, now: string): Promise<InvoiceRow> {
  const cur = await getInvoice(db, owner, id);
  if (cur.status !== "issued") throw new HttpError(409, "Only issued invoices can be cancelled.");
  const r = await db
    .prepare(`UPDATE invoices SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ? AND owner = ? AND status = 'issued'`)
    .bind(now, id, owner)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "This invoice changed elsewhere. Reload and try again.");
  return getInvoice(db, owner, id);
}

/** Internal lookup for public (payer-facing) flows: 404 if missing or still a draft. */
export async function getInvoiceByPublicId(db: Db, publicId: string): Promise<InvoiceRow> {
  if (!ID.test(publicId)) throw new HttpError(404, "Invoice not found");
  const r = await db.prepare(`SELECT ${COLS} FROM invoices WHERE public_id = ?`).bind(publicId).first<Raw>();
  if (!r || r.status === "draft") throw new HttpError(404, "Invoice not found");
  return row(r);
}

export async function getPublicInvoice(db: Db, publicId: string): Promise<PublicInvoice> {
  const inv = await getInvoiceByPublicId(db, publicId);
  const token = settlementToken(inv.tokenId);
  return {
    publicId: inv.publicId,
    status: inv.status,
    tokenId: inv.tokenId,
    symbol: token.symbol,
    data: inv.data,
    total: inv.total,
    totalFormatted: formatAmount(BigInt(inv.total), token.decimals),
    payTo: inv.owner,
    dueDate: inv.data.dueDate,
  };
}

/** The owner's issued invoices, oldest due date first, at most 200 (agent reminders). */
export async function listIssuedInvoices(db: Db, owner: string): Promise<InvoiceRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM invoices WHERE owner = ? AND status = 'issued' ORDER BY json_extract(data, '$.dueDate'), id LIMIT 200`)
    .bind(owner)
    .all<Raw>();
  return results.map(row);
}
