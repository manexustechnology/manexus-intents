import { approveProposal } from "../../../../../server/agent-actions.ts";
import type { Env } from "../../../../../server/env.ts";
import { handle, json, readJson } from "../../../../../server/http.ts";
import { requireUser } from "../../../../../server/session.ts";
import { transferDeps } from "../../../../../server/withdraw-deps.ts";

/**
 * `POST /api/agent/proposals/:id/approve` `{ originAsset? }` (originAsset: the token to pay a bill from).
 * Returns the transfer quote to sign (201), or `{ followUp: { payUrl } }` for an overdue invoice (200).
 */
export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const body = (await readJson(request)) as { originAsset?: string };
    const out = await approveProposal({ ...transferDeps(env), origin: new URL(request.url).origin }, user, String(params.id), body);
    return json(out, "followUp" in out ? 200 : 201);
  });
