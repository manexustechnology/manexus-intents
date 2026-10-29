// Spike: dry-run 1Click quotes + NEAR RPC balance reads. No funds, no signing.
import { writeFileSync } from 'node:fs';

const API = 'https://1click.chaindefuser.com';
const RPC = 'https://rpc.mainnet.fastnear.com';
const FIX = 'tests/fixtures/oneclick';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const NEAR_R = 'manexus-spike.near';
const EVM_R = '0x1111111111111111111111111111111111111111';
const deadline = new Date(Date.now() + 30 * 60_000).toISOString();

async function quote(body: object) {
  const res = await fetch(`${API}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function payBody(recipient: string) {
  return {
    dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
    originAsset: USDC_ARB, depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDC_NEAR, amount: '1000000',
    refundTo: '0x0000000000000000000000000000000000000001', refundType: 'ORIGIN_CHAIN',
    recipient, recipientType: 'INTENTS', deadline,
  };
}

function withdrawBody(refundTo: string) {
  return {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: USDC_NEAR, depositType: 'INTENTS',
    destinationAsset: USDC_ARB, amount: '1000000',
    refundTo, refundType: 'INTENTS',
    recipient: '0x0000000000000000000000000000000000000002', recipientType: 'DESTINATION_CHAIN',
    deadline,
  };
}

async function balance(account: string) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_ids: [USDC_NEAR] })).toString('base64');
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
      request_type: 'call_function', finality: 'final', account_id: 'intents.near',
      method_name: 'mt_batch_balance_of', args_base64: args } }),
  });
  const j: any = await res.json();
  if (j.error || j.result?.error) return { error: j.error ?? j.result.error };
  return JSON.parse(Buffer.from(j.result.result).toString());
}

const p1 = await quote(payBody(NEAR_R));
console.log('pay NEAR recipient', p1.status, p1.json?.quote?.amountIn ?? JSON.stringify(p1.json));
writeFileSync(`${FIX}/quote-pay-exact-output.json`, JSON.stringify(p1.json, null, 2) + '\n');
const p2 = await quote(payBody(EVM_R));
console.log('pay EVM recipient', p2.status, p2.json?.quote?.amountIn ?? JSON.stringify(p2.json));
const w = await quote(withdrawBody(NEAR_R));
console.log('withdraw', w.status, w.json?.quote?.amountOut ?? JSON.stringify(w.json));
writeFileSync(`${FIX}/quote-withdraw-intents.json`, JSON.stringify(w.json, null, 2) + '\n');
console.log('balance NEAR', JSON.stringify(await balance(NEAR_R)));
console.log('balance EVM', JSON.stringify(await balance(EVM_R)));
