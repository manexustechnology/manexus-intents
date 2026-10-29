import { expect, test, type Page } from "@playwright/test";

// Treasury loop against one stateful fake /api: swap inside the Intents account, pay a bill imported
// from a Manexus invoice link, run a 2-line payroll, then Home shows all of it. No real funds move.
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";
const A1 = "0x1111111111111111111111111111111111111111";
const PAYLOAD = JSON.stringify({ signer_id: ADDR, verifying_contract: "intents.near", deadline: "2999-01-01T00:00:00.000Z", nonce: "AAAA", intents: [] });
const SIG = "0x" + "11".repeat(64) + "1c";
const DEADLINE = "2999-01-01T00:00:00.000Z";
const DEP_SWAP = "a".repeat(64);
const DEP_BILL = "b".repeat(64);
const depLine = (n: number) => String(n).repeat(64);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type T = Record<string, unknown>;
const transfer = (depositAddress: string, kind: string, status: string, o: T = {}): T => ({
  depositAddress, originAsset: USDC, originSymbol: "USDC", amount: "1010000", amountFormatted: "1.01",
  destinationAsset: USDC, destinationSymbol: "USDC", destinationBlockchain: "near", recipient: "vendor.near",
  amountOut: "1000000", amountOutFormatted: "1", minAmountOut: "1000000", minAmountOutFormatted: "1",
  status, destinationTxHashes: [], deadline: DEADLINE, expired: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
  kind, swapType: "EXACT_OUTPUT", recipientType: "INTENTS", ...o,
});
const swapTransfer = (status: string) =>
  transfer(DEP_SWAP, "swap", status, {
    amount: "1000000", amountFormatted: "1", destinationAsset: WNEAR, destinationSymbol: "wNEAR", recipient: ADDR,
    amountOut: "312456000000000000000000", amountOutFormatted: "0.312456", minAmountOut: "309000000000000000000000", minAmountOutFormatted: "0.309",
    swapType: "EXACT_INPUT", createdAt: "2030-01-01T00:01:00.000Z",
  });
const quoteOf = (t: T) => ({ depositAddress: t.depositAddress, deadline: DEADLINE, amountOutFormatted: t.amountOutFormatted, intent: { standard: "erc191", payload: PAYLOAD }, transfer: t });

