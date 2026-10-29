import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { getPublicInvoice } from "../../../../server/invoices.ts";

export const onRequestGet: PagesFunction<Env> = ({ env, params }) => handle(async () => json(await getPublicInvoice(env.DB, String(params.publicId))));
