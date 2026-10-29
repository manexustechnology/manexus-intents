# Manexus Intents — Product Design (NEAR HACKATHON, Track 08 Real-World Money)

## Expectations (Pak Eko)

1. Invoicing system that supports multichain swap and multichain payment using NEAR Intents.
2. Flow: user creates invoice / swaps across chains → receives payment into their account → withdraws out of the app (exchange / wallet).
3. Must satisfy NEAR HACKATHON requirements (https://nearhackathon.com).
4. UX reference: ramp.com (finance-ops dashboard: AR, bill pay, payouts, treasury, automation rules).

## Hackathon constraints (from nearhackathon.com, checked 2026-10-29)

- Primary track: **08 Real-World Money** ("payroll, invoicing, remittances, merchant payments… something a normal company could use tomorrow"; named tech: stablecoins, NEAR Intents, meta transactions). Secondary: **04 Autonomous Business** (Plan 3 agent rules).
- Submission window 1–14 Nov 2026 23:59 UTC; public repo; public X demo post that states "built at NEAR HACKATHON" with video/screenshots; NEAR payout wallet.
- Judges (Claude Code & Codex first) check that the project **runs and does what the README says**. README claims must be exactly true.
- Rule "code must be written since the announcement": decision = continue this repo. README must have a section separating pre-hackathon baseline (commits up to `7d827b1`, 2026-10-22) from hackathon work.

## Decisions

| Topic | Decision |
|---|---|
| Account / balance | Non-custodial **NEAR Intents balance** on `intents.near` owned by the user's wallet. Manexus never holds funds or keys. |
| Account identity | NEAR wallet (NEP-413 signing) or EVM wallet (ERC-191 signing). Intents account id = NEAR account id, or lowercase EVM address. |
| Settlement assets | Invoices are denominated in **USDC or USDT** (NEAR Intents `nep141:` token ids resolved from `/v0/tokens`). |
| Payer | Anyone, no login. Pays with any token on any chain 1Click supports; 1Click `EXACT_OUTPUT` delivers the exact invoice amount to the owner's Intents account (`recipientType: INTENTS`). |
| Withdraw | Signed intent: `depositType: INTENTS` → `recipientType: DESTINATION_CHAIN` to any address/chain (exchange deposit address or wallet). |
| Backend | Cloudflare Pages Functions (`functions/api/*`) + D1, same Pages project `manexus-intents`. 1Click API key only server-side (`ONECLICK_API_KEY` secret; optional — without it 1Click adds 25 bps). |
| Reconciliation | Lazy: status polled from 1Click when payer/owner views; no cron. Invoice becomes `paid` only from verified 1Click `SUCCESS` with matching recipient, asset and amount. |
| Network | Mainnet only (NEAR Intents has no testnet). Real-funds smoke tests use small amounts and explicit user approval. |
| Frontend | Keep vanilla TypeScript + Vite, string templates with `escapeHTML`, existing style.css. |

## Retired from the baseline

Illustrative price calculator, local swap simulation, tokenized-asset concept gallery, Base Sepolia test-payment flow and localStorage-only invoices. They contradict a real product ("no funds move") and would make README claims ambiguous for judges. Pure helpers worth keeping (`validAmount`, `escapeHTML`, `baseUnits`, `formatUnits`, invoice line-item math) are reused.

## Roadmap (one plan each; every plan ships working software)

- **Plan 1 — Core loop** (`docs/superpowers/plans/2026-10-29-plan1-core-loop.md`): backend, wallet login, server invoices, payer pays from any chain into the owner's Intents balance, balances view, withdraw to any chain.
- **Plan 2 — Ramp features:** in-account swap (INTENTS→INTENTS), Bill pay (pay a vendor invoice/payment request from balance to any chain), Payroll / batch payout (CSV of recipients → N signed intents), Treasury dashboard (balances in USD, AR outstanding/overdue, unified transaction history).
- **Plan 3 — Automation & submission:** agent rules within user-set limits (auto-convert received funds to USDC, auto-sweep above threshold to a whitelisted withdrawal address, daily spend caps; rule proposals are executed only via pre-authorised constraints or user signature), demo video, X post, README hackathon section, submission form.

## Risks

- NEAR Intents suffered a ~$3.8M exploit on 2026-10-01 (postmortem public). App copy must not overstate safety; amounts in demo are small.
- 1Click behaviour for `recipientType: INTENTS` with EVM account ids, the ERC-191 `standard` literal and NEP-413 public-key registration on `intents.near` are verified in Plan 1 Task 0 before dependent code is written.

## Plan 2 decisions (2026-10-30)

- Order: Swap → Treasury dashboard → Bill pay → Payroll. Plan: `docs/superpowers/plans/2026-10-30-plan2-treasury-features.md`.
- All outbound money movement (withdraw, swap, bill, payroll) uses one transfer engine: 1Click quote → generated intent → owner signs → server relays the exact stored payload.
- Bill pay: paste a Manexus invoice link (paid into the vendor's Intents account and reconciled on the vendor invoice) or enter a manual address on any supported chain. Bills and payroll pay the exact recipient amount (`EXACT_OUTPUT`).
- Payroll: CSV upload or saved payees; one signed intent per line, signed sequentially; at most 50 lines per batch.

## Plan 3 decisions (2026-10-30)

- Agent proposes, owner approves every action with one wallet signature; no delegated keys; the server never signs. Plan: `docs/superpowers/plans/2026-10-30-plan3-ai-treasury-agent.md`.
- NEAR AI Cloud drafts policies from plain language and writes treasury summaries; drafts pass the same strict validator and need the owner's signature; LLM output never becomes an amount, token or address.
- Rules: auto-convert to stablecoin, auto-sweep to whitelist (keep balance), spending limits (per-tx, 24 h, whitelist-only), bill-due and invoice-overdue reminders. Policy and whitelist changes are wallet-signed.
- Submission package (docs/SUBMISSION.md, judge quickstart) is part of Plan 3; tracks 08 (primary), 04, 06.
