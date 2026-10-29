import { postJson } from "../api.ts";
import { connectEvm, disconnectEvm, signErc191 } from "./evm.ts";
import { connectNear, disconnectNear, signNep413, type NearWalletId } from "./near.ts";

export type Kind = "near" | "evm";
export type Session = { account: string; kind: Kind };
export { signErc191, signNep413, type NearWalletId };
export { NEAR_WALLETS } from "./near.ts";

export async function connectWallet(kind: Kind, nearWallet: NearWalletId = "meteor-wallet"): Promise<Session> {
  const account = kind === "evm" ? await connectEvm() : await connectNear(nearWallet);
  return { account, kind };
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Full sign-in: connect wallet, fetch a challenge, sign it, and exchange it for a session cookie. */
export async function signIn(kind: Kind, nearWallet?: NearWalletId): Promise<Session> {
  const { account } = await connectWallet(kind, nearWallet);
  const ch = await postJson<{ nonce: string; message: string; recipient: string }>("/api/auth/challenge", { kind, account });
  const body =
    kind === "evm"
      ? { kind, account, nonce: ch.nonce, signature: await signErc191(ch.message) }
      : { kind, account, nonce: ch.nonce, ...(await signNep413({ message: ch.message, nonce: base64ToBytes(ch.nonce), recipient: ch.recipient })) };
  return postJson<Session>("/api/auth/verify", body);
}

export async function disconnectWallet(): Promise<void> {
  disconnectEvm();
  await disconnectNear();
}
