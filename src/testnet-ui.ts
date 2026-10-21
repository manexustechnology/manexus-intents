import { escapeHTML as esc, parseRequest } from "./domain.ts";
import { formatUnits } from "./live.ts";
import {
  TEST_CHAIN,
  EXPLORER,
  address,
  payment,
  checkWallet,
  preflight,
  submitTestPayment,
  receiptState,
  validHash,
  type Payment,
  type Provider,
} from "./testnet.ts";
declare global {
  interface Window {
    ethereum?: Provider;
  }
}
const KEY = "manexus-testnet-payment-v1";
type RecordData = { payment: Payment; hash?: string; state: string };
let root: HTMLElement | undefined,
  provider: Provider | undefined,
  account = "",
  review: Payment | undefined,
  revision = 0,
  busy = false,
  notice = "",
  record: RecordData | undefined;
try {
  const stored = localStorage.getItem(KEY);
  if (stored) {
    const r = JSON.parse(stored);
    const p = payment(r.payment.from, r.payment.to, r.payment.amount);
    if (r.payment.chainId === TEST_CHAIN && (!r.hash || validHash(r.hash)))
      record = {
        payment: p,
        hash: r.hash,
        state:
          r.state === "confirmed" || r.state === "reverted"
            ? r.state
            : "uncertain",
      };
  }
} catch {
  /* Invalid browser storage is not used for transactions. */
}
function save() {
  if (record) localStorage.setItem(KEY, JSON.stringify(record));
  else localStorage.removeItem(KEY);
}
function invalidate(message = "Wallet changed. Review the payment again.") {
  revision++;
  review = undefined;
  account = "";
  notice = message;
  draw();
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Wallet request failed. No automatic retry will be attempted.";
}
function value(id: string) {
  return root!.querySelector<HTMLInputElement>("#" + id)!.value.trim();
}
function status(text: string) {
  notice = text;
  const el = root?.querySelector("#test-status");
  if (el) el.textContent = text;
}
export function mountTestnet(container: HTMLElement) {
  root = document.createElement("section");
  root.className = "panel testnet-panel";
  const heading = container.querySelector(".heading");
  if (heading) heading.after(root);
  else container.prepend(root);
  draw();
}
function draw() {
  if (!root?.isConnected) return;
  const previousTo =
      root.querySelector<HTMLInputElement>("#test-to")?.value ?? "",
    previousAmount =
      root.querySelector<HTMLInputElement>("#test-amount")?.value ?? "0.001";
  const shared = parseRequest(location.hash);
  root.innerHTML = `<div class="section-title"><h2>Try a testnet payment</h2><span class="badge">Base Sepolia · test ETH only</span></div><p class="fine">A genuine test-network transfer you approve in your own wallet. Test ETH has no monetary value. This is not a NEAR Intents swap. Mainnet transfers are blocked.</p><div class="wallet-actions"><button class="primary" id="test-connect" ${busy ? "disabled" : ""}>${account ? "Reconnect wallet" : "Connect test wallet"}</button><button class="textbutton" id="test-switch" ${busy ? "disabled" : ""}>Switch to Base Sepolia</button><a href="https://docs.base.org/get-started/get-funds" target="_blank" rel="noreferrer">Free faucet guide ↗</a></div><p class="fine address-line">${account ? "Connected: " + esc(account) : "Use an injected EVM wallet, including a mobile wallet’s in-app browser. No keys or seed phrases are requested."}</p><form id="test-form"><label>Recipient on Base Sepolia<input id="test-to" placeholder="0x…" autocomplete="off" value="${esc(previousTo || (shared?.chain === "base-sepolia" ? shared.address : ""))}" required ${busy || record ? "disabled" : ""}></label><label>Amount of test ETH (maximum 0.1)<input id="test-amount" inputmode="decimal" value="${esc(shared?.chain === "base-sepolia" && !previousTo ? shared.amount : previousAmount)}" required ${busy || record ? "disabled" : ""}></label><button class="primary full" ${busy || record ? "disabled" : ""}>Review test payment</button></form><div id="test-review"></div><div id="test-tracking"></div><p id="test-status" role="status" class="fine">${esc(notice)}</p><p class="fine">This flow sends only native test ETH to a plain address. Wallet gas estimates are approximate; review network, recipient, amount and fee in your wallet. Public transactions are not private. Payment details and transaction hash are kept in this browser for recovery.</p>`;
  root.querySelector("#test-connect")!.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    review = undefined;
    draw();
    try {
      if (!window.ethereum)
        throw Error(
          "No injected wallet found. Open this site in an EVM wallet browser or install a trusted wallet yourself.",
        );
      if (provider !== window.ethereum) {
        provider = window.ethereum;
        provider.on?.("accountsChanged", () => invalidate());
        provider.on?.("chainChanged", () => invalidate());
        provider.on?.("disconnect", () => invalidate("Wallet disconnected."));
      }
      await provider.request({ method: "eth_requestAccounts" });
      account = await checkWallet(provider);
      notice = "Connected to Base Sepolia. Enter a test payment to review.";
    } catch (e) {
      notice = message(e);
    } finally {
      busy = false;
      draw();
    }
  });
  root.querySelector("#test-switch")!.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    draw();
    try {
      const p = window.ethereum;
      if (!p) throw Error("Open this site in an injected EVM wallet browser.");
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TEST_CHAIN }],
      });
      notice = "Base Sepolia selected. Connect your test wallet.";
    } catch (e) {
      notice =
        (e as { code?: number })?.code === 4902
          ? "Add Base Sepolia in your wallet: chain ID 84532, RPC https://sepolia.base.org. Then reconnect."
          : message(e);
    } finally {
      busy = false;
      draw();
    }
  });
  root.querySelector("#test-form")!.addEventListener("input", () => {
    revision++;
    review = undefined;
    root!.querySelector("#test-review")!.innerHTML = "";
  });
  root.querySelector("#test-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || record) return;
    try {
      if (!provider || !account)
        throw Error("Connect a wallet on Base Sepolia first.");
      const p = payment(account, value("test-to"), value("test-amount")),
        version = revision;
      busy = true;
      status("Checking testnet balance and gas…");
      const fee = await preflight(provider, p);
      if (version !== revision)
        throw Error("Wallet or details changed. Review again.");
      review = p;
      const section = root!.querySelector("#test-review")!;
      section.innerHTML = `<div class="note"><strong>Review your Base Sepolia payment</strong><dl><div><dt>Amount</dt><dd>${esc(p.amount)} test ETH</dd></div><div><dt>From</dt><dd class="address-line">${esc(p.from)}</dd></div><div><dt>To</dt><dd class="address-line">${esc(p.to)}</dd></div><div><dt>Estimated execution gas</dt><dd>${esc(formatUnits(fee.toString(), 18))} test ETH</dd></div></dl><p class="fine">Your wallet shows final fees, including any L1 data cost. Review expires after 60 seconds. Nothing has been sent.</p><label class="confirm-label"><input type="checkbox" id="test-confirm"> I checked the recipient and Base Sepolia network.</label><button id="test-send" class="primary full" disabled>Approve test ETH payment in wallet</button></div>`;
      const button = section.querySelector<HTMLButtonElement>("#test-send")!;
      section.querySelector<HTMLInputElement>("#test-confirm")!.onchange = (
        e,
      ) => (button.disabled = !(e.target as HTMLInputElement).checked);
      const reviewedAt = Date.now();
      button.onclick = () => void send(p, version, reviewedAt);
      setTimeout(() => {
        if (review === p && !busy) {
          review = undefined;
          section.innerHTML =
            '<p class="fine">Review expired. Review the payment again.</p>';
        }
      }, 60000);
      status("Ready for your review. Wallet confirmation is still required.");
    } catch (e) {
      status(message(e));
    } finally {
      busy = false;
    }
  });
  if (record) {
    const r = record;
    const tracking = root.querySelector("#test-tracking")!;
    tracking.innerHTML = `<div class="note"><h3>Test payment tracking</h3><p>${esc(r.payment.amount)} test ETH to <span class="address-line">${esc(r.payment.to)}</span></p><p id="receipt-status">${esc(r.state === "confirmed" ? "Confirmed on Base Sepolia (not finality guaranteed)" : r.state === "reverted" ? "Transaction reverted on Base Sepolia" : r.hash ? "Submitted — confirmation not yet verified" : "Wallet outcome uncertain — check your wallet before another payment")}</p>${r.hash ? `<a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noreferrer">View testnet transaction ↗</a><button id="test-check" class="textbutton">Check confirmation</button>` : ""}<p class="fine">No automatic resend. If a wallet prompt is still open, resolve it there. Confirm activity in your wallet and explorer before clearing this record.</p><label class="confirm-label"><input id="clear-confirm" type="checkbox"> I checked my wallet and understand clearing tracking does not cancel a transaction.</label><button id="test-clear" class="textbutton" disabled>Clear local tracking</button></div>`;
    tracking
      .querySelector("#test-check")
      ?.addEventListener("click", () => void checkReceipt(r));
    tracking.querySelector<HTMLInputElement>("#clear-confirm")!.onchange = (
      e,
    ) =>
      ((tracking.querySelector("#test-clear") as HTMLButtonElement).disabled =
        !(e.target as HTMLInputElement).checked || busy);
    tracking.querySelector("#test-clear")!.addEventListener("click", () => {
      if (busy) return;
      record = undefined;
      save();
      notice =
        "Tracking cleared locally. Any previously submitted transaction is unchanged.";
      draw();
    });
  }
}
async function send(p: Payment, version: number, reviewedAt: number) {
  if (busy || record || review !== p) return;
  busy = true;
  let submitted = false;
  try {
    if (version !== revision || Date.now() - reviewedAt > 60000)
      throw Error("Review expired or wallet changed. Review again.");
    if (!provider) throw Error("Reconnect your wallet.");
    await preflight(provider, p);
    if (version !== revision || Date.now() - reviewedAt > 60000 || review !== p)
      throw Error("Payment details changed. Review again.");
    record = { payment: p, state: "uncertain" };
    save(); // Persist before asking the wallet; reloads cannot trigger an automatic resend.
    submitted = true;
    draw();
    status("Approve or reject the Base Sepolia payment in your wallet.");
    const hash = await submitTestPayment(provider, p);
    record = { payment: p, hash, state: "pending" };
    save();
    notice =
      "Transaction submitted to Base Sepolia. Confirmation is not yet verified.";
  } catch (e) {
    if (submitted && (e as { code?: number })?.code === 4001) {
      record = undefined;
      save();
      notice =
        "You rejected the wallet request. No transaction was submitted by this app.";
    } else
      notice =
        message(e) +
        (submitted
          ? " Outcome may be uncertain. Check wallet activity; do not resend blindly."
          : "");
  } finally {
    busy = false;
    review = undefined;
    draw();
  }
}
async function checkReceipt(r: RecordData) {
  if (busy || !r.hash) return;
  busy = true;
  try {
    if (!provider)
      throw Error("Reconnect the test wallet to check its network receipt.");
    await checkWallet(provider);
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [r.hash],
    });
    await checkWallet(provider);
    r.state = receiptState(receipt, r.hash);
    save();
    notice =
      r.state === "pending"
        ? "Still pending. Check again later."
        : r.state === "confirmed"
          ? "Receipt confirms the testnet transfer. This is not cross-chain settlement."
          : "Transaction reverted. The test payment did not execute; testnet gas may have been spent.";
  } catch (e) {
    notice = message(e);
  } finally {
    busy = false;
    draw();
  }
}
export function mountSimulation(container: HTMLElement) {
  const section = document.createElement("section");
  section.className = "panel testnet-panel";
  section.innerHTML = `<div class="section-title"><h2>Practice a cross-chain flow</h2><span class="badge">Simulation · no blockchain</span></div><p class="fine">NEAR Intents has no testnet. This local walkthrough simulates a quote, deposit detection and settlement without a wallet, real API quote, transaction or token movement. The public mainnet quote preview below remains read-only.</p><button class="primary" id="simulate">Start simulated swap</button><ol id="simulation-status" aria-live="polite"></ol>`;
  container.prepend(section);
  let step = 0;
  section.querySelector("#simulate")!.addEventListener("click", () => {
    const labels = [
      "Simulated quote prepared: 10 demo USDC → 3 demo NEAR. Invented rate.",
      "Simulated deposit detected. No deposit address or transaction exists.",
      "Simulated settlement complete. No assets were transferred.",
    ];
    const list = section.querySelector("#simulation-status")!;
    if (step === 3) {
      step = 0;
      list.innerHTML = "";
    }
    const li = document.createElement("li");
    li.textContent = labels[step++];
    list.append(li);
    section.querySelector("#simulate")!.textContent =
      step === 3 ? "Restart simulation" : "Next simulated step";
  });
}
