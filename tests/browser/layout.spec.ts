import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, invoices: unknown[]) {
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/api/me") return r.fulfill({ json: { account: "alice.near", kind: "near" } });
    if (path === "/api/invoices") return r.fulfill({ json: invoices });
    return r.fulfill({ json: [] });
  });
}

const invoice = (i: number) => ({
  id: `id${i}`, publicId: `pub${i}`, owner: "alice.near", status: "draft", revision: 1, total: "700000",
  tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  data: { number: `INV-${1000 + i}`, client: `Customer ${i}`, dueDate: "2030-02-01" }, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z",
});

test("the footer sits at the bottom of the viewport on a short page", async ({ page }) => {
  await setup(page, []);
  await page.goto("/#/withdraw");
  const footer = page.locator(".page > footer");
  await expect(footer).toContainText("Non-custodial");
  const box = (await footer.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(1);
});

test("the footer follows the content on a long page", async ({ page }) => {
  await setup(page, Array.from({ length: 40 }, (_, i) => invoice(i)));
  await page.goto("/#/invoices");
  await expect(page.locator("#content")).toContainText("Customer 39");
  const content = (await page.locator("#content").boundingBox())!;
  const footer = (await page.locator(".page > footer").boundingBox())!;
  expect(footer.y).toBeGreaterThanOrEqual(content.y + content.height - 1);
});

test("an empty balance points to creating an invoice", async ({ page }) => {
  await setup(page, []);
  await page.goto("/#/withdraw");
  await page.getByRole("link", { name: "Create an invoice" }).click();
  await expect(page).toHaveURL(/#\/invoices\/new$/);
});

test("nav icons are SVG and hidden from assistive tech", async ({ page }) => {
  await setup(page, []);
  await page.goto("/#/withdraw");
  const icons = page.locator("a.nav > span");
  await expect(icons).toHaveCount(7);
  for (const span of await icons.all()) {
    await expect(span).toHaveAttribute("aria-hidden", "true");
    await expect(span.locator("svg.icon")).toHaveCount(1);
  }
});
