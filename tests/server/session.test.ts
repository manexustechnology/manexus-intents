import test from "node:test";
import assert from "node:assert/strict";
import { readSession, signSession, sessionCookie, clearSessionCookie } from "../../server/session.ts";

const SECRET = "test-secret-test-secret-test-secret";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const cookie = (token: string) => `other=1; mx_session=${token}; x=y`;

test("session round-trip returns account and kind", async () => {
  const token = await signSession("alice.near", "near", SECRET, NOW);
  assert.deepEqual(await readSession(cookie(token), SECRET, NOW + DAY), { account: "alice.near", kind: "near" });
});

test("tampered HMAC or payload is rejected", async () => {
  const token = await signSession("0xabc0000000000000000000000000000000000000", "evm", SECRET, NOW);
  const [payload, mac] = token.split(".");
  const flipped = mac.slice(0, -2) + (mac.at(-2) === "A" ? "B" : "A") + mac.at(-1);
  assert.equal(await readSession(cookie(`${payload}.${flipped}`), SECRET, NOW), null);
  const otherPayload = (await signSession("mallory.near", "near", SECRET, NOW)).split(".")[0];
  assert.equal(await readSession(cookie(`${otherPayload}.${mac}`), SECRET, NOW), null);
  assert.equal(await readSession(cookie(token), "a-different-secret-a-different-secret", NOW), null);
});

test("expired session (now + 8 days) is rejected", async () => {
  const token = await signSession("alice.near", "near", SECRET, NOW);
  assert.equal(await readSession(cookie(token), SECRET, NOW + 8 * DAY), null);
  assert.ok(await readSession(cookie(token), SECRET, NOW + 6 * DAY));
});

test("missing or malformed cookie yields null", async () => {
  assert.equal(await readSession(null, SECRET, NOW), null);
  assert.equal(await readSession("mx_session=", SECRET, NOW), null);
  assert.equal(await readSession("mx_session=garbage", SECRET, NOW), null);
  assert.equal(await readSession("mx_session=a.b.c", SECRET, NOW), null);
});

test("session cookie attributes", () => {
  const c = sessionCookie("tok");
  assert.match(c, /^mx_session=tok;/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) assert.ok(c.includes(attr), attr);
  assert.match(clearSessionCookie(), /^mx_session=; .*Max-Age=0/);
});

test("requireUser reads the session cookie or throws 401", async () => {
  const { requireUser } = await import("../../server/session.ts");
  const env = { SESSION_SECRET: SECRET } as Parameters<typeof requireUser>[1];
  const token = await signSession("alice.near", "near", SECRET);
  const ok = new Request("https://x/api/me", { headers: { cookie: `mx_session=${token}` } });
  assert.deepEqual(await requireUser(ok, env), { account: "alice.near", kind: "near" });
  await assert.rejects(requireUser(new Request("https://x/api/me"), env), (e: any) => e.status === 401);
});
