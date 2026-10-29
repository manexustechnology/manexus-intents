export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, typeof msg === "string" ? msg : `Request failed (${res.status})`);
  }
  return body as T;
}

export const postJson = <T>(path: string, data: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(data) });
