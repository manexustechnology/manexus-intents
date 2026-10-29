import { expect, test, type Page } from "@playwright/test";
import { base58 } from "@scure/base";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "nep141:usdt.tether-token.near";
const DEP = "d".repeat(64);
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";
const MESSAGE = `Manexus policy v1\nAccount: ${ADDR}\nHash: ${"ab".repeat(32)}\nNonce: Tm9uY2U=`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const proposal = (id: string, type: string, params: Record<string, string>, status = "proposed") => ({
  id, type, dedupKey: `${type}:${id}`, params, status, createdAt: "t", updatedAt: "t", expiresAt: "2999-01-01T00:00:00.000Z",
});
const transfer = (status: string) => ({
  depositAddress: DEP, originAsset: USDT, originSymbol: "USDT", amount: "120000000", amountFormatted: "120",
  destinationAsset: USDC, destinationSymbol: "USDC", destinationBlockchain: "near", recipient: ADDR,
  amountOut: "119900000", amountOutFormatted: "119.9", minAmountOut: "118700000", minAmountOutFormatted: "118.7",
  status, destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false, createdAt: "t", updatedAt: "t",
  kind: "swap", swapType: "EXACT_INPUT", recipientType: "INTENTS",
});
const POLICY = {
  version: 1,
  convert: { enabled: true, targetTokenId: USDC, minUsdCents: 1000 },
  sweep: { enabled: true, tokenId: USDC, thresholdUnits: "600000000", keepUnits: "100000000", whitelistId: "w1" },
  reminders: { billDueDays: 3, invoiceOverdueDays: 7 },
};

async function setup(page: Page, saved: unknown = POLICY) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let proposals = [
    proposal("p1", "convert", { originAsset: USDT, destinationAsset: USDC, amount: "120000000" }),
    proposal("p2", "sweep", { originAsset: USDC, amount: "500000000", whitelistId: "w1" }),
    proposal("p3", "pay_bill", { billId: "b1" }),
    proposal("p4", "follow_up_invoice", { invoiceId: "i1", publicId: "PubId123" }),
  ];
  let policy: unknown = saved;
  let whitelist = [{ id: "w1", label: "Binance <i>deposit</i>", destinationAsset: USDC, recipientType: "INTENTS", recipient: "cold.near", createdAt: "t" }];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const path = u.pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path: path + u.search, method: req.method(), body });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [
        { tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "600000000", formatted: "600", usd: "600.00" },
        { tokenId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, amount: "120000000", formatted: "120", usd: "120.00" },
      ] });
    if (path === "/api/tokens")
      return r.fulfill({ json: [
        { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
        { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, price: 1 },
      ] });
    if (path === "/api/bills")
      return r.fulfill({ json: u.searchParams.get("status") === "scheduled" ? [{ id: "b1", vendor: "Acme <b>Co</b>", reference: "INV-7", dueDate: "2026-11-05", destinationAsset: USDC, recipientType: "INTENTS", recipient: "acme.near", amount: "1000000", amountFormatted: "1", symbol: "USDC", blockchain: "near", decimals: 6, source: "manual", status: "scheduled", overdue: false, createdAt: "t", updatedAt: "t" }] : [] });
    if (path === "/api/invoices")
      return r.fulfill({ json: [{ id: "i1", publicId: "PubId123", status: "issued", owner: ADDR, tokenId: USDC, total: "1", revision: 1, createdAt: "t", updatedAt: "t", data: { number: "INV-3", client: "Client", issuer: "Me", dueDate: day(-9), tokenId: USDC, notes: "", items: [] } }] });
    if (path === "/api/agent/proposals") return r.fulfill({ json: proposals });
    if (path === "/api/agent/policy" && req.method() === "GET") return r.fulfill({ json: { policy, hash: "h", updatedAt: "t" } });
    if (path === "/api/agent/policy" && req.method() === "PUT") {
      policy = (body as { policy: unknown }).policy;
      return r.fulfill({ json: { policy, hash: "h2", updatedAt: "t" } });
    }
    if (path === "/api/agent/policy/challenge") return r.fulfill({ json: { nonce: "Tm9uY2U=", message: MESSAGE, recipient: "manexus", hash: "ab".repeat(32) } });
    if (path === "/api/agent/whitelist" && req.method() === "GET") return r.fulfill({ json: whitelist });
    if (path === "/api/agent/whitelist" && req.method() === "POST") {
      const e = { ...(body as { entry: Record<string, string> }).entry, id: "w2", createdAt: "t" };
      whitelist = [...whitelist, e as never];
      return r.fulfill({ status: 201, json: e });
    }
    if (path === "/api/agent/proposals/p1/approve")
      return r.fulfill({ status: 201, json: { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "119.9", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer("AWAITING_SIGNATURE") } });
    if (path === "/api/agent/proposals/p4/approve") return r.fulfill({ json: { followUp: { payUrl: "http://127.0.0.1/#/pay/PubId123" } } });
    if (path === "/api/agent/proposals/p2/dismiss") {
      proposals = proposals.filter((p) => p.id !== "p2");
      return r.fulfill({ json: { ...proposal("p2", "sweep", {}), status: "dismissed" } });
    }
    if (path === "/api/transfers/submit") {
      proposals = proposals.map((p) => (p.id === "p1" ? { ...p, status: "executing", depositAddress: DEP } : p));
      return r.fulfill({ json: { ...transfer("PROCESSING"), intentHash: "H" } });
    }
    if (path === `/api/transfers/${DEP}`) {
      proposals = proposals.filter((p) => p.id !== "p1"); // done
      return r.fulfill({ json: transfer("SUCCESS") });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.addInitScript(
    ([addr, sig]) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method }: { method: string }) {
          if (method === "eth_requestAccounts") return [addr];
          if (method === "personal_sign") return sig;
          throw new Error("unsupported " + method);
        },
      };
    },
    [ADDR, SIG],
  );
  await page.clock.install();
  return calls;
}

