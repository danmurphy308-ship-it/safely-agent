-- Migration 005: per-campaign auto-replenish sourcing.
-- When auto_replenish is on and the campaign's unsent pipeline (leads in
-- new/enriched/scored/drafted) drops below replenish_threshold, the hourly
-- leadReplenisher job tops it up from Apollo (search + bulk_match enrichment —
-- spends Apollo credits, hence the opt-in default and the 24h cooldown
-- tracked via last_replenished_at). Re-runnable.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS auto_replenish BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replenish_threshold INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS last_replenished_at TIMESTAMPTZ;
