import { expect, test, type Page } from "@playwright/test";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const HEADER = "name,chain,token,address,amount";

type LineState = "unsent" | "awaiting" | "sent" | "failed";
const dep = (n: number) => String(n).repeat(64).slice(0, 64);
const transfer = (n: number, status: string) => ({
  depositAddress: dep(n), originAsset: USDC, originSymbol: "USDC", amount: "1010000", amountFormatted: "1.01", destinationAsset: ARB_USDC, destinationSymbol: "USDC",
  destinationBlockchain: "arb", recipient: A1, amountOut: "1000000", amountOutFormatted: "1", minAmountOut: "1000000", minAmountOutFormatted: "1", status,
  destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false, createdAt: "t", updatedAt: "t", kind: "payroll", swapType: "EXACT_OUTPUT",
  recipientType: "DESTINATION_CHAIN", batchId: "p1",
});
const quote = (n: number) => ({ depositAddress: dep(n), deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "1", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer(n, "AWAITING_SIGNATURE") });

function batchView(states: LineState[]) {
  const lines = states.map((state, i) => {
    const n = i + 1;
    const t = state === "sent" ? transfer(n, "SUCCESS") : state === "awaiting" ? transfer(n, "AWAITING_SIGNATURE") : state === "failed" ? transfer(n, "FAILED") : undefined;
    return {
      n, name: n === 1 ? "Ana <b>A</b>" : `Payee ${n}`, destinationAsset: ARB_USDC, recipientType: "DESTINATION_CHAIN", recipient: A1, amount: "1000000",
      symbol: "USDC", blockchain: "arb", decimals: 6, amountFormatted: "1", state, canQuote: state === "unsent" || state === "failed",
      ...(t ? { depositAddress: dep(n), transfer: t } : {}), ...(state === "awaiting" ? { pendingQuote: quote(n) } : {}),
    };
  });
  const count = (s: LineState) => states.filter((x) => x === s).length;
  return {
    batch: { id: "p1", title: "October <i>pay</i>", originAsset: USDC, originSymbol: "USDC", createdAt: "2030-01-01T00:00:00.000Z" },
    lines, summary: { sent: count("sent"), processing: 0, awaiting: count("unsent") + count("awaiting"), failed: count("failed"), total: states.length },
  };
}

async function setup(page: Page, o: { states?: LineState[]; rejectSigns?: number[]; createError?: unknown } = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const states: LineState[] = o.states ?? ["unsent", "unsent", "unsent"];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const path = u.pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path: path + u.search, method: req.method(), body });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances") return r.fulfill({ json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "25000000", formatted: "25" }] });
    if (path === "/api/tokens")
      return r.fulfill({ json: [{ assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 }, { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 }] });
    if (path === "/api/payroll/payees" && req.method() === "GET") return r.fulfill({ json: [] });
    if (path === "/api/payroll/batches" && req.method() === "GET") return r.fulfill({ json: [{ id: "p0", title: "Sept <b>run</b>", originAsset: USDC, createdAt: "2030-01-01T00:00:00.000Z", total: 5, sent: 3 }] });
    if (path === "/api/payroll/batches" && req.method() === "POST")
      return o.createError ? r.fulfill({ status: 400, json: o.createError }) : r.fulfill({ status: 201, json: batchView(["unsent", "unsent"]) });
    if (path === "/api/payroll/batches/p1") return r.fulfill({ json: batchView(states) });
    const m = /^\/api\/payroll\/batches\/p1\/lines\/(\d+)\/quote$/.exec(path);
    if (m) {
      const n = Number(m[1]);
      if (!(states[n - 1] === "unsent" || states[n - 1] === "failed")) return r.fulfill({ status: 409, json: { error: "Already sent" } });
      states[n - 1] = "awaiting";
      return r.fulfill({ status: 201, json: quote(n) });
    }
    if (path === "/api/transfers/submit") {
      const n = Number(String(body.depositAddress)[0]);
      states[n - 1] = "sent";
      return r.fulfill({ json: transfer(n, "SUCCESS") });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.addInitScript(
    ([addr, sig, reject]) => {
      let signs = 0;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method }: { method: string }) {
          if (method === "eth_requestAccounts") return [addr];
          if (method === "personal_sign") {
            signs++;
            if ((reject as number[]).includes(signs)) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            return sig;
          }
          throw new Error("unsupported " + method);
        },
      };
    },
    [ADDR, SIG, o.rejectSigns ?? []] as const,
  );
  return { calls, states };
}

const quoted = (calls: { path: string }[]) => calls.map((c) => /lines\/(\d+)\/quote$/.exec(c.path)?.[1]).filter(Boolean).map(Number);

