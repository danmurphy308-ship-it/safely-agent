const db = require('../config/db');
const { sendSequenceEmail } = require('../services/pipeline');
const { recordProcessRun } = require('../services/processRuns');

// How often to poll for due sequence emails.
const HOURLY_MS = 60 * 60 * 1000;

// Bound how many due emails one run will process (Safety Rules: batch functions
// cap their size, default 10) and keep a gap between sends to be polite to the
// Instantly API. sendSequenceEmail applies the actual send guards.
const DEFAULT_MAX_BATCH = 10;
const DEFAULT_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Look up the contact email for the lead behind a given email row.
 *
 * @param {number} emailId
 * @returns {Promise<string|null>} the lead's contact_email, or null if the lead
 *   has none (or the email/lead can't be found).
 */
async function leadEmailFor(emailId) {
  const { rows } = await db.query(
    `SELECT l.contact_email
     FROM emails e JOIN leads l ON l.id = e.lead_id
     WHERE e.id = $1`,
    [emailId]
  );
  return rows[0]?.contact_email ?? null;
}

// Prevent overlapping runs if a previous run is still in flight when the timer
// fires again (e.g. a slow batch).
let running = false;

/**
 * Find due sequence steps (status 'scheduled', scheduled_at in the past) and
 * send each via sendSequenceEmail, which applies the sequence guards (cancels
 * if the lead replied/booked/unsubscribed/bounced, blocks follow-ups until
 * email 1 is sent). Processes at most `maxBatch` rows per run.
 *
 * @param {object} [options]
 * @param {number} [options.maxBatch=10] - Max due emails to process this run.
 * @param {number} [options.delayMs=500] - Gap between sends.
 * @returns {Promise<{found:number, sent:number, blocked:number, cancelled:number,
 *   already_sent:number, not_approved:number, no_api_key:number, errors:number}>}
 */
async function runDueSequences({ maxBatch = DEFAULT_MAX_BATCH, delayMs = DEFAULT_DELAY_MS } = {}) {
  // Claim due rows under a transaction with FOR UPDATE SKIP LOCKED so that when
  // multiple Fly instances poll at the same time, each grabs a DISJOINT set of
  // rows (a concurrent instance skips rows we've locked) — no double-sending.
  // We commit immediately after selecting (releasing the locks) and then send
  // outside the transaction: holding the locks during the sends would deadlock
  // against sendSequenceEmail, which updates these same sequence rows on a
  // separate pool connection. Sequential ticks stay safe because
  // sendSequenceEmail flips status to 'sent'/'cancelled' and is idempotent on
  // already-sent emails. Oldest-scheduled first so the cadence is respected.
  const client = await db.pool.connect();
  let rows;
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT id, email_id
       FROM sequences
       WHERE status = 'scheduled' AND scheduled_at <= now()
       ORDER BY scheduled_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [maxBatch]
    );
    rows = res.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const summary = {
    found: rows.length,
    sent: 0,
    blocked: 0,
    cancelled: 0,
    already_sent: 0,
    not_approved: 0,
    no_api_key: 0,
    errors: 0,
  };

  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(delayMs);

    // An email whose lead has no address can never be sent. Cancel it (and its
    // scheduled step) so it isn't claimed again — otherwise the skip would
    // re-log on every tick/boot. Cancelling drops it from future 'scheduled'
    // claims entirely.
    const contactEmail = await leadEmailFor(rows[i].email_id);
    if (!contactEmail) {
      await db.query(
        `UPDATE emails SET approval_status = 'cancelled' WHERE id = $1 AND sent_at IS NULL`,
        [rows[i].email_id]
      );
      await db.query(`UPDATE sequences SET status = 'cancelled' WHERE id = $1`, [rows[i].id]);
      summary.cancelled += 1;
      console.debug(
        `[sequenceRunner] cancelled email ${rows[i].email_id}: lead has no contact_email`
      );
      continue;
    }

    try {
      const result = await sendSequenceEmail(rows[i].email_id);
      if (result.outcome in summary) summary[result.outcome] += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[sequenceRunner] failed to send email ${rows[i].email_id}:`,
        err.message
      );
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
    console.warn('[sequenceRunner] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    const summary = await runDueSequences();
    if (summary.found > 0) {
      console.log(
        `[sequenceRunner] processed ${summary.found} due email(s): ` +
          `${summary.sent} sent, ${summary.cancelled} cancelled, ` +
          `${summary.blocked} blocked, ${summary.errors} error(s)`
      );
      // Run-level ledger row (sends span campaigns, so no campaign_id) —
      // makes automated sends visible alongside processor/replenisher runs.
      await recordProcessRun('sequence_runner', null, {
        found: summary.found,
        sent: summary.sent,
        errors: summary.errors,
      });
    } else {
      // Idle heartbeat — no process_runs row (that ledger is for actual
      // work), but this line is what tells "ran, found nothing due" apart
      // from "tick stopped firing entirely" in the logs.
      console.log('[sequenceRunner] tick complete — no due sequence emails found');
    }
  } catch (err) {
    console.error('[sequenceRunner] run failed:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Start the hourly sequence runner. Returns the interval handle so callers can
 * clear it if needed (e.g. in tests).
 *
 * @param {number} [intervalMs=3600000] - Poll interval; defaults to one hour.
 * @returns {NodeJS.Timeout}
 */
function startSequenceRunner(intervalMs = HOURLY_MS) {
  console.log(`[sequenceRunner] starting — polling every ${Math.round(intervalMs / 60000)} min`);
  return setInterval(tick, intervalMs);
}

module.exports = { runDueSequences, startSequenceRunner };
