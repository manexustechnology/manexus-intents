import { cancelBill } from "../../../../server/bills.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { requireUser } from "../../../../server/session.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => json(await cancelBill({ db: env.DB, now: new Date() }, await requireUser(request, env), String(params.id))));
