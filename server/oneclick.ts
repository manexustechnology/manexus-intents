import { HttpError } from "./http.ts";

export type OneClickToken = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
};

export type QuoteRequest = {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;
  referral?: string;
};

export type Quote = {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  deadline: string;
  timeEstimate?: number;
};

export const SWAP_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type SwapStatus = {
  status: (typeof SWAP_STATUSES)[number];
  updatedAt: string;
  quoteRequest: QuoteRequest;
  amountOut?: string;
  refundedAmount?: string;
  originTxHashes: string[];
  destinationTxHashes: string[];
};

type Rec = Record<string, unknown>;
const bad = () => new HttpError(502, "NEAR Intents returned an unexpected response");
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => {
  if (typeof v !== "string" || !v) throw bad();
  return v;
};
const optStr = (v: unknown): string | undefined => (v == null ? undefined : str(v));
const hashes = (v: unknown): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad();
  return v.map((h) => str(isRec(h) ? h.hash : undefined));
};

export function createOneClick(opts: { baseUrl: string; apiKey?: string; fetch: typeof fetch }) {
  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;
    let res: Response;
    try {
      res = await opts.fetch(opts.baseUrl.replace(/\/$/, "") + path, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, "NEAR Intents is unreachable");
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const msg = isRec(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
      throw new HttpError(502, `NEAR Intents: ${msg.slice(0, 200)}`);
    }
    return data;
  }

  return {
    async tokens(): Promise<OneClickToken[]> {
      const data = await call("/v0/tokens");
      if (!Array.isArray(data)) throw bad();
      return data.map((t) => {
        if (!isRec(t) || typeof t.decimals !== "number") throw bad();
        return {
          assetId: str(t.assetId),
          symbol: str(t.symbol),
          blockchain: str(t.blockchain),
          decimals: t.decimals,
          ...(typeof t.price === "number" ? { price: t.price } : {}),
        };
      });
    },

    async quote(r: QuoteRequest): Promise<Quote> {
      const data = await call("/v0/quote", { method: "POST", body: r });
      if (!isRec(data) || !isRec(data.quote)) throw bad();
      const q = data.quote;
      const depositAddress = r.dry ? (optStr(q.depositAddress) ?? "") : str(q.depositAddress);
      return {
        depositAddress,
        ...(q.depositMemo != null ? { depositMemo: str(q.depositMemo) } : {}),
        amountIn: str(q.amountIn),
        minAmountIn: str(q.minAmountIn),
        amountOut: str(q.amountOut),
        minAmountOut: str(q.minAmountOut),
        deadline: optStr(q.deadline) ?? r.deadline,
        ...(typeof q.timeEstimate === "number" ? { timeEstimate: q.timeEstimate } : {}),
      };
    },

    async status(depositAddress: string, memo?: string): Promise<SwapStatus> {
      const qs = new URLSearchParams({ depositAddress });
      if (memo) qs.set("depositMemo", memo);
      const data = await call(`/v0/status?${qs}`);
      if (!isRec(data)) throw bad();
      const status = data.status;
      if (!SWAP_STATUSES.includes(status as never)) throw bad();
      const qr = isRec(data.quoteResponse) ? data.quoteResponse.quoteRequest : undefined;
      if (!isRec(qr)) throw bad();
      const sd = isRec(data.swapDetails) ? data.swapDetails : {};
      return {
        status: status as SwapStatus["status"],
        updatedAt: str(data.updatedAt),
        quoteRequest: qr as unknown as QuoteRequest,
        ...(sd.amountOut != null ? { amountOut: str(sd.amountOut) } : {}),
        ...(sd.refundedAmount != null ? { refundedAmount: str(sd.refundedAmount) } : {}),
        originTxHashes: hashes(sd.originChainTxHashes),
        destinationTxHashes: hashes(sd.destinationChainTxHashes),
      };
    },

    async submitDeposit(txHash: string, depositAddress: string): Promise<void> {
      await call("/v0/deposit/submit", { method: "POST", body: { txHash, depositAddress } });
    },

    async generateIntent(a: {
      depositAddress: string;
      signerId: string;
      standard: "nep413" | "erc191";
    }): Promise<{ standard: string; payload: unknown }> {
      const data = await call("/v0/generate-intent", {
        method: "POST",
        body: { type: "swap_transfer", standard: a.standard, signerId: a.signerId, depositAddress: a.depositAddress },
      });
      if (!isRec(data) || !isRec(data.intent)) throw bad();
      return { standard: str(data.intent.standard), payload: data.intent.payload };
    },

    async submitIntent(signedData: unknown): Promise<{ intentHash: string }> {
      const data = await call("/v0/submit-intent", { method: "POST", body: { type: "swap_transfer", signedData } });
      if (!isRec(data)) throw bad();
      return { intentHash: str(data.intentHash) };
    },
  };
}
