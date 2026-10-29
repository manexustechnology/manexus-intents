// Comparing an edited (or AI-drafted) treasury policy with the saved one, for the browser and the server alike.
// The shape mirrors `Policy` in server/policy.ts; nothing here validates (parsePolicy does that).

export type PolicyShape = {
  version: 1;
  convert?: { enabled: boolean; targetTokenId: string; minUsdCents: number };
  sweep?: { enabled: boolean; tokenId: string; thresholdUnits: string; keepUnits: string; whitelistId: string };
  limits?: { perTx: Record<string, string>; daily: Record<string, string>; whitelistOnly: boolean };
  reminders?: { billDueDays: number; invoiceOverdueDays: number };
};

/** The sections, in the order a change summary lists them. */
export const POLICY_SECTIONS = ["convert", "sweep", "limits", "reminders"] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

export const LOOSENS_LIMITS = "Loosens your spending limits";
export const LOOSENS_SWEEP = "Keeps less in your account after a sweep";

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * An AI draft applied over the saved policy, section by section: a section the draft omits keeps the saved
 * value, a section the draft has replaces the saved one whole. Returns a fresh object.
 */
export function mergeDraft<P extends PolicyShape>(saved: P | null, draft: P): P {
  const out = { version: 1 } as P;
  for (const k of POLICY_SECTIONS) {
    const v = draft[k] !== undefined ? draft[k] : saved?.[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = clone(v);
  }
  return out;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null)
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const isUnits = (s: unknown): s is string => typeof s === "string" && /^\d{1,78}$/.test(s);

/** A saved cap the next caps remove or raise. */
function capsLoosened(saved: Record<string, string>, next: Record<string, string> | undefined): boolean {
  for (const [token, cap] of Object.entries(saved)) {
    const n = next && Object.hasOwn(next, token) ? next[token] : undefined;
    if (n === undefined) return true;
    if (isUnits(cap) && isUnits(n) && BigInt(n) > BigInt(cap)) return true;
  }
  return false;
}

/**
 * Which sections differ between the saved policy and the next one, and plain warnings for any change that
 * removes or loosens a saved rule: limits removed, a per-transaction or 24-hour cap raised or removed,
 * whitelisted-recipients-only turned off, or a sweep of the same token that keeps less.
 */
export function policyChanges(saved: PolicyShape | null, next: PolicyShape): { changed: PolicySection[]; loosened: string[] } {
  const changed = POLICY_SECTIONS.filter((k) => canonical(saved?.[k] ?? null) !== canonical(next[k] ?? null));
  const loosened: string[] = [];
  const sl = saved?.limits, nl = next.limits;
  if (sl && (!nl || capsLoosened(sl.perTx, nl.perTx) || capsLoosened(sl.daily, nl.daily) || (sl.whitelistOnly && !nl.whitelistOnly))) loosened.push(LOOSENS_LIMITS);
  const ss = saved?.sweep, ns = next.sweep;
  if (ss && ns && ss.tokenId === ns.tokenId && isUnits(ss.keepUnits) && isUnits(ns.keepUnits) && BigInt(ns.keepUnits) < BigInt(ss.keepUnits)) loosened.push(LOOSENS_SWEEP);
  return { changed, loosened };
}
