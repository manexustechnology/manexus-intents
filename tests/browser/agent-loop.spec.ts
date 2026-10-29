// The agent loop end to end against a fake /api: an owner with no rules signs a convert rule, the agent's
// suggestion appears, the owner approves it, signs the intent, and the suggestion is done. Also the optional AI
// summary (hidden when NEAR AI is not configured, shown when it is) and no horizontal scroll at 390 px.
import { expect, test, type Page } from "@playwright/test";
import { base58 } from "@scure/base";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "nep141:usdt.tether-token.near";
const DEP = "e".repeat(64);
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "BBBB", intents: [] });
const SIG = "0x" + "22".repeat(64) + "1b";
const MESSAGE = `Manexus policy v1\nAccount: ${ADDR}\nHash: ${"cd".repeat(32)}\nNonce: TG9vcA==`;
const RULES = { version: 1, convert: { enabled: true, targetTokenId: USDC, minUsdCents: 2000 } };

const transfer = (status: string) => ({
  depositAddress: DEP, originAsset: USDT, originSymbol: "USDT", amount: "120000000", amountFormatted: "120",
  destinationAsset: USDC, destinationSymbol: "USDC", destinationBlockchain: "near", recipient: ADDR,
  amountOut: "119900000", amountOutFormatted: "119.9", minAmountOut: "118700000", minAmountOutFormatted: "118.7",
  status, destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false, createdAt: "t", updatedAt: "t",
  kind: "swap", swapType: "EXACT_INPUT", recipientType: "INTENTS",
});

