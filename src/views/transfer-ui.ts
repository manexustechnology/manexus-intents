// Small helpers shared by the withdraw and swap views.
export const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** m:ss until `deadline` (never negative). */
export function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
