import { expect, test, type Page } from "@playwright/test";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const REFUND = "0x0000000000000000000000000000000000000001";
const TOKENS = [
  { assetId: ARB, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
  { assetId: "nep141:xyz.omft.near", symbol: "XYZ", blockchain: "aleo", decimals: 6 },
];
const invoice = (status: string) => ({
  publicId: "pub1", status, tokenId: USDC, symbol: "USDC", total: "700000", totalFormatted: "0.7", payTo: "alice.near", dueDate: "2030-01-31",
  data: {
    number: "DEMO-001", client: "Demo <Client>", issuer: "Example Studio", dueDate: "2030-01-31", tokenId: USDC, notes: "",
    items: [{ description: "Design", quantity: "3", unitPrice: "0.1" }, { description: "Build", quantity: "2", unitPrice: "0.2" }],
  },
});

async function mock(page: Page, status = "issued", deadline = new Date(Date.now() + 25 * 60_000).toISOString()) {
  const seen: { quote?: unknown; deposit?: unknown } = {};
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/public/invoices/pub1") return r.fulfill({ json: invoice(status) });
    if (path === "/api/tokens") return r.fulfill({ json: TOKENS });
    if (path.endsWith("/quote")) {
      seen.quote = JSON.parse(req.postData()!);
      return r.fulfill({
        status: 201,
        json: { symbol: "USDC", blockchain: "arb", depositAddress: "0xDEPOSIT", depositMemo: "memo-7", originAsset: ARB, amountIn: "710180", amountInFormatted: "0.71018", deadline, status: "PENDING_DEPOSIT", expired: false },
      });
    }
    if (path.endsWith("/deposit")) {
      seen.deposit = JSON.parse(req.postData()!);
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true }));
  return seen;
}

test("payer picks a token and gets exact instructions without signing in", async ({ page }) => {
  const seen = await mock(page);
  await page.goto("/#/pay/pub1");
  await expect(page.getByRole("heading", { name: "Pay 0.7 USDC" })).toBeVisible();
  await expect(page.getByText("Paid to alice.near on NEAR Intents")).toBeVisible();
  await expect(page.getByText("Demo <Client>")).toBeVisible();
  await expect(page.getByRole("option", { name: "XYZ · aleo" })).toHaveCount(0);
  await page.getByLabel("Search token or chain").fill("arb");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "USDC · arb" }).click();
  await expect(page.getByLabel("Refund address on arb")).toBeVisible();
  await page.getByLabel("Refund address on arb").fill(REFUND);
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.locator("#pay-amount")).toHaveText("0.71018 USDC");
  await expect(page.locator("#pay-address")).toHaveText("0xDEPOSIT");
  await expect(page.locator("#pay-memo")).toHaveText("memo-7");
  await expect(page.getByText("Send exactly this amount from the selected chain. Unused amount is refunded to your refund address.")).toBeVisible();
  await expect(page.locator("#pay-countdown")).toContainText(/2[45]:\d\d/);
  expect(seen.quote).toEqual({ originAsset: ARB, refundTo: REFUND });
  await page.getByRole("button", { name: "Copy address" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByText("I've sent it").click();
  await page.getByLabel("Transaction hash").fill("0xabc");
  await page.getByRole("button", { name: "Submit transaction hash" }).click();
  await expect(page.getByText("Thanks. We will match it")).toBeVisible();
  expect(seen.deposit).toEqual({ depositAddress: "0xDEPOSIT", txHash: "0xabc" });
});

test("an expired quote hides the deposit address and offers a new one", async ({ page }) => {
  await mock(page, "issued", new Date(Date.now() + 2000).toISOString());
  await page.goto("/#/pay/pub1");
  await page.getByRole("option", { name: "USDC · arb" }).click();
  await page.getByLabel("Refund address on arb").fill(REFUND);
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.locator("#pay-address")).toBeVisible();
  await expect(page.getByText("expired", { exact: false })).toBeVisible({ timeout: 6000 });
  await expect(page.locator("#pay-address")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get payment instructions" })).toBeVisible();
});

test("a bad refund address surfaces the server error", async ({ page }) => {
  await mock(page);
  await page.route("**/quote", (r) => r.fulfill({ status: 400, json: { error: "Enter a valid arb refund address." } }));
  await page.goto("/#/pay/pub1");
  await page.getByRole("option", { name: "USDC · arb" }).click();
  await page.getByLabel("Refund address on arb").fill("alice.near");
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "valid arb refund address" })).toBeVisible();
});

for (const [status, text] of [["paid", "This invoice has been paid"], ["cancelled", "This invoice was cancelled"]] as const) {
  test(`${status} invoices show their state and no form`, async ({ page }) => {
    await mock(page, status);
    await page.goto("/#/pay/pub1");
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.locator("#pay-form")).toHaveCount(0);
  });
}
