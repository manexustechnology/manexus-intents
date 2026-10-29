import type { Db } from "./db.ts";

export type Env = {
  DB: Db;
  SESSION_SECRET: string;
  ONECLICK_API_KEY?: string;
  NEAR_RPC_URL: string;
  ONECLICK_BASE_URL: string;
};
