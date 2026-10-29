import type { Env } from "./env.ts";
import { nearRpcFor } from "./near-rpc.ts";
import { oneClickFor } from "./oneclick.ts";
import type { WithdrawDeps } from "./withdraw.ts";

export const withdrawDeps = (env: Env): WithdrawDeps => ({
  db: env.DB,
  rpc: nearRpcFor(env),
  oneclick: oneClickFor(env),
  now: new Date(),
});
