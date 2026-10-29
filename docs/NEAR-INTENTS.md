# NEAR Intents facts (verified 2026-10-29)

Recorded by `scripts/spike-oneclick.ts` (dry quotes only, no funds, no signing) and the docs at docs.near-intents.org.
Base URL: `https://1click.chaindefuser.com`. RPC: `https://rpc.mainnet.fastnear.com`. No API key used.

## Tokens (`GET /v0/tokens`, fixture `tests/fixtures/oneclick/tokens.json`)

| Token | blockchain | decimals | assetId |
| - | - | - | - |
| USDC | near | 6 | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| USDT | near | 6 | `nep141:usdt.tether-token.near` |
| USDC | arb | 6 | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` |
| USDC | base | 6 | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| USDC | eth | 6 | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` |
| USDC | sol | 6 | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` |

## Routing

| Fact | Value | How verified |
| - | - | - |
| Pay quote, `recipientType: "INTENTS"` with NEAR account recipient `manexus-spike.near` | Accepted: HTTP 201, `quote.amountIn = "1010180"` for `amount: "1000000"` EXACT_OUTPUT (arb USDC -> near USDC) | Script step 2; fixture `quote-pay-exact-output.json` |
| Same with lowercase EVM address recipient (`0x1111...1111`) | Accepted: HTTP 201, same `amountIn = "1010180"` | Script step 2 |
| Withdraw quote `depositType: "INTENTS"`, near USDC -> arb USDC, `recipientType: "DESTINATION_CHAIN"` | Accepted: HTTP 201, `amountOut = "994498"` for `amount: "1000000"` | Script step 3; fixture `quote-withdraw-intents.json` |
| Quote success status code | 201 (not 200) | Script output |
| Public balance read, `intents.near` `mt_batch_balance_of {account_id, token_ids:[USDC near]}` | `["0"]` for both NEAR and EVM account ids (no error for unknown accounts) | Script step 5, NEAR RPC `call_function` (args base64 JSON; result bytes decode to JSON) |

## Signing (docs: Signing Intents, Account Abstraction, submit-a-signed-intent)

| Fact | Value |
| - | - |
| ERC-191 `standard` literal | `"erc191"` |
| ERC-191 `signedData` shape | `{ "standard": "erc191", "payload": "<JSON string>", "signature": "secp256k1:<base58 of 65 bytes r\|\|s\|\|v>" }`. No `public_key` (recovered via ecrecover). `v` must be normalized to 0/1. |
| ERC-191 payload JSON | `{"signer_id":"0x<eth addr>","verifying_contract":"intents.near","deadline":"<ISO>","nonce":"<base64 32 bytes>","intents":[...]}` |
| NEP-413 shape | `{ standard:"nep413", payload:{recipient:"intents.near", nonce:<base64>, message:"<JSON string with signer_id, deadline, intents>"}, public_key:"ed25519:...", signature:"ed25519:..." }` |
| Named NEAR account must register key first | Yes: call `add_public_key` on `intents.near` from that account (100 Tgas, 1 yoctoNEAR) before its signatures are accepted. Deposits to it work before registration. |
| EVM (or other chain) accounts need registration | No: implicit account derived from the public key (`0x...` for ECDSA, 64-hex for EdDSA) |
| Check view method | `has_public_key {account_id, public_key}` on `intents.near`. Verified live 2026-10-29: returns `false` (valid call, no error) for `manexus-spike.near` with a sample key. |

## Concerns

- A named NEAR account with no registered key can receive funds but cannot sign withdrawals; the owner flow must check `has_public_key` and register first.
- Unauthenticated requests incur an extra 0.25% platform fee per the 1Click docs; the recorded quote's exact fee breakdown (amountIn 1010180 for 1000000 out) was not analysed.
