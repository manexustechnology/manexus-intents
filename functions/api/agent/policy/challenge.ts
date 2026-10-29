import type { Env } from "../../../../server/env.ts";
import { handle, json, readJson } from "../../../../server/http.ts";
import { policyChallenge } from "../../../../server/policy.ts";
import { requireUser } from "../../../../server/session.ts";

/**
 * `POST /api/agent/policy/challenge` with the change to sign: `{ kind: "policy", policy }`,
 * `{ kind: "whitelist_add", entry }` or `{ kind: "whitelist_remove", id }`. Returns `{ nonce, message, recipient, hash }`.
 */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await policyChallenge(env.DB, user, (await readJson(request)) as never, Date.now()));
  });
