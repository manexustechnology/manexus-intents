import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";
import { requireUser } from "../../../server/session.ts";
import { listTransfers, parseKind } from "../../../server/transfers.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const kind = parseKind(new URL(request.url).searchParams.get("kind"));
    return json(await listTransfers({ db: env.DB, now: new Date() }, user, kind));
  });
