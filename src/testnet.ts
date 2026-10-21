import { isAddress } from "viem";
import { baseUnits } from "./live.ts";
export const TEST_CHAIN = "0x14a34"; // Base Sepolia, 84532. Never parameterized by user input.
export const EXPLORER = "https://sepolia.basescan.org";
export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(name: string, listener: (value: unknown) => void): void;
};
export type Payment = {
  from: string;
  to: string;
  amount: string;
  value: string;
  chainId: typeof TEST_CHAIN;
};
export function address(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAddress(value, { strict: true }) &&
    !/^0x0{40}$/i.test(value)
  );
}
export function payment(from: string, to: string, amount: string): Payment {
  if (!address(from) || !address(to))
    throw Error(
      "Enter a valid nonzero EVM address (mixed-case addresses must pass checksum).",
    );
  const units = BigInt(baseUnits(amount, 18));
  if (units > 10n ** 17n)
    throw Error("This test flow is limited to 0.1 test ETH per payment.");
  return Object.freeze({
    from,
    to,
    amount,
    value: "0x" + units.toString(16),
    chainId: TEST_CHAIN,
  });
}
export async function checkWallet(
  provider: Provider,
  from?: string,
): Promise<string> {
  const chain = await provider.request({ method: "eth_chainId" });
  if (chain !== TEST_CHAIN)
    throw Error(
      "Select Base Sepolia (84532) in your wallet. Mainnet and other chains are blocked.",
    );
  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || !address(accounts[0]))
    throw Error("Connect an EVM wallet first.");
  if (from && accounts[0].toLowerCase() !== from.toLowerCase())
    throw Error("Wallet account changed. Review the payment again.");
  return accounts[0];
}
export function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw Error("Invalid wallet RPC response.");
  return BigInt(value);
}
export function transaction(p: Payment) {
  if (p.chainId !== TEST_CHAIN) throw Error("Only Base Sepolia is supported.");
  const validated = payment(p.from, p.to, p.amount);
  if (validated.value !== p.value) throw Error("Payment details changed.");
  return {
    from: p.from,
    to: p.to,
    value: p.value,
    chainId: TEST_CHAIN,
    data: "0x",
  };
}
export async function preflight(provider: Provider, p: Payment) {
  await checkWallet(provider, p.from);
  const tx = transaction(p);
  const code = await provider.request({
    method: "eth_getCode",
    params: [p.to, "latest"],
  });
  if (code !== "0x")
    throw Error(
      "This test payment flow supports plain receiving addresses only, not contracts.",
    );
  const balance = quantity(
    await provider.request({
      method: "eth_getBalance",
      params: [p.from, "latest"],
    }),
  );
  const gas = quantity(
    await provider.request({ method: "eth_estimateGas", params: [tx] }),
  );
  const gasPrice = quantity(await provider.request({ method: "eth_gasPrice" }));
  if (balance < BigInt(p.value) + gas * gasPrice)
    throw Error(
      "Insufficient test ETH for the payment and estimated gas. Get free faucet funds.",
    );
  await checkWallet(provider, p.from);
  return gas * gasPrice;
}
export function validHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash);
}
export async function submitTestPayment(provider: Provider, p: Payment) {
  await checkWallet(provider, p.from);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [transaction(p)],
  });
  if (!validHash(hash))
    throw Error(
      "Wallet returned no valid hash. Check your wallet before attempting another payment.",
    );
  return hash;
}
export function receiptState(
  receipt: unknown,
  hash: string,
  minedTransaction: unknown,
  reviewed: Payment,
): "pending" | "confirmed" | "reverted" {
  transaction(reviewed); // Revalidate the immutable reviewed request.
  if (!validHash(hash)) throw Error("Invalid transaction hash.");
  if (receipt === null) return "pending";
  if (!receipt || typeof receipt !== "object") throw Error("Invalid receipt.");
  const r = receipt as Record<string, unknown>;
  if (
    r.transactionHash !== hash ||
    !validHash(r.blockHash) ||
    quantity(r.blockNumber) <= 0n ||
    !["0x0", "0x1"].includes(String(r.status))
  )
    throw Error("Invalid receipt.");
  if (!minedTransaction || typeof minedTransaction !== "object")
    throw Error("Mined transaction details unavailable. Payment not verified.");
  const tx = minedTransaction as Record<string, unknown>;
  const sameAddress = (actual: unknown, expected: string) =>
    typeof actual === "string" &&
    actual.toLowerCase() === expected.toLowerCase();
  if (
    tx.hash !== hash ||
    tx.blockHash !== r.blockHash ||
    quantity(tx.blockNumber) !== quantity(r.blockNumber) ||
    quantity(tx.chainId) !== BigInt(TEST_CHAIN) ||
    !sameAddress(tx.from, reviewed.from) ||
    !sameAddress(tx.to, reviewed.to) ||
    !sameAddress(r.from, reviewed.from) ||
    !sameAddress(r.to, reviewed.to) ||
    quantity(tx.value) !== BigInt(reviewed.value) ||
    tx.input !== "0x"
  )
    throw Error(
      "Mined transaction does not match the reviewed payment. Payment not verified.",
    );
  return r.status === "0x1" ? "confirmed" : "reverted";
}

// Read-only confirmation uses the fixed official testnet RPC, never a wallet-supplied URL.
export async function readTestnetRPC(
  method:
    "eth_chainId" | "eth_getTransactionReceipt" | "eth_getTransactionByHash",
  hash?: string,
): Promise<unknown> {
  if (method !== "eth_chainId" && !validHash(hash))
    throw Error("Invalid transaction hash.");
  const response = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: method === "eth_chainId" ? [] : [hash],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      "Base Sepolia confirmation RPC unavailable. Payment not verified.",
    );
  const data = await response.json();
  if (
    !data ||
    data.jsonrpc !== "2.0" ||
    data.id !== 1 ||
    data.error ||
    !("result" in data)
  )
    throw Error("Invalid confirmation RPC response. Payment not verified.");
  return data.result;
}
