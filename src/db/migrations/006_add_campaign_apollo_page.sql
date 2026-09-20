-- Migration 006: persist the Apollo search cursor per campaign.
-- findLeadsForCampaign previously always fetched page 1, so every run
-- re-bought the same people and threw most away as duplicates. apollo_page
-- is the next page to fetch; it advances after each fetched page and resets
-- to 1 when the campaign's ICP targeting changes. Re-runnable.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS apollo_page INTEGER NOT NULL DEFAULT 1;
