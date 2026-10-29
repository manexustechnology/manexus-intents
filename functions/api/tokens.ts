import type { Env } from "../../server/env.ts";
import { handle, json } from "../../server/http.ts";
import { createOneClick } from "../../server/oneclick.ts";

export const onRequestGet: PagesFunction<Env> = ({ env }) =>
  handle(async () => {
    const tokens = await createOneClick({ baseUrl: env.ONECLICK_BASE_URL, apiKey: env.ONECLICK_API_KEY, fetch }).tokens();
    const res = json(tokens);
    res.headers.set("cache-control", "public, max-age=300");
    return res;
  });
