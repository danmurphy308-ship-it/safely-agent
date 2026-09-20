-- Migration 009: add aimfox_campaign_id to campaigns.
-- Holds the per-campaign Aimfox (LinkedIn outreach) campaign UUID that
-- addLeadToCampaign() adds 70+-scoring leads into; when null, it falls back
-- to the AIMFOX_CAMPAIGN_ID env var. Re-runnable.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS aimfox_campaign_id TEXT;
