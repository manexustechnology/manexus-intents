import { runAgent } from "../../../server/agent.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

/** `GET /api/agent/proposals[?force=1]`: runs the (throttled) agent and returns the open proposals. */
export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const force = new URL(request.url).searchParams.get("force") === "1";
    return json(await runAgent(transferDeps(env), user, { force }));
  });
