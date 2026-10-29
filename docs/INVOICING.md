# Invoice lifecycle and reconciliation

Current behaviour of the server-side invoice flow (code: `server/invoices.ts`, `server/reconcile.ts`, `server/payments.ts`).

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

## Not covered

No fiat, tax, legal or accounting guarantees; no email or messaging; no partial-payment tracking; no automatic refunds of duplicate payments.
