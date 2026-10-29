import { SETTLEMENT_TOKENS } from "../shared/assets.ts";
import { formatAmount } from "../shared/units.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { NearRpc } from "./near-rpc.ts";
import type { OneClickToken } from "./oneclick.ts";

export type Balance = {
  tokenId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  amount: string;
  formatted: string;
  /** Dollar value at the 1Click reference price, two decimals. Absent when no price is known. */
  usd?: string;
};

const MAX_TOKENS = 50;

async function tokenIds(db: Db, account: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT token_id AS id FROM invoices WHERE owner = ? UNION SELECT origin_asset AS id FROM withdrawals WHERE owner = ? ORDER BY id LIMIT ?`,
    )
    .bind(account, account, MAX_TOKENS)
    .all<{ id: string }>();
  const ids = new Set(SETTLEMENT_TOKENS.map((t) => t.tokenId));
  for (const r of results) if (ids.size < MAX_TOKENS) ids.add(r.id);
  return [...ids];
}

/** amount (base units) at a reference price, using integer micro-dollars; rounded to cents. */
function usdOf(amount: bigint, decimals: number, price: number | undefined): string | undefined {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined;
  const micros = BigInt(Math.round(price * 1e6));
  if (micros <= 0n) return undefined;
  const cents = (amount * micros / 10n ** BigInt(decimals) + 5000n) / 10000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export async function getBalances(
  deps: { rpc: NearRpc; oneclick: { tokens(): Promise<OneClickToken[]> }; db: Db },
  account: string,
): Promise<Balance[]> {
  const ids = await tokenIds(deps.db, account);
  let amounts: string[];
  try {
    amounts = await deps.rpc.viewFunction<string[]>("intents.near", "mt_batch_balance_of", { account_id: account, token_ids: ids });
    if (!Array.isArray(amounts) || amounts.length !== ids.length || amounts.some((a) => typeof a !== "string" || !/^\d+$/.test(a))) throw Error("bad reply");
  } catch {
    throw new HttpError(502, "Could not read NEAR Intents balance");
  }
  let meta = new Map<string, OneClickToken>();
  try {
    meta = new Map((await deps.oneclick.tokens()).map((t) => [t.assetId, t]));
  } catch {
    /* metadata is optional for the settlement tokens */
  }
  const out: Balance[] = [];
  ids.forEach((tokenId, i) => {
    const amount = BigInt(amounts[i]);
    if (amount === 0n) return;
    const known = SETTLEMENT_TOKENS.find((t) => t.tokenId === tokenId);
    const m = meta.get(tokenId);
    const info = m ?? (known ? { symbol: known.symbol, blockchain: "near", decimals: known.decimals, price: undefined } : undefined);
    if (!info) return;
    const usd = usdOf(amount, info.decimals, m?.price);
    out.push({
      tokenId,
      symbol: info.symbol,
      blockchain: info.blockchain,
      decimals: info.decimals,
      amount: amount.toString(),
      formatted: formatAmount(amount, info.decimals),
      ...(usd ? { usd } : {}),
    });
  });
  return out;
}
