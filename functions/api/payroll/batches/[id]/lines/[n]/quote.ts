import type { Env } from "../../../../../../../server/env.ts";
import { handle, json } from "../../../../../../../server/http.ts";
import { quoteBatchLine } from "../../../../../../../server/payroll.ts";
import { requireUser } from "../../../../../../../server/session.ts";
import { transferDeps } from "../../../../../../../server/withdraw-deps.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const n = String(params.n);
    return json(await quoteBatchLine(transferDeps(env), user, String(params.id), /^[1-9][0-9]?$/.test(n) ? Number(n) : 0), 201);
  });
