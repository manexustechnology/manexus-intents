import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { nearRpcFor } from "../../../server/near-rpc.ts";
import { requireUser } from "../../../server/session.ts";
import { keyStatus } from "../../../server/withdraw.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const publicKey = new URL(request.url).searchParams.get("publicKey") ?? "";
    return json(await keyStatus({ rpc: nearRpcFor(env) }, user, publicKey));
  });
