import { validAddress } from "./domain.ts";
import { baseUnits, formatUnits } from "./live.ts";
import { isAddress } from "viem";
export const INVOICE_KEY = "manexus-invoices-v1";
export const ASSETS = [
  {
    key: "USDC:eth",
    symbol: "USDC",
    chain: "eth",
    label: "USDC · Ethereum",
    decimals: 6,
  },
  {
    key: "ETH:eth",
    symbol: "ETH",
    chain: "eth",
    label: "ETH · Ethereum",
    decimals: 18,
  },
  {
    key: "NEAR:near",
    symbol: "NEAR",
    chain: "near",
    label: "NEAR · NEAR",
    decimals: 24,
  },
  {
    key: "SOL:sol",
    symbol: "SOL",
    chain: "sol",
    label: "SOL · Solana",
    decimals: 9,
  },
  {
    key: "ETH:base-sepolia",
    symbol: "ETH",
    chain: "base-sepolia",
    label: "Test ETH · Base Sepolia",
    decimals: 18,
  },
] as const;
export type InvoiceLine = {
  description: string;
  quantity: string;
  unitPrice: string;
};
export type InvoiceData = {
  number: string;
  issuer: string;
  client: string;
  dueDate: string;
  asset: string;
  address: string;
  notes: string;
  items: InvoiceLine[];
};
export type Invoice = {
  id: string;
  revision: number;
  status: "draft" | "issued" | "cancelled";
  createdAt: string;
  updatedAt: string;
  issuedAt?: string;
  data: InvoiceData;
};
export type Snapshot = {
  version: 1;
  id: string;
  issuedAt: string;
  status: "issued";
  data: InvoiceData;
};
export const assetFor = (key: string) => {
  const a = ASSETS.find((a) => a.key === key);
  if (!a) throw Error("Select a supported asset and network.");
  return a;
};
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
export function readData(value: unknown): InvoiceData {
  if (
    !plain(value) ||
    !text(value.number, 32) ||
    !text(value.issuer, 64) ||
    !text(value.client, 64) ||
    !text(value.dueDate, 10) ||
    !text(value.asset, 32) ||
    !text(value.address, 64) ||
    !text(value.notes, 280) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 10
  )
    throw Error("Invalid invoice data. Maximum 10 line items.");
  assetFor(value.asset);
  const items = value.items.map((item) => {
    if (
      !plain(item) ||
      !text(item.description, 100) ||
      !text(item.quantity, 5) ||
      !text(item.unitPrice, 32)
    )
      throw Error("Invalid line item.");
    return {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
  });
  return {
    number: value.number,
    issuer: value.issuer,
    client: value.client,
    dueDate: value.dueDate,
    asset: value.asset,
    address: value.address,
    notes: value.notes,
    items,
  };
}
export function invoiceTotals(data: InvoiceData) {
  const a = assetFor(data.asset);
  const lines = data.items.map((line, index) => {
    if (!/^[1-9]\d{0,3}$/.test(line.quantity))
      throw Error(`Line ${index + 1}: use a whole quantity from 1 to 9999.`);
    let units: bigint;
    try {
      units = BigInt(baseUnits(line.unitPrice, a.decimals));
    } catch {
      throw Error(
        `Line ${index + 1}: enter a positive unit price with at most ${a.decimals} decimals.`,
      );
    }
    return units * BigInt(line.quantity);
  });
  const total = lines.reduce((a, b) => a + b, 0n);
  if (total <= 0n || total > 10n ** 12n * 10n ** BigInt(a.decimals))
    throw Error(
      "Invoice total must be positive and no more than one trillion tokens.",
    );
  return { lines, total, formatted: formatAmount(total, a.decimals) };
}
export function formatAmount(units: bigint, decimals: number) {
  return formatUnits(units.toString(), decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}
export function validDate(date: string) {
  try {
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number(date.slice(0, 4)) >= 2000 &&
      Number(date.slice(0, 4)) <= 2100 &&
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
    );
  } catch {
    return false;
  }
}
export function validateInvoice(value: unknown): InvoiceData {
  const data = readData(value);
  if (!data.number.trim() || !data.issuer.trim() || !data.client.trim())
    throw Error(
      "Add an invoice number, issuer label and client label. Use synthetic data only.",
    );
  if (!validDate(data.dueDate))
    throw Error("Choose a valid due date between 2000 and 2100.");
  const a = assetFor(data.asset);
  const address = data.address;
  if (a.chain === "eth" || a.chain === "base-sepolia") {
    if (!isAddress(address, { strict: true }) || /^0x0{40}$/i.test(address))
      throw Error("Enter a valid nonzero EVM receiving address.");
  } else if (
    (a.chain === "near" && /^0x[0-9a-f]{40}$/i.test(address)) ||
    !validAddress(address, a.chain)
  )
    throw Error("Enter a valid receiving address for the selected network.");
  if (data.items.some((i) => !i.description.trim()))
    throw Error("Add a description to every line item.");
  invoiceTotals(data);
  return data;
}
export function newInvoice(now = new Date()): Invoice {
  const date = now.toISOString();
  return {
    id: crypto.randomUUID(),
    revision: 1,
    status: "draft",
    createdAt: date,
    updatedAt: date,
    data: {
      number:
        "INV-" +
        date.slice(0, 10).replaceAll("-", "") +
        "-" +
        crypto.randomUUID().slice(0, 4).toUpperCase(),
      issuer: "",
      client: "",
      dueDate: new Date(now.getTime() + 14 * 86400000)
        .toISOString()
        .slice(0, 10),
      asset: ASSETS[0].key,
      address: "",
      notes: "",
      items: [{ description: "", quantity: "1", unitPrice: "" }],
    },
  };
}
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(v);
const validISO = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  v.length <= 32;
export function readInvoice(value: unknown): Invoice {
  if (
    !plain(value) ||
    !validId(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !["draft", "issued", "cancelled"].includes(String(value.status)) ||
    !validISO(value.createdAt) ||
    !validISO(value.updatedAt)
  )
    throw Error(
      "Stored invoice is invalid. Existing data has not been overwritten.",
    );
  const data =
    value.status === "draft"
      ? readData(value.data)
      : validateInvoice(value.data);
  if (value.status !== "draft" && !validISO(value.issuedAt))
    throw Error("Missing issue timestamp.");
  return {
    id: value.id,
    revision: Number(value.revision),
    status: value.status as Invoice["status"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(validISO(value.issuedAt) ? { issuedAt: value.issuedAt } : {}),
    data,
  };
}
export function lifecycle(
  invoice: Invoice,
  today = new Date().toISOString().slice(0, 10),
) {
  return invoice.status === "issued" && invoice.data.dueDate < today
    ? "overdue"
    : invoice.status;
}
export function updateInvoice(current: Invoice, data: InvoiceData) {
  if (current.status !== "draft")
    throw Error("Issued invoices are locked. Duplicate to make a new draft.");
  return {
    ...current,
    data: readData(data),
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}
export function issueInvoice(current: Invoice): Invoice {
  if (current.status !== "draft") throw Error("Only a draft can be issued.");
  const now = new Date().toISOString();
  return {
    ...current,
    data: validateInvoice(current.data),
    status: "issued",
    issuedAt: now,
    updatedAt: now,
    revision: current.revision + 1,
  };
}
export function cancelInvoice(current: Invoice): Invoice {
  if (current.status !== "issued")
    throw Error("Only an issued invoice can be cancelled.");
  return {
    ...current,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
    revision: current.revision + 1,
  };
}
export function snapshotOf(invoice: Invoice): Snapshot {
  if (invoice.status !== "issued" || !invoice.issuedAt)
    throw Error("Only an issued invoice can be shared.");
  return {
    version: 1,
    id: invoice.id,
    issuedAt: invoice.issuedAt,
    status: "issued",
    data: validateInvoice(invoice.data),
  };
}
export function snapshotHash(invoice: Invoice) {
  const hash =
    "#invoice=" + encodeURIComponent(JSON.stringify(snapshotOf(invoice)));
  if (hash.length > 16000)
    throw Error("Invoice is too long for a shareable link. Shorten its text.");
  return hash;
}
export function parseSnapshot(hash: string): Snapshot {
  if (hash.length > 16000 || !hash.startsWith("#invoice="))
    throw Error("Invalid invoice link.");
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(hash.slice(9)));
  } catch {
    throw Error("Invoice link is malformed.");
  }
  if (
    !plain(value) ||
    value.version !== 1 ||
    value.status !== "issued" ||
    !validId(value.id) ||
    !validISO(value.issuedAt)
  )
    throw Error(
      "Unsupported invoice snapshot. Payment status cannot be supplied in a link.",
    );
  return {
    version: 1,
    id: value.id,
    issuedAt: value.issuedAt,
    status: "issued",
    data: validateInvoice(value.data),
  };
}
export type InvoiceStorage = Pick<Storage, "getItem" | "setItem">;
export function listInvoices(storage: InvoiceStorage): Invoice[] {
  const raw = storage.getItem(INVOICE_KEY);
  if (raw === null) return [];
  if (raw.length > 500000)
    throw Error(
      "Invoice storage is too large. Existing data has not been overwritten.",
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error(
      "Invoice storage is unreadable. Existing data has not been overwritten.",
    );
  }
  if (!Array.isArray(value) || value.length > 100)
    throw Error("Invalid invoice collection.");
  const items = value.map(readInvoice);
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw Error("Duplicate invoice IDs found in storage.");
  return items;
}
export function saveInvoice(
  storage: InvoiceStorage,
  next: Invoice,
  expectedRevision: number | null,
) {
  const valid = readInvoice(next),
    items = listInvoices(storage);
  const index = items.findIndex((i) => i.id === valid.id);
  if (expectedRevision === null) {
    if (index !== -1) throw Error("Invoice already exists. Reload invoices.");
    if (items.length >= 100) throw Error("Local limit: 100 invoices.");
    items.unshift(valid);
  } else {
    if (index === -1 || items[index].revision !== expectedRevision)
      throw Error(
        "This invoice changed in another tab. Reload invoices before editing.",
      );
    items[index] = valid;
  }
  try {
    storage.setItem(INVOICE_KEY, JSON.stringify(items));
  } catch {
    throw Error(
      "Could not save in this browser. Keep this tab open and copy your draft before leaving.",
    );
  }
  return valid;
}
