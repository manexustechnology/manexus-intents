-- AI treasury agent (Plan 3). Sign-in challenges are reused for signed policy changes: `purpose` is
-- 'login' for sign-in and '<action kind>:<sha256 hex of the action>' for a policy/whitelist change, so a
-- challenge can only be consumed for the exact change it was issued for.
ALTER TABLE challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';
-- The owner's signed rules: `policy` is the canonical JSON (server/policy.ts), `hash` its sha256 hex.
CREATE TABLE agent_policies (owner TEXT PRIMARY KEY, policy TEXT NOT NULL, hash TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Recipients the owner approved with a signature. EVM addresses are stored lowercase.
CREATE TABLE whitelist (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  label TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('DESTINATION_CHAIN','INTENTS')),
  recipient TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner, destination_asset, recipient)
);
-- Agent proposals the owner approves (one signature each) or dismisses.
CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('convert','sweep','pay_bill','follow_up_invoice')),
  dedup_key TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','executing','done','dismissed','expired')),
  deposit_address TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- At most one open proposal per owner and basis.
CREATE UNIQUE INDEX agent_proposals_open ON agent_proposals(owner, dedup_key) WHERE status IN ('proposed','executing');