test("inbox: plain-language reasons, owner data escaped; approve → review → sign → done", async ({ page }, info) => {
  const calls = await setup(page);
  await page.goto("/#/agent");
  const inbox = page.locator("#ag-inbox");
  await expect(inbox.locator(".agent-reason").nth(0)).toHaveText("Convert 120 USDT → USDC (≈ $120.00 reference price)");
  await expect(inbox.locator(".agent-reason").nth(1)).toHaveText("Sweep 500 USDC to Binance <i>deposit</i> (keeps 100 USDC)");
  await expect(inbox.locator(".agent-reason").nth(2)).toHaveText("Pay bill INV-7 to Acme <b>Co</b> (due 2026-11-05)");
  await expect(inbox.locator(".agent-reason").nth(3)).toHaveText("Invoice INV-3 is 9 days overdue — send the pay link");
  await expect(page.locator("#ag-inbox b, #ag-inbox i, #ag-wl i")).toHaveCount(0);

  await inbox.locator('.ag-approve[data-proposal="p1"]').click();
  await expect(page.locator("#ag-send")).toHaveText("120 USDT");
  await expect(page.locator("#ag-receive")).toHaveText("≈ 119.9 USDC");
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#ag-track-status")).toHaveText("Processing");
  const submit = calls.find((c) => c.path === "/api/transfers/submit")!;
  const bytes = new Uint8Array(65).fill(0x11);
  bytes[64] = 1;
  expect(submit.body).toEqual({ depositAddress: DEP, signedData: { standard: "erc191", payload: PAYLOAD, signature: "secp256k1:" + base58.encode(bytes) } });
  await page.clock.runFor(5_100);
  await expect(page.locator("#ag-track-status")).toHaveText("Done");
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(inbox.locator('[data-proposal="p1"]')).toHaveCount(0);
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);

  // Desktop sidebar lists Agent; on mobile it is under More.
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  if (info.project.name === "mobile") {
    await expect(nav.getByRole("link", { name: "Agent" })).toBeHidden();
    await nav.getByRole("button", { name: "More" }).click();
  }
  await expect(nav.getByRole("link", { name: "Agent" })).toBeVisible();
});

test("dismiss removes the card; follow-up shows the pay link", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/agent");
  await page.locator('.ag-dismiss[data-proposal="p2"]').click();
  await expect(page.locator('#ag-inbox [data-proposal="p2"]')).toHaveCount(0);
  expect(calls.some((c) => c.path === "/api/agent/proposals/p2/dismiss" && c.method === "POST")).toBe(true);
  await page.locator('.ag-approve[data-proposal="p4"]').click();
  await expect(page.locator("#ag-pay-url")).toHaveText("http://127.0.0.1/#/pay/PubId123");
});

test("rules save shows the message to sign, then sends the signed policy", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/agent");
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.locator("#ag-sweep-threshold")).toHaveValue("600");
  await page.locator("#ag-convert-min").fill("25");
  await page.locator(`.ag-cap-tx[data-token="${USDC}"]`).fill("50");
  await page.locator("#ag-wl-only").check();
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  const expected = {
    version: 1,
    convert: { enabled: true, targetTokenId: USDC, minUsdCents: 2500 },
    sweep: POLICY.sweep,
    reminders: POLICY.reminders,
    limits: { perTx: { [USDC]: "50000000" }, daily: {}, whitelistOnly: true },
  };
  expect(calls.find((c) => c.path === "/api/agent/policy/challenge")!.body).toEqual({ kind: "policy", policy: expected });
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  await page.locator("#ag-sign-go").click();
  await expect(page.locator("#ag-rules-note")).toHaveText("Rules saved.");
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ policy: expected, nonce: "Tm9uY2U=", signature: SIG });
  await expect(page.locator("#ag-sign-step")).toHaveCount(0);
});

