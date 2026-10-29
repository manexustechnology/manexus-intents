import { expect, test, type Page } from "@playwright/test";

const ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const SIG = "0x" + "11".repeat(65);

async function mockApi(page: Page, me: () => { status: number; json: unknown }) {
  const calls: { path: string; body: unknown }[] = [];
  // Block every non-local request: no wallet or RPC traffic in tests.
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    const body = r.request().postData() ? JSON.parse(r.request().postData()!) : null;
    calls.push({ path, body });
    if (path === "/api/me") return r.fulfill(me());
    if (path === "/api/auth/challenge")
      return r.fulfill({ json: { nonce: "bm9uY2U=", message: `Manexus Intents sign-in\nAccount: ${ADDR.toLowerCase()}\nNonce: bm9uY2U=`, recipient: "manexus-intents" } });
    if (path === "/api/auth/verify") return r.fulfill({ json: { account: ADDR.toLowerCase(), kind: "evm" } });
    if (path === "/api/auth/logout") return r.fulfill({ json: { ok: true } });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

test("signed-out home shows the wallet login", async ({ page }) => {
  await mockApi(page, () => ({ status: 401, json: { error: "Not signed in" } }));
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: "Connect NEAR wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect EVM wallet" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect NEAR wallet" }).click();
  await expect(page.getByRole("button", { name: "Meteor Wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "HOT Wallet" })).toBeVisible();
});

test("private routes require sign-in; the pay page does not", async ({ page }) => {
  await mockApi(page, () => ({ status: 401, json: { error: "Not signed in" } }));
  await page.goto("/#/invoices");
  await expect(page.getByRole("button", { name: "Connect EVM wallet" })).toBeVisible();
  await page.goto("/#/pay/abc");
  await expect(page.getByRole("heading", { name: "Invoice unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect NEAR wallet" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect EVM wallet" })).toHaveCount(0);
});

test("signed-in user sees the app shell with account chip", async ({ page }) => {
  await mockApi(page, () => ({ status: 200, json: { account: "alice.near", kind: "near" } }));
  await page.goto("/#/");
  await expect(page.locator(".account-chip")).toContainText("alice.near");
  await expect(page.getByRole("button", { name: "Connect NEAR wallet" })).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const name of ["Home", "Invoices", "Withdraw"]) await expect(nav.getByRole("link", { name })).toBeVisible();
  await nav.getByRole("link", { name: "Withdraw" }).click();
  await expect(page).toHaveURL(/#\/withdraw$/);
  await expect(page.getByRole("heading", { name: "Withdraw" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Withdraw" })).toHaveAttribute("aria-current", "page");
});

test("EVM sign-in with an injected wallet, then sign out", async ({ page }) => {
  let signedIn = false;
  const calls = await mockApi(page, () =>
    signedIn ? { status: 200, json: { account: ADDR.toLowerCase(), kind: "evm" } } : { status: 401, json: { error: "Not signed in" } },
  );
  await page.addInitScript(
    ([addr, sig]) => {
      const log: unknown[] = [];
      (window as unknown as { __eth: unknown[] }).__eth = log;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          log.push({ method, params });
          if (method === "eth_requestAccounts") return [addr];
          if (method === "personal_sign") return sig;
          throw new Error("unsupported " + method);
        },
      };
    },
    [ADDR, SIG],
  );
  await page.goto("/#/");
  await page.getByRole("button", { name: "Connect EVM wallet" }).click();
  await expect(page.locator(".account-chip")).toContainText("0xabcd…ef01");
  signedIn = true;

  const eth = (await page.evaluate(() => (window as unknown as { __eth: unknown[] }).__eth)) as { method: string; params?: unknown[] }[];
  expect(eth.map((c) => c.method)).toEqual(["eth_requestAccounts", "personal_sign"]);
  const message = `Manexus Intents sign-in\nAccount: ${ADDR.toLowerCase()}\nNonce: bm9uY2U=`;
  expect(eth[1].params).toEqual(["0x" + Buffer.from(message).toString("hex"), ADDR.toLowerCase()]);
  expect(calls.find((c) => c.path === "/api/auth/challenge")?.body).toEqual({ kind: "evm", account: ADDR.toLowerCase() });
  expect(calls.find((c) => c.path === "/api/auth/verify")?.body).toEqual({ kind: "evm", account: ADDR.toLowerCase(), nonce: "bm9uY2U=", signature: SIG });

  signedIn = false;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Connect EVM wallet" })).toBeVisible();
  expect(calls.some((c) => c.path === "/api/auth/logout")).toBe(true);
});

test("EVM sign-in without an injected wallet shows a clear error", async ({ page }) => {
  await mockApi(page, () => ({ status: 401, json: { error: "Not signed in" } }));
  await page.goto("/#/");
  await page.getByRole("button", { name: "Connect EVM wallet" }).click();
  await expect(page.getByRole("status")).toContainText("No EVM wallet found");
});
