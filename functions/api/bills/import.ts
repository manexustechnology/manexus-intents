import { importManexusInvoice } from "../../../server/bills.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";

/** Prefill a bill from a Manexus invoice link on this same origin (or a bare public id). */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const body = (await readJson(request)) as { link?: unknown } | null;
    return json(await importManexusInvoice({ db: env.DB, origin: new URL(request.url).origin }, user, body?.link as string));
  });
