import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError, handle, json, readJson, rejectCrossOrigin } from "../../server/http.ts";

test("handle maps HttpError to status and error body", async () => {
  const res = await handle(async () => {
    throw new HttpError(404, "Not found");
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
});

test("handle hides unexpected errors", async () => {
  const res = await handle(async () => {
    throw new Error("secret");
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Internal error" });
});

test("handle passes through successful responses", async () => {
  const res = await handle(async () => json({ ok: true }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

const post = (body: string) => new Request("http://x/", { method: "POST", body });

test("readJson rejects oversized bodies with 413", async () => {
  await assert.rejects(readJson(post("a".repeat(20000))), (e: unknown) => e instanceof HttpError && e.status === 413);
});

test("readJson rejects invalid JSON with 400", async () => {
  await assert.rejects(readJson(post("{nope")), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("readJson parses valid JSON", async () => {
  assert.deepEqual(await readJson(post('{"a":1}')), { a: 1 });
});

test("rejectCrossOrigin blocks non-GET requests from another origin", async () => {
  const req = (method: string, origin?: string) =>
    new Request("https://app.example/api/x", { method, headers: origin ? { origin } : {} });
  const blocked = rejectCrossOrigin(req("POST", "https://evil.example"));
  assert.equal(blocked?.status, 403);
  assert.deepEqual(await blocked?.json(), { error: "Cross-origin request rejected" });
  assert.equal(rejectCrossOrigin(req("POST", "null"))?.status, 403);
  assert.equal(rejectCrossOrigin(req("DELETE", "https://app.example:444"))?.status, 403);
  assert.equal(rejectCrossOrigin(req("POST", "https://app.example")), null);
  assert.equal(rejectCrossOrigin(req("POST")), null);
  assert.equal(rejectCrossOrigin(req("GET", "https://evil.example")), null);
  assert.equal(rejectCrossOrigin(req("HEAD", "https://evil.example")), null);
});
