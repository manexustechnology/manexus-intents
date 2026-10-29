import { verifyLogin, type LoginBody } from "../../../server/auth.ts";
import type { Env } from "../../../server/env.ts";
import { HttpError, handle, json, readJson } from "../../../server/http.ts";
import { createNearRpc } from "../../../server/near-rpc.ts";
import { sessionCookie, signSession } from "../../../server/session.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const body = (await readJson(request, 4096)) as LoginBody | null;
    if (!body || typeof body !== "object") throw new HttpError(400, "Invalid body");
    const rpc = createNearRpc(env.NEAR_RPC_URL, (input, init) => fetch(input, init));
    const account = await verifyLogin(env.DB, rpc, body, Date.now());
    const kind = body.kind as "near" | "evm";
    const res = json({ account, kind });
    res.headers.append("set-cookie", sessionCookie(await signSession(account, kind, env.SESSION_SECRET)));
    return res;
  });
