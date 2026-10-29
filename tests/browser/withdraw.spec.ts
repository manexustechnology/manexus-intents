import { expect, test, type Page } from "@playwright/test";
import { base58 } from "@scure/base";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const DEST = "0x2222222222222222222222222222222222222222";
const DEP = "a".repeat(64);
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
// r||s = 0x11 * 64, v = 0x1c (28) → must be normalized to 1 before base58.
const SIG = "0x" + "11".repeat(64) + "1c";
const TX = "0x" + "ab".repeat(32);

const withdrawal = (status: string, over: Record<string, unknown> = {}) => ({
  depositAddress: DEP, originSymbol: "USDC", amountFormatted: "1.5", destinationSymbol: "USDC", destinationBlockchain: "arb", recipient: DEST,
  amountOutFormatted: "1.49", minAmountOutFormatted: "1.48", status, destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z", expired: false,
  createdAt: "2030-01-01T00:00:00.000Z", ...over,
});

async function setup(page: Page, opts: { statuses?: string[] } = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const statuses = [...(opts.statuses ?? ["SUCCESS"])];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path, method: req.method(), body });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5" }] });
    if (path === "/api/tokens")
      return r.fulfill({
        json: [
          { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
          { assetId: ARB, symbol: "USDC", blockchain: "arb", decimals: 6 },
          { assetId: "nep141:x.omft.near", symbol: "XYZ", blockchain: "zzz", decimals: 6 },
        ],
      });
    if (path === "/api/withdrawals" && req.method() === "GET") return r.fulfill({ json: [] });
    if (path === "/api/withdrawals/quote")
      return r.fulfill({
        status: 201,
        json: { depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", intent: { standard: "erc191", payload: PAYLOAD }, withdrawal: withdrawal("AWAITING_SIGNATURE") },
      });
    if (path === "/api/withdrawals/submit") return r.fulfill({ json: withdrawal("PROCESSING", { intentHash: "H" }) });
    if (path === `/api/withdrawals/${DEP}`) {
      const st = statuses.shift() ?? "SUCCESS";
      return r.fulfill({ json: withdrawal(st, st === "SUCCESS" ? { destinationTxHashes: [TX] } : {}) });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
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
  await page.clock.install();
  return calls;
}

async function fillForm(page: Page) {
  await page.goto("/#/withdraw");
  await expect(page.getByRole("heading", { name: "Withdraw" })).toBeVisible();
  await expect(page.getByText("Exchange deposit address or your wallet; check the network matches")).toBeVisible();
  // Unsupported chains are not offered.
  await expect(page.locator("#wd-dest option")).toHaveCount(2);
  await page.locator("#wd-dest").selectOption(ARB);
}

test("EVM withdrawal: review, explicit confirmation, wallet signature, progress, success", async ({ page }) => {
  const calls = await setup(page, { statuses: ["PROCESSING", "SUCCESS"] });
  await fillForm(page);
  await page.locator("#wd-amount").fill("1.5");
  await page.getByLabel("Destination address on Arbitrum (arb)").fill(DEST);
  await page.getByRole("button", { name: "Review withdrawal" }).click();

  const quote = calls.find((c) => c.path === "/api/withdrawals/quote")!;
  expect(quote.body).toEqual({ originAsset: USDC, amount: "1500000", destinationAsset: ARB, recipient: DEST });

  await expect(page.locator("#wd-network")).toHaveText("Arbitrum (arb)");
  await expect(page.locator("#wd-address")).toHaveText(DEST);
  await expect(page.locator("#wd-send")).toHaveText("1.5 USDC");
  await expect(page.locator("#wd-receive")).toHaveText("≈ 1.49 USDC");
  await expect(page.locator("#wd-min")).toContainText("1.48 USDC");
  const signBtn = page.getByRole("button", { name: "Sign in wallet" });
  await expect(signBtn).toBeDisabled();
  await page.getByLabel("I confirm this address is on Arbitrum (arb)").check();
  await expect(signBtn).toBeEnabled();
  await signBtn.click();

  await expect(page.locator("#wd-track")).toBeVisible();
  const submit = calls.find((c) => c.path === "/api/withdrawals/submit")!;
  const bytes = new Uint8Array(65).fill(0x11);
  bytes[64] = 1;
  const expectedSig = base58.encode(bytes);
  expect(submit.body).toEqual({ depositAddress: DEP, signedData: { standard: "erc191", payload: PAYLOAD, signature: "secp256k1:" + expectedSig } });
  const eth = await page.evaluate(() => (window as unknown as { __eth: { method: string; params?: unknown[] }[] }).__eth);
  const ps = eth.find((c) => c.method === "personal_sign")!;
  const hexMsg = "0x" + Buffer.from(PAYLOAD, "utf8").toString("hex");
  expect(ps.params).toEqual([hexMsg, ADDR]);

  await page.clock.runFor(5_100);
  await expect(page.locator("#wd-status")).toContainText("Processing");
  await page.clock.runFor(5_100);
  await expect(page.getByRole("heading", { name: "Withdrawal sent" })).toBeVisible();
  await expect(page.locator("#wd-links a")).toHaveAttribute("href", `https://arbiscan.io/tx/${TX}`);
  await expect(page.locator("#wd-history")).toContainText("Sent");
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
});

test("Max fills the full balance; over-balance and bad input are caught before any quote", async ({ page }) => {
  const calls = await setup(page);
  await fillForm(page);
  await page.getByRole("button", { name: "Max" }).click();
  await expect(page.locator("#wd-amount")).toHaveValue("2.5");
  await page.locator("#wd-amount").fill("2.6");
  await page.locator("#wd-recipient").fill(DEST);
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(page.locator("#wd-error")).toHaveText("Amount exceeds your balance");
  await page.locator("#wd-amount").fill("abc");
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(page.locator("#wd-error")).not.toHaveText("");
  expect(calls.some((c) => c.path === "/api/withdrawals/quote")).toBe(false);
});

test("server rejection is shown and nothing is signed", async ({ page }) => {
  await setup(page);
  await page.route("**/api/withdrawals/quote", (r) => r.fulfill({ status: 400, json: { error: "Enter a valid arb address." } }));
  await fillForm(page);
  await page.locator("#wd-amount").fill("1");
  await page.locator("#wd-recipient").fill("alice.near");
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(page.locator("#wd-error")).toHaveText("Enter a valid arb address.");
  await expect(page.locator("#wd-review")).toHaveCount(0);
  const eth = await page.evaluate(() => (window as unknown as { __eth: unknown[] }).__eth);
  expect(eth).toEqual([]);
});

test("after a submit error the review asks for confirmation again", async ({ page }) => {
  await setup(page);
  await page.route("**/api/withdrawals/submit", (r) => r.fulfill({ status: 502, json: { error: "NEAR Intents: boom" } }));
  await fillForm(page);
  await page.locator("#wd-amount").fill("1.5");
  await page.locator("#wd-recipient").fill(DEST);
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  const box = page.getByLabel("I confirm this address is on Arbitrum (arb)");
  await box.check();
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#wd-review")).toContainText("NEAR Intents: boom");
  await expect(box).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
});
