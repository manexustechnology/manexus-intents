// Payroll CSV: `name,chain,token,address,amount`, RFC 4180 quoting, no dependencies. Used for the
// browser preview and, on the server, re-run on the raw CSV text (the server never trusts amounts the
// browser parsed). Any invalid line rejects the whole upload; every error carries its line number.
import { supportedChain, validDestination, validIntentsAccount } from "./address.ts";
import { baseUnits, formatAmount } from "./units.ts";

export type CsvToken = { assetId: string; symbol: string; blockchain: string; decimals: number };
export type PayrollRecipientType = "DESTINATION_CHAIN" | "INTENTS";
export type PayrollRow = {
  /** Line of the file the row starts on (the header is line 1). */
  line: number;
  name: string;
  /** As written in the file, lowercased: a chain id or "near-intents". */
  chain: string;
  symbol: string;
  destinationAsset: string;
  decimals: number;
  recipientType: PayrollRecipientType;
  recipient: string;
  /** What the recipient receives, in base units of `destinationAsset`. */
  amount: string;
  amountFormatted: string;
};
export type LineError = { line: number; message: string };

export const MAX_PAYROLL_LINES = 50;
export const MAX_CSV_BYTES = 65_536;
export const MAX_PAYEE_NAME = 64;
/** The chain value that pays a NEAR Intents account instead of an address on a chain. */
export const INTENTS_CHAIN = "near-intents";
const HEADER = ["name", "chain", "token", "address", "amount"];
const HEADER_ERROR = "The first line must be: name,chain,token,address,amount";

/** Why `name` cannot be a payee name, or null. Spreadsheet formula prefixes are refused (CSV injection). */
export function payeeNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n.length > MAX_PAYEE_NAME) return `Names may be at most ${MAX_PAYEE_NAME} characters`;
  if (/^[=+\-@]/.test(n)) return "Names may not start with = + - @";
  if (/[\u0000-\u001f\u007f]/.test(n)) return "Names may not contain tabs, line breaks or control characters";
  return null;
}

/** Key identifying a recipient for duplicate detection (EVM addresses compare case-insensitively). */
export function recipientKey(destinationAsset: string, recipientType: string, recipient: string): string {
  return `${destinationAsset}|${recipientType}|${/^0x/i.test(recipient) ? recipient.toLowerCase() : recipient}`;
}

type Rec = { fields: string[]; line: number };

/** RFC 4180 records. Accepts LF, CRLF or CR line ends; quotes must wrap a whole field. */
function records(text: string): { recs: Rec[] } | { error: LineError } {
  const recs: Rec[] = [];
  const len = text.length;
  let i = 0;
  let line = 1;
  while (i < len) {
    const start = line;
    const fields: string[] = [];
    for (;;) {
      let f = "";
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= len) return { error: { line: start, message: "A quoted field is never closed" } };
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              f += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
          f += c;
          i++;
        }
        if (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r")
          return { error: { line, message: "Unexpected text after a closing quote" } };
      } else {
        while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          if (text[i] === '"') return { error: { line, message: "Quotes must wrap the whole field" } };
          f += text[i++];
        }
      }
      fields.push(f);
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      line++;
      break;
    }
    if (!(fields.length === 1 && fields[0].trim() === "")) recs.push({ fields, line: start });
  }
  return { recs };
}

function rowOf(r: Rec, tokens: CsvToken[]): PayrollRow | string {
  if (r.fields.length !== HEADER.length) return `Expected ${HEADER.length} columns`;
  const [rawName, rawChain, rawToken, rawAddress, rawAmount] = r.fields.map((f) => f.trim());
  const nameError = payeeNameError(r.fields[0]);
  if (nameError) return nameError;
  const chain = rawChain.toLowerCase();
  const intents = chain === INTENTS_CHAIN;
  // NEAR Intents accounts hold NEAR-chain token ids (e.g. native USDC nep141:17208…).
  const tokenChain = intents ? "near" : chain;
  if (!intents && !supportedChain(chain)) return `Unknown chain "${rawChain.slice(0, 20)}"`;
  const matches = tokens.filter((t) => t.blockchain === tokenChain && t.symbol.toLowerCase() === rawToken.toLowerCase());
  if (matches.length === 0) return `Unknown token "${rawToken.slice(0, 20)}" on ${chain}`;
  if (matches.length > 1) return `"${rawToken.slice(0, 20)}" matches more than one token on ${chain}`;
  const t = matches[0];
  if (intents) {
    if (!validIntentsAccount(rawAddress)) return "Enter a valid NEAR account or lowercase 0x address";
  } else if (!validDestination(chain, rawAddress)) return `Enter a valid ${chain} address`;
  let amount: bigint;
  try {
    amount = baseUnits(rawAmount, t.decimals);
  } catch {
    return `Enter a positive amount with at most ${t.decimals} decimals`;
  }
  return {
    line: r.line, name: rawName, chain, symbol: t.symbol, destinationAsset: t.assetId, decimals: t.decimals,
    recipientType: intents ? "INTENTS" : "DESTINATION_CHAIN", recipient: rawAddress,
    amount: amount.toString(), amountFormatted: formatAmount(amount, t.decimals),
  };
}

/**
 * Parse a payroll CSV against the 1Click token list. `rows` holds every valid line; the upload is
 * acceptable only when `errors` is empty.
 */
export function parsePayrollCsv(text: string, tokens: CsvToken[]): { rows: PayrollRow[]; errors: LineError[] } {
  if (typeof text !== "string") return { rows: [], errors: [{ line: 0, message: "Upload a CSV file." }] };
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) return { rows: [], errors: [{ line: 0, message: "The file is larger than 64 KB." }] };
  const parsed = records(text.replace(/^﻿/, ""));
  if ("error" in parsed) return { rows: [], errors: [parsed.error] };
  const [head, ...data] = parsed.recs;
  if (!head || head.fields.length !== HEADER.length || head.fields.some((f, i) => f.trim().toLowerCase() !== HEADER[i]))
    return { rows: [], errors: [{ line: head?.line ?? 1, message: HEADER_ERROR }] };
  if (!data.length) return { rows: [], errors: [{ line: head.line, message: "The file has no payout lines." }] };
  if (data.length > MAX_PAYROLL_LINES)
    return { rows: [], errors: [{ line: data[MAX_PAYROLL_LINES].line, message: `A payout can have at most ${MAX_PAYROLL_LINES} lines.` }] };
  const rows: PayrollRow[] = [];
  const errors: LineError[] = [];
  const seen = new Map<string, number>();
  for (const r of data) {
    const row = rowOf(r, tokens);
    if (typeof row === "string") {
      errors.push({ line: r.line, message: row });
      continue;
    }
    const key = recipientKey(row.destinationAsset, row.recipientType, row.recipient);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ line: r.line, message: `Same chain, token and address as line ${first}` });
      continue;
    }
    seen.set(key, r.line);
    rows.push(row);
  }
  return { rows, errors };
}
