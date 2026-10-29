// Pure helpers that turn a 1Click-generated intent payload plus a wallet signature into the
// `signedData` object 1Click relays to intents.near (formats in docs/NEAR-INTENTS.md, Signing).
import { base58, base64, hex } from "@scure/base";

export type Nep413Payload = { recipient: string; nonce: string; message: string };
export type Nep413SignedData = { standard: "nep413"; payload: Nep413Payload; public_key: string; signature: string };
export type Erc191SignedData = { standard: "erc191"; payload: string; signature: string };

export const ED25519_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function decode58(s: string, bytes: number): Uint8Array | null {
  try {
    const b = base58.decode(s);
    return b.length === bytes ? b : null;
  } catch {
    return null;
  }
}

/** ed25519:<base58> public key → 32 raw bytes, or null. */
export function ed25519KeyBytes(key: string): Uint8Array | null {
  return ED25519_KEY.test(key) ? decode58(key.slice(8), 32) : null;
}

/** 32-byte nonce from its base64 form, or null. */
export function nonceBytes(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string") return null;
  try {
    const b = base64.decode(b64);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** Arguments for the wallet's NEP-413 signMessage: message and recipient verbatim, nonce decoded. */
export function nep413SignArgs(p: Nep413Payload): { message: string; nonce: Uint8Array; recipient: string } {
  if (typeof p?.message !== "string" || typeof p.recipient !== "string") throw new Error("Invalid intent payload.");
  const nonce = nonceBytes(p.nonce);
  if (!nonce) throw new Error("Invalid intent nonce.");
  return { message: p.message, nonce, recipient: p.recipient };
}

export function nep413SignedData(payload: Nep413Payload, signed: { publicKey: string; signature: string }): Nep413SignedData {
  if (!ed25519KeyBytes(signed.publicKey)) throw new Error("The wallet returned an invalid public key.");
  let sig: Uint8Array;
  try {
    sig = base64.decode(signed.signature);
  } catch {
    throw new Error("The wallet returned an invalid signature.");
  }
  if (sig.length !== 64) throw new Error("The wallet returned an invalid signature.");
  return { standard: "nep413", payload, public_key: signed.publicKey, signature: "ed25519:" + base58.encode(sig) };
}

/** personal_sign hex (r||s||v, 65 bytes) → secp256k1:<base58> with v normalized to 0/1. */
export function erc191SignedData(payload: string, hexSig: string): Erc191SignedData {
  if (!/^0x[0-9a-fA-F]{130}$/.test(hexSig)) throw new Error("The wallet returned an invalid signature.");
  const bytes = hex.decode(hexSig.slice(2).toLowerCase());
  const v = bytes[64];
  if (v === 27 || v === 28) bytes[64] = v - 27;
  else if (v !== 0 && v !== 1) throw new Error("The wallet returned an invalid signature.");
  return { standard: "erc191", payload, signature: "secp256k1:" + base58.encode(bytes) };
}
