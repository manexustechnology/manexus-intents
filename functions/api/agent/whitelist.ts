import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { addWhitelist, listWhitelist, removeWhitelist } from "../../../server/policy.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await listWhitelist(env.DB, user));
  });

/** `POST /api/agent/whitelist` `{ entry, nonce, signature, publicKey? }`: a signed addition. */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await addWhitelist(transferDeps(env), user, (await readJson(request)) as never), 201);
  });

/** `DELETE /api/agent/whitelist` `{ id, nonce, signature, publicKey? }`: a signed removal. */
export const onRequestDelete: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    await removeWhitelist(transferDeps(env), user, (await readJson(request)) as never);
    return json({ ok: true });
  });
