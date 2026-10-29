// Route-layer smoke tests: real functions/api handlers with a fake env and a `this`-strict global fetch,
// so wiring bugs (e.g. calling an injected fetch as a method, which workerd rejects) fail `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDb } from "./d1-shim.ts";
import { createInvoice, issueInvoice } from "../../server/invoices.ts";
import { signSession } from "../../server/session.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { Env } from "../../server/env.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";
import { onRequestGet as tokensGet } from "../../functions/api/tokens.ts";
import { onRequestGet as balancesGet } from "../../functions/api/balances.ts";
import { onRequestPost as quotePost } from "../../functions/api/public/invoices/[publicId]/quote.ts";
import { onRequestGet as statusGet } from "../../functions/api/public/invoices/[publicId]/status.ts";

const TOKENS = readFileSync("tests/fixtures/oneclick/tokens.json", "utf8");
const QUOTE = JSON.parse(readFileSync("tests/fixtures/oneclick/quote-pay-exact-output.json", "utf8"));
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const SECRET = "s".repeat(32);
const OWNER = "alice.near";
const USDC = SETTLEMENT_TOKENS[0].tokenId;
const draft: InvoiceDraft = { number: "R-1", client: "C", issuer: "I", dueDate: "2030-01-31", tokenId: USDC, notes: "", items: [{ description: "x", quantity: "1", unitPrice: "1" }] };

type Route = (req: Request) => Response | Promise<Response>;

/** Replaces globalThis.fetch with a stub that, like workerd, throws unless called with no receiver. */
async function withStrictFetch<T>(route: Route, run: (urls: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    const req = new Request(input, init);
    urls.push(req.url);
    return Promise.resolve(route(req));
  } as typeof fetch;
  try {
    return await run(urls);
  } finally {
    globalThis.fetch = real;
  }
}

const upstream: Route = async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/v0/tokens") return new Response(TOKENS);
  if (u.pathname === "/v0/quote") {
    const r = await req.json();
    return new Response(JSON.stringify({ quote: { ...QUOTE.quote, amountOut: r.amount, depositAddress: "dep-route" }, quoteRequest: r }), { status: 201 });
  }
  if (u.pathname === "/v0/status")
    return new Response(JSON.stringify({ status: "PENDING_DEPOSIT", updatedAt: "t", quoteResponse: { quoteRequest: QUOTE.quoteRequest } }));
  if (u.hostname === "rpc.test") {
    const ids = JSON.parse(atob((await req.json()).params.args_base64)).token_ids as string[];
    const bytes = [...new TextEncoder().encode(JSON.stringify(ids.map(() => "1000000")))];
    return Response.json({ jsonrpc: "2.0", id: "manexus", result: { result: bytes } });
  }
  return new Response("not found", { status: 404 });
};

function ctx(req: Request, env: Env, params: Record<string, string> = {}) {
  return { request: req, env, params } as unknown as Parameters<PagesFunction<Env>>[0];
}
const envWith = (): Env => ({ DB: createTestDb(), SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.test/", ONECLICK_BASE_URL: "https://oneclick.test" });

test("GET /api/tokens reaches 1Click through the global fetch", async () => {
  await withStrictFetch(upstream, async (urls) => {
    const res = await tokensGet(ctx(new Request("https://app.test/api/tokens"), envWith()));
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { assetId: string }[];
    assert.ok(body.some((t) => t.assetId === "nep141:wrap.near"));
    assert.deepEqual(urls, ["https://oneclick.test/v0/tokens"]);
  });
});

test("GET /api/balances reads intents.near via RPC and token metadata via 1Click", async () => {
  await withStrictFetch(upstream, async (urls) => {
    const cookie = `mx_session=${await signSession(OWNER, "near", SECRET)}`;
    const res = await balancesGet(ctx(new Request("https://app.test/api/balances", { headers: { cookie } }), envWith()));
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { tokenId: string; amount: string }[];
    assert.equal(body.find((b) => b.tokenId === USDC)?.amount, "1000000");
    assert.deepEqual(urls.sort(), ["https://oneclick.test/v0/tokens", "https://rpc.test/"]);
  });
});

test("public quote and status routes reach 1Click", async () => {
  const env = envWith();
  const at = "2030-01-01T00:00:00.000Z";
  const inv = await issueInvoice(env.DB, OWNER, (await createInvoice(env.DB, OWNER, draft, at)).id, at);
  await withStrictFetch(upstream, async () => {
    const res = await quotePost(
      ctx(new Request("https://app.test/q", { method: "POST", body: JSON.stringify({ originAsset: ARB, refundTo: "0x0000000000000000000000000000000000000001" }) }), env, { publicId: inv.publicId }),
    );
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal(((await res.json()) as { depositAddress: string }).depositAddress, "dep-route");
    const st = await statusGet(ctx(new Request("https://app.test/s"), env, { publicId: inv.publicId }));
    assert.equal(st.status, 200, await st.clone().text());
    const sb = (await st.json()) as { invoiceStatus: string; refreshError?: string };
    assert.equal(sb.invoiceStatus, "issued");
    assert.equal(sb.refreshError, undefined);
  });
});
