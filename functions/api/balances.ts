import { getBalances } from "../../server/balances.ts";
import type { Env } from "../../server/env.ts";
import { handle, json } from "../../server/http.ts";
import { nearRpcFor } from "../../server/near-rpc.ts";
import { oneClickFor } from "../../server/oneclick.ts";
import { requireUser } from "../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const rpc = nearRpcFor(env);
    const oneclick = oneClickFor(env);
    return json(await getBalances({ rpc, oneclick, db: env.DB }, account));
  });
