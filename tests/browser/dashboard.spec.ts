import { expect, test, type Page } from "@playwright/test";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const bal = [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5", usd: "2.50" }];
const feed = [
  { at: "2030-03-12T00:00:00.000Z", type: "payment_received_extra", title: "Extra payment received · <b>INV-1</b>", amountFormatted: "1", symbol: "USDC", status: "duplicate", href: "#/invoices/i1" },
  { at: "2030-03-11T00:00:00.000Z", type: "withdraw", title: "Withdrawal to sol", amountFormatted: "0.4", symbol: "USDC", status: "SUCCESS", href: "#/withdraw" },
];
const month = { month: "2030-03", tokens: [{ tokenId: USDC, symbol: "USDC", received: "3500000", sent: "400000", receivedFormatted: "3.5", sentFormatted: "0.4" }, { tokenId: "x", symbol: "USDT", received: "0", sent: "0", receivedFormatted: "0", sentFormatted: "0" }] };

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const bill = (id: string, dueDate: string, amount: string, over: Record<string, unknown> = {}) => ({
  id, vendor: `V ${id}`, reference: "", dueDate, destinationAsset: USDC, recipientType: "INTENTS", recipient: "v.near", amount, amountFormatted: "", symbol: "USDC",
  blockchain: "near", decimals: 6, source: "manual", status: "scheduled", overdue: false, createdAt: "t", updatedAt: "t", ...over,
});

async function mock(page: Page, failing: string[] = [], bills: unknown[] = []) {
  const calls: string[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    calls.push(u.pathname + u.search);
    if (failing.includes(u.pathname + u.search)) return r.fulfill({ status: 502, json: { error: "Upstream down" } });
    if (u.pathname === "/api/me") return r.fulfill({ json: { account: "alice.near", kind: "near" } });
    if (u.pathname === "/api/balances") return r.fulfill({ json: bal });
    if (u.pathname === "/api/invoices") return r.fulfill({ json: [] });
    if (u.pathname === "/api/bills") return r.fulfill({ json: bills });
    if (u.pathname === "/api/activity") return r.fulfill({ json: u.searchParams.get("summary") ? month : feed });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

test("dashboard tiles, escaped activity feed and links", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/#/");
  await expect(page.locator("#home-total")).toContainText("$2.50");
  await expect(page.locator("#home-pay")).toContainText("No scheduled bills");
  expect(calls).toContain("/api/bills?status=scheduled");
  await expect(page.locator("#home-month")).toContainText("received 3.5");
  await expect(page.locator("#home-month")).toContainText("sent 0.4");
  await expect(page.locator("#home-month")).not.toContainText("USDT");
  await expect(page.locator("#home-activity")).toContainText("Extra payment received · <b>INV-1</b>");
  await expect(page.locator("#home-activity b")).toHaveCount(0);
  await expect(page.locator("#home-activity a").first()).toHaveAttribute("href", "#/invoices/i1");
  await expect(page.locator("#home-activity a").nth(1)).toHaveAttribute("href", "#/withdraw");
  await page.locator("#home-activity a").first().click();
  await expect(page).toHaveURL(/#\/invoices\/i1/);
});

test("an activity failure does not blank the other tiles", async ({ page }) => {
  await mock(page, ["/api/activity"]);
  await page.goto("/#/");
  await expect(page.locator("#home-activity")).toContainText("Upstream down");
  await expect(page.locator("#home-total")).toContainText("$2.50");
  await expect(page.locator("#home-cards")).toContainText("2.5 USDC");
  await expect(page.locator("#home-pay")).toContainText("No scheduled bills");
});

test("a month failure leaves the feed visible", async ({ page }) => {
  await mock(page, ["/api/activity?summary=month"]);
  await page.goto("/#/");
  await expect(page.locator("#home-month")).toContainText("Upstream down");
  await expect(page.locator("#home-activity")).toContainText("Withdrawal to sol");
});

test("payables: scheduled bills due within 14 days per token, with the overdue count", async ({ page }) => {
  await mock(page, [], [
    bill("a", day(3), "1500000"),
    bill("b", day(-2), "250000"),
    bill("c", day(40), "9000000"),
    bill("d", day(1), "1", { destinationAsset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24 }),
  ]);
  await page.goto("/#/");
  await expect(page.locator("#home-pay")).toContainText("1.75 USDC + 0.000000000000000000000001 wNEAR");
  await expect(page.locator("#home-pay")).toContainText("3 bills due in the next 14 days · 1 overdue");
});

test("payables: scheduled bills none of which are due soon", async ({ page }) => {
  await mock(page, [], [bill("c", day(40), "9000000")]);
  await page.goto("/#/");
  await expect(page.locator("#home-pay")).toContainText("Nothing due in the next 14 days.");
});
