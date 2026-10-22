import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSETS,
  INVOICE_KEY,
  newInvoice,
  invoiceTotals,
  issueInvoice,
  cancelInvoice,
  updateInvoice,
  parseSnapshot,
  snapshotHash,
  lifecycle,
  validateInvoice,
  validDate,
  listInvoices,
  saveInvoice,
  type InvoiceStorage,
} from "../src/invoice.ts";
const draft = () => {
  const i = newInvoice(new Date("2026-10-22T00:00:00Z"));
  i.data = {
    number: "DEMO-001",
    issuer: "Example Studio",
    client: "Demo Client",
    dueDate: "2026-11-01",
    asset: "USDC:eth",
    address: "0x2222222222222222222222222222222222222222",
    notes: "Synthetic invoice only",
    items: [
      { description: "Demo design", quantity: "3", unitPrice: "0.1" },
      { description: "Demo review", quantity: "2", unitPrice: "0.2" },
    ],
  };
  return i;
};
function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } satisfies InvoiceStorage;
}
test("invoice line totals use exact base units, never floating point", () => {
  const i = draft();
  assert.equal(invoiceTotals(i.data).formatted, "0.7");
  i.data.asset = "ETH:eth";
  i.data.items = [
    {
      description: "Tiny test",
      quantity: "3",
      unitPrice: "0.000000000000000001",
    },
  ];
  assert.equal(invoiceTotals(i.data).formatted, "0.000000000000000003");
});
test("invoice validation rejects bad quantities, prices, dates and mismatched networks", () => {
  for (const quantity of ["0", "-1", "1.5", "01", "10000", "1e3"]) {
    const i = draft();
    i.data.items[0].quantity = quantity;
    assert.throws(() => validateInvoice(i.data));
  }
  for (const price of ["0", "-1", "NaN", "1e3", "0.0000001"]) {
    const i = draft();
    i.data.items[0].unitPrice = price;
    assert.throws(() => validateInvoice(i.data));
  }
  for (const date of ["2026-02-30", "2026-13-01", "abc", "1999-01-01"])
    assert.equal(validDate(date), false);
  const i = draft();
  i.data.asset = "NEAR:near";
  assert.throws(() => validateInvoice(i.data));
});
test("all supported invoice asset/network pairs are explicit", () => {
  for (const asset of ASSETS) {
    const i = draft();
    i.data.asset = asset.key;
    i.data.address =
      asset.chain === "near"
        ? "preview.near"
        : asset.chain === "sol"
          ? "11111111111111111111111111111111"
          : i.data.address;
    assert.equal(validateInvoice(i.data).asset, asset.key);
  }
  assert.throws(() => validateInvoice({ ...draft().data, asset: "BTC:btc" }));
});
test("issuing locks content and cancellation never means paid", () => {
  const i = issueInvoice(draft());
  assert.equal(i.status, "issued");
  assert.equal(lifecycle(i, "2026-11-02"), "overdue");
  assert.throws(() => issueInvoice(i));
  assert.throws(() => updateInvoice(i, i.data));
  const cancelled = cancelInvoice(i);
  assert.equal(lifecycle(cancelled), "cancelled");
  assert.throws(() => snapshotHash(cancelled));
  assert.throws(() => cancelInvoice(draft()));
});
test("snapshot totals are recomputed and links cannot assert paid", () => {
  const i = issueInvoice(draft()),
    link = snapshotHash(i);
  assert.deepEqual(parseSnapshot(link).data, i.data);
  const raw = JSON.parse(decodeURIComponent(link.slice(9)));
  raw.total = "0";
  assert.equal(
    invoiceTotals(
      parseSnapshot("#invoice=" + encodeURIComponent(JSON.stringify(raw))).data,
    ).formatted,
    "0.7",
  );
  raw.status = "paid";
  assert.throws(() =>
    parseSnapshot("#invoice=" + encodeURIComponent(JSON.stringify(raw))),
  );
  for (const invalid of [
    "#invoice=%FF",
    "#invoice={",
    "#invoice=" + "x".repeat(16001),
  ])
    assert.throws(() => parseSnapshot(invalid));
});
test("saving repeated drafts keeps a single record; stale writers cannot overwrite", () => {
  const s = memory(),
    i = draft();
  saveInvoice(s, i, null);
  const next = updateInvoice(i, { ...i.data, client: "Next synthetic client" });
  saveInvoice(s, next, 1);
  assert.equal(listInvoices(s).length, 1);
  assert.throws(() => saveInvoice(s, updateInvoice(i, i.data), 1));
  assert.equal(listInvoices(s)[0].data.client, "Next synthetic client");
  assert.throws(() => saveInvoice(s, i, null));
});
test("corrupt storage and quota failures never silently overwrite or claim a save", () => {
  const s = memory();
  s.setItem(INVOICE_KEY, "bad JSON");
  assert.throws(() => saveInvoice(s, draft(), null));
  assert.equal(s.getItem(INVOICE_KEY), "bad JSON");
  const denied = {
    getItem: () => null,
    setItem: () => {
      throw Error("QuotaExceeded");
    },
  };
  assert.throws(() => saveInvoice(denied, draft(), null), /Could not save/);
});
test("cancelled locally does not change an existing snapshot", () => {
  const i = issueInvoice(draft()),
    link = snapshotHash(i);
  cancelInvoice(i);
  assert.equal(parseSnapshot(link).status, "issued");
  assert.ok(!("paid" in parseSnapshot(link)));
});
