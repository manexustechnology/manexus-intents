// Approving an agent proposal. The agent never signs: approval re-checks the proposal against fresh inputs and
// then runs the existing quote path (swap, withdraw or bill payment), which stores an unsigned intent the owner
// signs in their wallet (POST /api/transfers/submit). The transfer engine re-checks balance and spending limits.
import { COLS, evaluate, loadEvalInput, sameParams, view, type ProposalRaw } from "./agent.ts";
import { quoteBillPayment } from "./bills.ts";
import { HttpError } from "./http.ts";
import { getPolicy } from "./policy.ts";
import { quoteSwap } from "./swaps.ts";
import { quoteTransfer, type TransferDeps, type TransferQuote } from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };
export type ApproveDeps = TransferDeps & { /** Origin of the request, for the invoice pay link. */ origin: string };
export type ApproveResult = TransferQuote | { followUp: { payUrl: string } };

export const OUT_OF_DATE = "This suggestion is out of date";
const NOT_OPEN = "This proposal is no longer open";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const STALE = Symbol("stale");

/**
 * proposed → executing (guarded; 409 if not proposed, 409 + expired if past `expires_at`), then `evaluate`
 * again with fresh inputs: the draft for this dedupKey must exist with identical params, and a sweep's
 * whitelist entry must still exist; otherwise the proposal is expired and 409 "This suggestion is out of date".
 * Then the quote: convert → in-account swap (1% slippage); sweep → withdraw EXACT_INPUT to the whitelist entry;
 * pay_bill → `quoteBillPayment` from `originAsset`; follow_up_invoice → the pay link, and the proposal is done.
 * Any failure before the quote is stored releases the proposal back to `proposed`. The stored deposit address
 * lets `runAgent` follow the transfer (SUCCESS → done; failed/refunded/unsigned for good → proposed).
 */
export async function approveProposal(deps: ApproveDeps, user: User, id: string, body: { originAsset?: string }): Promise<ApproveResult> {
  const { db, now } = deps;
  const owner = user.account;
  if (typeof id !== "string" || !ID.test(id)) throw new HttpError(404, "Proposal not found");
  const ts = now.toISOString();
  const claimed = await db
    .prepare(`UPDATE agent_proposals SET status = 'executing', updated_at = ? WHERE id = ? AND owner = ? AND status = 'proposed' AND expires_at > ? RETURNING ${COLS}`)
    .bind(ts, id, owner, ts)
    .first<ProposalRaw>();
  const move = (from: string, to: string) =>
    db.prepare("UPDATE agent_proposals SET status = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = ?").bind(to, ts, id, owner, from).run();
  if (!claimed) {
    const cur = await db.prepare("SELECT status FROM agent_proposals WHERE id = ? AND owner = ?").bind(id, owner).first<{ status: string }>();
    if (!cur) throw new HttpError(404, "Proposal not found");
    if (cur.status !== "proposed") throw new HttpError(409, NOT_OPEN);
    await move("proposed", "expired");
    throw new HttpError(409, OUT_OF_DATE);
  }
  const p = view({ ...claimed });

  let quote: TransferQuote;
  try {
    const { policy } = await getPolicy(db, user);
    if (!policy) throw STALE;
    // Bill and invoice drafts do not depend on balances, and convert/sweep drafts not on bills or invoices.
    const money = p.type === "convert" || p.type === "sweep";
    const input = await loadEvalInput(deps, user, policy, { balances: money, reminders: !money });
    const d = evaluate(input).find((x) => x.dedupKey === p.dedupKey);
    if (!d || d.type !== p.type || !sameParams(d.params, p.params)) throw STALE;
    const x = p.params;
    if (p.type === "follow_up_invoice") {
      await move("executing", "done");
      return { followUp: { payUrl: `${deps.origin}/#/pay/${encodeURIComponent(x.publicId)}` } };
    }
    if (p.type === "convert") {
      quote = await quoteSwap(deps, user, { originAsset: x.originAsset, destinationAsset: x.destinationAsset, amount: x.amount, slippageBps: 100 });
    } else if (p.type === "sweep") {
      // Re-read with the fresh inputs: never sweep to an entry the owner removed after the proposal was made.
      const entry = input.whitelist.find((e) => e.id === x.whitelistId);
      if (!entry) throw STALE;
      quote = await quoteTransfer(deps, user, {
        kind: "withdraw", swapType: "EXACT_INPUT", originAsset: x.originAsset, amount: x.amount,
        destinationAsset: entry.destinationAsset, recipientType: entry.recipientType, recipient: entry.recipient, slippageBps: 100,
      });
    } else {
      const b = typeof body === "object" && body !== null ? body : {};
      quote = await quoteBillPayment(deps, user, x.billId, { originAsset: b.originAsset as string });
    }
  } catch (e) {
    if (e === STALE) {
      await move("executing", "expired");
      throw new HttpError(409, OUT_OF_DATE);
    }
    await move("executing", "proposed");
    throw e;
  }
  await db
    .prepare("UPDATE agent_proposals SET deposit_address = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'executing'")
    .bind(quote.depositAddress, ts, id, owner)
    .run();
  return quote;
}
