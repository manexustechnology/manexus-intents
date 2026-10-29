# NEAR AI Cloud facts (spike, 2026-10-30)

OpenAI-compatible gateway used only to draft policy JSON from owner text and write short summaries.
Re-run `node scripts/spike-nearai.ts` to refresh (Node >= 22.18 runs .ts directly). The script always GETs `/models`; it POSTs one tiny chat completion (twice: plain and `json_object`) only when `NEAR_AI_API_KEY` is set. No secrets here.

| Fact | Value | Verified how |
|---|---|---|
| Base URL | `https://cloud-api.near.ai/v1` | OpenAI-compat guide; live call |
| Auth | `Authorization: Bearer <key>` (`sk-` key) | docs (guide + API ref) |
| `GET /models` auth | Not required (public) | live: HTTP 200 unauthenticated, ~1.1s, ~64 KB, 62 models; docs `security: {}` |
| Models body | `{object:"list", data:[{id, pricing{input,output USD/1M}, context_length, supported_features[], is_ready?, ...}]}` | live |
| `supported_features` flags | `tools`, `structured_outputs`, `json_mode`, `reasoning`, `logprobs` | live |
| Default model (`NEAR_AI_MODEL`) | `openai/gpt-6-luna` | see below |
| Chat completions | `POST /chat/completions`; response has `id, object, created, model, choices[{index,message,finish_reason}], usage{prompt_tokens,completion_tokens,total_tokens}` | docs only |
| `response_format` / JSON mode | NOT documented in the chat-completions request schema (fields: model, messages, max_tokens, temperature, top_p, n, stop, stream, penalties; extra props allowed). Compat guide only says "structured outputs" supported. `/models` advertises per-model `json_mode` / `structured_outputs`. Acceptance NOT tested live. | docs + live /models flags |
| Error body | `{"error":{"message":str,"type":str,"code":str\|null,"param":str\|null}}` | docs (`ErrorResponse`) |
| 400 | Invalid request parameters | docs |
| 401 | Invalid or missing API key | docs |
| 402 | Insufficient credits (do not retry; surface "AI credits exhausted") | docs |
| 429 | Rate limited or overloaded, retry with backoff; `error.type` is `rate_limit_exceeded` or `service_overloaded` | docs |
| Streaming default | Unspecified; always send `stream:false` explicitly | docs |
| Latency of chat | Unknown | pending (no key) |

## Default model rationale
`openai/gpt-6-luna`: `is_ready: true`, advertises both `json_mode` and `structured_outputs`, 1.05M context, cheap (USD 0.10 in / 0.50 out per 1M tokens). Alternatives, also ready with `json_mode`: `deepseek/deepseek-v4.1-flash` (0.30/1.20), `Qwen/Qwen3.6-35B-A3B-FP8` (0.17/1.10). Many models (all `openai/gpt-5*`, gemini) show `is_ready: false`, so they were avoided. The model is chosen from the list but not yet exercised with a real completion; it is a reasoning model, so give `max_tokens` headroom.

## Step 2 status: PENDING
`NEAR_AI_API_KEY` is empty, so no chat completion was sent. Still to measure with a key: whether `response_format: {type:"json_object"}` returns 400 or is ignored, real latency, the 401 body. Run the script with a key set; it probes plain and `json_object` requests.

## Design implications for Task 4
- Do NOT depend on `response_format`. Prompt for JSON only, extract the first JSON object from the text (tolerate code fences), then validate with the policy schema; treat failures as "could not draft".
- Map 402 to an "AI credits exhausted" state, 429 to retry with backoff, 401 to a config error. Set a request timeout.
- Make `NEAR_AI_MODEL` and `NEAR_AI_BASE_URL` env-configurable; the key stays server-side only.
