import { settlementToken } from "./assets.ts";
import { baseUnits } from "./units.ts";

export type InvoiceLine = { description: string; quantity: string; unitPrice: string };
export type InvoiceDraft = {
  number: string;
  client: string;
  issuer: string;
  dueDate: string;
  tokenId: string;
  notes: string;
  items: InvoiceLine[];
};
export type InvoiceStatus = "draft" | "issued" | "paid" | "cancelled";
export type InvoiceRow = {
  id: string;
  publicId: string;
  owner: string;
  status: InvoiceStatus;
  tokenId: string;
  data: InvoiceDraft;
  total: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  issuedAt?: string;
  paidAt?: string;
  paidBy?: string;
};
export type PublicInvoice = {
  publicId: string;
  status: InvoiceStatus;
  tokenId: string;
  symbol: string;
  data: InvoiceDraft;
  total: string;
  totalFormatted: string;
  payTo: string;
  dueDate: string;
};

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

/** Shape and length checks only; incomplete drafts pass. */
export function readDraft(value: unknown): InvoiceDraft {
  if (
    !plain(value) ||
    !text(value.number, 32) ||
    !text(value.issuer, 64) ||
    !text(value.client, 64) ||
    !text(value.dueDate, 10) ||
    !text(value.tokenId, 100) ||
    !text(value.notes, 280) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 10
  )
    throw Error("Invalid invoice data. Maximum 10 line items.");
  const items = value.items.map((item) => {
    if (!plain(item) || !text(item.description, 100) || !text(item.quantity, 5) || !text(item.unitPrice, 32))
      throw Error("Invalid line item.");
    return { description: item.description, quantity: item.quantity, unitPrice: item.unitPrice };
  });
  return {
    number: value.number,
    client: value.client,
    issuer: value.issuer,
    dueDate: value.dueDate,
    tokenId: value.tokenId,
    notes: value.notes,
    items,
  };
}

export function invoiceTotal(d: InvoiceDraft): bigint {
  const token = settlementToken(d.tokenId);
  let total = 0n;
  d.items.forEach((line, i) => {
    if (!/^[1-9]\d{0,3}$/.test(line.quantity)) throw Error(`Line ${i + 1}: use a whole quantity from 1 to 9999.`);
    let units: bigint;
    try {
      units = baseUnits(line.unitPrice, token.decimals);
    } catch {
      throw Error(`Line ${i + 1}: enter a positive unit price with at most ${token.decimals} decimals.`);
    }
    total += units * BigInt(line.quantity);
  });
  if (total <= 0n || total > 10n ** 12n * 10n ** BigInt(token.decimals))
    throw Error("Invoice total must be positive and no more than one trillion tokens.");
  return total;
}

export function validDate(date: string): boolean {
  try {
    const y = Number(date.slice(0, 4));
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && y >= 2000 && y <= 2100 && new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date;
  } catch {
    return false;
  }
}

/** Full validation, required before an invoice can be issued. */
export function validateDraft(value: unknown): InvoiceDraft {
  const d = readDraft(value);
  if (!d.number.trim() || !d.issuer.trim() || !d.client.trim())
    throw Error("Add an invoice number, your business name and a client name.");
  if (!validDate(d.dueDate)) throw Error("Choose a valid due date between 2000 and 2100.");
  settlementToken(d.tokenId);
  if (d.items.some((i) => !i.description.trim())) throw Error("Add a description to every line item.");
  invoiceTotal(d);
  return d;
}

export type DisplayStatus = InvoiceStatus | "overdue";
/** Overdue is derived, never stored: an issued invoice whose UTC due date has passed. */
export function displayStatus(status: InvoiceStatus, dueDate: string, now = new Date()): DisplayStatus {
  return status === "issued" && dueDate < now.toISOString().slice(0, 10) ? "overdue" : status;
}
export const STATUS_LABEL: Record<DisplayStatus, string> = { draft: "Draft", issued: "Issued", overdue: "Overdue", paid: "Paid", cancelled: "Cancelled" };
