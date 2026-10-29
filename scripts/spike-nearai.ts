// Spike: NEAR AI Cloud facts. GET /v1/models is public. Chat probes run only if NEAR_AI_API_KEY is set.
// Never prints the key. Run: node scripts/spike-nearai.ts
import { readFileSync } from 'node:fs';

function envVar(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  try {
    const m = readFileSync('.env', 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}
const BASE = envVar('NEAR_AI_BASE_URL') || 'https://cloud-api.near.ai/v1';
const DEFAULT_MODEL = 'openai/gpt-6-luna';
const key = envVar('NEAR_AI_API_KEY');

const t0 = Date.now();
const res = await fetch(`${BASE}/models`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
const body: any = await res.json().catch(() => null);
if (!res.ok) console.log('models NOT OK', res.status, JSON.stringify(body));
console.log('GET /models', res.status, `${Date.now() - t0}ms`, key ? '(with key)' : '(unauthenticated)');
const models: any[] = body?.data ?? [];
console.log('models:', models.length);
for (const m of models) {
  console.log(
    m.id.padEnd(48), `in=${m.pricing?.input} out=${m.pricing?.output}`.padEnd(22),
    `ctx=${m.context_length}`, `ready=${m.is_ready ?? '-'}`, (m.supported_features ?? []).join(','),
  );
}

if (!key) {
  console.log('NEAR_AI_API_KEY not set: Step 2 (chat completions / response_format probe) PENDING');
} else {
  const model = envVar('NEAR_AI_MODEL') || DEFAULT_MODEL;
  for (const rf of [undefined, { type: 'json_object' }]) {
    const s = Date.now();
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: 1000, stream: false,
        messages: [{ role: 'user', content: 'Reply with a JSON object {"ok":true} and nothing else.' }],
        ...(rf ? { response_format: rf } : {}),
      }),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) console.log('chat NOT OK', r.status, JSON.stringify(j));
    console.log('chat', rf ? 'json_object' : 'plain', r.status, `${Date.now() - s}ms`,
      JSON.stringify(j?.error ?? { content: j?.choices?.[0]?.message?.content, usage: j?.usage }));
  }
}
