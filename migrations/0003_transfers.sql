-- The withdrawals table now holds every outbound transfer (in code: "transfers"): withdrawals, swaps,
-- bill payments and payroll lines. Existing rows are withdrawals.
ALTER TABLE withdrawals ADD COLUMN kind TEXT NOT NULL DEFAULT 'withdraw' CHECK (kind IN ('withdraw','swap','bill','payroll'));
ALTER TABLE withdrawals ADD COLUMN reference TEXT;
ALTER TABLE withdrawals ADD COLUMN batch_id TEXT;
ALTER TABLE withdrawals ADD COLUMN bill_id TEXT;
CREATE INDEX withdrawals_owner_kind ON withdrawals(owner, kind, created_at);
