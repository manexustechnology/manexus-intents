import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { createInvoice, listInvoices } from "../../../server/invoices.ts";
import { requireUser } from "../../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => json(await listInvoices(env.DB, (await requireUser(request, env)).account)));

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    return json(await createInvoice(env.DB, account, await readJson(request), new Date().toISOString()), 201);
  });
