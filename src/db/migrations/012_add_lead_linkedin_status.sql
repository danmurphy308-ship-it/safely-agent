-- LinkedIn outreach progress per lead, driven by Aimfox:
--   queued    - added to the Aimfox campaign audience (our side)
--   requested - Aimfox sent the connection request (webhook: connect)
--   accepted  - request accepted (webhook: accepted / new_connection)
--   replied   - lead replied on LinkedIn (webhook: reply / new_reply /
--               campaign_reply); also advances leads.status to 'replied'
-- NULL = lead is not on the LinkedIn route. Transitions are forward-only
-- (enforced in the webhook receiver, not here).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS linkedin_status TEXT
    CHECK (linkedin_status IN ('queued', 'requested', 'accepted', 'replied'));
