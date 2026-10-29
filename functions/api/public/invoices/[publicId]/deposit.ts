import type { Env } from "../../../../../server/env.ts";
import { handle, json, readJson } from "../../../../../server/http.ts";
import { createOneClick } from "../../../../../server/oneclick.ts";
import { submitDepositTx } from "../../../../../server/payments.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const oneclick = createOneClick({ baseUrl: env.ONECLICK_BASE_URL, apiKey: env.ONECLICK_API_KEY, fetch });
    const body = (await readJson(request)) as { depositAddress: string; txHash: string };
    await submitDepositTx({ db: env.DB, oneclick, now: new Date() }, String(params.publicId), body);
    return json({ ok: true });
  });
