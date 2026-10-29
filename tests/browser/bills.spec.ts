import { expect, test, type Page } from "@playwright/test";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const DEP = "c".repeat(64);
const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const bill = (over: Record<string, unknown> = {}) => ({
  id: "b1", owner: ADDR, vendor: "Vendor <b>Studio</b>", reference: "V-42", dueDate: day(5), destinationAsset: USDC, recipientType: "INTENTS",
  recipient: "vendor.near", amount: "1000000", amountFormatted: "1", symbol: "USDC", blockchain: "near", decimals: 6, source: "manexus",
  vendorPublicId: PUBLIC_ID, status: "scheduled", overdue: false, createdAt: "t", updatedAt: "t", extraPayment: false, ...over,
});
const transfer = (status: string) => ({
  depositAddress: DEP, originAsset: USDC, originSymbol: "USDC", amount: "1010000", amountFormatted: "1.01",
  destinationAsset: USDC, destinationSymbol: "USDC", destinationBlockchain: "near", recipient: "vendor.near",
  amountOut: "1000000", amountOutFormatted: "1", minAmountOut: "1000000", minAmountOutFormatted: "1",
  status, destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false, createdAt: "t", updatedAt: "t",
  kind: "bill", swapType: "EXACT_OUTPUT", recipientType: "INTENTS", billId: "b1",
});

async function setup(page: Page, opts: { detail?: () => unknown; list?: unknown[] } = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let submitted = false;
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const path = u.pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path: path + u.search, method: req.method(), body });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [
        { tokenId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24, amount: "1", formatted: "0.000000000000000000000001" },
        { tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5" },
      ] });
    if (path === "/api/tokens")
      return r.fulfill({ json: [{ assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 }, { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6 }] });
    if (path === "/api/bills/import")
      return body.link.includes(PUBLIC_ID)
        ? r.fulfill({ json: { vendor: "Vendor <b>Studio</b>", reference: "V-42", dueDate: day(5), destinationAsset: USDC, recipientType: "INTENTS", recipient: "vendor.near", amount: "1000000", amountFormatted: "1", symbol: "USDC", source: "manexus", vendorPublicId: PUBLIC_ID } })
        : r.fulfill({ status: 400, json: { error: "Paste a Manexus invoice link" } });
    if (path === "/api/bills" && req.method() === "POST") return r.fulfill({ status: 201, json: bill() });
    if (path === "/api/bills") return r.fulfill({ json: opts.list ?? [] });
    if (path === "/api/bills/b1/quote")
      return r.fulfill({ status: 201, json: { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "1", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer("AWAITING_SIGNATURE") } });
    if (path === "/api/transfers/submit") {
      submitted = true;
      return r.fulfill({ json: transfer("PROCESSING") });
    }
    if (path === "/api/bills/b1")
      return r.fulfill({ json: opts.detail ? opts.detail() : submitted ? bill({ status: "paid", transfer: transfer("SUCCESS") }) : bill() });
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
  return calls;
}

const noForbiddenWords = async (page: Page) => {
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
};

test("new bill from a Manexus invoice link: read-only prefill, then save", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/bills/new");
  await expect(page.getByRole("tab", { name: "Paste Manexus invoice link" })).toHaveAttribute("aria-selected", "true");
  await page.locator("#bill-link").fill("https://elsewhere.test/#/pay/nope");
  await page.getByRole("button", { name: "Import invoice" }).click();
  await expect(page.locator("#bill-form-error")).toHaveText("Paste a Manexus invoice link");
  await page.locator("#bill-link").fill(`http://127.0.0.1/#/pay/${PUBLIC_ID}`);
  await page.getByRole("button", { name: "Import invoice" }).click();
  await expect(page.locator("#bill-vendor")).toHaveValue("Vendor <b>Studio</b>");
  await expect(page.locator("#bill-vendor")).toHaveAttribute("readonly", "");
  await expect(page.locator("#bill-amount")).toHaveValue("1 USDC");
  await expect(page.locator("#bill-amount")).toHaveAttribute("readonly", "");
  await expect(page.locator("#bill-recipient")).toHaveValue("Manexus account vendor.near");
  await page.getByRole("button", { name: "Save bill" }).click();
  const post = calls.find((c) => c.path === "/api/bills" && c.method === "POST")!;
  expect(post.body).toEqual({ source: "manexus", vendorPublicId: PUBLIC_ID, dueDate: day(5) });
  await expect(page).toHaveURL(/#\/bills\/b1$/);
  await expect(page.getByRole("heading", { name: "Vendor <b>Studio</b>" })).toBeVisible();
});

