import test from "node:test";
import assert from "node:assert/strict";
import { createNearRpc } from "../../server/near-rpc.ts";

function fakeFetch(reply: unknown, seen: unknown[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("viewAccessKey returns the permission", async () => {
  const seen: any[] = [];
  const rpc = createNearRpc("https://rpc.example", fakeFetch({ jsonrpc: "2.0", id: "1", result: { nonce: 1, permission: "FullAccess", block_height: 1 } }, seen));
  assert.deepEqual(await rpc.viewAccessKey("alice.near", "ed25519:abc"), { permission: "FullAccess" });
  assert.equal(seen[0].method, "query");
  assert.deepEqual(seen[0].params, { request_type: "view_access_key", finality: "final", account_id: "alice.near", public_key: "ed25519:abc" });
});

test("viewAccessKey returns null for unknown key or account", async () => {
  const handlerErr = { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } };
  assert.equal(await createNearRpc("u", fakeFetch(handlerErr)).viewAccessKey("a.near", "k"), null);
  const acct = { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
  assert.equal(await createNearRpc("u", fakeFetch(acct)).viewAccessKey("a.near", "k"), null);
  const legacy = { jsonrpc: "2.0", id: "1", result: { error: "access key ed25519:k does not exist while viewing", block_height: 1 } };
  assert.equal(await createNearRpc("u", fakeFetch(legacy)).viewAccessKey("a.near", "k"), null);
});

test("other RPC errors throw", async () => {
  const err = { jsonrpc: "2.0", id: "1", error: { name: "INTERNAL_ERROR", cause: { name: "TIMEOUT" } } };
  await assert.rejects(createNearRpc("u", fakeFetch(err)).viewAccessKey("a.near", "k"));
  const bad = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(createNearRpc("u", bad).viewAccessKey("a.near", "k"));
});

test("viewFunction encodes args and decodes the JSON result", async () => {
  const seen: any[] = [];
  const bytes = [...new TextEncoder().encode('["0"]')];
  const rpc = createNearRpc("u", fakeFetch({ jsonrpc: "2.0", id: "1", result: { result: bytes, logs: [] } }, seen));
  assert.deepEqual(await rpc.viewFunction<string[]>("intents.near", "mt_batch_balance_of", { account_id: "a.near" }), ["0"]);
  assert.equal(seen[0].params.request_type, "call_function");
  assert.equal(seen[0].params.method_name, "mt_batch_balance_of");
  assert.equal(Buffer.from(seen[0].params.args_base64, "base64").toString(), '{"account_id":"a.near"}');
});
