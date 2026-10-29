# NEAR HACKATHON submission — Manexus Intents

**Manexus Intents** — non-custodial invoicing and treasury on NEAR Intents: get paid in USDC or USDT from any chain into your own `intents.near` balance, then swap, pay bills, run payroll and withdraw, with every outflow signed in your wallet and an agent that suggests actions within limits you sign.

- Repository: https://github.com/manexustechnology/manexus-intents
- Live app: `<add after deploy>`
- Demo video: `<add after recording>`
- X demo post: `<add after posting>`
- NEAR payout wallet: `<add before submitting>`

## What did you build?

<!-- desc:start -->
Manexus Intents is non-custodial invoicing and treasury software for small businesses and freelancers who get paid in crypto across many chains.

Problem: a client holds USDC on Arbitrum, SOL or BTC; the business wants USDC or USDT in one place it controls, plus a way to pay vendors and staff without handing funds to a custodian.

What we built: wallet sign-in (NEAR via NEP-413, EVM via ERC-191); invoices in USDC or USDT with a public pay link; the payer picks any token on any chain and gets an exact deposit address from a NEAR Intents 1Click quote that delivers the invoice total into the owner's own intents.near balance; an invoice is marked paid only after the server verifies 1Click's SUCCESS status against recipient, asset and amount. From that balance the owner swaps, pays vendor bills (including another Manexus invoice), runs CSV payroll and withdraws to any chain. Every outflow is an intent the owner signs in their wallet; the server only quotes, checks and relays.

An agent applies rules the owner signs (convert to a stablecoin, sweep the excess to a whitelisted address, bill and invoice reminders) and proposes actions; each needs one wallet signature. Per-transaction and 24-hour spending limits and a recipient whitelist are enforced on every outbound transfer.

NEAR's role: NEAR Intents 1Click for multichain payments, swaps and withdrawals; signed intents on intents.near for every outflow; NEAR AI Cloud drafts rules from plain language (validated, never saved without a signature) and writes a short summary from totals only.
<!-- desc:end -->

## Tracks

- **08 Real-World Money** (primary): invoices, multichain payment into a non-custodial balance, verified reconciliation, bill pay, payroll, withdrawals.
- **04 Autonomous Business**: a deterministic agent turns signed rules into suggestions (convert, sweep, pay bill, follow up an overdue invoice); approving one is a single wallet signature.
- **06 AI Security & Defense**: per-transaction and rolling 24-hour spending limits, a recipient whitelist, and policy changes that need a fresh signed message; NEAR AI output is treated as untrusted text and goes through the same strict validator as a manual edit.

## 3-minute demo script

| Time | Scene | Show |
|---|---|---|
| 0:00–0:15 | Intro | Title card: "Manexus Intents — built at NEAR HACKATHON". One line: get paid from any chain into your own NEAR Intents balance. |
| 0:15–0:30 | Sign in | Login page → Connect EVM wallet (or NEAR wallet) → sign the message. Point out: signing does not send a transaction. |
| 0:30–0:50 | Invoice | Invoices → New invoice, ~1 USDC, one line item → Issue → copy the pay link. |
| 0:50–1:15 | Pay from another chain | Open the pay link in a second browser/wallet → choose USDC on Arbitrum → enter refund address → show the deposit address and exact amount from the 1Click quote → send. |
| 1:15–1:30 | Paid + balance | Invoice flips to Paid after the verified 1Click status; Home shows the new USDC in the Intents balance and the activity feed. |
| 1:30–1:45 | Swap | Swap → 1 USDC → wNEAR, 1 % slippage → review expected/minimum → sign. |
| 1:45–2:00 | Bill | Bills → paste a Manexus invoice link → vendor fields read-only → Pay → confirm address → sign. |
| 2:00–2:15 | Payroll | Payroll → upload a 2-line CSV → Send all → one signature per line. |
| 2:15–2:40 | Agent | Agent → Rules: enable "Convert to a stablecoin", set a 24-hour limit → Save rules → show the policy message → sign. A convert suggestion appears → Approve → review quote → sign → Done. (If NEAR AI is configured: "Describe your rules" draft and the AI summary.) |
| 2:40–2:55 | Withdraw | Withdraw → Arbitrum address → review expected/minimum → confirm address → sign → tracked to the destination transaction. |
| 2:55–3:00 | Close | Repo link; "non-custodial: every outflow signed by you". |

## X post draft

<!-- x:start -->
Built at NEAR HACKATHON: Manexus Intents. Invoice in USDC/USDT, get paid in any token on any chain into your own NEAR Intents balance, then swap, pay bills, run payroll, withdraw. Every outflow signed in your wallet. https://github.com/manexustechnology/manexus-intents
<!-- x:end -->

Attach the demo video or screenshots (invoice paid, Home balance, agent suggestion approved).

## Submission checklist

- [ ] Repository is public (https://github.com/manexustechnology/manexus-intents) and the README quickstart works from a clean clone.
- [ ] Demo recorded (video or screenshots) following the script above.
- [ ] Public X post published stating "Built at NEAR HACKATHON", with the video/screenshots and the repo link; link added above.
- [ ] NEAR payout wallet added above and in the submission form.
- [ ] Live launch gates in the README "Launch checklist" run with small amounts (or the submission says which were not run).
- [ ] Submitted before **14 Nov 2026 23:59 UTC**.
- [ ] If the team enters a second project, the README names it.
