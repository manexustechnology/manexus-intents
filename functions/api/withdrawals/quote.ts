import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { quoteWithdrawal } from "../../../server/withdraw.ts";
import { withdrawDeps } from "../../../server/withdraw-deps.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await quoteWithdrawal(withdrawDeps(env), user, (await readJson(request)) as never), 201);
  });
