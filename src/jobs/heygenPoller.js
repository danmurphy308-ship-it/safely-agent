const db = require('../config/db');
const { getVideoStatus, HOLD_TIMEOUT_MS } = require('../integrations/heygen');
const { sendSequenceEmail } = require('../services/pipeline');
const { recordProcessRun } = require('../services/processRuns');

// Polls HeyGen for leads with a video still 'pending', on a much shorter
// interval than the hourly jobs — the 15-minute hold in sendSequenceEmail
// needs finer-grained checking than an hourly tick would give it.
const POLL_INTERVAL_MS = 2 * 60 * 1000;

// Batch-processing defaults (Safety Rules: batch functions cap their size,
// default 10) with a politeness delay between HeyGen calls.
const DEFAULT_MAX_BATCH = 10;
const DEFAULT_DELAY_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Prevent overlapping runs if a previous run is still in flight when the timer fires again.
let running = false;

/**
 * Check render status for up to `maxBatch` leads with heygen_video_status =
 * 'pending', update the lead row on completion/failure, then re-attempt
 * sendSequenceEmail for that lead's still-unsent email 1 — its own gate
 * decides whether to actually send now (video ready, failed, or 15-minute
 * timeout elapsed) or keep holding.
 *
 * @param {object} [options]
 * @param {number} [options.maxBatch=10]
 * @param {number} [options.delayMs=300]
 * @returns {Promise<{found:number, completed:number, failed:number,
 *   still_pending:number, sent:number, awaiting_video:number, errors:number}>}
 */
async function runHeygenPoll({ maxBatch = DEFAULT_MAX_BATCH, delayMs = DEFAULT_DELAY_MS } = {}) {
  const { rows: leads } = await db.query(
    `SELECT id, heygen_video_id, heygen_requested_at
     FROM leads
     WHERE heygen_video_status = 'pending' AND heygen_video_id IS NOT NULL
     ORDER BY heygen_requested_at ASC
     LIMIT $1`,
    [maxBatch]
  );

  const summary = {
    found: leads.length,
    completed: 0,
    failed: 0,
    still_pending: 0,
    sent: 0,
    awaiting_video: 0,
    errors: 0,
  };

  for (let i = 0; i < leads.length; i++) {
    if (i > 0) await sleep(delayMs);
    const lead = leads[i];

    try {
      const { status, videoUrl } = await getVideoStatus(lead.heygen_video_id);

      if (status === 'completed') {
        await db.query(
          `UPDATE leads SET heygen_video_status = 'completed', heygen_video_url = $2 WHERE id = $1`,
          [lead.id, videoUrl]
        );
        summary.completed += 1;
      } else if (status === 'failed') {
        await db.query(`UPDATE leads SET heygen_video_status = 'failed' WHERE id = $1`, [lead.id]);
        summary.failed += 1;
      } else {
        const elapsedMs = Date.now() - new Date(lead.heygen_requested_at).getTime();
        summary.still_pending += 1;
        if (elapsedMs < HOLD_TIMEOUT_MS) {
          // Not ready and not timed out — nothing to retry yet.
          continue;
        }
        console.log(`[heygenPoller] lead ${lead.id} video hold timed out (15 min) — sending without it`);
      }

      // Video is completed, failed, or timed out — retry the held send. A
      // lead with no still-pending email 1 (already sent, or never enrolled
      // for some other reason) has nothing to retry.
      const { rows: emailRows } = await db.query(
        `SELECT id FROM emails
         WHERE lead_id = $1 AND email_number = 1 AND sent_at IS NULL AND approval_status = 'approved'
         LIMIT 1`,
        [lead.id]
      );
      if (emailRows.length === 0) continue;

      const result = await sendSequenceEmail(emailRows[0].id);
      if (result.outcome === 'sent') summary.sent += 1;
      else if (result.outcome === 'awaiting_video') summary.awaiting_video += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[heygenPoller] lead ${lead.id} poll/send failed:`, err.message);
    }
  }

  return summary;
}

/**
 * Run once now, guarding against overlapping invocations. Logs a one-line
 * summary. Swallows errors so a failed run never crashes the server.
 */
async function tick() {
  if (running) {
    console.warn('[heygenPoller] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    const summary = await runHeygenPoll();
    if (summary.found > 0) {
      console.log(
        `[heygenPoller] checked ${summary.found} pending video(s): ` +
          `${summary.completed} completed, ${summary.failed} failed, ` +
          `${summary.sent} sent, ${summary.errors} error(s)`
      );
      await recordProcessRun('heygen_poller', null, {
        found: summary.found,
        sent: summary.sent,
        errors: summary.errors,
      });
    } else {
      // Idle heartbeat — no process_runs row (that ledger is for actual
      // work), but this line is what tells "ran, found nothing pending"
      // apart from "tick stopped firing entirely" in the logs.
      console.log('[heygenPoller] tick complete — no pending videos found');
    }
  } catch (err) {
    console.error('[heygenPoller] run failed:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Start the HeyGen video poller. Returns the interval handle so callers can
 * clear it if needed (e.g. in tests).
 *
 * @param {number} [intervalMs=120000] - Poll interval; defaults to 2 minutes.
 * @returns {NodeJS.Timeout}
 */
function startHeygenPoller(intervalMs = POLL_INTERVAL_MS) {
  console.log(`[heygenPoller] starting — polling every ${Math.round(intervalMs / 1000)}s`);
  return setInterval(tick, intervalMs);
}

module.exports = { runHeygenPoll, startHeygenPoller };
