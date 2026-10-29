-- Payroll: saved payees and batch payouts paid from the owner's NEAR Intents balance. A line's
-- `amount` is what the payee receives, in base units of `destination_asset` (EXACT_OUTPUT);
-- `deposit_address` links the line's latest transfer (a `withdrawals` row with kind 'payroll').
CREATE TABLE payees (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('DESTINATION_CHAIN','INTENTS')),
  recipient TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX payees_owner ON payees(owner, name);

CREATE TABLE payroll_batches (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX payroll_batches_owner ON payroll_batches(owner, created_at);

CREATE TABLE payroll_lines (
  batch_id TEXT NOT NULL REFERENCES payroll_batches(id),
  n INTEGER NOT NULL CHECK (n >= 1),
  name TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('DESTINATION_CHAIN','INTENTS')),
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  deposit_address TEXT,
  PRIMARY KEY (batch_id, n)
);
CREATE INDEX withdrawals_owner_batch ON withdrawals(owner, batch_id);