test("whitelist add is signed too", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/agent");
  await page.locator("#ag-wl-label").fill("Ops wallet");
  await page.locator("#ag-wl-dest").selectOption(USDT);
  await page.locator("#ag-wl-type").selectOption("INTENTS");
  await page.locator("#ag-wl-recipient").fill("ops.near");
  await page.getByRole("button", { name: "Add to whitelist" }).click();
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  await page.locator("#ag-sign-go").click();
  await expect(page.locator("#ag-wl-note")).toHaveText("Address added.");
  const entry = { label: "Ops wallet", destinationAsset: USDT, recipientType: "INTENTS", recipient: "ops.near" };
  expect(calls.find((c) => c.path === "/api/agent/policy/challenge")!.body).toEqual({ kind: "whitelist_add", entry });
  expect(calls.find((c) => c.path === "/api/agent/whitelist" && c.method === "POST")!.body).toEqual({ entry, nonce: "Tm9uY2U=", signature: SIG });
  await expect(page.locator(".wl-entry")).toHaveCount(2);
});

test("home shows the agent suggestions card; the agent page has no horizontal scroll", async ({ page }) => {
  await setup(page);
  await page.goto("/#/");
  await page.getByRole("link", { name: "Agent suggestions (4)" }).click();
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
  await expect(page.locator(".agent-reason")).toHaveCount(4);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("AI not configured: describe box and summary are hidden, the rest of the page works", async ({ page }) => {
  await setup(page); // /api/agent/ai-status is not mocked: 404
  await page.goto("/#/agent");
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.locator("#ag-ai-text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft rules" })).toHaveCount(0);
  await expect(page.locator("#ag-ai-summary")).toHaveText("AI features are not configured.");
  await expect(page.locator("#ag-inbox .agent-reason")).toHaveCount(4);
});

test("AI draft fills the Rules form without saving; summary is escaped text", async ({ page }) => {
  const calls = await setup(page);
  const draft = { version: 1, convert: { enabled: true, targetTokenId: USDC, minUsdCents: 7500 }, reminders: { billDueDays: 5, invoiceOverdueDays: 9 } };
  await page.route("**/api/agent/ai-status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/summary", (r) => r.fulfill({ json: { text: "You hold <b>600</b> USDC.", at: "t" } }));
  await page.route("**/api/agent/policy/draft", (r) => r.fulfill({ json: { policy: draft, notes: "Converts above $75 <i>only</i>." } }));
  await page.goto("/#/agent");
  await expect(page.locator("#ag-ai-summary")).toContainText("You hold <b>600</b> USDC.");
  await expect(page.locator("#ag-ai-summary b")).toHaveCount(0);
  await page.locator("#ag-ai-text").fill("convert over 75 dollars");
  await page.getByRole("button", { name: "Draft rules" }).click();
  await expect(page.locator("#ag-convert-min")).toHaveValue("75.00");
  await expect(page.locator("#ag-bill-days")).toHaveValue("5");
  await expect(page.locator("#ag-ai-draft")).toContainText("Converts above $75 <i>only</i>. Review and sign to save.");
  await expect(page.locator("#ag-ai-draft i")).toHaveCount(0);
  expect(calls.some((c) => c.method === "PUT" || c.path === "/api/agent/policy/challenge")).toBe(false);
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  expect(calls.find((c) => c.path === "/api/agent/policy/challenge")!.body).toMatchObject({ kind: "policy", policy: { convert: { minUsdCents: 7500 } } });
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("AI 503 (402/429/timeout) shows a message and the rest of the Agent page keeps working", async ({ page }) => {
  await setup(page);
  await page.route("**/api/agent/ai-status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/summary", (r) => r.fulfill({ status: 503, json: { error: "AI is unavailable right now" } }));
  await page.route("**/api/agent/policy/draft", (r) => r.fulfill({ status: 503, json: { error: "AI is unavailable right now" } }));
  await page.goto("/#/agent");
  await expect(page.locator("#ag-ai-summary")).toHaveText("AI is unavailable right now");
  await page.locator("#ag-ai-text").fill("anything");
  await page.getByRole("button", { name: "Draft rules" }).click();
  await expect(page.locator("#ag-ai-draft .error")).toHaveText("AI is unavailable right now");
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.locator("#ag-inbox .agent-reason")).toHaveCount(4);
  await page.locator('.ag-dismiss[data-proposal="p2"]').click();
  await expect(page.locator("#ag-inbox .agent-reason")).toHaveCount(3);
});

test("Discard draft resets the Rules form to the saved policy", async ({ page }) => {
  const calls = await setup(page);
  const draft = { version: 1, convert: { enabled: false, targetTokenId: USDC, minUsdCents: 7500 }, sweep: { ...POLICY.sweep, enabled: false }, reminders: { billDueDays: 5, invoiceOverdueDays: 9 } };
  await page.route("**/api/agent/ai-status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/summary", (r) => r.fulfill({ json: { text: "Summary.", at: "t" } }));
  await page.route("**/api/agent/policy/draft", (r) => r.fulfill({ json: { policy: draft, notes: "Draft notes." } }));
  await page.goto("/#/agent");
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.getByRole("button", { name: "Discard draft" })).toBeHidden();
  await page.locator("#ag-ai-text").fill("convert over 75 dollars");
  await page.getByRole("button", { name: "Draft rules" }).click();
  await expect(page.locator("#ag-convert-min")).toHaveValue("75.00");
  await expect(page.locator("#ag-sweep-on")).not.toBeChecked();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.locator("#ag-bill-days")).toHaveValue("3");
  await expect(page.locator("#ag-sweep-on")).toBeChecked();
  await expect(page.locator("#ag-sweep-threshold")).toHaveValue("600");
  await expect(page.locator("#ag-ai-draft")).not.toContainText("Draft notes.");
  await expect(page.locator("#ag-rules-note")).toHaveText("Draft discarded. These are your saved rules.");
  await expect(page.getByRole("button", { name: "Discard draft" })).toBeHidden();
  // Unsaved manual edits can be discarded too, including an open signing step.
  await page.locator("#ag-convert-min").fill("33");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.locator("#ag-convert-min")).toHaveValue("10.00");
  await expect(page.locator("#ag-sign-step")).toHaveCount(0);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

