import { expect, test, type Page } from "@playwright/test";
import { base58 } from "@scure/base";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
const NOPRICE = "nep141:noprice.omft.near";
const DEP = "b".repeat(64);
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";

const transfer = (status: string, dest = WNEAR, sym = "wNEAR", over: Record<string, unknown> = {}) => ({
  depositAddress: DEP, originAsset: USDC, originSymbol: "USDC", amount: "1500000", amountFormatted: "1.5",
  destinationAsset: dest, destinationSymbol: sym, destinationBlockchain: "near", recipient: ADDR,
  amountOut: "468684000000000000000000", amountOutFormatted: "0.468684", minAmountOut: "464000000000000000000000", minAmountOutFormatted: "0.464",
  status, destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
  kind: "swap", swapType: "EXACT_INPUT", recipientType: "INTENTS", ...over,
});

async function setup(page: Page, opts: { dest?: string; sym?: string } = {}) {
  const dest = opts.dest ?? WNEAR;
  const sym = opts.sym ?? "wNEAR";
  const calls: { path: string; method: string; body: unknown }[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path, method: req.method(), body });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5", usd: "2.50" }] });
    if (path === "/api/tokens")
      return r.fulfill({
        json: [
          { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
          { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24, price: 3.2 },
          { assetId: NOPRICE, symbol: "NOP", blockchain: "near", decimals: 24 },
        ],
      });
    if (path === "/api/swaps/quote")
      return r.fulfill({
        status: 201,
        json: { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "0.468684", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer("AWAITING_SIGNATURE", dest, sym) },
      });
    if (path === "/api/transfers/submit") return r.fulfill({ json: transfer("PROCESSING", dest, sym, { intentHash: "H" }) });
    if (path === `/api/transfers/${DEP}`) return r.fulfill({ json: transfer("SUCCESS", dest, sym) });
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

test("swap into a 24-decimal token: quote, rate, USD only where priced, sign, success", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/swap");
  await expect(page.getByRole("heading", { name: "Swap", exact: true })).toBeVisible();
  // The origin token is not offered as a destination.
  await expect(page.locator("#sw-dest option")).toHaveCount(2);
  await page.locator("#sw-amount").fill("1.5");
  await page.locator("#sw-dest").selectOption(WNEAR);
  await page.getByLabel("3 %").check();
  await page.getByRole("button", { name: "Get quote" }).click();

  expect(calls.find((c) => c.path === "/api/swaps/quote")!.body).toEqual({ originAsset: USDC, destinationAsset: WNEAR, amount: "1500000", slippageBps: 300 });
  await expect(page.locator("#sw-send")).toHaveText("1.5 USDC");
  await expect(page.locator("#sw-receive")).toHaveText("≈ 0.468684 wNEAR");
  await expect(page.locator("#sw-min")).toContainText("0.464 wNEAR");
  await expect(page.locator("#sw-rate")).toHaveText("1 USDC ≈ 0.312456 wNEAR");
  await expect(page.locator("#sw-review")).toContainText("≈ $1.50 reference price");
  await expect(page.locator("#sw-review")).toContainText("The swapped tokens stay in your NEAR Intents account.");
  await page.getByRole("button", { name: "Sign in wallet" }).click();

  await expect(page.locator("#sw-track")).toBeVisible();
  const submit = calls.find((c) => c.path === "/api/transfers/submit")!;
  const bytes = new Uint8Array(65).fill(0x11);
  bytes[64] = 1;
  expect(submit.body).toEqual({ depositAddress: DEP, signedData: { standard: "erc191", payload: PAYLOAD, signature: "secp256k1:" + base58.encode(bytes) } });
  await page.clock.runFor(5_100);
  await expect(page.getByRole("heading", { name: "Swapped — new balance on Home" })).toBeVisible();
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
});

test("a destination token without a price shows no USD for it", async ({ page }) => {
  await setup(page, { dest: NOPRICE, sym: "NOP" });
  await page.goto("/#/swap");
  await page.locator("#sw-amount").fill("1.5");
  await page.locator("#sw-dest").selectOption(NOPRICE);
  await page.getByRole("button", { name: "Get quote" }).click();
  await expect(page.locator("#sw-receive")).toHaveText("≈ 0.468684 NOP");
  // Only the priced origin token shows a USD value.
  await expect(page.locator("#sw-review small")).toHaveCount(1);
  await expect(page.locator(".invoice-total").nth(1)).not.toContainText("$");
});

test("over-balance is caught before any quote", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/swap");
  await page.getByRole("button", { name: "Max" }).click();
  await expect(page.locator("#sw-amount")).toHaveValue("2.5");
  await page.locator("#sw-amount").fill("2.6");
  await page.locator("#sw-dest").selectOption(WNEAR);
  await page.getByRole("button", { name: "Get quote" }).click();
  await expect(page.locator("#sw-error")).toHaveText("Amount exceeds your balance");
  expect(calls.some((c) => c.path === "/api/swaps/quote")).toBe(false);
});
