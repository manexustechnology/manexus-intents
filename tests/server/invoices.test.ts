import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import { cancelInvoice, createInvoice, getInvoice, getPublicInvoice, issueInvoice, listInvoices, updateInvoice } from "../../server/invoices.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";

const A = "alice.near";
const B = "0x1111111111111111111111111111111111111111";
const draft: InvoiceDraft = {
  number: "DEMO-001",
  client: "Demo Client",
  issuer: "Example Studio",
  dueDate: "2030-01-31",
  tokenId: SETTLEMENT_TOKENS[0].tokenId,
  notes: "",
  items: [
    { description: "Design", quantity: "3", unitPrice: "0.1" },
    { description: "Build", quantity: "2", unitPrice: "0.2" },
  ],
};
const NOW = "2030-01-01T00:00:00.000Z";
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

test("create makes a draft at revision 1", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  assert.equal(inv.status, "draft");
  assert.equal(inv.revision, 1);
  assert.equal(inv.owner, A);
  assert.equal(inv.total, "700000");
  assert.ok(inv.publicId.length >= 20);
  assert.deepEqual({ ...(await getInvoice(db, A, inv.id)) }, { ...inv });
});

test("other owners cannot read or list an invoice", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  assert.equal(await status(getInvoice(db, B, inv.id)), 404);
  assert.equal(await status(updateInvoice(db, B, inv.id, 1, draft, NOW)), 404);
  assert.equal(await status(issueInvoice(db, B, inv.id, NOW)), 404);
  assert.equal(await status(cancelInvoice(db, B, inv.id, NOW)), 404);
  assert.deepEqual(await listInvoices(db, B), []);
  assert.equal((await listInvoices(db, A)).length, 1);
});

test("stale revision conflicts", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  const u = await updateInvoice(db, A, inv.id, 1, { ...draft, number: "X" }, NOW);
  assert.equal(u.revision, 2);
  assert.equal(u.data.number, "X");
  assert.equal(await status(updateInvoice(db, A, inv.id, 1, draft, NOW)), 409);
});

test("issue locks the invoice", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  const issued = await issueInvoice(db, A, inv.id, NOW);
  assert.equal(issued.status, "issued");
  assert.equal(issued.total, "700000");
  assert.equal(issued.issuedAt, NOW);
  assert.equal(await status(updateInvoice(db, A, inv.id, issued.revision, draft, NOW)), 409);
  assert.equal(await status(issueInvoice(db, A, inv.id, NOW)), 409);
});

test("issue rejects an incomplete draft", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, { ...draft, client: "" }, NOW);
  assert.equal(await status(issueInvoice(db, A, inv.id, NOW)), 400);
  assert.equal((await getInvoice(db, A, inv.id)).status, "draft");
});

test("cancel works only from issued", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  assert.equal(await status(cancelInvoice(db, A, inv.id, NOW)), 409);
  await issueInvoice(db, A, inv.id, NOW);
  assert.equal((await cancelInvoice(db, A, inv.id, NOW)).status, "cancelled");
  assert.equal(await status(cancelInvoice(db, A, inv.id, NOW)), 409);
});

test("public invoice hides drafts and exposes payTo", async () => {
  const db = createTestDb();
  const inv = await createInvoice(db, A, draft, NOW);
  assert.equal(await status(getPublicInvoice(db, inv.publicId)), 404);
  assert.equal(await status(getPublicInvoice(db, "nope")), 404);
  await issueInvoice(db, A, inv.id, NOW);
  const p = await getPublicInvoice(db, inv.publicId);
  assert.equal(p.payTo, A);
  assert.equal(p.totalFormatted, "0.7");
  assert.equal(p.symbol, "USDC");
  assert.equal(p.status, "issued");
  assert.equal(p.total, "700000");
  assert.equal((p as Record<string, unknown>).owner, undefined);
});

test("list is capped and ordered by updated_at desc", async () => {
  const db = createTestDb();
  const a = await createInvoice(db, A, draft, "2030-01-01T00:00:00.000Z");
  const b = await createInvoice(db, A, draft, "2030-01-02T00:00:00.000Z");
  assert.deepEqual((await listInvoices(db, A)).map((i) => i.id), [b.id, a.id]);
});
