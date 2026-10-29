-- Cached AI treasury summary per owner (10-minute TTL, server/nearai.ts). Owners without a signed policy
-- have no agent_policies row, so the cache is its own table.
CREATE TABLE agent_cache (owner TEXT PRIMARY KEY, summary TEXT, summary_at TEXT);
