-- Per-owner rate limit for AI rule drafting (server/nearai.ts checkDraftRate): at most 5 calls in a
-- one-minute window that starts at the first call after the previous window ended.
ALTER TABLE agent_cache ADD COLUMN draft_window_start TEXT;
ALTER TABLE agent_cache ADD COLUMN draft_count INTEGER NOT NULL DEFAULT 0;