async function setup(page: Page) {
  const s = { swapped: false, billSaved: false, billPaid: false, batch: false, lines: ["unsent", "unsent"] as string[] };
  const calls: { path: string; method: string }[] = [];
  const bill = () => ({
    id: "b1", owner: ADDR, vendor: "Vendor <b>Studio</b>", reference: "V-42", dueDate: day(5), destinationAsset: USDC, recipientType: "INTENTS",
    recipient: "vendor.near", amount: "1000000", amountFormatted: "1", symbol: "USDC", blockchain: "near", decimals: 6, source: "manexus",
    vendorPublicId: PUBLIC_ID, status: s.billPaid ? "paid" : "scheduled", overdue: false, createdAt: "t", updatedAt: "t", extraPayment: false,
    ...(s.billPaid ? { transfer: transfer(DEP_BILL, "bill", "SUCCESS", { billId: "b1" }) } : {}),
  });
  const lineTransfer = (n: number, status: string) =>
    transfer(depLine(n), "payroll", status, { destinationAsset: ARB_USDC, destinationBlockchain: "arb", recipient: n === 1 ? A1 : "budi.near", recipientType: n === 1 ? "DESTINATION_CHAIN" : "INTENTS", batchId: "p1", createdAt: `2030-01-01T00:0${2 + n}:00.000Z` });
  const batchView = () => ({
    batch: { id: "p1", title: "October <i>pay</i>", originAsset: USDC, originSymbol: "USDC", createdAt: "2030-01-01T00:00:00.000Z" },
    lines: s.lines.map((state, i) => {
      const n = i + 1;
      const t = state === "sent" ? lineTransfer(n, "SUCCESS") : state === "awaiting" ? lineTransfer(n, "AWAITING_SIGNATURE") : undefined;
      return {
        n, name: n === 1 ? "Ana" : "Budi", destinationAsset: n === 1 ? ARB_USDC : USDC, recipientType: n === 1 ? "DESTINATION_CHAIN" : "INTENTS", recipient: n === 1 ? A1 : "budi.near",
        amount: "1000000", symbol: "USDC", blockchain: n === 1 ? "arb" : "near", decimals: 6, amountFormatted: "1", state, canQuote: state === "unsent",
        ...(t ? { depositAddress: depLine(n), transfer: t } : {}), ...(state === "awaiting" ? { pendingQuote: quoteOf(t!) } : {}),
      };
    }),
    summary: { sent: s.lines.filter((x) => x === "sent").length, processing: 0, awaiting: s.lines.filter((x) => x !== "sent").length, failed: 0, total: 2 },
  });
  const activity = () => [
    ...s.lines.flatMap((st, i) => (st === "sent" ? [{ at: `2030-01-01T00:0${3 + i}:00.000Z`, type: "payroll", title: "Payroll", amountFormatted: "1.01", symbol: "USDC", status: "SUCCESS", href: "#/payroll/p1" }] : [])),
    ...(s.billPaid ? [{ at: "2030-01-01T00:02:00.000Z", type: "bill", title: "Bill payment", amountFormatted: "1.01", symbol: "USDC", status: "SUCCESS", href: "#/bills/b1" }] : []),
    ...(s.swapped ? [{ at: "2030-01-01T00:01:00.000Z", type: "swap", title: "Swap USDC → wNEAR", amountFormatted: "1", symbol: "USDC", status: "SUCCESS", href: "#/swap" }] : []),
  ].reverse().sort((a, b) => (a.at < b.at ? 1 : -1));

  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const path = u.pathname;
    const m = req.method();
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path: path + u.search, method: m });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({
        json: [
          { tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: s.swapped ? "9000000" : "10000000", formatted: s.swapped ? "9" : "10", usd: s.swapped ? "9.00" : "10.00" },
          ...(s.swapped ? [{ tokenId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24, amount: "312456000000000000000000", formatted: "0.312456", usd: "1.00" }] : []),
        ],
      });
    if (path === "/api/tokens")
      return r.fulfill({
        json: [
          { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
          { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24, price: 3.2 },
          { assetId: ARB_USDC, symbol: "USDC", blockchain: "arb", decimals: 6, price: 1 },
        ],
      });
    if (path === "/api/invoices") return r.fulfill({ json: [] });
    if (path === "/api/activity") return r.fulfill({ json: u.searchParams.get("summary") ? { month: "2030-01", tokens: [] } : activity() });
    // swap
    if (path === "/api/swaps/quote") return r.fulfill({ status: 201, json: quoteOf(swapTransfer("AWAITING_SIGNATURE")) });
    // bills
    if (path === "/api/bills/import")
      return r.fulfill({ json: { vendor: "Vendor <b>Studio</b>", reference: "V-42", dueDate: day(5), destinationAsset: USDC, recipientType: "INTENTS", recipient: "vendor.near", amount: "1000000", amountFormatted: "1", symbol: "USDC", source: "manexus", vendorPublicId: PUBLIC_ID } });
    if (path === "/api/bills" && m === "POST") return (s.billSaved = true), r.fulfill({ status: 201, json: bill() });
    if (path === "/api/bills") return r.fulfill({ json: s.billSaved && (u.searchParams.get("status") ?? "scheduled") === bill().status ? [bill()] : [] });
    if (path === "/api/bills/b1/quote") return r.fulfill({ status: 201, json: quoteOf(transfer(DEP_BILL, "bill", "AWAITING_SIGNATURE", { billId: "b1" })) });
    if (path === "/api/bills/b1") return r.fulfill({ json: bill() });
    // payroll
    if (path === "/api/payroll/payees") return r.fulfill({ json: [] });
    if (path === "/api/payroll/batches" && m === "POST") return (s.batch = true), r.fulfill({ status: 201, json: batchView() });
    if (path === "/api/payroll/batches") return r.fulfill({ json: s.batch ? [{ id: "p1", title: "October <i>pay</i>", originAsset: USDC, createdAt: "2030-01-01T00:00:00.000Z", total: 2, sent: s.lines.filter((x) => x === "sent").length }] : [] });
    if (path === "/api/payroll/batches/p1") return r.fulfill({ json: batchView() });
    const lq = /^\/api\/payroll\/batches\/p1\/lines\/(\d)\/quote$/.exec(path);
    if (lq) {
      const n = Number(lq[1]);
      if (s.lines[n - 1] !== "unsent") return r.fulfill({ status: 409, json: { error: "Already sent" } });
      s.lines[n - 1] = "awaiting";
      return r.fulfill({ status: 201, json: quoteOf(lineTransfer(n, "AWAITING_SIGNATURE")) });
    }
    // one relay endpoint for every kind
    if (path === "/api/transfers/submit") {
      const dep = String(body.depositAddress);
      if (dep === DEP_SWAP) return (s.swapped = true), r.fulfill({ json: swapTransfer("SUCCESS") });
      if (dep === DEP_BILL) return (s.billPaid = true), r.fulfill({ json: transfer(DEP_BILL, "bill", "SUCCESS", { billId: "b1" }) });
      const n = Number(dep[0]);
      s.lines[n - 1] = "sent";
      return r.fulfill({ json: lineTransfer(n, "SUCCESS") });
    }
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
  return { s, calls };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
}
async function clean(page: Page) {
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["safe", "guaranteed", "insured"]) expect(text).not.toContain(w);
}

/** Go to a section the way a user would: sidebar on desktop, bottom bar (or its More menu) on mobile. */
async function navTo(page: Page, name: string, isMobile: boolean) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  if (isMobile && (name === "Payroll" || name === "Withdraw")) await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("link", { name, exact: true }).click();
}

