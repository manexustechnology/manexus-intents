import type { Env } from "../../../../../server/env.ts";
import { handle, json } from "../../../../../server/http.ts";
import { oneClickFor } from "../../../../../server/oneclick.ts";
import { publicStatus } from "../../../../../server/reconcile.ts";

export const onRequestGet: PagesFunction<Env> = ({ env, params }) =>
  handle(async () => {
    const oneclick = oneClickFor(env);
    return json(await publicStatus({ db: env.DB, oneclick, now: new Date() }, String(params.publicId)));
  });
