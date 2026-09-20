-- ============================================
-- Safely AI SDR — Database Schema
-- ============================================

-- Auto-update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Locked search_path (Supabase Security Advisor: function_search_path_mutable).
-- Safe: the only call inside is now() (a pg_catalog builtin, always
-- implicitly searched), plus NEW/RETURN NEW record access — no schema
-- lookups exist in this function for an empty search_path to break.
ALTER FUNCTION set_updated_at() SET search_path = '';

-- ============================================
-- CAMPAIGNS
-- Defines a targeting campaign with ICP criteria
-- ============================================
CREATE TABLE IF NOT EXISTS campaigns (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'active', 'paused', 'completed')),

  -- ICP targeting criteria
  icp_industries          TEXT[],
  icp_locations           TEXT[],
  icp_titles              TEXT[],
  icp_min_fleet_size      INTEGER DEFAULT 100,
  icp_excluded_industries TEXT[],

  -- Instantly campaign this campaign's leads are enrolled into when sending.
  -- Null falls back to the INSTANTLY_CAMPAIGN_ID env var.
  instantly_campaign_id   TEXT,

  -- Aimfox (LinkedIn outreach) campaign that leads scoring 70+ with a
  -- LinkedIn URL are added to. Null falls back to the AIMFOX_CAMPAIGN_ID env var.
  aimfox_campaign_id      TEXT,

  -- Auto-replenish sourcing: when on and the unsent pipeline drops below the
  -- threshold, the hourly leadReplenisher tops it up from Apollo (spends
  -- credits — opt-in, max one top-up per 24h via last_replenished_at).
  auto_replenish          BOOLEAN NOT NULL DEFAULT false,
  replenish_threshold     INTEGER NOT NULL DEFAULT 25,
  last_replenished_at     TIMESTAMPTZ,

  -- Next Apollo People Search page to fetch for this campaign's ICP. Advances
  -- as pages are consumed so repeat sourcing runs see fresh people; reset to 1
  -- when the ICP targeting changes.
  apollo_page             INTEGER NOT NULL DEFAULT 1,

  -- Which provider Auto-Source / auto-replenish uses for this campaign.
  lead_source             TEXT NOT NULL DEFAULT 'apollo'
                            CHECK (lead_source IN ('apollo', 'clay')),

  -- Clay Public API search id: Clay's iterator advances server-side per fetch,
  -- so this is the sourcing cursor for lead_source = 'clay'. Reset to NULL when
  -- the ICP targeting changes (a new search is created on the next run).
  clay_search_id          TEXT,

  -- Source-fallback chain (migration 019): when the PRIMARY provider
  -- (lead_source) comes back empty, findLeadsForCampaign can fall through to
  -- the other provider for the same ICP. apollo_exhausted_at/clay_exhausted_at
  -- record the last time that provider ran dry for the current ICP; v1 only
  -- clears them on an ICP edit (same trigger as the cursor reset above), not
  -- on a timer. fallback_source_enabled is opt-in per campaign — existing
  -- campaigns keep single-provider sourcing until this is turned on.
  apollo_exhausted_at     TIMESTAMPTZ,
  clay_exhausted_at       TIMESTAMPTZ,
  fallback_source_enabled BOOLEAN NOT NULL DEFAULT false,

  -- ============================================
  -- CADENCE EDITOR — per-campaign sequence + schedule, configurable from the
  -- app instead of hardcoded (src/services/cadence.js). Every column here is
  -- NULL-as-default: NULL means "use the computed default", not "unset".
  --   sequence_steps   NULL -> SAFELY_SEQUENCE_STEPS (instantly.js)
  --   sending_days/window/timezone NULL -> Mon-Fri 9-17 in
  --     timezoneForLocations(icp_locations), matching createCampaign's default
  --   daily_limit      NULL -> CAMPAIGN_DAILY_LIMIT (50)
  -- This lets an existing campaign keep behaving exactly as it does today
  -- until someone actually edits its cadence.
  -- ============================================

  -- Ordered array of {subject, body, delayDays}. delayDays is the number of
  -- days AFTER THE PREVIOUS step that this step fires (step 0's is always 0) —
  -- this is the reverse of Instantly's own wire format, where `delay` sits on
  -- the step BEFORE the gap; the conversion happens in cadence.js so the DB/UI
  -- can show a natural "Day 0 -> 3 -> 6" timeline.
  sequence_steps          JSONB,

  -- Sun..Sat "is this a sending day" flags (matches Instantly's days object,
  -- 0=Sun..6=Sat, just as an array instead of a keyed object).
  sending_days            BOOLEAN[],
  sending_window_start    TEXT,
  sending_window_end      TEXT,

  -- Must be one of Instantly's closed timezone enum values (validated in
  -- app code against INSTANTLY_TIMEZONES in instantly.js, not a DB CHECK —
  -- that enum has 100+ values and Instantly could add more) — NOT full IANA
  -- names; enforced here has burned us with rejections before.
  sending_timezone        TEXT,

  -- Cap 50 to match Instantly's own CAMPAIGN_DAILY_LIMIT default and the
  -- cadence editor's guardrail.
  daily_limit             INTEGER CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 50),

  -- Stats (updated as campaign runs)
  total_leads             INTEGER DEFAULT 0,
  total_contacted         INTEGER DEFAULT 0,
  total_replied           INTEGER DEFAULT 0,
  total_meetings          INTEGER DEFAULT 0,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- LEADS
