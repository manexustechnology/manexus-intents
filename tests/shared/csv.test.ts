import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { MAX_PAYROLL_LINES, parsePayrollCsv, type CsvToken } from "../../shared/csv.ts";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const TOKENS: CsvToken[] = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
  { assetId: "nep141:sol-a.omft.near", symbol: "USDS", blockchain: "sol", decimals: 6 },
  { assetId: "nep141:sol-b.omft.near", symbol: "USDS", blockchain: "sol", decimals: 6 },
];
const ARB_ADDR = "0x2222222222222222222222222222222222222222";
const HEADER = "name,chain,token,address,amount";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");

test("valid file: rows in base units, near-intents lines are INTENTS recipients", () => {
  const r = parsePayrollCsv(csv(`Ana,arb,USDC,${ARB_ADDR},12.5`, "Budi,near-intents,usdc,budi.near,0.000001", "Citra,near,wNEAR,citra.near,1"), TOKENS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.rows.map((x) => [x.line, x.name, x.destinationAsset, x.recipientType, x.recipient, x.amount, x.amountFormatted, x.symbol, x.chain]),
    [
      [2, "Ana", ARB_USDC, "DESTINATION_CHAIN", ARB_ADDR, "12500000", "12.5", "USDC", "arb"],
      [3, "Budi", USDC, "INTENTS", "budi.near", "1", "0.000001", "USDC", "near-intents"],
      [4, "Citra", "nep141:wrap.near", "DESTINATION_CHAIN", "citra.near", "1000000000000000000000000", "1", "wNEAR", "near"],
    ],
  );
});

test("BOM, CRLF, case-insensitive header, trailing blank lines", () => {
  const text = "﻿Name,Chain,TOKEN,Address,Amount\r\nAna,arb,USDC," + ARB_ADDR + ",1\r\n\r\n";
  const r = parsePayrollCsv(text, TOKENS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].amount, "1000000");
});

test("RFC 4180 quoting: comma and doubled quote inside a quoted name", () => {
  const r = parsePayrollCsv(csv(`"Doe, ""JD"" Jane",arb,USDC,${ARB_ADDR},2`), TOKENS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].name, 'Doe, "JD" Jane');
  assert.equal(r.rows[0].line, 2);
  // A quoted line break still counts toward the line numbers that follow.
  const r2 = parsePayrollCsv(csv(`"Two\nLines",arb,USDC,${ARB_ADDR},2`, `Ok,arb,USDC,0x3333333333333333333333333333333333333333,1`), TOKENS);
  assert.deepEqual(r2.errors.map((e) => e.line), [2]);
  assert.equal(r2.rows[0].line, 4);
});

test("malformed quotes are rejected", () => {
  for (const line of [`"Ana,arb,USDC,${ARB_ADDR},1`, `"Ana"x,arb,USDC,${ARB_ADDR},1`, `An"a,arb,USDC,${ARB_ADDR},1`]) {
    const r = parsePayrollCsv(csv(line), TOKENS);
    assert.equal(r.errors.length, 1, line);
    assert.equal(r.errors[0].line, 2, line);
  }
});

test("wrong header or column count", () => {
  assert.deepEqual(parsePayrollCsv("name,token,chain,address,amount\nAna,USDC,arb,x,1", TOKENS).errors, [{ line: 1, message: "The first line must be: name,chain,token,address,amount" }]);
  assert.equal(parsePayrollCsv("", TOKENS).errors.length, 1);
  assert.deepEqual(parsePayrollCsv(HEADER + "\n", TOKENS).errors, [{ line: 1, message: "The file has no payout lines." }]);
  const r = parsePayrollCsv(csv(`Ana,arb,USDC,${ARB_ADDR}`, `Budi,arb,USDC,${ARB_ADDR},1,extra`), TOKENS);
  assert.deepEqual(r.errors.map((e) => [e.line, e.message]), [[2, "Expected 5 columns"], [3, "Expected 5 columns"]]);
});

