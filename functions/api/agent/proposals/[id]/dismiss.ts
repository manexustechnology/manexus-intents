import { dismissProposal } from "../../../../../server/agent.ts";
import type { Env } from "../../../../../server/env.ts";
import { handle, json } from "../../../../../server/http.ts";
import { requireUser } from "../../../../../server/session.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await dismissProposal(env.DB, user, String(params.id)));
  });
