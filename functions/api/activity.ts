import { listActivity, monthSummary } from "../../server/activity.ts";
import type { Env } from "../../server/env.ts";
import { handle, json } from "../../server/http.ts";
import { requireUser } from "../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const url = new URL(request.url);
    const deps = { db: env.DB, now: new Date() };
    if (url.searchParams.get("summary") === "month") return json(await monthSummary(deps, user));
    const raw = url.searchParams.get("limit");
    return json(await listActivity(deps, user, raw && /^\d{1,4}$/.test(raw) ? Number(raw) : 50));
  });
