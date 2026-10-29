import { expect, test, type BrowserContext } from "@playwright/test";

// One stateful fake /api shared by two browser contexts (owner and payer).
// Nothing leaves localhost: every other origin is aborted.
const OWNER = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const DEST = "0x2222222222222222222222222222222222222222";
const DEP_IN = "0xDEPOSIT";
const DEP_OUT = "b".repeat(64);
const REFUND = "0x0000000000000000000000000000000000000001";
const PAYLOAD = JSON.stringify({ signer_id: OWNER, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";
const TX = "0x" + "cd".repeat(32);
const FAR = "2999-01-01T00:00:00.000Z";

function fakeServer() {
  const s = { signedIn: false, invoice: null as null | Record<string, unknown>, quoted: false, paid: false, withdrawn: false };
  const wd = (status: string, extra: Record<string, unknown> = {}) => ({
    depositAddress: DEP_OUT, originSymbol: "USDC", amountFormatted: "0.5", destinationSymbol: "USDC", destinationBlockchain: "arb", recipient: DEST,
    amountOutFormatted: "0.49", minAmountOutFormatted: "0.48", status, destinationTxHashes: [], deadline: FAR, expired: false, createdAt: "2030-01-01T00:00:00.000Z", ...extra,
  });
  const attempt = (status: string, outcome?: string) => ({
    symbol: "USDC", blockchain: "arb", depositAddress: DEP_IN, originAsset: ARB, amountIn: "710180", amountInFormatted: "0.71018", deadline: FAR, status, outcome,
    expired: false, destinationTxHashes: [], ...(status === "SUCCESS" ? { destinationTxHashes: ["6xJZ3tYbKk7d8m9QpR2sT4uV5wX6yZ7aB8cD9eF1gH2j"] } : {}),
  });
  async function install(ctx: BrowserContext) {
    await ctx.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
    await ctx.route("**/api/**", async (r) => {
      const req = r.request();
      const path = new URL(req.url()).pathname;
      const body = req.postData() ? JSON.parse(req.postData()!) : null;
      const m = req.method();
      if (path === "/api/me") return s.signedIn ? r.fulfill({ json: { account: OWNER, kind: "evm" } }) : r.fulfill({ status: 401, json: { error: "Not signed in" } });
      if (path === "/api/auth/challenge") return r.fulfill({ json: { nonce: "bm9uY2U=", message: `Manexus Intents sign-in\nAccount: ${OWNER}\nNonce: bm9uY2U=`, recipient: "manexus-intents" } });
      if (path === "/api/auth/verify") { s.signedIn = true; return r.fulfill({ json: { account: OWNER, kind: "evm" } }); }
      if (path === "/api/tokens")
        return r.fulfill({ json: [{ assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 }, { assetId: ARB, symbol: "USDC", blockchain: "arb", decimals: 6 }] });
      if (path === "/api/balances")
        return r.fulfill({ json: s.paid ? [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "700000", formatted: "0.7", usd: "0.70" }] : [] });
      if (path === "/api/invoices" && m === "GET") return r.fulfill({ json: s.invoice ? [s.invoice] : [] });
      if (path === "/api/invoices" && m === "POST") {
        s.invoice = { id: "id1", publicId: "pub1", owner: OWNER, status: "draft", tokenId: USDC, data: body, total: "700000", revision: 1, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z" };
        return r.fulfill({ status: 201, json: s.invoice });
      }
      if (path === "/api/invoices/id1/issue") { Object.assign(s.invoice!, { status: "issued", issuedAt: "2030-01-01T00:00:00Z", revision: 2 }); return r.fulfill({ json: s.invoice }); }
      if (path === "/api/invoices/id1/payments") return r.fulfill({ json: { invoiceStatus: s.paid ? "paid" : "issued", attempts: [] } });
      if (path === "/api/invoices/id1") return r.fulfill({ json: s.invoice });
      if (path === "/api/public/invoices/pub1")
        return r.fulfill({ json: { publicId: "pub1", status: s.paid ? "paid" : "issued", tokenId: USDC, symbol: "USDC", total: "700000", totalFormatted: "0.7", payTo: OWNER, dueDate: "2030-01-31", data: s.invoice!.data } });
      if (path === "/api/public/invoices/pub1/quote") { s.quoted = true; return r.fulfill({ status: 201, json: { ...attempt("PENDING_DEPOSIT"), status: "PENDING_DEPOSIT" } }); }
      if (path === "/api/public/invoices/pub1/status")
        return r.fulfill({ json: s.paid ? { invoiceStatus: "paid", attempts: [attempt("SUCCESS", "paid")] } : { invoiceStatus: "issued", attempts: s.quoted ? [attempt("PENDING_DEPOSIT")] : [] } });
      if (path === "/api/withdrawals" && m === "GET") return r.fulfill({ json: [] });
      if (path === "/api/withdrawals/quote")
        return r.fulfill({ status: 201, json: { depositAddress: DEP_OUT, deadline: FAR, intent: { standard: "erc191", payload: PAYLOAD }, withdrawal: wd("AWAITING_SIGNATURE") } });
      if (path === "/api/transfers/submit") { s.withdrawn = true; return r.fulfill({ json: wd("PROCESSING") }); }
      if (path === `/api/withdrawals/${DEP_OUT}`) return r.fulfill({ json: wd("SUCCESS", { destinationTxHashes: [TX] }) });
      return r.fulfill({ status: 404, json: { error: "Not found" } });
    });
  }
  return { s, install };
}

test("core loop: sign in, invoice, payer pays, balance, withdraw", async ({ page, browser }) => {
  const { s, install } = fakeServer();
  const ctx = page.context();
  await install(ctx);
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
    [OWNER, SIG],
  );
  await page.clock.install();
  const noOverflow = async (p: typeof page) =>
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth));

  // 1. Sign in
  await page.goto("/#/");
  await page.getByRole("button", { name: "Connect EVM wallet" }).click();
  await expect(page.locator(".account-chip")).toContainText("0xabcd…ef01");
  await noOverflow(page);

  // 2. Create and issue an invoice
  await page.goto("/#/invoices/new");
  await page.locator("#invoice-number").fill("DEMO-001");
  await page.locator("#invoice-issuer").fill("Example Studio");
  await page.locator("#invoice-client").fill("Demo Client");
  await page.getByLabel("Description 1", { exact: true }).fill("Design");
  await page.getByLabel("Quantity 1", { exact: true }).fill("7");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.locator("#invoice-link")).toHaveValue(/#\/pay\/pub1$/);
  const link = await page.locator("#invoice-link").inputValue();
  await noOverflow(page);

  // 3. A different browser context (no session) pays via the public link
  const payerCtx = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: test.info().project.name === "mobile", hasTouch: test.info().project.name === "mobile" });
  try {
    await install(payerCtx);
    const payer = await payerCtx.newPage();
    await payer.clock.install();
    await payer.goto(link);
    await expect(payer.getByRole("heading", { name: "Pay 0.7 USDC" })).toBeVisible();
    await payer.getByRole("option", { name: "USDC · arb" }).click();
    await payer.getByLabel("Refund address on arb").fill(REFUND);
    await payer.getByRole("button", { name: "Get payment instructions" }).click();
    await expect(payer.locator("#pay-address")).toHaveText(DEP_IN);
    await expect(payer.locator("#pay-amount")).toHaveText("0.71018 USDC");
    await noOverflow(payer);
    s.paid = true; // the server reconciled a verified 1Click SUCCESS
    await payer.clock.runFor(10_100);
    await expect(payer.getByRole("heading", { name: "Paid — thank you" })).toBeVisible();
    await noOverflow(payer);
  } finally {
    await payerCtx.close();
  }

  // 4. Owner sees the balance and the paid invoice
  await page.goto("/#/");
  await expect(page.locator("#home-cards")).toContainText("0.7 USDC");
  await expect(page.locator("#home-recent")).toContainText("DEMO-001");
  await noOverflow(page);

  // 5. Withdraw part of it
  await page.goto("/#/withdraw");
  await page.locator("#wd-dest").selectOption(ARB);
  await page.locator("#wd-amount").fill("0.5");
  await page.getByLabel("Destination address on Arbitrum (arb)").fill(DEST);
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(page.locator("#wd-address")).toHaveText(DEST);
  await noOverflow(page);
  await page.getByLabel("I confirm this address is on Arbitrum (arb)").check();
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#wd-track")).toBeVisible();
  await page.clock.runFor(5_100);
  await expect(page.getByRole("heading", { name: "Withdrawal sent" })).toBeVisible();
  expect(s.withdrawn).toBe(true);
  await noOverflow(page);
});
