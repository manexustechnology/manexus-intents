import type { Env } from "./env.ts";
import { createNearRpc } from "./near-rpc.ts";
import { createOneClick } from "./oneclick.ts";
import type { WithdrawDeps } from "./withdraw.ts";

export const withdrawDeps = (env: Env): WithdrawDeps => ({
  db: env.DB,
  rpc: createNearRpc(env.NEAR_RPC_URL, fetch),
  oneclick: createOneClick({ baseUrl: env.ONECLICK_BASE_URL, apiKey: env.ONECLICK_API_KEY, fetch }),
  now: new Date(),
});
