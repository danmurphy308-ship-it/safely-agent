const db = require('../config/db');

// process_runs ledger — shared by the background jobs, the manual Process
// Leads route, and the Campaigns page "Last run" display. See migration 011.

/**
 * Record one run row. Never throws — a ledger write must not break the run it
 * describes (jobs swallow their own errors for the same reason).
 *
 * @param {('lead_processor'|'lead_replenisher'|'sequence_runner'|'manual_process')} job
 * @param {number|null} campaignId - Null for run-level rows (heartbeats, sequenceRunner).
 * @param {object} [counts] - Any of found/processed/drafted/deprioritised/sent/inserted/errors.
 */
async function recordProcessRun(job, campaignId, counts = {}) {
  try {
    await db.query(
      `INSERT INTO process_runs
         (job, campaign_id, found, processed, drafted, deprioritised, sent, inserted, errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        job,
        campaignId ?? null,
        counts.found ?? 0,
        counts.processed ?? 0,
        counts.drafted ?? 0,
        counts.deprioritised ?? 0,
        counts.sent ?? 0,
        counts.inserted ?? 0,
        counts.errors ?? 0,
      ]
    );
  } catch (err) {
    console.error(`[processRuns] failed to record ${job} run:`, err.message);
  }
}

/**
 * Leads processed (scored/drafted via the Anthropic API) so far today (UTC),
 * across the hourly processor and manual runs — the spend the daily cap
 * meters. Idle heartbeat rows carry processed=0, so they don't count.
 *
 * @returns {Promise<number>}
 */
async function getProcessedToday() {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(processed), 0) AS used
     FROM process_runs
     WHERE job IN ('lead_processor', 'manual_process')
       AND created_at >= date_trunc('day', now())`
  );
  return Number(rows[0].used);
}

/**
 * The most recent `limit` runs for every campaign, newest first, keyed by
 * campaign id — the Campaigns page "Last run" data. Campaign-less rows
 * (heartbeats, sequenceRunner) are excluded.
 *
 * @param {number} [limit=3]
 * @returns {Promise<Object<string, object[]>>}
 */
async function getLatestRunsPerCampaign(limit = 3) {
  const { rows } = await db.query(
    `SELECT campaign_id, job, found, processed, drafted, deprioritised, sent,
            inserted, errors, created_at
     FROM (
       SELECT pr.*,
              ROW_NUMBER() OVER (PARTITION BY pr.campaign_id ORDER BY pr.created_at DESC) AS rn
       FROM process_runs pr
       WHERE pr.campaign_id IS NOT NULL
     ) t
     WHERE rn <= $1
     ORDER BY campaign_id, created_at DESC`,
    [Math.min(10, Math.max(1, Number(limit) || 3))]
  );

  const byCampaign = {};
  for (const row of rows) {
    (byCampaign[row.campaign_id] ??= []).push(row);
  }
  return byCampaign;
}

module.exports = { recordProcessRun, getProcessedToday, getLatestRunsPerCampaign };
