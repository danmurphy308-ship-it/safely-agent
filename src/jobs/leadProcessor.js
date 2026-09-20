const db = require('../config/db');
const { processCampaignLeads } = require('../services/pipeline');
const { recordProcessRun, getProcessedToday } = require('../services/processRuns');

// How often to look for new leads to process.
const HOURLY_MS = 60 * 60 * 1000;

// Hard cap on how many leads one run will process across ALL campaigns, to
// control Anthropic API costs (each processed lead is scored and possibly
// drafted). processCampaignLeads applies the per-call delay and batch guards.
const DEFAULT_MAX_LEADS = 60;

// Daily ceiling across ALL runs (hourly + manual), metered via the
// process_runs ledger — bounds Anthropic spend at roughly $3/day at current
// per-lead cost. Manual runs aren't blocked by this, but they consume the
// budget, so automation backs off when a human has already spent it.
const DAILY_MAX_LEADS = 200;

// Prevent overlapping runs if a previous run is still in flight when the timer
// fires again (a full run can take a while given the inter-call delays).
let running = false;

/**
 * Process up to `maxLeads` 'new' leads across all campaigns, oldest campaigns
 * first. The budget is shared: each campaign is given whatever remains, and we
 * stop as soon as the budget is exhausted. Delegates the actual scoring/
 * drafting and rate-limiting to processCampaignLeads so behaviour matches the
 * per-campaign route and CLI batch script.
 *
 * The run's budget is the smaller of `maxLeads` and what's left of the
 * DAILY_MAX_LEADS ledger (process_runs rows from today). Every campaign
 * processed gets a process_runs row; a run that finds no work writes a single
 * campaign-less heartbeat row so "running but idle" stays distinguishable
 * from "job died" in production.
 *
 * @param {object} [options]
 * @param {number} [options.maxLeads=60] - Max leads to process this run, total.
 * @returns {Promise<{campaigns:number, found:number, processed:number,
 *   scored:number, drafted:number, deprioritised:number, blacklisted:number,
 *   errors:number, dailyCapReached:boolean}>}
 */
