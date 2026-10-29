import { isAddress, isHex, verifyMessage } from "viem";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { NearRpc } from "./near-rpc.ts";

export type Kind = "near" | "evm";
export const RECIPIENT = "manexus-intents" as const;
export const NEAR_MESSAGE = "Sign in to Manexus Intents";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NEP413_TAG = 2147484061; // 2**31 + 413

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Returns the canonical Intents account id for (account, kind), or null if invalid. */
export function normalizeAccount(account: unknown, kind: unknown): string | null {
  if (typeof account !== "string") return null;
  if (kind === "evm") return isAddress(account, { strict: false }) ? account.toLowerCase() : null;
  if (kind === "near") return account.length >= 2 && account.length <= 64 && NEAR_ACCOUNT.test(account) ? account : null;
  return null;
}

export function evmMessage(account: string, nonce: string): string {
  return `Manexus Intents sign-in\nAccount: ${account}\nNonce: ${nonce}`;
}

export async function createChallenge(
  db: Db,
  account: string,
  kind: Kind,
  now = Date.now(),
): Promise<{ nonce: string; message: string; recipient: typeof RECIPIENT }> {
  const acct = normalizeAccount(account, kind);
  if (!acct) throw new HttpError(400, "Invalid account");
  const nonce = base64.encode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now).run();
  await db
    .prepare("INSERT INTO challenges (nonce, account, kind, expires_at, used, purpose) VALUES (?, ?, ?, ?, 0, 'login')")
    .bind(nonce, acct, kind, now + CHALLENGE_TTL_MS)
    .run();
  return { nonce, message: kind === "evm" ? evmMessage(acct, nonce) : NEAR_MESSAGE, recipient: RECIPIENT };
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

/** NEP-413 payload hash: sha256(u32le(2^31+413) ‖ borsh{message, nonce[32], recipient, Option<callbackUrl>}). */
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const cb = p.callbackUrl == null ? [Uint8Array.of(0)] : [Uint8Array.of(1), borshString(p.callbackUrl)];
  const parts = [tag, borshString(p.message), p.nonce, borshString(p.recipient), ...cb];
  const buf = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let off = 0;
  for (const x of parts) {
    buf.set(x, off);
    off += x.length;
  }
  return sha256(buf);
}

function decodeOrNull<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

export type LoginBody = { kind: unknown; account: unknown; nonce: unknown; signature: unknown; publicKey?: unknown };

const fail = () => new HttpError(401, "Sign-in failed");

/** What a wallet signed for a challenge: `message` is the ERC-191 personal_sign text or the NEP-413 `message`. */
export type SignedMessage = { kind: unknown; account: string; nonce: unknown; signature: unknown; publicKey?: unknown; message: string; purpose: string };

/**
 * Consume the challenge `nonce` atomically (exists, unused, unexpired, bound to this account, kind and
 * purpose), then verify the signature over `message`: ERC-191 by `account`, or NEP-413
 * `{message, nonce (the challenge's 32 bytes), recipient: "manexus-intents"}` by a full-access key of
 * `account`. `account` must already be normalized. Returns false on any failure; the challenge is spent
 * even when the signature is bad. An RPC failure during the NEAR full-access check throws 503 (challenge still spent).
 */
export async function verifySignedMessage(db: Db, rpc: NearRpc, m: SignedMessage, now = Date.now()): Promise<boolean> {
  const { kind, account, nonce, signature, publicKey, message, purpose } = m;
  if (typeof nonce !== "string" || typeof signature !== "string") return false;

  const consumed = await db
    .prepare("UPDATE challenges SET used = 1 WHERE nonce = ? AND account = ? AND kind = ? AND purpose = ? AND used = 0 AND expires_at > ?")
    .bind(nonce, account, kind, purpose, now)
    .run();
  if (consumed.meta.changes !== 1) return false;

  if (kind === "evm") {
    if (!isHex(signature)) return false;
    return verifyMessage({ address: account as `0x${string}`, message, signature }).catch(() => false);
  }

  // NEAR (NEP-413)
  if (typeof publicKey !== "string" || !publicKey.startsWith("ed25519:")) return false;
  const pk = decodeOrNull(() => base58.decode(publicKey.slice("ed25519:".length)));
  const sig = decodeOrNull(() => base64.decode(signature));
  const nonceBytes = decodeOrNull(() => base64.decode(nonce));
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64 || !nonceBytes || nonceBytes.length !== 32) return false;
  const hash = nep413Hash({ message, nonce: nonceBytes, recipient: RECIPIENT, callbackUrl: null });
  if (!decodeOrNull(() => ed25519.verify(sig, hash, pk))) return false;
  let key: Awaited<ReturnType<NearRpc["viewAccessKey"]>>;
  try {
    key = await rpc.viewAccessKey(account, "ed25519:" + base58.encode(pk));
  } catch {
    // RPC error or timeout: not a bad signature. The challenge stays consumed; the owner signs a fresh one.
    throw new HttpError(503, "NEAR RPC is unavailable, try again");
  }
  return !!key && key.permission === "FullAccess";
}

export async function verifyLogin(db: Db, rpc: NearRpc, body: LoginBody, now = Date.now()): Promise<string> {
  const { kind, nonce, signature, publicKey } = body;
  const account = normalizeAccount(body.account, kind);
  if (!account || typeof nonce !== "string" || typeof signature !== "string") throw fail();
  const message = kind === "evm" ? evmMessage(account, nonce) : NEAR_MESSAGE;
  if (!(await verifySignedMessage(db, rpc, { kind, account, nonce, signature, publicKey, message, purpose: "login" }, now))) throw fail();
  return account;
}
