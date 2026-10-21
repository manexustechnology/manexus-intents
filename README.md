# Manexus Intents

An original, mobile-first web MVP for exploring cross-chain assets, public quote previews, and shareable payment requests.

## Run

Requires Node 22.18+ (Node 24 recommended).

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

## Implemented

- Live public NEAR 1Click token discovery with clearly labelled sample fallback.
- Searchable assets and reference prices; hide-prices screen preference.
- Illustrative swap calculator with amount/pair/slippage validation, invalidation on edit and 60-second expiry. Explicitly excludes fees and is not an executable quote.
- Separate live public mainnet dry-quote preview: Arbitrum USDC to wrapped NEAR (wNEAR) or Ethereum XAUT, dynamically resolved from provider token discovery. Uses integer base-unit conversion and synthetic recipient addresses, literal `dry: true`, no authentication, no proxy and no confidential mode. Rejects responses with a nonempty deposit address. Errors never fall back to invented quotes. Snapshots expire after 60 seconds.
- Payment request builder with network-aware address syntax and amount validation. URL fragments contain only public address, amount, asset, network; no request database. Shareable previews do not verify address ownership or payment status.
- Educational tokenized-asset concept gallery, explicitly synthetic and not inventory or investment offers.
- Responsive layout, keyboard focus states, labelled fields, privacy explanation, security headers.

## Boundaries

The original preview baseline has no mainnet wallet signing, custody, deposits, transaction broadcast, swap execution, mainnet balance retrieval, payment verification, or private payments. The later Base Sepolia test-payment flow is documented below. Hiding prices is not on-chain privacy. NEAR Intents has no testnet; live calls are mainnet dry previews only. Provider reference prices and snapshots may change. The provider sees browser IP and quote inputs. Synthetic quote addresses cannot be used as payment destinations.

XAUT is an issuer-backed token, not a claim that this app offers redemption or verifies eligibility. See [issuer](https://gold.tether.to/) and [terms](https://gold.tether.to/legal/). Production asset support requires issuer, custody, legal and jurisdiction review.

No analytics, private client material, credentials, paid backend or third-party font/image requests are included. The optional wallet handles testnet RPC requests and signing.

## Demo

1. Open Overview; live discovery label appears when available. Search an asset/network.
2. Swap: inspect the illustrative calculator and disabled execution. Scroll to Mainnet quote preview; request 10 Arbitrum USDC to wNEAR or XAUT. No funds move.
3. Payments: choose NEAR, amount 1.25, public test example `preview.near`. Create and copy a request; open it to see an unverified request preview. Do not send funds to this example.
4. Explore assets and Privacy explain what remains conceptual/deferred.

## Deployment

Static Cloudflare Pages project `manexus-intents`, output `dist`. No DNS changes, Functions, new credentials or paid services.

```sh
npm run build
npx wrangler pages deploy dist --project-name manexus-intents --branch main
```

## Sources

- https://docs.near-intents.org/
- https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api
- https://1click.chaindefuser.com/v0/tokens

This baseline is independently developed; no claim of hackathon eligibility or submission is made.

## Testnet payment iteration

The Payments tab now has an **optional, user-controlled Base Sepolia test ETH flow**. Open in an injected EVM wallet browser, select Base Sepolia (chain ID 84532), connect, enter a plain receiving address and up to 0.1 test ETH, review, check the confirmation box, and explicitly approve in the wallet. No private keys are requested or stored. There is no mainnet transfer path, ERC-20 approval, swap execution, or WalletConnect service.

The sender needs faucet test ETH and test gas. See [Base network details](https://docs.base.org/get-started/connect-to-base) and [free test funds](https://docs.base.org/get-started/get-funds). The app never claims a submitted transaction is confirmed: receipt checking uses the fixed official Base Sepolia RPC and requires a successful mined receipt plus a matching transaction: chain, sender, recipient, exact value, hash, block hash/number, and empty calldata. A mined but mismatched transaction never fulfills the reviewed payment; saved confirmations are reverified after reload. An uncertain wallet outcome is retained locally and blocks another payment until the user checks their wallet and explicitly clears tracking. Local tracking does not cancel an on-chain transaction. Account/network changes invalidate the review. Only plain receiving addresses are supported in this iteration.

Payment requests can include **Test ETH / Base Sepolia**. Opening such a link pre-fills the optional test payment form; it never connects, signs, or sends automatically. Mainnet request links remain request-only.

The Swap tab also has a **local cross-chain simulation**. Every step is labelled simulated; it has no wallet/API/blockchain side effects. NEAR Intents has no testnet. Existing public mainnet dry quotes remain read-only. No confidential payments are implemented.

Browser validation uses a mocked injected wallet; the agent did not connect to an owner's wallet, request faucet funds, sign, or broadcast a real/testnet transaction. A user-approved on-chain test remains the final integration check.

### Test commands

```sh
npm test
npm run build
# Run against a local server or a deployed preview:
PLAYWRIGHT_BASE_URL=https://manexus-intents.pages.dev npx playwright test
# Optional public mainnet dry-quote smoke checks only:
LIVE_API=1 PLAYWRIGHT_BASE_URL=https://manexus-intents.pages.dev npx playwright test live.spec.ts
```

Deployment is a manual upload with existing Wrangler OAuth access to the Manexus Cloudflare account. The GitHub repository is separate; **automatic GitHub-to-Pages deployment is not configured**.
