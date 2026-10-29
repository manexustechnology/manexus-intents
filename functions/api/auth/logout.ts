import { json } from "../../../server/http.ts";
import { clearSessionCookie } from "../../../server/session.ts";

export const onRequestPost: PagesFunction = () => {
  const res = json({ ok: true });
  res.headers.append("set-cookie", clearSessionCookie());
  return res;
};