-- One row per person found via Clay or Apollo
-- ============================================
CREATE TABLE IF NOT EXISTS leads (
  id                  SERIAL PRIMARY KEY,
  campaign_id         INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,

  -- Identity
  company_name        TEXT NOT NULL,
  contact_name        TEXT,
  contact_email       TEXT,
  contact_title       TEXT,
  contact_linkedin    TEXT,
  company_url         TEXT,
  company_domain      TEXT,

  -- Enrichment data from Clay/Apollo
  industry            TEXT,
  fleet_size          INTEGER,
  country             TEXT,
  employee_count      INTEGER,
  raw_enrichment      JSONB,

  -- Pipeline status
  -- new → enriched → scored → drafted → approved → sent → replied → booked
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN (
                          'new', 'enriched', 'scored', 'drafted',
                          'approved', 'sent', 'replied', 'booked',
                          'rejected', 'deprioritised', 'bounced', 'unsubscribed', 'error',
                          'not_interested'
                        )),

  -- CRM reference
  hubspot_contact_id  TEXT,

  -- Email verification (Instantly): verified / invalid / risky / catch_all /
  -- pending / unknown. Invalid addresses are deprioritised before scoring and
  -- blocked at send time.
  email_verification  TEXT,
  email_verified_at   TIMESTAMPTZ,

  -- LinkedIn outreach progress (Aimfox): queued (added to audience) →
  -- requested (connection request sent) → accepted → replied. NULL = not on
  -- the LinkedIn route. Advanced by the /api/webhooks/aimfox receiver.
  linkedin_status     TEXT
                        CHECK (linkedin_status IN ('queued', 'requested', 'accepted', 'replied')),

  -- Free-form labels. 'linkedin-only' = email failed verification but the
  -- lead has a LinkedIn URL, so it skips email drafting and is reachable via
  -- the Aimfox path only (score >= 70).
  tags                TEXT[] NOT NULL DEFAULT '{}',

  -- HeyGen personalized video (leads scoring >= 85 only). 'pending' from the
  -- moment the video is requested; the hourly heygenPoller job flips it to
  -- 'completed' (with heygen_video_url set) or 'failed'. sendSequenceEmail
  -- holds Instantly enrollment while 'pending' and heygen_requested_at is
  -- under the 15-minute timeout, then sends without the video past it.
  heygen_video_id     TEXT,
  heygen_video_status TEXT
                        CHECK (heygen_video_status IN ('pending', 'completed', 'failed')),
  heygen_video_url    TEXT,
  heygen_requested_at TIMESTAMPTZ,

  -- Free-text operator notes (first writer: reply-assist's auto-reply
  -- extraction — named colleague / return date from an OOO).
  notes               TEXT,

  -- Marks the CURRENT inbound reply as triaged, independent of `status` —
  -- booking/rejecting already change status away from 'replied', but
  -- categories like wrong_person/pricing/send_info have no terminal status
  -- of their own, so this is how they leave the Dashboard's Needs Attention
  -- count. Reset to NULL whenever a fresh reply event comes in.
  reply_handled_at    TIMESTAMPTZ,

  -- Re-engagement
  re_engage_after     TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- SCORES
