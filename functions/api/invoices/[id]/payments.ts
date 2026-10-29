import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { createOneClick } from "../../../../server/oneclick.ts";
import { ownerPayments } from "../../../../server/reconcile.ts";
import { requireUser } from "../../../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const oneclick = createOneClick({ baseUrl: env.ONECLICK_BASE_URL, apiKey: env.ONECLICK_API_KEY, fetch });
    return json(await ownerPayments({ db: env.DB, oneclick, now: new Date() }, account, String(params.id)));
  });
