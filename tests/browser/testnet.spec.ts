import { test, expect, type Page } from "@playwright/test";
const from = "0x1111111111111111111111111111111111111111",
  to = "0x2222222222222222222222222222222222222222";
async function wallet(page: Page, mode = "normal") {
  await page.addInitScript(
    ({ from, mode }) => {
      const w = window as unknown as {
        ethereum: unknown;
        calls: { method: string; params?: unknown[] }[];
        testChain: string;
        testAccount: string;
        listeners: Record<string, (v: unknown) => void>;
      };
      w.calls = [];
      w.testChain = mode === "mainnet" ? "0x1" : "0x14a34";
      w.testAccount = from;
      w.listeners = {};
      w.ethereum = {
        on: (n: string, fn: (v: unknown) => void) => (w.listeners[n] = fn),
        request: async (a: { method: string; params?: unknown[] }) => {
          w.calls.push(a);
          switch (a.method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [w.testAccount];
            case "eth_chainId":
              return w.testChain;
            case "wallet_switchEthereumChain":
              w.testChain = "0x14a34";
              w.listeners.chainChanged?.(w.testChain);
              return null;
            case "eth_getCode":
              return "0x";
            case "eth_getBalance":
              return mode === "empty" ? "0x0" : "0xde0b6b3a7640000";
            case "eth_estimateGas":
              return "0x5208";
            case "eth_gasPrice":
              return "0x3b9aca00";
            case "eth_sendTransaction":
              if (mode === "reject")
                throw Object.assign(new Error("Rejected"), { code: 4001 });
              if (mode === "uncertain") throw Error("Disconnected");
              return "0x" + "a".repeat(64);
            case "eth_getTransactionReceipt":
              return {
                transactionHash: "0x" + "a".repeat(64),
                blockNumber: "0x123",
                status: "0x1",
              };
            default:
              throw Error("Unexpected method " + a.method);
          }
        },
      };
    },
    { from, mode },
  );
}
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "↗ Payments", exact: true }).click();
  await page.getByRole("button", { name: "Connect test wallet" }).click();
}
async function review(page: Page) {
  await page.locator("#test-to").fill(to);
  await page.locator("#test-amount").fill("0.001");
  await page.getByRole("button", { name: "Review test payment" }).click();
}
const sendCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { calls: { method: string }[] }).calls.filter(
        (c) => c.method === "eth_sendTransaction",
      ).length,
  );
test("testnet review, explicit confirmation, transaction and receipt", async ({ page }, info) => {
  await wallet(page);
  await open(page);
  await review(page);
  await expect(page.locator("#test-send")).toBeDisabled();
  expect(await sendCount(page)).toBe(0);
  await page.locator("#test-confirm").check();
  await page.locator("#test-send").click();
  await expect(page.locator("#test-tracking")).toContainText("Submitted");
  expect(await sendCount(page)).toBe(1);
  const tx = await page.evaluate(
    () =>
      (
        window as unknown as { calls: { method: string; params?: unknown[] }[] }
      ).calls.find((c) => c.method === "eth_sendTransaction")!.params![0],
  );
  expect(tx).toMatchObject({
    from,
    to,
    chainId: "0x14a34",
    value: "0x38d7ea4c68000",
    data: "0x",
  });
  await page.getByRole("button", { name: "Check confirmation" }).click();
  await expect(page.locator("#test-tracking")).toContainText(
    "Confirmed on Base Sepolia",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: `/tmp/manexus-testnet-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "↗ Payments", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review test payment" }),
  ).toBeDisabled();
  expect(await sendCount(page)).toBe(0);
});
test("mainnet cannot send and explicit switch is required", async ({
  page,
}) => {
  await wallet(page, "mainnet");
  await open(page);
  await expect(page.locator("#test-status")).toContainText(
    "Mainnet and other chains are blocked",
  );
  expect(await sendCount(page)).toBe(0);
  await page.getByRole("button", { name: "Switch to Base Sepolia" }).click();
  await page.getByRole("button", { name: "Connect test wallet" }).click();
  await review(page);
  await expect(page.locator("#test-send")).toBeVisible();
  expect(await sendCount(page)).toBe(0);
});
test("account change invalidates review before signing", async ({
  page,
}, info) => {
  await wallet(page);
  await open(page);
  await review(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      testAccount: string;
      listeners: Record<string, (v: unknown) => void>;
    };
    w.testAccount = "0x3333333333333333333333333333333333333333";
    w.listeners.accountsChanged([w.testAccount]);
  });
  await expect(page.locator("#test-send")).toHaveCount(0);
  expect(await sendCount(page)).toBe(0);
});
test("insufficient test funds block review", async ({ page }) => {
  await wallet(page, "empty");
  await open(page);
  await review(page);
  await expect(page.locator("#test-status")).toContainText(
    "Insufficient test ETH",
  );
  expect(await sendCount(page)).toBe(0);
});
test("wallet rejection is distinct from uncertain outcomes", async ({
  page,
}) => {
  await wallet(page, "reject");
  await open(page);
  await review(page);
  await page.locator("#test-confirm").check();
  await page.locator("#test-send").click();
  await expect(page.locator("#test-status")).toContainText("You rejected");
  await expect(page.locator("#test-tracking")).toBeEmpty();
  expect(await sendCount(page)).toBe(1);
});
test("uncertain submission is not automatically retried", async ({ page }) => {
  await wallet(page, "uncertain");
  await open(page);
  await review(page);
  await page.locator("#test-confirm").check();
  await page.locator("#test-send").click();
  await expect(page.locator("#test-tracking")).toContainText(
    "outcome uncertain",
  );
  await expect(
    page.getByRole("button", { name: "Review test payment" }),
  ).toBeDisabled();
  expect(await sendCount(page)).toBe(1);
});
test("simulation does not connect wallet or send anything", async ({
  page,
}) => {
  await wallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "⇄ Swap", exact: true }).click();
  await page.getByRole("button", { name: "Start simulated swap" }).click();
  await page.getByRole("button", { name: "Next simulated step" }).click();
  await page.getByRole("button", { name: "Next simulated step" }).click();
  await expect(page.locator("#simulation-status")).toContainText(
    "No assets were transferred",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { calls: unknown[] }).calls.length,
    ),
  ).toBe(0);
});
test("search-selected assets beyond old 150-token limit remain selectable", async ({
  page,
}) => {
  await page.route("**/v0/tokens", (r) =>
    r.fulfill({
      json: Array.from({ length: 160 }, (_, i) => ({
        assetId: "token-" + i,
        symbol: "TOKEN" + i,
        blockchain: "eth",
        decimals: 18,
        price: 1,
      })),
    }),
  );
  await page.goto("/");
  await expect(page.locator(".livebadge")).toContainText("Live");
  await page.locator("#search").fill("TOKEN159");
  await page.getByRole("button", { name: "Preview TOKEN159 swap" }).click();
  await expect(page.locator("#from")).toHaveValue("token-159");
});

test("testnet request links prefill only, with no wallet side effects", async ({
  page,
}) => {
  await wallet(page);
  await page.goto(
    "/#address=0x2222222222222222222222222222222222222222&amount=0.005&chain=base-sepolia&symbol=ETH",
  );
  await expect(page.locator("#test-to")).toHaveValue(to);
  await expect(page.locator("#test-amount")).toHaveValue("0.005");
  await expect(page.locator("#request-preview")).toContainText(
    "Base Sepolia testnet",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { calls: unknown[] }).calls.length,
    ),
  ).toBe(0);
});
