-- 015: Cadence editor — per-campaign sequence steps + schedule/limits,
-- configurable from the app instead of hardcoded. Every column is
-- NULL-as-default (see schema.sql comment above these columns for the exact
-- default each one falls back to); adding them changes no existing campaign's
-- behavior until someone actually edits its cadence.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_steps JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_days BOOLEAN[];
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_window_start TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_window_end TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_timezone TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_limit INTEGER;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_daily_limit_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_daily_limit_check
  CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 50);
