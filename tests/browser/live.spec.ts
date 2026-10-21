import { test, expect } from "@playwright/test";
test("public mainnet dry quote smoke test", async ({ page }) => {
  test.skip(
    !process.env.LIVE_API,
    "Opt in with LIVE_API=1; calls the public provider with synthetic recipients only.",
  );
  await page.goto("/");
  await expect(page.locator(".livebadge")).toContainText(
    "Live token discovery",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "⇄ Swap", exact: true }).click();
  await page.getByRole("button", { name: "Get live quote" }).click();
  await expect(page.locator("#live-result")).toContainText("Quoted output", {
    timeout: 25000,
  });
  await page.screenshot({
    path: "/tmp/manexus-live-quote.png",
    fullPage: true,
  });
});
