-- Migration 003: add a generic key/value `settings` table.
-- Backs the manually-maintained demo stats shown on the Dashboard summary card
-- (emails sent, open rate, replies, meetings booked). Re-runnable.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- set_updated_at() already exists (defined in schema.sql). Recreate the trigger
-- idempotently so this migration can be applied more than once safely.
DROP TRIGGER IF EXISTS settings_set_updated_at ON settings;
CREATE TRIGGER settings_set_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the Dashboard demo stats with zeros; edited manually in the UI for now.
INSERT INTO settings (key, value) VALUES
  ('demo_emails_sent', '0'),
  ('demo_open_rate', '0'),
  ('demo_replies', '0'),
  ('demo_meetings_booked', '0')
ON CONFLICT (key) DO NOTHING;
