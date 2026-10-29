import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { nearRpcFor } from "../../../server/near-rpc.ts";
import { getSummary, nearAiFor, requireConfigured } from "../../../server/nearai.ts";
import { oneClickFor } from "../../../server/oneclick.ts";
import { requireUser } from "../../../server/session.ts";

/** `GET /api/agent/summary[?refresh=1]` → `{ text, at }`: a short AI summary of numbers only, cached 10 minutes. */
export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const ai = nearAiFor(env);
    requireConfigured(ai);
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return json(await getSummary({ ai, db: env.DB, rpc: nearRpcFor(env), oneclick: oneClickFor(env), now: new Date() }, user, { refresh }));
  });
