import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { refreshTransfer } from "../../../server/transfers.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await refreshTransfer(transferDeps(env), user, String(params.depositAddress)));
  });