async function runNewLeads({ maxLeads = DEFAULT_MAX_LEADS } = {}) {
  // ACTIVE campaigns that currently have 'new' leads waiting. Draft/paused
  // campaigns are skipped — activating a campaign is the on-switch for its
  // hourly scoring/drafting (the manual Process Leads action still works on
  // any campaign). Unassigned leads (campaign_id IS NULL) aren't handled here
  // — processCampaignLeads works per campaign — so they're excluded too.
  const { rows: campaigns } = await db.query(
    `SELECT l.campaign_id, COUNT(*) AS cnt
     FROM leads l
     JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.status = 'new' AND c.status = 'active'
     GROUP BY l.campaign_id
     ORDER BY l.campaign_id`
  );

  const summary = {
    campaigns: 0,
    found: 0,
    processed: 0,
    scored: 0,
    drafted: 0,
    deprioritised: 0,
    blacklisted: 0,
    sent: 0,
    errors: 0,
    dailyCapReached: false,
  };

  // Spend against the shared daily ledger: today's processed count across the
  // hourly processor and manual runs. At/over the cap, skip the whole run
  // (heartbeat still recorded so the tick stays visible).
  const usedToday = await getProcessedToday();
  const budget = Math.min(maxLeads, DAILY_MAX_LEADS - usedToday);
  if (budget <= 0) {
    summary.dailyCapReached = true;
    console.log(
      `[leadProcessor] daily cap reached (${usedToday}/${DAILY_MAX_LEADS} leads today) — skipping run`
    );
    await recordProcessRun('lead_processor', null, {});
    return summary;
  }

  let remaining = budget;
  for (const { campaign_id: campaignId } of campaigns) {
    if (remaining <= 0) break;

    try {
      const result = await processCampaignLeads(campaignId, { limit: remaining });
      summary.campaigns += 1;
      summary.found += result.found;
      summary.processed += result.processed;
      summary.scored += result.scored;
      summary.drafted += result.drafted;
      summary.deprioritised += result.deprioritised;
      summary.blacklisted += result.blacklisted;
      summary.sent += result.sent ?? 0;
      summary.errors += result.errors;
      // Spend the budget against leads actually picked up this run.
      remaining -= result.found;
      await recordProcessRun('lead_processor', campaignId, result);
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[leadProcessor] failed to process campaign ${campaignId}:`,
        err.message
      );
      await recordProcessRun('lead_processor', campaignId, { errors: 1 });
    }
  }

  // Idle tick: no campaign rows were written — leave a heartbeat so the
  // ledger (and anyone reading it) can tell "alive but idle" from "dead".
  if (summary.campaigns === 0 && summary.errors === 0) {
    await recordProcessRun('lead_processor', null, {});
  }

  return summary;
}

/**
 * Delete leads that were scored, fell below the fit threshold, and were
 * deprioritised by the pipeline — so they don't accumulate run after run. Only
 * touches leads whose *latest* score is below 50 AND whose status is
 * 'deprioritised' (scored-but-weak); 'new'/'pursued'/unscored leads are left
 * alone. FK cascades remove each deleted lead's scores, emails, and sequences.
 * Runs in a transaction and keeps each campaign's total_leads counter in sync,
 * mirroring the manual DELETE /api/campaigns/:id/low-scores endpoint.
 *
 * @returns {Promise<number>} how many leads were deleted
 */
async function deleteLowScoringLeads() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Latest score per lead via a correlated subquery (a plain join on scores
    // would match any historical score < 50, not the most recent one).
    const { rows: deleted } = await client.query(
      `DELETE FROM leads l
       WHERE l.status = 'deprioritised'
         AND (
           SELECT s.score
           FROM scores s
           WHERE s.lead_id = l.id
           ORDER BY s.created_at DESC
           LIMIT 1
         ) < 50
       RETURNING l.campaign_id`
    );

    // Decrement total_leads for each affected campaign so the counters don't drift.
    if (deleted.length > 0) {
      const perCampaign = new Map();
      for (const { campaign_id: campaignId } of deleted) {
        if (campaignId == null) continue;
        perCampaign.set(campaignId, (perCampaign.get(campaignId) || 0) + 1);
      }
      for (const [campaignId, count] of perCampaign) {
        await client.query(
          'UPDATE campaigns SET total_leads = GREATEST(0, total_leads - $1) WHERE id = $2',
          [count, campaignId]
        );
      }
    }

    await client.query('COMMIT');
    return deleted.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run once now, guarding against overlapping invocations. Logs a one-line
 * summary. Swallows errors so a failed run never crashes the server.
 */
async function tick() {
  if (running) {
    console.warn('[leadProcessor] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    const summary = await runNewLeads();
    if (summary.found > 0) {
      console.log(
        `[leadProcessor] processed ${summary.found} new lead(s) across ` +
          `${summary.campaigns} campaign(s): ${summary.drafted} drafted, ` +
          `${summary.deprioritised} deprioritised, ${summary.blacklisted} blacklisted, ` +
          `${summary.sent} sent to Instantly, ${summary.errors} error(s)`
      );
    }

    // Prune scored-and-deprioritised low-fit leads left by this (and prior) runs.
    const deleted = await deleteLowScoringLeads();
    if (deleted > 0) {
      console.log(`[leadProcessor] deleted ${deleted} deprioritised low-scoring lead(s)`);
    }
  } catch (err) {
    console.error('[leadProcessor] run failed:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Start the hourly new-lead processor. Returns the interval handle so callers
 * can clear it if needed (e.g. in tests).
 *
 * @param {number} [intervalMs=3600000] - Poll interval; defaults to one hour.
 * @returns {NodeJS.Timeout}
 */
function startLeadProcessor(intervalMs = HOURLY_MS) {
  console.log(`[leadProcessor] starting — polling every ${Math.round(intervalMs / 60000)} min`);
  return setInterval(tick, intervalMs);
}

module.exports = { runNewLeads, deleteLowScoringLeads, startLeadProcessor };
