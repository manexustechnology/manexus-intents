import { expect, test, type Page } from "@playwright/test";

const OWNER = "alice.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

type Row = Record<string, unknown> & { id: string; status: string; revision: number; data: Record<string, unknown> };

async function mockApi(page: Page, payments: Record<string, unknown>[] = [], paidOnPayments = false) {
  const rows: Row[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    if (path === "/api/me") return r.fulfill({ json: { account: OWNER, kind: "near" } });
    if (path === "/api/invoices" && req.method() === "GET") return r.fulfill({ json: rows });
    if (path === "/api/invoices" && req.method() === "POST") {
      const row: Row = {
        id: `id${rows.length + 1}`, publicId: `pub${rows.length + 1}`, owner: OWNER, status: "draft", tokenId: USDC, data: body,
        total: "700000", revision: 1, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z",
      };
      rows.push(row);
      return r.fulfill({ status: 201, json: row });
    }
    const pm = /^\/api\/invoices\/([^/]+)\/payments$/.exec(path);
    const prow = pm && rows.find((x) => x.id === pm[1]);
    if (prow) {
      if (paidOnPayments) Object.assign(prow, { status: "paid", paidAt: "2030-01-02T00:00:00Z", paidBy: "dep1" });
      return r.fulfill({ json: { invoiceStatus: prow.status, attempts: payments } });
    }
    const m = /^\/api\/invoices\/([^/]+)(?:\/(issue|cancel))?$/.exec(path);
    const row = m && rows.find((x) => x.id === m[1]);
    if (m && row) {
      if (m[2] === "issue") Object.assign(row, { status: "issued", issuedAt: "2030-01-01T00:00:00Z", revision: row.revision + 1 });
      if (m[2] === "cancel") Object.assign(row, { status: "cancelled", revision: row.revision + 1 });
      if (req.method() === "PUT") Object.assign(row, { data: body.data, revision: row.revision + 1 });
      return r.fulfill({ json: row });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return rows;
}

async function createAndIssue(page: Page) {
  await page.goto("/#/invoices");
  await page.getByRole("link", { name: "+ New invoice" }).click();
  await page.locator("#invoice-number").fill("DEMO-001");
  await page.locator("#invoice-issuer").fill("Example Studio");
  await page.locator("#invoice-client").fill("Demo Client");
  await page.getByLabel("Description 1", { exact: true }).fill("Design");
  await page.getByLabel("Quantity 1", { exact: true }).fill("3");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "+ Add line item" }).click();
  await page.getByLabel("Description 2", { exact: true }).fill("Build");
  await page.getByLabel("Quantity 2", { exact: true }).fill("2");
  await page.getByLabel("Unit price 2", { exact: true }).fill("0.2");
  await expect(page.locator("#invoice-totals")).toContainText("0.7 USDC");
  await page.getByRole("button", { name: "Issue invoice" }).click();
}

test("token select offers only USDC and USDT", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#/invoices/new");
  await expect(page.locator("#invoice-token option")).toHaveText(["USDC", "USDT"]);
});

test("create and issue an invoice, list it, copy its payment link", async ({ page }) => {
  await mockApi(page);
  await createAndIssue(page);
  await expect(page.getByRole("heading", { name: "DEMO-001" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy payment link" })).toBeVisible();
  await expect(page.locator("#invoice-link")).toHaveValue(/#\/pay\/pub1$/);
  await page.getByRole("link", { name: "← Invoices" }).click();
  const row = page.locator(".invoice-record", { hasText: "DEMO-001" });
  await expect(row).toContainText("0.7 USDC");
  await expect(row).toContainText("Issued");
  await page.getByLabel("Filter by status").selectOption("paid");
  await expect(page.getByText("No invoices in this view.")).toBeVisible();
});

test("cancel and duplicate an issued invoice", async ({ page }) => {
  await mockApi(page);
  page.on("dialog", (d) => d.accept());
  await createAndIssue(page);
  await page.getByRole("button", { name: "Cancel invoice" }).click();
  await expect(page.locator(".badge", { hasText: "Cancelled" })).toBeVisible();
  await page.getByRole("button", { name: "Duplicate as new draft" }).click();
  await expect(page.getByRole("heading", { name: "Edit draft" })).toBeVisible();
  await expect(page.locator("#invoice-number")).toHaveValue(/^DEMO-001-/);
});

const attempt = (over: Record<string, unknown>) => ({
  symbol: "USDC", blockchain: "arb", depositAddress: "dep1", originAsset: "nep141:arb", amountIn: "710180", amountInFormatted: "0.71018",
  status: "SUCCESS", expired: false, createdAt: "2030-01-01T00:05:00.000Z", refundTo: "0x1", originTxHashes: ["0xorigin"],
  destinationTxHashes: ["6xJZ3tYbKk7d8m9QpR2sT4uV5wX6yZ7aB8cD9eF1gH2j"], amountOut: "700000", amountOutFormatted: "0.7", ...over,
});

test("owner sees verified payments, extra payments and the Paid chip", async ({ page }) => {
  await mockApi(page, [attempt({ depositAddress: "dep2", outcome: "duplicate" }), attempt({ outcome: "paid" }), attempt({ depositAddress: "dep3", status: "REFUNDED", outcome: "refunded", destinationTxHashes: [], originTxHashes: [] })], true);
  await createAndIssue(page);
  await expect(page.locator(".heading .badge.status-paid")).toContainText("Paid");
  await expect(page.getByText(/paid 2030-01-02/)).toBeVisible();
  const list = page.locator("#invoice-payments");
  await expect(list.locator(".payment-row")).toHaveCount(3);
  await expect(list.locator('[data-deposit="dep2"]')).toContainText("Extra payment received (in your balance)");
  await expect(list.locator('[data-deposit="dep1"] .badge')).toHaveText("Paid");
  await expect(list.locator('[data-deposit="dep1"]')).toContainText("Received 0.7 USDC");
  await expect(list.locator('[data-deposit="dep1"] a')).toHaveAttribute("href", /^https:\/\/nearblocks\.io\/txns\//);
  await expect(list.locator('[data-deposit="dep3"] .badge')).toHaveText("Refunded");
  await page.getByRole("link", { name: "← Invoices" }).click();
  await expect(page.locator(".invoice-record", { hasText: "DEMO-001" }).locator(".badge.status-paid")).toHaveText("✓ Paid");
});
