import type { Env } from "../../../../../server/env.ts";
import { handle, json, readJson } from "../../../../../server/http.ts";
import { oneClickFor } from "../../../../../server/oneclick.ts";
import { createPaymentQuote } from "../../../../../server/payments.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const oneclick = oneClickFor(env);
    const body = (await readJson(request)) as { originAsset: string; refundTo: string };
    return json(await createPaymentQuote({ db: env.DB, oneclick, now: new Date() }, String(params.publicId), body), 201);
  });
