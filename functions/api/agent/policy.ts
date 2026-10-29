import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { getPolicy, savePolicy } from "../../../server/policy.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await getPolicy(env.DB, user));
  });

/** `PUT /api/agent/policy` `{ policy, nonce, signature, publicKey? }`: the signed policy (see POST /api/agent/policy/challenge). */
export const onRequestPut: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await savePolicy(transferDeps(env), user, (await readJson(request)) as never));
  });
