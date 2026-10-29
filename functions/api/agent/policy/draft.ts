import { SETTLEMENT_TOKENS } from "../../../../shared/assets.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, HttpError, json, readJson } from "../../../../server/http.ts";
import { checkDraftRate, draftPolicy, nearAiFor, requireConfigured, validateDraftText } from "../../../../server/nearai.ts";
import { getBalances } from "../../../../server/balances.ts";
import { nearRpcFor } from "../../../../server/near-rpc.ts";
import { oneClickFor } from "../../../../server/oneclick.ts";
import { getPolicy, listWhitelist } from "../../../../server/policy.ts";
import { requireUser } from "../../../../server/session.ts";

/** `POST /api/agent/policy/draft` `{ text }` → `{ policy, notes? }`. The draft is returned, never saved.
 *  At most 5 drafting calls per owner per minute (429 after that). The prompt carries the owner's own saved
 *  policy and balance token decimals; the model outputs only the sections to change (the browser merges). */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const ai = nearAiFor(env);
    requireConfigured(ai);
    const body = (await readJson(request)) as { text?: unknown } | null;
    if (typeof body !== "object" || body === null || typeof body.text !== "string") throw new HttpError(400, "Describe the rules you want.");
    validateDraftText(body.text); // invalid input never reaches the AI and does not count against the limit
    await checkDraftRate(env.DB, user, new Date());
    const whitelist = (await listWhitelist(env.DB, user)).map((w) => ({ id: w.id, label: w.label }));
    // Owner data only: their saved policy and the id/symbol/decimals of tokens they hold (balances are optional).
    const { policy: current } = await getPolicy(env.DB, user);
    const balanceTokens = await getBalances({ db: env.DB, rpc: nearRpcFor(env), oneclick: oneClickFor(env) }, user.account).then(
      (bs) => bs.map((b) => ({ tokenId: b.tokenId, symbol: b.symbol, decimals: b.decimals })),
      () => [],
    );
    return json(await draftPolicy(ai, user, body.text, { settlementTokens: SETTLEMENT_TOKENS, whitelist, current, balanceTokens }));
  });
