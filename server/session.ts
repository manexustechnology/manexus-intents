import { base64urlnopad } from "@scure/base";
import type { Env } from "./env.ts";
import { HttpError } from "./http.ts";

export type Session = { account: string; kind: "near" | "evm" };

export const SESSION_COOKIE = "mx_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(account: string, kind: "near" | "evm", secret: string, now = Date.now()): Promise<string> {
  const payload = base64urlnopad.encode(enc.encode(JSON.stringify({ a: account, k: kind, e: now + SESSION_TTL_MS })));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${base64urlnopad.encode(mac)}`;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function readSession(cookieHeader: string | null, secret: string, now = Date.now()): Promise<Session | null> {
  const token = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  let macBytes: Uint8Array;
  let data: unknown;
  try {
    macBytes = base64urlnopad.decode(mac);
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), macBytes as Uint8Array<ArrayBuffer>, enc.encode(payload)))) return null;
    data = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(payload)));
  } catch {
    return null;
  }
  const { a, k, e } = (data ?? {}) as { a?: unknown; k?: unknown; e?: unknown };
  if (typeof a !== "string" || !a || (k !== "near" && k !== "evm") || typeof e !== "number" || e <= now) return null;
  return { account: a, kind: k };
}

export async function requireUser(req: Request, env: Env): Promise<Session> {
  const s = await readSession(req.headers.get("cookie"), env.SESSION_SECRET);
  if (!s) throw new HttpError(401, "Not signed in");
  return s;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
