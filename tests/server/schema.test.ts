import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";

const insert =
  "INSERT INTO invoices (id, public_id, owner, status, token_id, data, total, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

test("invoice status CHECK constraint rejects unknown status", async () => {
  const db = createTestDb();
  await assert.rejects(
    db.prepare(insert).bind("i1", "p1", "o", "unknown", "t", "{}", "1", 1, "now", "now").run(),
  );
  const r = await db.prepare(insert).bind("i2", "p2", "o", "draft", "t", "{}", "1", 1, "now", "now").run();
  assert.equal(r.meta.changes, 1);
  const row = await db.prepare("SELECT id FROM invoices WHERE id = ?").bind("i2").first<{ id: string }>();
  assert.equal(row?.id, "i2");
});

test("d1 shim batch: statements run in one transaction and roll back together on failure", async () => {
  const db = createTestDb();
  const ins = (id: string, title: string | null) =>
    db.prepare("INSERT INTO payroll_batches (id, owner, title, origin_asset, created_at) VALUES (?, 'a.near', ?, 'x', 't')").bind(id, title);
  const r = await db.batch([ins("b1", "one"), ins("b2", "two")]);
  assert.deepEqual(r.map((x) => x.meta.changes), [1, 1]);
  await assert.rejects(db.batch([ins("b3", "three"), ins("b4", null)]));
  const n = await db.prepare("SELECT COUNT(*) AS n FROM payroll_batches").bind().first<{ n: number }>();
  assert.equal(n?.n, 2);
});