test("treasury loop: swap, bill from a Manexus link, 2-line payroll, then Home shows all of it", async ({ page, isMobile }) => {
  const { s, calls } = await setup(page);
  await page.goto("/#/");
  await expect(page.locator("#home-activity")).toBeVisible();

  // 1. Swap 1 USDC → wNEAR inside the Intents account.
  await navTo(page, "Swap", isMobile);
  await expect(page.getByRole("heading", { name: "Swap", exact: true })).toBeVisible();
  await page.locator("#sw-origin").selectOption(USDC);
  await page.locator("#sw-amount").fill("1");
  await page.locator("#sw-dest").selectOption(WNEAR);
  await page.getByRole("button", { name: "Get quote" }).click();
  await expect(page.locator("#sw-receive")).toHaveText("≈ 0.312456 wNEAR");
  await clean(page);
  await noOverflow(page);
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.getByRole("heading", { name: "Swapped — new balance on Home" })).toBeVisible();
  expect(s.swapped).toBe(true);

  // 2. Bill imported from a Manexus invoice link, paid from the balance.
  await navTo(page, "Bills", isMobile);
  await page.getByRole("link", { name: "+ New bill" }).click();
  await page.locator("#bill-link").fill(`http://127.0.0.1/#/pay/${PUBLIC_ID}`);
  await page.getByRole("button", { name: "Import invoice" }).click();
  await expect(page.locator("#bill-vendor")).toHaveValue("Vendor <b>Studio</b>");
  await noOverflow(page);
  await page.getByRole("button", { name: "Save bill" }).click();
  await expect(page).toHaveURL(/#\/bills\/b1$/);
  await page.getByRole("button", { name: "Pay from balance" }).click();
  await page.getByRole("button", { name: "Get quote" }).click();
  await expect(page.locator("#rv-receive")).toHaveText("1 USDC");
  await page.locator("#rv-confirm").check();
  await clean(page);
  await noOverflow(page);
  await page.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(page.locator("#bill-status h2")).toHaveText("Paid");

  // 3. Payroll: a 2-line CSV, one signature per line.
  await navTo(page, "Payroll", isMobile);
  await expect(page.getByRole("heading", { name: "Payroll", exact: true })).toBeVisible();
  await page.locator("#batch-title").fill("October");
  const csv = ["name,chain,token,address,amount", `Ana,arb,USDC,${A1},1`, "Budi,near-intents,USDC,budi.near,1"].join("\n");
  await page.locator("#csv-file").setInputFiles({ name: "pay.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.locator("#csv-summary")).toContainText("2 lines");
  await noOverflow(page);
  await page.locator("#batch-create").click();
  await expect(page).toHaveURL(/#\/payroll\/p1$/);
  await expect(page.getByRole("heading", { name: "October <i>pay</i>" })).toBeVisible();
  await page.getByRole("button", { name: "Send all" }).click();
  await page.locator("#run-confirm").check();
  await clean(page);
  await page.getByRole("button", { name: "Start sending" }).click();
  await expect(page.locator("#batch-progress")).toHaveText("2/2 sent");
  await noOverflow(page);
  expect(calls.filter((c) => c.path === "/api/transfers/submit")).toHaveLength(4); // swap, bill, 2 lines

  // 4. Home: the swapped balance and every outbound transfer in the activity feed.
  await navTo(page, "Home", isMobile);
  await expect(page.locator("#home-cards")).toContainText("0.312456 wNEAR");
  const feed = page.locator("#home-activity");
  await expect(feed).toContainText("Swap USDC → wNEAR");
  await expect(feed).toContainText("Bill payment");
  await expect(feed.getByText("Payroll")).toHaveCount(2);
  await expect(feed.locator('a[href="#/payroll/p1"]')).toHaveCount(2);
  await expect(feed.locator('a[href="#/bills/b1"]')).toHaveCount(1);
  await expect(feed.locator('a[href="#/swap"]')).toHaveCount(1);
  await clean(page);
  await noOverflow(page);
});

test("navigation: the desktop sidebar lists every section; on mobile, More opens Payroll, Withdraw and Sign out", async ({ page, isMobile }) => {
  await setup(page);
  await page.goto("/#/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const name of ["Home", "Invoices", "Bills", "Swap"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  const more = nav.getByRole("button", { name: "More" });
  if (!isMobile) {
    for (const name of ["Payroll", "Withdraw"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(more).toBeHidden();
    return;
  }
  await noOverflow(page);
  for (const name of ["Payroll", "Withdraw"]) await expect(nav.getByRole("link", { name, exact: true })).toBeHidden();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator("#more-menu");
  for (const name of ["Payroll", "Withdraw"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  // The open menu stays inside the 390 px viewport.
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await noOverflow(page);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await more.click();
  await menu.getByRole("link", { name: "Withdraw", exact: true }).click();
  await expect(page).toHaveURL(/#\/withdraw$/);
  await expect(more).toHaveClass(/active/);
  await noOverflow(page);
  await more.click();
  await page.locator("#more-menu").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Connect EVM wallet" })).toBeVisible();
});
