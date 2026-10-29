import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { submitWithdrawal } from "../../../server/withdraw.ts";
import { withdrawDeps } from "../../../server/withdraw-deps.ts";

// Kept for the Plan 1 URL; same engine and checks as /api/transfers/submit.
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await submitWithdrawal(withdrawDeps(env), user, (await readJson(request)) as never));
  });
