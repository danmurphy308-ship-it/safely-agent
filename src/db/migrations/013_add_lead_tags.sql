-- 013: leads.tags — free-form labels on a lead.
--
-- First use: 'linkedin-only', set when a lead's email fails Instantly
-- verification but the lead has a contact_linkedin. Instead of being
-- deprioritised, the bad address is cleared and the lead is scored anyway,
-- staying eligible for the Aimfox LinkedIn path at score >= 70.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
