import type { Env } from "./env.ts";
import { nearRpcFor } from "./near-rpc.ts";
import { oneClickFor } from "./oneclick.ts";
import type { TransferDeps } from "./transfers.ts";

export const transferDeps = (env: Env): TransferDeps => ({
  db: env.DB,
  rpc: nearRpcFor(env),
  oneclick: oneClickFor(env),
  now: new Date(),
});
export const withdrawDeps = transferDeps;