test("formula-injection prefixes in names are rejected", () => {
  for (const name of ["=HYPERLINK(1)", "+1", "-2", "@SUM(A1)", "  =1"]) {
    const r = parsePayrollCsv(csv(`${name},arb,USDC,${ARB_ADDR},1`), TOKENS);
    assert.deepEqual(r.errors, [{ line: 2, message: "Names may not start with = + - @" }], name);
    assert.deepEqual(r.rows, []);
  }
  assert.equal(parsePayrollCsv(csv(`${"x".repeat(65)},arb,USDC,${ARB_ADDR},1`), TOKENS).errors[0].message, "Names may be at most 64 characters");
  assert.equal(parsePayrollCsv(csv(` ,arb,USDC,${ARB_ADDR},1`), TOKENS).errors[0].message, "Enter a name");
  assert.equal(parsePayrollCsv(csv(`"A\tB",arb,USDC,${ARB_ADDR},1`), TOKENS).errors.length, 1);
});

test("duplicate (chain, token, address) rows are rejected", () => {
  const lower = "0xabcdef0123456789abcdef0123456789abcdef01";
  const r = parsePayrollCsv(csv(`Ana,arb,USDC,${lower},1`, `Ana again,ARB,USDC,${getAddress(lower)},2`), TOKENS);
  assert.deepEqual(r.errors, [{ line: 3, message: "Same chain, token and address as line 2" }]);
});

test("unknown chain or token, ambiguous symbol", () => {
  const r = parsePayrollCsv(
    csv(`A,arb,USDX,${ARB_ADDR},1`, `B,mars,USDC,${ARB_ADDR},1`, `C,sol,USDS,So11111111111111111111111111111111111111112,1`),
    TOKENS,
  );
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4]);
  assert.match(r.errors[0].message, /Unknown token/);
  assert.match(r.errors[1].message, /Unknown chain/);
  assert.match(r.errors[2].message, /more than one token/);
});

test("invalid address for the chain, invalid NEAR Intents account", () => {
  const r = parsePayrollCsv(csv("A,arb,USDC,budi.near,1", "B,near-intents,USDC,Not An Account,1", "C,near-intents,USDC,0xABCDEF0123456789abcdef0123456789abcdef01,1"), TOKENS);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4]);
  assert.match(r.errors[0].message, /arb address/);
});

test("amounts: decimals beyond the token's precision, zero, negative, not a number", () => {
  const r = parsePayrollCsv(
    csv(`A,arb,USDC,${ARB_ADDR},1.0000001`, `B,arb,USDC,0x3333333333333333333333333333333333333333,0`, `C,arb,USDC,0x4444444444444444444444444444444444444444,-1`, `D,arb,USDC,0x5555555555555555555555555555555555555555,1e3`),
    TOKENS,
  );
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4, 5]);
  assert.match(r.errors[0].message, /at most 6 decimals/);
});

test("more than 50 lines: a single error, no rows", () => {
  const lines = Array.from({ length: MAX_PAYROLL_LINES + 1 }, (_, i) => `P${i},arb,USDC,0x${(i + 1).toString(16).padStart(40, "0")},1`);
  const r = parsePayrollCsv(csv(...lines), TOKENS);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.errors, [{ line: 52, message: "A payout can have at most 50 lines." }]);
  assert.equal(parsePayrollCsv(csv(...lines.slice(0, 50)), TOKENS).errors.length, 0);
});

test("files over 64 KB are rejected", () => {
  const r = parsePayrollCsv(csv(`Ana,arb,USDC,${ARB_ADDR},1`) + "\n" + " ".repeat(65_536), TOKENS);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.errors, [{ line: 0, message: "The file is larger than 64 KB." }]);
});

test("one bad line rejects nothing else silently: errors and good rows are both reported", () => {
  const r = parsePayrollCsv(csv(`Ana,arb,USDC,${ARB_ADDR},1`, "=cmd,arb,USDC,x,1"), TOKENS);
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 1);
});
