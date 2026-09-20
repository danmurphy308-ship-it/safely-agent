-- Migration 017: allow the new heygenPoller job in the process_runs ledger
-- (see migration 011). Re-runnable.

ALTER TABLE process_runs DROP CONSTRAINT IF EXISTS process_runs_job_check;
ALTER TABLE process_runs ADD CONSTRAINT process_runs_job_check
  CHECK (job IN (
    'lead_processor', 'lead_replenisher', 'sequence_runner', 'manual_process',
    'heygen_poller'
  ));
