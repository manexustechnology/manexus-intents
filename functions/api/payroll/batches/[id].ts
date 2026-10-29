import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { getBatch } from "../../../../server/payroll.ts";
import { requireUser } from "../../../../server/session.ts";
import { transferDeps } from "../../../../server/withdraw-deps.ts";

/** The batch with every line's latest transfer, refreshed from NEAR Intents, and the derived summary. */
export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await getBatch(transferDeps(env), user, String(params.id)));
  });
