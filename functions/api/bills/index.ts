import { billViews, createBill, listBills, parseBillStatus } from "../../../server/bills.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import type { OneClickToken } from "../../../server/oneclick.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const url = new URL(request.url);
    const status = parseBillStatus(url.searchParams.get("status"));
    const raw = url.searchParams.get("page");
    const deps = transferDeps(env);
    const [rows, tokens] = await Promise.all([
      listBills(env.DB, user.account, status, raw && /^\d{1,2}$/.test(raw) ? Number(raw) : 0),
      deps.oneclick.tokens().catch(() => [] as OneClickToken[]),
    ]);
    return json(billViews(rows, tokens, deps.now));
  });

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const deps = transferDeps(env);
    const bill = await createBill(deps, user, await readJson(request));
    const tokens = await deps.oneclick.tokens().catch(() => [] as OneClickToken[]);
    return json(billViews([bill], tokens, deps.now)[0], 201);
  });
