// Withdrawals from the owner's own intents.near balance to any supported chain: an EXACT_INPUT transfer
// to a destination-chain address. The engine (and every safety check) lives in ./transfers.ts.
import {
  keyStatus,
  listTransfers,
  quoteTransfer,
  refreshTransfer,
  submitTransfer,
  type TransferDeps,
  type TransferQuote,
  type TransferStatus,
  type TransferView,
} from "./transfers.ts";

type User = { account: string; kind: "near" | "evm" };

export type WithdrawDeps = TransferDeps;
export type WithdrawalStatus = TransferStatus;
export type WithdrawalView = TransferView;
export type WithdrawalQuote = TransferQuote;

export { keyStatus };
export const submitWithdrawal = submitTransfer;
export const refreshWithdrawal = refreshTransfer;

export function quoteWithdrawal(
  deps: WithdrawDeps,
  user: User,
  body: { originAsset: string; amount: string; destinationAsset: string; recipient: string },
): Promise<WithdrawalQuote> {
  // Only these four fields come from the client; kind, swap type, recipient type and slippage are fixed.
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return quoteTransfer(deps, user, {
    kind: "withdraw",
    swapType: "EXACT_INPUT",
    recipientType: "DESTINATION_CHAIN",
    originAsset: b.originAsset as string,
    amount: b.amount as string,
    destinationAsset: b.destinationAsset as string,
    recipient: b.recipient as string,
  });
}

/** Withdrawal history (other transfer kinds have their own pages). */
export function listWithdrawals(deps: Pick<WithdrawDeps, "db" | "now">, user: User): Promise<WithdrawalView[]> {
  return listTransfers(deps, user, "withdraw");
}
