import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { refreshWithdrawal } from "../../../server/withdraw.ts";
import { withdrawDeps } from "../../../server/withdraw-deps.ts";

// Kept for the Plan 1 URL; same engine as /api/transfers/[depositAddress].
export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await refreshWithdrawal(withdrawDeps(env), user, String(params.depositAddress)));
  });
