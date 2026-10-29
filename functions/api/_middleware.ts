import { rejectCrossOrigin } from "../../server/http.ts";

export const onRequest: PagesFunction = (ctx) => rejectCrossOrigin(ctx.request) ?? ctx.next();
