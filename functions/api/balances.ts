import { getBalances } from "../../server/balances.ts";
import type { Env } from "../../server/env.ts";
import { handle, json } from "../../server/http.ts";
import { createNearRpc } from "../../server/near-rpc.ts";
import { createOneClick } from "../../server/oneclick.ts";
import { requireUser } from "../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const rpc = createNearRpc(env.NEAR_RPC_URL, fetch);
    const oneclick = createOneClick({ baseUrl: env.ONECLICK_BASE_URL, apiKey: env.ONECLICK_API_KEY, fetch });
    return json(await getBalances({ rpc, oneclick, db: env.DB }, account));
  });
