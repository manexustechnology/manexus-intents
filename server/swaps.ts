// In-account swap: trade one Intents balance for another token that stays in the owner's own
// NEAR Intents account. A thin wrapper over the generic transfer engine (EXACT_INPUT, INTENTS recipient).
import { HttpError } from "./http.ts";
import { quoteTransfer, SLIPPAGE_BPS, type TransferDeps, type TransferQuote } from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };

export type SwapBody = { originAsset: string; destinationAsset: string; amount: string; slippageBps: (typeof SLIPPAGE_BPS)[number] };

export async function quoteSwap(deps: TransferDeps, user: User, body: SwapBody): Promise<TransferQuote> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Partial<SwapBody>;
  if (b.originAsset !== undefined && b.originAsset === b.destinationAsset) throw new HttpError(400, "Choose two different tokens");
  if (!(SLIPPAGE_BPS as readonly unknown[]).includes(b.slippageBps)) throw new HttpError(400, "Choose a slippage of 0.5%, 1% or 3%.");
  return quoteTransfer(deps, user, {
    kind: "swap",
    originAsset: b.originAsset as string,
    destinationAsset: b.destinationAsset as string,
    amount: b.amount as string,
    swapType: "EXACT_INPUT",
    recipientType: "INTENTS",
    recipient: user.account,
    slippageBps: b.slippageBps,
  });
}
