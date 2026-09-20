-- Ledger of automated (and manual) pipeline runs, one row per campaign per
-- run. Written by the hourly leadProcessor (job 'lead_processor'; plus a
-- campaign-less heartbeat row on idle ticks so "running but idle" is
-- distinguishable from "dead"), the hourly leadReplenisher
-- ('lead_replenisher'), the hourly sequenceRunner ('sequence_runner',
-- campaign-less), and the manual Process Leads action ('manual_process').
--
-- Doubles as the daily spend ledger: the leadProcessor's 200-leads/day cap is
-- computed as SUM(processed) over today's lead_processor + manual_process rows.
-- The Campaigns page "Last run" display reads from here (GET
-- /api/campaigns/process-runs) instead of browser localStorage.
CREATE TABLE IF NOT EXISTS process_runs (
  id            SERIAL PRIMARY KEY,
  job           TEXT NOT NULL CHECK (job IN (
                  'lead_processor', 'lead_replenisher', 'sequence_runner', 'manual_process'
                )),
  campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  found         INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0,
  drafted       INTEGER NOT NULL DEFAULT 0,
  deprioritised INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  inserted      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS process_runs_campaign_created_idx
  ON process_runs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS process_runs_job_created_idx
  ON process_runs (job, created_at DESC);
