import type { Env } from "./env.ts";

export type NearRpc = {
  viewAccessKey(account: string, publicKey: string): Promise<{ permission: unknown } | null>;
  viewFunction<T>(contract: string, method: string, args: object): Promise<T>;
};

const NOT_FOUND = new Set(["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"]);

/** A hung RPC must not stall a request (an approval holds its proposal while it runs). */
export const RPC_TIMEOUT_MS = 15_000;

export function createNearRpc(url: string, fetchFn: typeof fetch): NearRpc {
  async function query(params: Record<string, unknown>): Promise<{ notFound: true } | { result: Record<string, unknown> }> {
    // Called bare (fetchFn is a local): workerd's fetch throws "Illegal invocation" when called as a method.
    const res = await fetchFn(url, {
      method: "POST",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "manexus", method: "query", params: { ...params } }),
    });
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: { name?: string; cause?: { name?: string } } };
    if (body.error) {
      if (NOT_FOUND.has(String(body.error.cause?.name))) return { notFound: true };
      throw new Error(`NEAR RPC error ${body.error.cause?.name ?? body.error.name ?? "unknown"}`);
    }
    const result = body.result;
    if (!result) throw new Error("NEAR RPC returned no result");
    // Older nodes report a missing key as a result with an error string.
    if (typeof result.error === "string") {
      if (/does not exist/.test(result.error)) return { notFound: true };
      throw new Error("NEAR RPC query error");
    }
    return { result };
  }

  return {
    async viewAccessKey(account, publicKey) {
      const r = await query({ request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
      if ("notFound" in r) return null;
      return { permission: r.result.permission };
    },
    async viewFunction<T>(contract: string, method: string, args: object): Promise<T> {
      const argsBytes = new TextEncoder().encode(JSON.stringify(args));
      let bin = "";
      for (const b of argsBytes) bin += String.fromCharCode(b);
      const r = await query({ request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(bin) });
      if ("notFound" in r) throw new Error(`NEAR account ${contract} not found`);
      const bytes = r.result.result;
      if (!Array.isArray(bytes)) throw new Error("NEAR RPC call_function returned no bytes");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))) as T;
    },
  };
}

/** The NEAR RPC client for a request's env. Every route builds its client here. */
export const nearRpcFor = (env: Env): NearRpc => createNearRpc(env.NEAR_RPC_URL, (input, init) => fetch(input, init));
