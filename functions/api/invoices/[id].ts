import type { Env } from "../../../server/env.ts";
import { HttpError, handle, json, readJson } from "../../../server/http.ts";
import { getInvoice, updateInvoice } from "../../../server/invoices.ts";
import { requireUser } from "../../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => json(await getInvoice(env.DB, (await requireUser(request, env)).account, String(params.id))));

export const onRequestPut: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const body = (await readJson(request)) as { revision?: unknown; data?: unknown } | null;
    if (!body || typeof body.revision !== "number") throw new HttpError(400, "Missing revision");
    return json(await updateInvoice(env.DB, account, String(params.id), body.revision, body.data, new Date().toISOString()));
  });