/** A stateful fake API: no rules at first; once a policy is saved the agent proposes converting the USDT. */
async function setup(page: Page, ai: "off" | "on") {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let policy: unknown = null;
  let convert: { status: string; depositAddress?: string } | null = null;
  const proposals = () =>
    convert && convert.status !== "done"
      ? [{ id: "c1", type: "convert", dedupKey: `convert:${USDT}`, params: { originAsset: USDT, destinationAsset: USDC, amount: "120000000" }, ...convert, createdAt: "t", updatedAt: "t", expiresAt: "2999-01-01T00:00:00.000Z" }]
      : [];
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
        { tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "50000000", formatted: "50", usd: "50.00" },
        { tokenId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, amount: "120000000", formatted: "120", usd: "120.00" },
      ] });
    if (path === "/api/tokens")
      return r.fulfill({ json: [
        { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
        { assetId: USDT, symbol: "USDT", blockchain: "near", decimals: 6, price: 1 },
      ] });
    if (path === "/api/bills" || path === "/api/invoices" || path === "/api/agent/whitelist") return r.fulfill({ json: [] });
    if (path === "/api/agent/ai-status") return ai === "on" ? r.fulfill({ json: { configured: true } }) : r.fulfill({ json: { configured: false } });
    if (path === "/api/agent/summary")
      return ai === "on" ? r.fulfill({ json: { text: "You hold 50 USDC and 120 USDT; one suggestion is open.", at: "t" } }) : r.fulfill({ status: 404, json: { error: "AI features are not configured" } });
    if (path === "/api/agent/policy" && req.method() === "GET") return r.fulfill({ json: { policy, hash: policy ? "h" : null, updatedAt: policy ? "t" : null } });
    if (path === "/api/agent/policy/challenge") return r.fulfill({ json: { nonce: "TG9vcA==", message: MESSAGE, recipient: "manexus", hash: "cd".repeat(32) } });
    if (path === "/api/agent/policy" && req.method() === "PUT") {
      const b = body as { policy: unknown; nonce: string; signature: string };
      if (b.nonce !== "TG9vcA==" || b.signature !== SIG) return r.fulfill({ status: 401, json: { error: "Signature does not match this change" } });
      policy = b.policy;
      convert = { status: "proposed" };
      return r.fulfill({ json: { policy, hash: "h", updatedAt: "t" } });
    }
    if (path === "/api/agent/proposals") return r.fulfill({ json: proposals() });
    if (path === "/api/agent/proposals/c1/approve")
      return r.fulfill({ status: 201, json: { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "119.9", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer("AWAITING_SIGNATURE") } });
    if (path === "/api/transfers/submit") {
      convert = { status: "executing", depositAddress: DEP };
      return r.fulfill({ json: { ...transfer("PROCESSING"), intentHash: "H" } });
    }
    if (path === `/api/transfers/${DEP}`) {
      convert = { status: "done", depositAddress: DEP };
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

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("agent loop: sign rules → suggestion appears → approve convert → sign → done (AI off)", async ({ page }) => {
  const calls = await setup(page, "off");
  await page.goto("/#/agent");
  const inbox = page.locator("#ag-inbox");
  await expect(inbox).toContainText("No rules yet.");
  await expect(page.locator("#ag-ai-summary")).toHaveText("AI features are not configured.");
  await expect(page.locator("#ag-ai-text")).toHaveCount(0);
  await expect(page.locator("#ag-ai-refresh")).toBeHidden();
  await noOverflow(page);

  // 1. Rules are saved only through the signed step.
  await page.locator("#ag-convert-on").check();
  await page.locator("#ag-convert-target").selectOption(USDC);
  await page.locator("#ag-convert-min").fill("20");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#ag-sign-message")).toHaveText(MESSAGE);
  expect(calls.find((c) => c.path === "/api/agent/policy/challenge")!.body).toEqual({ kind: "policy", policy: RULES });
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  await page.locator("#ag-sign-go").click();
  await expect(page.locator("#ag-rules-note")).toHaveText("Rules saved.");
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ policy: RULES, nonce: "TG9vcA==", signature: SIG });

  // 2. The agent's suggestion appears.
  await expect(inbox.locator(".agent-reason")).toHaveText("Convert 120 USDT → USDC (≈ $120.00 reference price)");
  await noOverflow(page);

  // 3. Approve → review the quote → sign the intent in the wallet.
  await inbox.locator('.ag-approve[data-proposal="c1"]').click();
  await expect(page.locator("#ag-send")).toHaveText("120 USDT");
  await expect(page.locator("#ag-receive")).toHaveText("≈ 119.9 USDC");
  await noOverflow(page);
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#ag-track-status")).toHaveText("Processing");
  const bytes = new Uint8Array(65).fill(0x22);
  bytes[64] = 0;
  expect(calls.find((c) => c.path === "/api/transfers/submit")!.body).toEqual({ depositAddress: DEP, signedData: { standard: "erc191", payload: PAYLOAD, signature: "secp256k1:" + base58.encode(bytes) } });

  // 4. Done; the inbox is empty again.
  await page.clock.runFor(5_100);
  await expect(page.locator("#ag-track-status")).toHaveText("Done");
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(inbox).toContainText("No suggestions right now.");
  expect(calls.some((c) => c.path.startsWith("/api/agent/summary") || c.path === "/api/agent/policy/draft")).toBe(false);
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
  await noOverflow(page);
});

test("AI configured: the summary and the describe box are shown; the agent loop is unchanged", async ({ page }) => {
  await setup(page, "on");
  await page.goto("/#/agent");
  await expect(page.locator("#ag-ai-summary")).toContainText("You hold 50 USDC and 120 USDT; one suggestion is open.");
  await expect(page.locator("#ag-ai-summary")).toContainText("Written by an AI from totals only.");
  await expect(page.locator("#ag-ai-refresh")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft rules" })).toBeVisible();
  await page.locator("#ag-convert-on").check();
  await page.locator("#ag-convert-min").fill("20");
  await page.getByRole("button", { name: "Save rules" }).click();
  await page.locator("#ag-sign-go").click();
  await expect(page.locator("#ag-inbox .agent-reason")).toHaveText("Convert 120 USDT → USDC (≈ $120.00 reference price)");
  await noOverflow(page);
});
