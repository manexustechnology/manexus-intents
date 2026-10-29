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
