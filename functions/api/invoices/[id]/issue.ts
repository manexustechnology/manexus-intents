import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { issueInvoice } from "../../../../server/invoices.ts";
import { requireUser } from "../../../../server/session.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => json(await issueInvoice(env.DB, (await requireUser(request, env)).account, String(params.id), new Date().toISOString())));
