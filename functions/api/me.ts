import type { Env } from "../../server/env.ts";
import { handle, json } from "../../server/http.ts";
import { requireUser } from "../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => handle(async () => json(await requireUser(request, env)));
