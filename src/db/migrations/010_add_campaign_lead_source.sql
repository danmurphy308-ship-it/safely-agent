-- Per-campaign sourcing provider for Auto-Source / auto-replenish, plus the
-- Clay Public API's stateful search id. Clay's search iterator advances
-- server-side per fetch (no page numbers), so the cursor IS the search id;
-- like apollo_page resetting to 1, it resets to NULL when the ICP changes
-- (handled in PUT /api/campaigns/:id) so a stale search is never resumed.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS lead_source TEXT NOT NULL DEFAULT 'apollo',
  ADD COLUMN IF NOT EXISTS clay_search_id TEXT;

-- Enforce the provider enum. Drop-then-add keeps re-runs idempotent.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_lead_source_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_lead_source_check CHECK (lead_source IN ('apollo', 'clay'));
