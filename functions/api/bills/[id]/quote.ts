import { quoteBillPayment } from "../../../../server/bills.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json, readJson } from "../../../../server/http.ts";
import { requireUser } from "../../../../server/session.ts";
import { transferDeps } from "../../../../server/withdraw-deps.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await quoteBillPayment(transferDeps(env), user, String(params.id), (await readJson(request)) as never), 201);
  });
