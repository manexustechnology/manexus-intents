import { test, expect, type Page } from "@playwright/test";
const key = "manexus-invoices-v1";
const receiving = "0x2222222222222222222222222222222222222222";
test.beforeEach(async ({ page }) => {
  await page.route("**/v0/tokens", (r) =>
    r.fulfill({
      json: [
        {
          assetId: "sample-usdc",
          symbol: "USDC",
          blockchain: "eth",
          decimals: 6,
          price: 1,
        },
        {
          assetId: "sample-near",
          symbol: "NEAR",
          blockchain: "near",
          decimals: 24,
          price: 3,
        },
      ],
    }),
  );
  await page.addInitScript(() => {
    (
      window as unknown as { walletCalls: number; ethereum: unknown }
    ).walletCalls = 0;
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: () => {
        (window as unknown as { walletCalls: number }).walletCalls++;
        throw Error("Invoice must not call wallet");
      },
    };
  });
});
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "▤ Invoices", exact: true }).click();
}
async function fill(page: Page) {
  await page
    .getByRole("button", { name: "+ New invoice", exact: true })
    .click();
  await page.locator("#invoice-number").fill("DEMO-001");
  await page.locator("#invoice-issuer").fill("Example Studio");
  await page.locator("#invoice-client").fill("Demo Client");
  await page.locator("#invoice-address").fill(receiving);
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Synthetic design");
  await page.getByLabel("Quantity 1", { exact: true }).fill("3");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0.1");
}
async function issue(page: Page) {
  await page.getByRole("button", { name: "Issue preview invoice" }).click();
  await expect(page.locator(".invoice-document")).toContainText(
    "unpaid / unverified",
  );
}
async function share(page: Page) {
  await page.locator("#invoice-share-consent").check();
  await page
    .getByRole("button", { name: "Create shareable snapshot link" })
    .click();
  return page.locator("#invoice-link").inputValue();
}
async function records(page: Page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]"), key);
}
test("draft recovery, exact line totals, issue, sharing, cancellation and duplication", async ({
  page,
}, info) => {
  await open(page);
  await fill(page);
  await page.getByRole("button", { name: "+ Add line item" }).click();
  await page
    .getByLabel("Description 2", { exact: true })
    .fill("Synthetic review");
  await page.getByLabel("Quantity 2", { exact: true }).fill("2");
  await page.getByLabel("Unit price 2", { exact: true }).fill("0.2");
  await expect(page.locator("#invoice-totals")).toContainText("0.7 USDC");
  const id = (await records(page))[0].id;
  await page.reload();
  await page.getByRole("button", { name: "▤ Invoices", exact: true }).click();
  await expect(page.locator("#invoice-client")).toHaveValue("Demo Client");
  await expect(page.getByLabel("Unit price 2", { exact: true })).toHaveValue(
    "0.2",
  );
  expect((await records(page))[0].id).toBe(id);
  expect((await records(page)).length).toBe(1);
  await issue(page);
  await expect(page.locator("#invoice-number")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create shareable snapshot link" }),
  ).toBeDisabled();
  const link = await share(page);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `/tmp/manexus-invoice-${info.project.name}.png`,
    fullPage: true,
  });
  await page.locator("#invoice-cancel-consent").check();
  await page.getByRole("button", { name: "Cancel invoice locally" }).click();
  expect((await records(page))[0].status).toBe("cancelled");
  await page.getByRole("button", { name: "Duplicate as new draft" }).click();
  expect((await records(page)).length).toBe(2);
  expect((await records(page))[0].id).not.toBe(id);
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "DEMO-001", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".notice").first()).toContainText(
    "payment not verified",
  );
  await expect(page.locator(".invoice-document")).toContainText("0.7 USDC");
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: number }).walletCalls,
    ),
  ).toBe(0);
});
test("incomplete, wrong-network and zero-price drafts cannot issue", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "+ New invoice", exact: true })
    .click();
  await page.getByRole("button", { name: "Issue preview invoice" }).click();
  await expect(page.locator("#invoice-notice")).toContainText(
    "Add an invoice number",
  );
  await page.locator("#invoice-issuer").fill("Example");
  await page.locator("#invoice-client").fill("Demo");
  await page.locator("#invoice-address").fill(receiving);
  await page.locator("#invoice-asset").selectOption("NEAR:near");
  await page.getByLabel("Description 1", { exact: true }).fill("Demo");
  await page.getByLabel("Unit price 1", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Issue preview invoice" }).click();
  await expect(page.locator("#invoice-notice")).toContainText(
    "valid receiving address",
  );
  await page.locator("#invoice-address").fill("preview.near");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Issue preview invoice" }).click();
  await expect(page.locator("#invoice-notice")).toContainText(
    "positive unit price",
  );
  expect((await records(page))[0].status).toBe("draft");
});
test("repeated issue events create only one issued record", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page.locator("#invoice-form").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
  expect((await records(page)).length).toBe(1);
  expect((await records(page))[0].status).toBe("issued");
});
test("edited snapshot cannot claim paid and labels cannot inject markup", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page
    .locator("#invoice-client")
    .fill('<img src=x onerror="window.compromised=true">');
  await issue(page);
  const link = await share(page);
  await page.goto(link);
  await expect(page.locator(".invoice-document img")).toHaveCount(0);
  await expect(page.locator(".invoice-document")).toContainText("<img src=x");
  expect(
    await page.evaluate(
      () => (window as unknown as { compromised?: boolean }).compromised,
    ),
  ).toBeUndefined();
  const payload = JSON.parse(decodeURIComponent(new URL(link).hash.slice(9)));
  payload.status = "paid";
  await page.goto("/#invoice=" + encodeURIComponent(JSON.stringify(payload)));
  await expect(
    page.getByRole("heading", { name: "Cannot open this invoice" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Payment status cannot be supplied",
  );
});
test("quota failure keeps unsaved edits visible and blocks silent navigation", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page.evaluate((k) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === k) throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, key);
  await page.locator("#invoice-client").fill("Unsaved synthetic label");
  await expect(page.locator("#invoice-notice")).toContainText("Could not save");
  await page.getByRole("button", { name: "⇄ Swap", exact: true }).click();
  await expect(page.locator("#invoice-client")).toHaveValue(
    "Unsaved synthetic label",
  );
  await expect(page.locator("#invoice-notice")).toContainText(
    "Unsaved invoice edits remain",
  );
  await page.locator("#invoice-discard-confirm").check();
  await page
    .getByRole("button", { name: "Discard unsaved edits & reload" })
    .click();
  await expect(page.locator("#invoice-client")).toHaveValue("Demo Client");
});
test("conflicting tab edits fail closed and recover after explicit discard", async ({
  page,
  context,
}) => {
  await open(page);
  await fill(page);
  const other = await context.newPage();
  await open(other);
  await other.locator("#invoice-client").fill("Changed in other tab");
  await page.locator("#invoice-client").fill("Stale edit");
  await expect(page.locator("#invoice-notice")).toContainText(
    "changed in another tab",
  );
  await page.locator("#invoice-discard-confirm").check();
  await page
    .getByRole("button", { name: "Discard unsaved edits & reload" })
    .click();
  await expect(page.locator("#invoice-client")).toHaveValue(
    "Changed in other tab",
  );
  await other.close();
});
test("testnet invoice opens a separate request only and route preview never marks it paid", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page.locator("#invoice-asset").selectOption("ETH:base-sepolia");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0.001");
  await issue(page);
  await page
    .getByRole("button", { name: "Open separate testnet payment preview" })
    .click();
  await expect(page.locator("#test-to")).toHaveValue(receiving);
  await expect(page.locator("#test-amount")).toHaveValue("0.003");
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: number }).walletCalls,
    ),
  ).toBe(0);
  expect((await records(page))[0].status).toBe("issued");
  await page.getByRole("button", { name: "▤ Invoices", exact: true }).click();
  await page
    .getByRole("button", { name: "Open read-only quotes & simulation" })
    .click();
  await page.getByRole("button", { name: "Start simulated swap" }).click();
  await page.getByRole("button", { name: "Next simulated step" }).click();
  await page.getByRole("button", { name: "Next simulated step" }).click();
  expect((await records(page))[0].status).toBe("issued");
});
test("corrupted local store is not replaced on opening invoices", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate((k) => localStorage.setItem(k, "broken-json"), key);
  await page.getByRole("button", { name: "▤ Invoices", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local invoices unavailable" }),
  ).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe(
    "broken-json",
  );
});
