import { billViews, refreshBill, updateBill } from "../../../server/bills.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import type { OneClickToken } from "../../../server/oneclick.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

/** The bill with its latest transfer, refreshed (and, for a Manexus bill, the vendor invoice reconciled). */
export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await refreshBill(transferDeps(env), user, String(params.id)));
  });

export const onRequestPut: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const deps = transferDeps(env);
    const bill = await updateBill(deps, user, String(params.id), await readJson(request));
    const tokens = await deps.oneclick.tokens().catch(() => [] as OneClickToken[]);
    return json(billViews([bill], tokens, deps.now)[0]);
  });
