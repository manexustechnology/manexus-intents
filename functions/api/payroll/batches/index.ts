import type { Env } from "../../../../server/env.ts";
import { handle, json, readJson } from "../../../../server/http.ts";
import { createBatchFromBody, listBatches } from "../../../../server/payroll.ts";
import { requireUser } from "../../../../server/session.ts";
import { transferDeps } from "../../../../server/withdraw-deps.ts";

/** A CSV is at most 64 KB; JSON string escaping can roughly double it. */
const MAX_BODY = 160_000;

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await listBatches({ db: env.DB }, user));
  });

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await createBatchFromBody(transferDeps(env), user, await readJson(request, MAX_BODY)), 201);
  });
