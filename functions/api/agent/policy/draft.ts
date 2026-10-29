import { SETTLEMENT_TOKENS } from "../../../../shared/assets.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, HttpError, json, readJson } from "../../../../server/http.ts";
import { draftPolicy, nearAiFor, requireConfigured } from "../../../../server/nearai.ts";
import { listWhitelist } from "../../../../server/policy.ts";
import { requireUser } from "../../../../server/session.ts";

/** `POST /api/agent/policy/draft` `{ text }` → `{ policy, notes? }`. The draft is returned, never saved. */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const ai = nearAiFor(env);
    requireConfigured(ai);
    const body = (await readJson(request)) as { text?: unknown } | null;
    if (typeof body !== "object" || body === null || typeof body.text !== "string") throw new HttpError(400, "Describe the rules you want.");
    const whitelist = (await listWhitelist(env.DB, user)).map((w) => ({ id: w.id, label: w.label }));
    return json(await draftPolicy(ai, user, body.text, { settlementTokens: SETTLEMENT_TOKENS, whitelist }));
  });
