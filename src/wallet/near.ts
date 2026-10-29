// NEAR wallets via wallet-selector: Meteor and HOT only (both sign NEP-413 without a page redirect).
// The selector and wallet modules are loaded lazily so the app shell does not pay for them.
import type { InjectedWallet, WalletSelector } from "@near-wallet-selector/core";

export type NearWalletId = "meteor-wallet" | "hot-wallet";
export const NEAR_WALLETS: { id: NearWalletId; name: string }[] = [
  { id: "meteor-wallet", name: "Meteor Wallet" },
  { id: "hot-wallet", name: "HOT Wallet" },
];

let selectorPromise: Promise<WalletSelector> | null = null;
let current: { walletId: NearWalletId; accountId: string } | null = null;

function selector(): Promise<WalletSelector> {
  selectorPromise ??= (async () => {
    // HOT's SDK uses Node's Buffer at call time; provide the browser polyfill before loading it.
    const g = globalThis as { Buffer?: unknown };
    if (!g.Buffer) g.Buffer = (await import("buffer")).Buffer;
    const [{ setupWalletSelector }, { setupMeteorWallet }, { setupHotWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/hot-wallet"),
    ]);
    return setupWalletSelector({ network: "mainnet", modules: [setupMeteorWallet(), setupHotWallet()] });
  })().catch((e) => {
    selectorPromise = null;
    throw e;
  });
  return selectorPromise;
}

export async function connectNear(walletId: NearWalletId): Promise<string> {
  const wallet = await (await selector()).wallet<InjectedWallet>(walletId);
  const accounts = await wallet.signIn({});
  const accountId = accounts?.[0]?.accountId;
  if (typeof accountId !== "string" || !accountId) throw new Error("The wallet did not return an account.");
  current = { walletId, accountId };
  return accountId;
}

/** NEP-413 signMessage. Returns the wallet's `ed25519:<base58>` public key and base64 signature. */
export async function signNep413(p: { message: string; nonce: Uint8Array; recipient: string }): Promise<{ publicKey: string; signature: string }> {
  if (!current) throw new Error("Connect a NEAR wallet first.");
  const wallet = await (await selector()).wallet<InjectedWallet>(current.walletId);
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages.");
  // wallet-selector types the nonce as Buffer; both supported wallets accept any Uint8Array.
  const signed = await wallet.signMessage({ message: p.message, nonce: p.nonce as never, recipient: p.recipient });
  if (!signed) throw new Error("The wallet did not return a signature.");
  if (signed.accountId !== current.accountId) throw new Error("The wallet signed with a different account than the one connected.");
  return { publicKey: signed.publicKey, signature: signed.signature };
}

export async function disconnectNear(): Promise<void> {
  const c = current;
  current = null;
  if (!c || !selectorPromise) return;
  try {
    await (await (await selectorPromise).wallet(c.walletId)).signOut();
  } catch {
    /* best effort */
  }
}