const LIMITED = { ...POLICY, limits: { perTx: { [USDC]: "50000000" }, daily: { [USDC]: "200000000" }, whitelistOnly: true } };
async function withDraft(page: Page, draft: unknown) {
  const calls = await setup(page, LIMITED);
  await page.route("**/api/agent/ai-status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/summary", (r) => r.fulfill({ json: { text: "Summary.", at: "t" } }));
  await page.route("**/api/agent/policy/draft", (r) => r.fulfill({ json: { policy: draft, notes: "Draft notes." } }));
  await page.goto("/#/agent");
  await expect(page.locator(`.ag-cap-tx[data-token="${USDC}"]`)).toHaveValue("50");
  await page.locator("#ag-ai-text").fill("convert over 75 dollars");
  await page.getByRole("button", { name: "Draft rules" }).click();
  await expect(page.locator("#ag-ai-draft")).toContainText("Draft notes.");
  return calls;
}

test("AI draft with only convert keeps the saved limits, sweep and reminders; the sign step lists the change", async ({ page }) => {
  const calls = await withDraft(page, { version: 1, convert: { enabled: true, targetTokenId: USDC, minUsdCents: 7500 } });
  await expect(page.locator("#ag-convert-min")).toHaveValue("75.00");
  await expect(page.locator(`.ag-cap-tx[data-token="${USDC}"]`)).toHaveValue("50");
  await expect(page.locator(`.ag-cap-day[data-token="${USDC}"]`)).toHaveValue("200");
  await expect(page.locator("#ag-wl-only")).toBeChecked();
  await expect(page.locator("#ag-sweep-on")).toBeChecked();
  await expect(page.locator("#ag-bill-days")).toHaveValue("3");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-changes")).toHaveText("This draft changes: convert");
  await expect(page.locator("#ag-sign-loosened")).toHaveCount(0);
  expect(calls.find((c) => c.path === "/api/agent/policy/challenge")!.body).toEqual({ kind: "policy", policy: { ...LIMITED, convert: { enabled: true, targetTokenId: USDC, minUsdCents: 7500 } } });
});

test("AI draft that removes a spending cap is flagged before signing", async ({ page }) => {
  const calls = await withDraft(page, { version: 1, limits: { perTx: {}, daily: { [USDC]: "200000000" }, whitelistOnly: true } });
  await expect(page.locator(`.ag-cap-tx[data-token="${USDC}"]`)).toHaveValue("");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-changes")).toHaveText("This draft changes: limits");
  await expect(page.locator("#ag-sign-loosened")).toHaveText("⚠ Loosens your spending limits");
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});