-- Claude's scoring output per lead
-- ============================================
CREATE TABLE IF NOT EXISTS scores (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,

  score           INTEGER CHECK (score BETWEEN 0 AND 100),
  segment         TEXT CHECK (segment IN ('fleet', 'broker', 'underwriter', 'unknown')),
  reasoning       TEXT,
  recommendation  TEXT CHECK (recommendation IN ('pursue', 'deprioritise', 'discard')),
  data_quality    TEXT CHECK (data_quality IN ('high', 'medium', 'low')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- EMAILS
-- Claude's drafted emails per lead
-- ============================================
CREATE TABLE IF NOT EXISTS emails (
  id                SERIAL PRIMARY KEY,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE CASCADE,

  -- Email content
  subject           TEXT,
  body              TEXT,
  email_number      INTEGER DEFAULT 1, -- 1, 2, or 3 in sequence

  -- Approval
  approval_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (approval_status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,

  -- Sending
  sent_at           TIMESTAMPTZ,
  instantly_id      TEXT, -- reference ID from Instantly

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER emails_set_updated_at
  BEFORE UPDATE ON emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- SEQUENCES
-- Tracks which email in the sequence each lead is on
-- Email 1: day 0, Email 2: day 2, Email 3: day 6
-- ============================================
CREATE TABLE IF NOT EXISTS sequences (
  id                SERIAL PRIMARY KEY,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  email_id          INTEGER REFERENCES emails(id) ON DELETE CASCADE,

  email_number      INTEGER NOT NULL, -- 1, 2, or 3
  scheduled_at      TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'sent', 'skipped', 'cancelled')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- EVENTS
-- Webhook events from Instantly
-- Tracks replies, bounces, unsubscribes, meetings
-- ============================================
CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,

  event_type    TEXT NOT NULL,
  -- reply, bounce, unsubscribe, meeting_booked, open, click

  payload       JSONB, -- raw webhook payload from Instantly
  processed     BOOLEAN DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- REPLY ASSISTS
-- Claude's classification + suggested response for each real inbound reply
-- (email via Instantly webhook, LinkedIn via Aimfox webhook). Drafts are for
-- human review — never auto-sent.
-- ============================================
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
  referral_name       TEXT,
  referral_draft      TEXT,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reply_assists_lead ON reply_assists(lead_id, created_at DESC);

-- ============================================
-- KNOWLEDGE BASE
-- Safely product docs, case studies, value props
-- Claude reads this before scoring and drafting
-- ============================================
CREATE TABLE IF NOT EXISTS knowledge_base (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT,
  -- product, case_study, value_prop, pain_point, competitor

  vertical    TEXT,
  -- fleet, broker, underwriter, general

  active      BOOLEAN DEFAULT true,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER knowledge_base_set_updated_at
  BEFORE UPDATE ON knowledge_base
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- BLACKLIST
-- Do not contact list — by email, domain, or LinkedIn
-- ============================================
CREATE TABLE IF NOT EXISTS blacklist (
  id            SERIAL PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('email', 'domain', 'linkedin')),
  value         TEXT NOT NULL,
  reason        TEXT,
  -- existing_customer, unsubscribed, competitor, manual

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint — no duplicate blacklist entries
CREATE UNIQUE INDEX IF NOT EXISTS blacklist_type_value
  ON blacklist(type, value);

-- ============================================
-- USERS
-- Simple internal auth — no roles, no self-registration. Password changes go
-- through `npm run user:set-password` (bcrypt), never a reset-flow endpoint.
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed users. Replace with your own before running: generate a bcrypt hash
-- with `npm run user:set-password`, or insert a placeholder and set the
-- password afterwards.
INSERT INTO users (email, password_hash, name) VALUES
  ('admin@example.com', '<bcrypt-hash>', 'Admin User')
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- SETTINGS
-- Generic key/value store for app settings. Currently backs the manually-
-- maintained demo stats shown on the Dashboard summary card (emails sent,
-- open rate, replies, meetings booked).
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- Seed the configurable pre-score lead filters (JSON arrays of bad-fit
-- keywords, editable from the Settings page). processLead deprioritises
-- matching leads before scoring, without spending a Claude call.
INSERT INTO settings (key, value) VALUES
  ('filter_company_keywords',
   '["marine","shipping","yacht","vessel","maritime","logistics","courier","haulage","freight","trucking","taxi","chauffeur","removals"]'),
  ('filter_title_keywords',
   '["marine","vessel","shipping","warehouse"]')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- USEFUL INDEXES
-- Speed up the most common queries
-- ============================================

-- Find leads by campaign and status
CREATE INDEX IF NOT EXISTS leads_campaign_status
  ON leads(campaign_id, status);

-- Find leads by email for webhook matching
CREATE INDEX IF NOT EXISTS leads_email
  ON leads(contact_email);

-- Find leads by domain for blacklist checking
CREATE INDEX IF NOT EXISTS leads_domain
  ON leads(company_domain);

-- Find unprocessed events
CREATE INDEX IF NOT EXISTS events_unprocessed
  ON events(processed) WHERE processed = false;

-- Find active knowledge base entries by vertical
CREATE INDEX IF NOT EXISTS knowledge_base_vertical
  ON knowledge_base(vertical, active);

-- ============================================
-- ROW-LEVEL SECURITY
-- Supabase's default anon/authenticated roles otherwise get full table
-- access via the public REST API, completely bypassing this app's own
-- session auth. Safe for THIS app specifically because the backend
-- connects via DATABASE_URL as the `postgres` role, which has
-- rolbypassrls = true — it bypasses RLS regardless of policies. No
-- policies are written on purpose: there is no legitimate anon/
-- authenticated use case (no Supabase Auth, no client-side Supabase
-- calls anywhere in this codebase), so "RLS enabled, zero policies"
-- correctly means default-deny for every non-bypassing role. See
-- migration 021 for the full rationale.
-- ============================================

ALTER TABLE blacklist      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails         ENABLE ROW LEVEL SECURITY;
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_assists  ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences      ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON blacklist      FROM anon, authenticated;
REVOKE ALL ON campaigns      FROM anon, authenticated;
REVOKE ALL ON emails         FROM anon, authenticated;
REVOKE ALL ON events         FROM anon, authenticated;
REVOKE ALL ON knowledge_base FROM anon, authenticated;
REVOKE ALL ON leads          FROM anon, authenticated;
REVOKE ALL ON process_runs   FROM anon, authenticated;
REVOKE ALL ON reply_assists  FROM anon, authenticated;
REVOKE ALL ON scores         FROM anon, authenticated;
REVOKE ALL ON sequences      FROM anon, authenticated;
REVOKE ALL ON settings       FROM anon, authenticated;
REVOKE ALL ON users          FROM anon, authenticated;
