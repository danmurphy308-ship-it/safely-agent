-- Migration 004: add instantly_campaign_id to campaigns.
-- Holds the per-campaign Instantly campaign UUID that sendEmail() enrols leads
-- into; when null, sending falls back to the INSTANTLY_CAMPAIGN_ID env var.
-- Re-runnable.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT;