test("new manual bill: token, address with network hint, amount the vendor receives", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/bills/new");
  await page.getByRole("tab", { name: "Manual" }).click();
  await expect(page.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
  await page.locator("#bill-vendor").fill("Hosting Ltd");
  await page.locator("#bill-reference").fill("H-9");
  await page.locator("#bill-due").fill(day(10));
  await page.locator("#bill-dest").selectOption(ARB_USDC);
  await expect(page.locator("#bill-network-hint")).toContainText("Enter an address on Arbitrum (arb)");
  await page.locator("#bill-recipient").fill("0x2222222222222222222222222222222222222222");
  await page.locator("#bill-amount").fill("2.1234567");
  await page.getByRole("button", { name: "Save bill" }).click();
  await expect(page.locator("#bill-form-error")).toContainText("at most 6 decimals");
  await page.locator("#bill-amount").fill("12.5");
  await page.getByRole("button", { name: "Save bill" }).click();
  const post = calls.find((c) => c.path === "/api/bills" && c.method === "POST")!;
  expect(post.body).toEqual({
    source: "manual", vendor: "Hosting Ltd", reference: "H-9", dueDate: day(10), destinationAsset: ARB_USDC,
    recipientType: "DESTINATION_CHAIN", recipient: "0x2222222222222222222222222222222222222222", amount: "12.5",
  });
  await expect(page).toHaveURL(/#\/bills\/b1$/);
});

test("bills list: sections by status, due and overdue chips, escaped vendor", async ({ page }) => {
  await setup(page, {
    list: [
      bill({ id: "late", dueDate: day(-3), overdue: true }),
      bill({ id: "soon", vendor: "Soon Co", dueDate: day(2) }),
      bill({ id: "done", vendor: "Done Co", status: "paid" }),
    ],
  });
  await page.goto("/#/bills");
  await expect(page.locator("#bills-section-scheduled .invoice-record")).toHaveCount(2);
  await expect(page.locator("#bills-section-scheduled .invoice-record").first()).toContainText("Overdue");
  await expect(page.locator("#bills-section-scheduled .invoice-record").first()).toContainText("Vendor <b>Studio</b>");
  await expect(page.locator("#bills-section-scheduled b")).toHaveCount(0);
  await expect(page.locator("#bills-section-scheduled .invoice-record").nth(1)).toContainText("Due in 2 days");
  await expect(page.locator("#bills-section-paid")).toContainText("Done Co");
  await expect(page.locator("#bills-section-paying")).toHaveCount(0);
  await expect(page.locator("#bills-section-paid")).not.toContainText("Overdue");
});

test("pay a bill from balance: review, confirm, sign, paid", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/#/bills/b1");
  await page.getByRole("button", { name: "Pay from balance" }).click();
  await expect(page.locator("#bill-origin")).toHaveValue(USDC);
  await page.getByRole("button", { name: "Get quote" }).click();
  expect(calls.find((c) => c.path === "/api/bills/b1/quote")!.body).toEqual({ originAsset: USDC });
  await expect(page.locator("#rv-vendor")).toHaveText("Vendor <b>Studio</b>");
  await expect(page.locator("#rv-network")).toHaveText("NEAR Intents");
  await expect(page.locator("#rv-address")).toHaveText("Manexus account vendor.near");
  await expect(page.locator("#rv-receive")).toHaveText("1 USDC");
  await expect(page.locator("#rv-send")).toHaveText("≈ 1.01 USDC");
  await expect(page.locator("#rv-buffer")).toContainText("refunded to your NEAR Intents balance");
  await expect(page.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  await noForbiddenWords(page);
  await page.locator("#rv-confirm").check();
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#bill-status h2")).toHaveText("Paid");
  expect(calls.find((c) => c.path === "/api/transfers/submit")!.body).toMatchObject({ depositAddress: DEP });
});

test("a paid bill whose vendor invoice was already settled shows the extra payment", async ({ page }) => {
  await setup(page, { detail: () => bill({ status: "paid", extraPayment: true, vendorOutcome: "duplicate", transfer: transfer("SUCCESS") }) });
  await page.goto("/#/bills/b1");
  await expect(page.locator("#bill-status h2")).toHaveText("Paid — vendor reports extra payment");
  await expect(page.locator(".heading .badge").first()).toContainText("Paid — vendor reports extra payment");
  await expect(page.getByRole("button", { name: "Pay from balance" })).toHaveCount(0);
});

test("an overdue scheduled bill shows the overdue chip and can be cancelled", async ({ page }) => {
  let cancelled = false;
  const calls = await setup(page, { detail: () => bill({ dueDate: day(-1), overdue: true, ...(cancelled ? { status: "cancelled" } : {}) }) });
  await page.route("**/api/bills/b1/cancel", (r) => {
    cancelled = true;
    return r.fulfill({ json: bill({ status: "cancelled" }) });
  });
  await page.goto("/#/bills/b1");
  await expect(page.locator(".heading")).toContainText("Overdue");
  await page.getByRole("button", { name: "Cancel bill" }).click();
  await expect(page.locator("#bill-status h2")).toHaveText("Cancelled");
  void calls;
});

test("an unsigned quote can be resumed after leaving the page", async ({ page }) => {
  const pending = { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", amountOutFormatted: "1", intent: { standard: "erc191", payload: PAYLOAD }, transfer: transfer("AWAITING_SIGNATURE") };
  let submitted = false;
  const calls = await setup(page, {
    detail: () => (submitted ? bill({ status: "paid", transfer: transfer("SUCCESS") }) : bill({ status: "paying", depositAddress: DEP, transfer: transfer("AWAITING_SIGNATURE"), pendingQuote: pending })),
  });
  await page.route("**/api/transfers/submit", (r) => {
    submitted = true;
    calls.push({ path: "/api/transfers/submit", method: "POST", body: JSON.parse(r.request().postData()!) });
    return r.fulfill({ json: transfer("PROCESSING") });
  });
  await page.goto("/#/bills/b1");
  await expect(page.locator("#bill-status h2")).toHaveText("Payment in progress");
  await page.getByRole("button", { name: "Review and sign" }).click();
  await expect(page.locator("#rv-send")).toHaveText("≈ 1.01 USDC");
  await page.locator("#rv-confirm").check();
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#bill-status h2")).toHaveText("Paid");
  expect(calls.find((c) => c.path === "/api/transfers/submit")!.body).toMatchObject({ depositAddress: DEP });
  expect(calls.some((c) => c.path === "/api/bills/b1/quote")).toBe(false);
});
