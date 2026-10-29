import type { Db } from "./db.ts";

export type Env = {
  DB: Db;
  SESSION_SECRET: string;
  ONECLICK_API_KEY?: string;
  NEAR_RPC_URL: string;
  ONECLICK_BASE_URL: string;
  /** NEAR AI Cloud (OpenAI-compatible). Without a key the AI features are off. */
  NEAR_AI_API_KEY?: string;
  NEAR_AI_MODEL?: string;
  NEAR_AI_BASE_URL?: string;
};