test("CSV upload: preview highlights bad lines, nothing can be created until they are fixed", async ({ page }) => {
  const { calls } = await setup(page);
  await page.goto("/#/payroll");
  await expect(page.locator("#batch-list")).toContainText("Sept <b>run</b>");
  await expect(page.locator("#batch-list")).toContainText("3/5 sent");
  await expect(page.locator("#batch-list b")).toHaveCount(0);
  await page.locator("#batch-title").fill("October");
  const bad = [HEADER, `"Doe, <b>Jane</b>",arb,USDC,${A1},1.5`, `=HYPERLINK(1),arb,USDC,${A2},1`, `Budi,arb,USDC,not-an-address,1`].join("\r\n");
  await page.locator("#csv-file").setInputFiles({ name: "pay.csv", mimeType: "text/csv", buffer: Buffer.from("﻿" + bad) });
  await expect(page.locator("#csv-preview tr.line-error")).toHaveCount(2);
  await expect(page.locator("#csv-preview tr.line-error").first()).toContainText("Names may not start with = + - @");
  await expect(page.locator("#csv-preview")).toContainText("Doe, <b>Jane</b>");
  await expect(page.locator("#csv-preview b")).toHaveCount(0);
  await expect(page.locator("#batch-create")).toBeDisabled();

  const good = [HEADER, `Ana,arb,USDC,${A1},1.5`, `Budi,near-intents,USDC,budi.near,2`].join("\n");
  await page.locator("#csv-file").setInputFiles({ name: "pay.csv", mimeType: "text/csv", buffer: Buffer.from(good) });
  await expect(page.locator("#csv-preview tr.line-error")).toHaveCount(0);
  await expect(page.locator("#csv-summary")).toContainText("2 lines");
  await page.locator("#batch-create").click();
  const post = calls.find((c) => c.path === "/api/payroll/batches" && c.method === "POST")!;
  // The server gets the raw CSV, not amounts parsed in the browser.
  expect(post.body).toEqual({ title: "October", originAsset: USDC, csv: good });
  await expect(page).toHaveURL(/#\/payroll\/p1$/);
});

test("line errors returned by the server are highlighted in the preview", async ({ page }) => {
  await setup(page, { createError: { error: "Fix the highlighted lines.", lineErrors: [{ line: 2, message: "Choose an account other than your own" }] } });
  await page.goto("/#/payroll");
  await page.locator("#batch-title").fill("October");
  await page.locator("#csv-file").setInputFiles({ name: "pay.csv", mimeType: "text/csv", buffer: Buffer.from([HEADER, `Ana,near-intents,USDC,${ADDR},1`].join("\n")) });
  await page.locator("#batch-create").click();
  await expect(page.locator("#csv-preview tr.line-error")).toHaveCount(1);
  await expect(page.locator("#csv-preview tr.line-error")).toContainText("Choose an account other than your own");
  await expect(page.locator("#batch-error")).toContainText("Fix the highlighted lines.");
});

test("send all: one signature per line, stops on a wallet rejection, sent lines are never re-sent", async ({ page }) => {
  const { calls } = await setup(page, { rejectSigns: [2] });
  await page.goto("/#/payroll/p1");
  await expect(page.getByRole("heading", { name: "October <i>pay</i>" })).toBeVisible();
  await expect(page.locator("#batch-progress")).toHaveText("0/3 sent, 3 awaiting");
  await expect(page.locator("#line-1")).toContainText("Ana <b>A</b>");
  await page.getByRole("button", { name: "Send all" }).click();
  await expect(page.getByRole("button", { name: "Start sending" })).toBeDisabled();
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
  await page.locator("#run-confirm").check();
  await page.getByRole("button", { name: "Start sending" }).click();
  await expect(page.locator("#batch-error")).toContainText("rejected");
  await expect(page.locator("#batch-progress")).toHaveText("1/3 sent, 2 awaiting");
  await expect(page.locator("#line-1 .badge")).toHaveText("Sent");
  await expect(page.locator("#line-2 .badge")).toHaveText("Waiting for signature");
  await expect(page.locator("#line-3 .badge")).toHaveText("Not sent");
  expect(quoted(calls)).toEqual([1, 2]);
  expect(calls.filter((c) => c.path === "/api/transfers/submit").length).toBe(1);

  // Running again resumes line 2's open quote and sends line 3; line 1 is never quoted again.
  await page.getByRole("button", { name: "Send all" }).click();
  await page.locator("#run-confirm").check();
  await page.getByRole("button", { name: "Start sending" }).click();
  await expect(page.locator("#batch-progress")).toHaveText("3/3 sent");
  expect(quoted(calls)).toEqual([1, 2, 3]);
  expect(calls.filter((c) => c.path === "/api/transfers/submit").map((c) => (c.body as { depositAddress: string }).depositAddress)).toEqual([dep(1), dep(2), dep(3)]);
  await expect(page.getByRole("button", { name: "Send all" })).toHaveCount(0);
});

test("a failed line can be retried on its own", async ({ page }) => {
  const { calls } = await setup(page, { states: ["sent", "failed", "sent"] });
  await page.goto("/#/payroll/p1");
  await expect(page.locator("#batch-progress")).toHaveText("2/3 sent, 1 failed");
  await expect(page.locator("#line-1 button")).toHaveCount(0);
  await page.locator("#line-2").getByRole("button", { name: "Retry" }).click();
  await page.locator("#run-confirm").check();
  await page.getByRole("button", { name: "Start sending" }).click();
  await expect(page.locator("#batch-progress")).toHaveText("3/3 sent");
  expect(quoted(calls)).toEqual([2]);
});
