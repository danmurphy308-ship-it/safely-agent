-- Source-fallback chain: when a campaign's primary lead_source runs dry
-- (empty Apollo page / Clay has_more:false), findLeadsForCampaign can fall
-- through to the OTHER provider for the same ICP instead of just stopping.
--
-- apollo_exhausted_at / clay_exhausted_at record the last time that provider
-- came back empty for this campaign's current ICP. v1 only clears them on an
-- ICP edit (PUT /api/campaigns/:id, alongside the existing apollo_page/
-- clay_search_id cursor reset) — a time-based re-check is a future
-- enhancement, not built here.
--
-- fallback_source_enabled is opt-in per campaign (default false), consistent
-- with auto_replenish and lead_source — no existing campaign's sourcing
-- behavior changes until this is turned on.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS apollo_exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clay_exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fallback_source_enabled BOOLEAN NOT NULL DEFAULT false;
