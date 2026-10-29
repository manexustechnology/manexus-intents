export class ApiError extends Error {
  status: number;
  /** The parsed error body (e.g. `lineErrors` next to `error`), when the server sent JSON. */
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Same-origin JSON fetch. Throws ApiError(body.error) on non-2xx. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof msg === "string" ? msg : `Request failed (${res.status})`, body);
  }
  return body as T;
}

export const postJson = <T>(path: string, data: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const deleteJson = <T>(path: string) => api<T>(path, { method: "DELETE" });
