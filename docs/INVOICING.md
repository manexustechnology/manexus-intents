# Invoice lifecycle and reconciliation

Current behaviour of the server-side invoice flow (code: `server/invoices.ts`, `server/reconcile.ts`, `server/payments.ts`) and of bill pay against Manexus invoices (`server/bills.ts`).

## States

`draft` -> `issued` -> `paid` or `cancelled`. Drafts are editable (optimistic `revision` check); issued invoices are locked. Only an issued invoice can be cancelled. "Overdue" is not a stored state: it is shown when an unpaid issued invoice is past its due date. Every invoice belongs to one owner account (NEAR or EVM address from sign-in); owners can only read and change their own invoices. The public payer page (`#/pay/<publicId>`) needs no sign-in and shows only invoice data needed to pay.

## How an invoice becomes paid

A payer chooses any supported token/chain. The server requests a 1Click `EXACT_OUTPUT` quote for the invoice total in the invoice token (USDC or USDT) with `recipientType: INTENTS` and the owner's account as recipient, and stores the payment attempt (deposit address, deadline). Funds then land in the owner's own `intents.near` balance.

The invoice is marked `paid` only by the server, and only from 1Click's own status endpoint reporting `SUCCESS` for that attempt, where the executed quote matches the invoice exactly: `EXACT_OUTPUT`, recipient equals the owner, `INTENTS` recipient type, destination asset equals the invoice token, requested amount equals the invoice total, and the delivered amount is at least the total. Anything else is recorded as `failed` and never marks the invoice paid. A payer-submitted transaction hash is only a hint to speed up processing and is never proof of payment. The browser never decides payment state.

## Other outcomes

- `paid`: the first verified SUCCESS. The deposit address is recorded on the invoice.
- `duplicate`: a second verified SUCCESS for an already paid invoice (different deposit). The invoice stays paid; the extra funds also arrive in the owner's balance and are the owner's to refund manually.
- `after_cancel`: a verified SUCCESS that arrives after the owner cancelled. The invoice stays cancelled; the funds are in the owner's balance.
- `refunded`: 1Click refunded the payer (for example the deposit was insufficient or the quote expired); the invoice stays unpaid and the payer can try again.
- `failed`: 1Click reported failure, or a SUCCESS that did not match the invoice.

An unpaid quote is no longer polled one day after its deadline.

## Bill pay and vendor reconciliation

A Manexus user can pay another Manexus user's issued invoice from their own NEAR Intents balance by importing its pay link as a bill (`POST /api/bills/import`, then `POST /api/bills`). Both sides are reconciled from the same verified 1Click status; neither side's browser decides payment state.

- **Import.** Accepted: `<this deployment>/#/pay/<publicId>` or the bare public id of an `issued` invoice in the same database. Refused: links from another origin, your own invoice, an invoice that is not issued, and (on save) a second bill for the same invoice unless the earlier one was cancelled. The bill copies vendor (issuer), reference (invoice number), amount (invoice total), token and pay-to account (the vendor's Intents account) as read-only fields.
- **Quote.** `POST /api/bills/<id>/quote` re-reads the vendor invoice and refuses with 409 "The vendor invoice is no longer payable" unless it is still `issued` with the same total, owner and token. The quote is built exactly like a payer's quote on the public pay page (`EXACT_OUTPUT` for the invoice total, `INTENTS` recipient = the vendor, refunds to the bill owner's Intents account), and the same deposit address is stored twice: as the bill's transfer (kind `bill`, in the payer's history) and as a **payment attempt on the vendor's invoice**. The bill becomes `paying`.
- **Sign and relay.** Before relaying the owner's signature, `POST /api/transfers/submit` checks the vendor invoice again and refuses with 409 "The vendor invoice is no longer payable" if it is no longer `issued` (the vendor cancelled it, or another payment marked it paid). Nothing is relayed, so no funds move.
- **Settlement.** Opening the bill refreshes the transfer and runs the vendor invoice's reconciliation (`refreshInvoice`, the only path to `paid`). The vendor invoice flips to `paid` under the rules above; the bill becomes `paid` when its transfer reports `SUCCESS`. A `FAILED` or `REFUNDED` transfer, or a quote that expired unsigned for good (after a failed relay: only once a 1Click status read after a grace period shows nothing landed), returns the bill to `scheduled` so it can be paid again.
- **A payment that lands anyway** (relayed just before the vendor cancelled, or after someone else paid) is recorded on the vendor's invoice as `duplicate` or `after_cancel`, exactly like any other extra payment. The funds are in the vendor's balance; the bill shows **"Paid — vendor reports extra payment"** and asks the payer to contact the vendor. There is no automatic refund.

Manual bills (any address on any supported chain, or any Intents account) are paid with the same engine but have no vendor-side record.

## Not covered

No fiat, tax, legal or accounting guarantees; no email or messaging; no partial-payment tracking; no automatic refunds of duplicate payments; no scheduled or automatic bill payments (a due date is a reminder).
