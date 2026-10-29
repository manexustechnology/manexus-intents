import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { createPayee, deletePayee, listPayees } from "../../../server/payroll.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await listPayees(transferDeps(env), user));
  });

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await createPayee(transferDeps(env), user, await readJson(request)), 201);
  });

/** `DELETE /api/payroll/payees?id=<id>`: only the owner's own payee. */
export const onRequestDelete: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    await deletePayee(env.DB, user, new URL(request.url).searchParams.get("id"));
    return json({ ok: true });
  });
