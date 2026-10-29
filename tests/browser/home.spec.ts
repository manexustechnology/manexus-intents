import { expect, test, type Page } from "@playwright/test";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const inv = (id: string, status: string, dueDate: string, total: string, number: string) => ({
  id, publicId: `p${id}`, owner: "alice.near", status, tokenId: USDC, total, revision: 1, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z",
  data: { number, client: "<b>Client</b>", issuer: "I", dueDate, tokenId: USDC, notes: "", items: [{ description: "x", quantity: "1", unitPrice: "1" }] },
});

async function mock(page: Page, balances: { status: number; json: unknown }) {
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/api/me") return r.fulfill({ json: { account: "alice.near", kind: "near" } });
    if (path === "/api/balances") return r.fulfill(balances);
    if (path === "/api/invoices")
      return r.fulfill({ json: [inv("1", "issued", "2000-01-01", "1000000", "A-1"), inv("2", "issued", "2999-01-01", "2500000", "A-2"), inv("3", "paid", "2000-01-01", "9000000", "A-3")] });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

test("home shows balances, reference usd, receivables and actions", async ({ page }) => {
  await mock(page, { status: 200, json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5", usd: "2.50" }] });
  await page.goto("/#/");
  await expect(page.getByText("Your funds are held in your own NEAR Intents account (alice.near), controlled by your wallet.")).toBeVisible();
  await expect(page.locator("#home-total")).toContainText("$2.50");
  await expect(page.locator("#home-total")).toContainText("reference price");
  await expect(page.locator("#home-cards")).toContainText("2.5 USDC");
  await expect(page.locator("#home-recv")).toContainText("3.5 USDC");
  await expect(page.locator("#home-recv")).toContainText("2 unpaid invoices · 1 overdue");
  await expect(page.locator("#home-recv")).toContainText("Payment status updates when you open an invoice.");
  await expect(page.locator("#home-recent")).toContainText("A-3");
  await expect(page.locator("#home-recent b")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Withdraw" }).first()).toHaveAttribute("href", "#/withdraw");
  await page.getByRole("link", { name: "+ New invoice" }).click();
  await expect(page).toHaveURL(/#\/invoices\/new/);
});

test("balance failure shows an error, not zeros, and keeps receivables", async ({ page }) => {
  await mock(page, { status: 502, json: { error: "Could not read NEAR Intents balance" } });
  await page.goto("/#/");
  await expect(page.locator("#home-balance-error")).toHaveText("Could not read NEAR Intents balance");
  await expect(page.locator("#home-total")).not.toContainText("$0");
  await expect(page.locator("#home-recv")).toContainText("3.5 USDC");
});
