# Invoicing prototype — implementation and release handoff

## Reference and scope

Reviewed the public [Trezu application](https://trezu.app/) and [Trezu public site](https://trezu.org/) on 2026-10-22. The application presents a sign-in chooser; no sign-in, account, wallet, or treasury was created. The public site describes treasury payment requests, recipient/network context, and cross-chain operations. Its [public documentation index](https://docs.trezu.org/llms.txt) lists proposing/handling payments and swapping assets. An authenticated invoice editor was not inspected, so this is an original, bounded invoice design rather than a reproduction or a claim of feature parity. No Trezu privacy, regulatory, asset coverage, or payment execution claims are inherited.

## Implemented

- Invoices navigation on desktop/mobile, record list and status filters.
- Up to 100 local records; up to 10 line items each. Description, whole quantity, token unit price, exact base-unit line totals and total. No floating-point monetary arithmetic.
- Invoice number, fictional issuer/client labels, due date, public receiving address, notes. No real client data is included.
- Existing choices: USDC/Ethereum, ETH/Ethereum, NEAR/NEAR, SOL/Solana, test ETH/Base Sepolia. One asset/network per invoice. No implied support for other settlement chains.
- Locally autosaved incomplete drafts; validation before issuance; recovery after reload. Stale-revision edits are rejected, storage corruption is not overwritten, and quota failure leaves edits visible with an explicit discard/reload path. This is optimistic browser-local conflict detection, not a collaborative database guarantee.
- Draft → issued → cancelled. Issued contents are locked; duplicate creates a new draft with its own ID. Overdue is derived from the UTC due date. All issued/overdue invoices remain unpaid/unverified. There is no mark-paid button or automatic reconciliation.
- Shareable, versioned, unsigned URL-fragment snapshots. Totals are recomputed. Links cannot claim paid; malformed/unsupported snapshots are rejected and text is escaped. Issuer/address ownership is unverified. Anyone with the link can read/edit it. Cancellation cannot revoke a distributed link; the requester must communicate changes separately. No email or messaging is sent.
- Funding-route navigation to the existing public NEAR Intents dry-quote and explicit simulation workspace. It does not forward invoice details or claim a route quote settles an invoice. Existing quotes remain Arbitrum USDC → wNEAR/NEAR or XAUT/Ethereum.
- Base Sepolia invoices can open a separate existing payment-request preview; it never connects/signs/sends automatically. Existing verified-receipt checks are unchanged. A separate payment receipt does not mark an invoice paid.

## Boundaries

No mainnet financial execution, tax calculations, billing/legal guarantees, private payments, authentication, team sync, backend persistence, email delivery, issuer signatures, payment reconciliation, or new credentials. This prototype is for synthetic records only. Local browser storage and URL fragments are not private storage. Browser clearing loses local invoices; this release does not provide backups/import. NEAR Intents has no testnet; cross-chain simulation is explicitly local and does not move assets.

## Validation

Run one worker to preserve host resources:

```sh
npm test
npm run typecheck
npm run build
# In another terminal, local only:
./node_modules/.bin/vite preview --host 127.0.0.1 --port 4179 --strictPort
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4179 npm run test:e2e -- --workers=1
```

Verified on 2026-10-22: 21 unit tests passed; typecheck/build passed; 50 mobile/desktop browser tests passed with one worker (2 optional live-provider smoke tests skipped). The new invoice-specific subset accounts for 16 browser tests. Desktop/mobile screenshots were visually checked; no horizontal overflow was found. `git diff --check` passed, and the testnet implementation, quote module, CSP, and dependency manifests remain unchanged.

No lint script is configured in this repository. New files are formatted with Prettier; TypeScript remains the static check. Browser tests use synthetic invoice records and mocked wallet/RPC responses. Optional live-quote tests are skipped unless `LIVE_API=1`; invoice tests never request a wallet action. Repeated issuance, reload recovery, stale tab conflicts, quota failures, corrupt storage, malicious snapshot content, exact totals, and unpaid-versus-simulated states are covered.

## Retest script

1. Open Invoices → New invoice. Use `DEMO-001`, `Example Studio`, `Demo Client`, a future date, USDC/Ethereum, and `0x2222222222222222222222222222222222222222` (synthetic address; do not send funds).
2. Add `Synthetic design`, quantity 3, price 0.1; add `Synthetic review`, quantity 2, price 0.2. Total must be exactly 0.7 USDC.
3. Reload and return to Invoices: one saved draft and both lines remain. Issue it: contents lock and the status remains unpaid/unverified.
4. Acknowledge public-link contents; create/open the snapshot. Verify totals, network, address and the unverified notice. No funds move.
5. Cancel the local invoice: local status changes, while the old snapshot explicitly remains independent. Duplicate creates a separate editable draft.
6. Open the route preview/simulation. Finishing the simulation must not change invoice status. A testnet invoice can open a separate request preview without a wallet call.

## Release procedure

Baseline: `668c887aa866641e26deb89a536a28c386e8163d` in `manexustechnology/manexus-intents`.

Inspect the working tree, run checks, and review only the intended files before an approved release. Commit/push and deploy manually:

```sh
git add src/invoice.ts src/invoice-ui.ts src/main.ts src/style.css tests/invoice.test.ts tests/browser/invoice.spec.ts docs/INVOICING.md README.md
git commit -m "Add local invoice drafts and unsigned shareable previews"
git push origin main
npm run build
npx wrangler pages deploy dist --project-name manexus-intents --branch main
```

Verify production HTTP 200, its exact JS/CSS bundle hashes, and the invoice flow before requesting a retest. Cloudflare Pages uses manual Wrangler upload; automatic GitHub deployment is not configured. Deployment does not send any external retest message.
