import test from "node:test";
import assert from "node:assert/strict";
import { mergeDraft, policyChanges, type PolicyShape } from "../../shared/policy-diff.ts";

const USDC = "nep141:usdc.near";
const USDT = "nep141:usdt.near";
const SAVED: PolicyShape = {
  version: 1,
  convert: { enabled: true, targetTokenId: USDC, minUsdCents: 1000 },
  sweep: { enabled: true, tokenId: USDC, thresholdUnits: "600", keepUnits: "100", whitelistId: "w1" },
  limits: { perTx: { [USDC]: "50" }, daily: { [USDC]: "200" }, whitelistOnly: true },
  reminders: { billDueDays: 3, invoiceOverdueDays: 7 },
};

test("mergeDraft: sections the draft omits keep the saved value; sections it has replace the saved one", () => {
  const draft: PolicyShape = { version: 1, convert: { enabled: true, targetTokenId: USDT, minUsdCents: 7500 } };
  const m = mergeDraft(SAVED, draft);
  assert.deepEqual(m, { ...SAVED, convert: draft.convert });
  // A whole limits section in the draft replaces the saved one (no per-token merge).
  const lim = mergeDraft(SAVED, { version: 1, limits: { perTx: {}, daily: { [USDT]: "5" }, whitelistOnly: false } });
  assert.deepEqual(lim.limits, { perTx: {}, daily: { [USDT]: "5" }, whitelistOnly: false });
  assert.deepEqual(lim.sweep, SAVED.sweep);
  // No saved policy: the draft as is. Empty draft: the saved policy unchanged. Inputs are not mutated.
  assert.deepEqual(mergeDraft(null, draft), draft);
  assert.deepEqual(mergeDraft(SAVED, { version: 1 }), SAVED);
  assert.notEqual(mergeDraft(SAVED, { version: 1 }).limits, SAVED.limits);
});

test("policyChanges: changed sections in a fixed order, key order does not matter", () => {
  assert.deepEqual(policyChanges(SAVED, structuredClone(SAVED)), { changed: [], loosened: [] });
  const reordered = { reminders: { invoiceOverdueDays: 7, billDueDays: 3 }, version: 1 } as PolicyShape;
  assert.deepEqual(policyChanges({ version: 1, reminders: { billDueDays: 3, invoiceOverdueDays: 7 } }, reordered).changed, []);
  const next = { ...SAVED, convert: { ...SAVED.convert!, minUsdCents: 1 }, reminders: undefined, limits: { ...SAVED.limits!, perTx: { [USDC]: "40" } } };
  assert.deepEqual(policyChanges(SAVED, next), { changed: ["convert", "limits", "reminders"], loosened: [] });
  assert.deepEqual(policyChanges(null, SAVED), { changed: ["convert", "sweep", "limits", "reminders"], loosened: [] });
});

test("policyChanges: removing or loosening a saved rule is flagged", () => {
  const L = "Loosens your spending limits";
  const S = "Keeps less in your account after a sweep";
  const lim = (l: PolicyShape["limits"]) => ({ ...SAVED, limits: l });
  assert.deepEqual(policyChanges(SAVED, { ...SAVED, limits: undefined }).loosened, [L]);
  assert.deepEqual(policyChanges(SAVED, lim({ ...SAVED.limits!, perTx: { [USDC]: "51" } })).loosened, [L]); // cap raised
  assert.deepEqual(policyChanges(SAVED, lim({ ...SAVED.limits!, perTx: {} })).loosened, [L]); // per-tx cap removed
  assert.deepEqual(policyChanges(SAVED, lim({ ...SAVED.limits!, daily: { [USDT]: "1" } })).loosened, [L]); // daily cap removed
  assert.deepEqual(policyChanges(SAVED, lim({ ...SAVED.limits!, whitelistOnly: false })).loosened, [L]);
  // Tightening or adding caps is a change, not a loosening.
  assert.deepEqual(policyChanges(SAVED, lim({ perTx: { [USDC]: "10", [USDT]: "1" }, daily: { [USDC]: "200" }, whitelistOnly: true })), { changed: ["limits"], loosened: [] });
  assert.deepEqual(policyChanges({ version: 1 }, lim({ perTx: {}, daily: {}, whitelistOnly: false })).loosened, []);
  // Sweep keep lowered for the same token.
  assert.deepEqual(policyChanges(SAVED, { ...SAVED, sweep: { ...SAVED.sweep!, keepUnits: "99" } }), { changed: ["sweep"], loosened: [S] });
  assert.deepEqual(policyChanges(SAVED, { ...SAVED, sweep: { ...SAVED.sweep!, keepUnits: "101" } }).loosened, []);
  assert.deepEqual(policyChanges(SAVED, { ...SAVED, sweep: undefined }).loosened, []);
});
