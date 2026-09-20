-- 014: reply-assist — Claude classifies each real inbound reply and drafts a
-- suggested response for human review (never auto-sent).

-- One row per classified reply event.
CREATE TABLE IF NOT EXISTS reply_assists (
  id                  SERIAL PRIMARY KEY,
  event_id            INTEGER REFERENCES events(id) ON DELETE CASCADE,
  lead_id             INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  category            TEXT NOT NULL CHECK (category IN (
                        'interested', 'send_info', 'wrong_person',
                        'pricing', 'not_interested', 'auto_reply'
                      )),
  reply_text          TEXT,
  suggested_response  TEXT,
  -- wrong_person replies that name a colleague also get a fresh outreach
  -- draft to that person, referencing the referral.
  referral_name       TEXT,
  referral_draft      TEXT,
  -- auto_reply extraction: named colleague / return or leaving date.
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reply_assists_lead ON reply_assists(lead_id, created_at DESC);

-- Free-text operator notes on a lead (first writer: auto-reply extraction).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;

-- 'not_interested': set when a reply is classified not_interested. Distinct
-- from 'rejected' (the manual Replies-page triage, which hides the thread) so
-- the reply stays visible until the human sends the graceful close.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN (
  'new', 'enriched', 'scored', 'drafted',
  'approved', 'sent', 'replied', 'booked',
  'rejected', 'deprioritised', 'bounced', 'unsubscribed', 'error',
  'not_interested'
));
