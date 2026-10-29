import { postJson } from "../api.ts";
import { connectEvm, disconnectEvm, evmConnectedAccount, signErc191 } from "./evm.ts";
import { connectNear, disconnectNear, nearConnectedAccount, nearPublicKey, registerIntentsKey, signNep413, type NearWalletId } from "./near.ts";

export type Kind = "near" | "evm";
export type Session = { account: string; kind: Kind };
export { nearPublicKey, registerIntentsKey, signErc191, signNep413, type NearWalletId };
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

/** Whether the wallet for this session is connected in this page as the session's account. */
export function walletConnected(s: Session): boolean {
  const a = s.kind === "evm" ? evmConnectedAccount() : nearConnectedAccount();
  return a !== null && a.toLowerCase() === s.account.toLowerCase();
}

/** Connect the session's wallet if needed and require it to be the signed-in account. */
export async function ensureWallet(s: Session, nearWallet?: NearWalletId): Promise<void> {
  if (walletConnected(s)) return;
  const { account } = await connectWallet(s.kind, nearWallet);
  if (account.toLowerCase() !== s.account.toLowerCase())
    throw new Error(`Your wallet is connected as ${account}, but you are signed in as ${s.account}. Switch accounts in your wallet and try again.`);
}

/** A policy-change challenge from POST /api/agent/policy/challenge. */
export type PolicyChallenge = { nonce: string; message: string; recipient: string; hash: string };

/**
 * Sign a policy-change challenge as for sign-in: ERC-191 personal_sign of the message, or NEP-413 with the
 * challenge nonce and recipient. Returns the fields PUT /api/agent/policy and the whitelist routes expect.
 */
export async function signPolicyChallenge(s: Session, ch: PolicyChallenge, nearWallet?: NearWalletId): Promise<{ nonce: string; signature: string; publicKey?: string }> {
  await ensureWallet(s, nearWallet);
  if (s.kind === "evm") return { nonce: ch.nonce, signature: await signErc191(ch.message) };
  const signed = await signNep413({ message: ch.message, nonce: base64ToBytes(ch.nonce), recipient: ch.recipient });
  return { nonce: ch.nonce, signature: signed.signature, publicKey: signed.publicKey };
}
