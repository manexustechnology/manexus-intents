import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { listWithdrawals } from "../../../server/withdraw.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => json(await listWithdrawals({ db: env.DB, now: new Date() }, await requireUser(request, env))));
