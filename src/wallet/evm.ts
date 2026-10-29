// Thin EIP-1193 adapter over the injected `window.ethereum`. EOAs only: the server verifies
// signatures with ecrecover, so smart-contract (EIP-1271) wallets cannot sign in.
export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

let current: string | null = null;

function provider(): Eip1193Provider {
  const p = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!p || typeof p.request !== "function") throw new Error("No EVM wallet found. Install or enable a browser wallet such as MetaMask.");
  return p;
}

function utf8Hex(s: string): string {
  return "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function connectEvm(): Promise<string> {
  const accounts = (await provider().request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new Error("The wallet did not return an account.");
  current = first.toLowerCase();
  return current;
}

/** ERC-191 `personal_sign` of a UTF-8 message with the connected account. */
export async function signErc191(message: string): Promise<string> {
  if (!current) throw new Error("Connect an EVM wallet first.");
  const sig = await provider().request({ method: "personal_sign", params: [utf8Hex(message), current] });
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error("The wallet returned an invalid signature.");
  return sig;
}

export function evmConnectedAccount(): string | null {
  return current;
}

export function disconnectEvm(): void {
  current = null;
}
