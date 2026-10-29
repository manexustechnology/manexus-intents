import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { nearAiFor } from "../../../server/nearai.ts";
import { requireUser } from "../../../server/session.ts";

/** `GET /api/agent/ai-status` `{ configured }`: whether the AI features are on (the UI hides them otherwise). */
export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    await requireUser(request, env);
    return json({ configured: nearAiFor(env).configured });
  });
