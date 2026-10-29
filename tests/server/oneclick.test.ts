import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOneClick, type QuoteRequest } from "../../server/oneclick.ts";
import { HttpError } from "../../server/http.ts";

const fx = JSON.parse(readFileSync("tests/fixtures/oneclick/quote-pay-exact-output.json", "utf8"));
type Call = { url: string; init: RequestInit };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const req = (dry: boolean) => ({ ...fx.quoteRequest, dry }) as QuoteRequest;
const withDeposit = () => ({ ...fx, quote: { ...fx.quote, depositAddress: "dep123" } });

test("quote parses, sends api key only when set", async () => {
  let h = fake(201, withDeposit());
  const q = await createOneClick({ baseUrl: "https://x", apiKey: "k", fetch: h.f }).quote(req(false));
  assert.equal(q.depositAddress, "dep123");
  assert.equal(q.amountIn, "1010180");
  assert.equal(q.minAmountOut, "1000000");
  assert.equal(q.timeEstimate, 25);
  assert.equal((h.calls[0].init.headers as any)["X-API-Key"], "k");
  h = fake(201, withDeposit());
  await createOneClick({ baseUrl: "https://x", fetch: h.f }).quote(req(false));
  assert.equal((h.calls[0].init.headers as any)["X-API-Key"], undefined);
});

test("quote without depositAddress fails when not dry", async () => {
  const h = fake(201, fx);
  await assert.rejects(createOneClick({ baseUrl: "https://x", fetch: h.f }).quote(req(false)), (e: any) => e instanceof HttpError && e.status === 502);
  await createOneClick({ baseUrl: "https://x", fetch: h.f }).quote(req(true));
});

test("status maps upstream shape", async () => {
  const h = fake(200, {
    status: "SUCCESS",
    updatedAt: "t",
    quoteResponse: { quoteRequest: fx.quoteRequest },
    swapDetails: { amountOut: "5", originChainTxHashes: [{ hash: "a" }], destinationChainTxHashes: [{ hash: "b" }] },
  });
  const oc = createOneClick({ baseUrl: "https://x", fetch: h.f });
  const s = await oc.status("dep", "memo");
  assert.match(h.calls[0].url, /\/v0\/status\?depositAddress=dep&depositMemo=memo$/);
  assert.deepEqual([s.status, s.amountOut, s.originTxHashes, s.destinationTxHashes], ["SUCCESS", "5", ["a"], ["b"]]);
  assert.equal(s.depositAddress, undefined);
  const h3 = fake(200, { status: "PROCESSING", updatedAt: "t", quoteResponse: { quoteRequest: fx.quoteRequest, quote: { depositAddress: "dep" } } });
  assert.equal((await createOneClick({ baseUrl: "https://x", fetch: h3.f }).status("dep")).depositAddress, "dep");
  const h2 = fake(200, { status: "WEIRD", updatedAt: "t" });
  await assert.rejects(createOneClick({ baseUrl: "https://x", fetch: h2.f }).status("d"), (e: any) => e.status === 502);
});

test("upstream error becomes 502", async () => {
  const h = fake(400, { message: "bad" });
  await assert.rejects(createOneClick({ baseUrl: "https://x", fetch: h.f }).quote(req(false)), (e: any) => e instanceof HttpError && e.status === 502 && e.message === "NEAR Intents: bad");
});

test("intent endpoints", async () => {
  let h = fake(200, { intent: { standard: "nep413", payload: { a: 1 } }, correlationId: "c" });
  const oc = createOneClick({ baseUrl: "https://x", fetch: h.f });
  assert.deepEqual(await oc.generateIntent({ depositAddress: "d", signerId: "s", standard: "nep413" }), { standard: "nep413", payload: { a: 1 } });
  assert.deepEqual(JSON.parse(h.calls[0].init.body as string), { type: "swap_transfer", standard: "nep413", signerId: "s", depositAddress: "d" });
  h = fake(200, { intentHash: "H" });
  const oc2 = createOneClick({ baseUrl: "https://x", fetch: h.f });
  assert.deepEqual(await oc2.submitIntent({ z: 1 }), { intentHash: "H" });
  assert.deepEqual(JSON.parse(h.calls[0].init.body as string), { type: "swap_transfer", signedData: { z: 1 } });
  h = fake(200, {});
  await createOneClick({ baseUrl: "https://x", fetch: h.f }).submitDeposit("tx", "d");
  assert.deepEqual(JSON.parse(h.calls[0].init.body as string), { txHash: "tx", depositAddress: "d" });
});

test("injected fetch is called bare, never as a method (workerd throws Illegal invocation)", async () => {
  const body = JSON.stringify([{ assetId: "a", symbol: "A", blockchain: "near", decimals: 6 }]);
  const strict = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(body));
  } as unknown as typeof fetch;
  const tokens = await createOneClick({ baseUrl: "https://x", fetch: strict }).tokens();
  assert.equal(tokens[0].assetId, "a");
});

test("status without quoteRequest parses with quoteRequest undefined (decided later, not an upstream error)", async () => {
  const h = fake(200, { status: "SUCCESS", updatedAt: "t", swapDetails: { amountOut: "5" } });
  const s = await createOneClick({ baseUrl: "https://x", fetch: h.f }).status("dep");
  assert.equal(s.status, "SUCCESS");
  assert.equal(s.quoteRequest, undefined);
});
