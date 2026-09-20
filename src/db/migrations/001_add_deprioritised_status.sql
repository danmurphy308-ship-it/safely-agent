-- Migration 001: add 'deprioritised' to the leads status CHECK constraint.
-- Sub-50 leads are now marked 'deprioritised' (distinct from 'rejected').

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN (
  'new', 'enriched', 'scored', 'drafted', 'approved', 'sent', 'replied',
  'booked', 'rejected', 'deprioritised', 'bounced', 'unsubscribed', 'error'
));
