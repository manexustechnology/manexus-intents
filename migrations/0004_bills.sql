-- Bills the owner pays from their NEAR Intents balance. `amount` is what the vendor receives, in base
-- units of `destination_asset` (EXACT_OUTPUT). `deposit_address` links the bill's latest payment
-- transfer (a `withdrawals` row with kind 'bill'). Manexus-imported bills keep the vendor invoice's
-- public id so the vendor side reconciles the same payment.
CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  vendor TEXT NOT NULL,
  reference TEXT NOT NULL,
  due_date TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('DESTINATION_CHAIN','INTENTS')),
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','manexus')),
  vendor_public_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled','paying','paid','cancelled')),
  deposit_address TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bills_owner_status_due ON bills(owner, status, due_date);
