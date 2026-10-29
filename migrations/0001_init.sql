CREATE TABLE challenges (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('near','evm')), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE invoices (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','issued','paid','cancelled')), token_id TEXT NOT NULL, data TEXT NOT NULL, total TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issued_at TEXT, paid_at TEXT, paid_by TEXT);
CREATE INDEX invoices_owner ON invoices(owner, updated_at);
CREATE TABLE payment_attempts (deposit_address TEXT PRIMARY KEY, deposit_memo TEXT, invoice_id TEXT NOT NULL REFERENCES invoices(id), origin_asset TEXT NOT NULL, amount_in TEXT NOT NULL, refund_to TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, amount_out TEXT, upstream TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX attempts_invoice ON payment_attempts(invoice_id);
CREATE TABLE withdrawals (deposit_address TEXT PRIMARY KEY, owner TEXT NOT NULL, origin_asset TEXT NOT NULL, destination_asset TEXT NOT NULL, amount TEXT NOT NULL, recipient TEXT NOT NULL, intent_hash TEXT, status TEXT NOT NULL, upstream TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX withdrawals_owner ON withdrawals(owner, created_at);
