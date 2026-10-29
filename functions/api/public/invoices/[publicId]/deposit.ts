import type { Env } from "../../../../../server/env.ts";
import { handle, json, readJson } from "../../../../../server/http.ts";
import { oneClickFor } from "../../../../../server/oneclick.ts";
import { submitDepositTx } from "../../../../../server/payments.ts";

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const oneclick = oneClickFor(env);
    const body = (await readJson(request)) as { depositAddress: string; txHash: string };
    await submitDepositTx({ db: env.DB, oneclick, now: new Date() }, String(params.publicId), body);
    return json({ ok: true });
  });
