import { createChallenge, type Kind } from "../../../server/auth.ts";
import type { Env } from "../../../server/env.ts";
import { HttpError, handle, json, readJson } from "../../../server/http.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const body = (await readJson(request, 1024)) as { kind?: unknown; account?: unknown };
    if (body?.kind !== "near" && body?.kind !== "evm") throw new HttpError(400, "Invalid wallet kind");
    if (typeof body.account !== "string") throw new HttpError(400, "Invalid account");
    return json(await createChallenge(env.DB, body.account, body.kind as Kind, Date.now()));
  });
