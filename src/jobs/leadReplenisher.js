const db = require('../config/db');
const { findLeadsForCampaign } = require('../pipeline/findLeads');
const { recordProcessRun } = require('../services/processRuns');

// How often to check campaigns for a low pipeline.
const HOURLY_MS = 60 * 60 * 1000;

// Cap on Apollo pages one top-up may consume (each page's enrichment spends
// credits on every has_email preview, so keep the walk bounded).
const REPLENISH_MAX_PAGES = 4;

// A campaign is only topped up once per cooldown window, whatever the hourly
// tick finds — this is the daily credit-spend cap per campaign. Also applies
// when a top-up inserts nothing (ICP exhausted), so we don't burn a search on
// the same empty ICP every hour.
const COOLDOWN_HOURS = 24;

// Lead statuses that count as "still in the funnel, not yet sent" on the
// EMAIL channel. When a campaign has fewer than replenish_threshold of
// these, it needs more leads. Two exclusions keep this to leads that can
// still become an actual email send (see depthQuery below):
//   - 'scored' + tagged linkedin-only: routed to Aimfox already — that's a
//     LinkedIn send pending, not an email one. 'new' leads keep counting
//     even when linkedin-only-tagged (a rescued lead is genuinely pending
//     work until it's scored and the channel is decided).
//   - no contact_email AND no contact_linkedin: unreachable on any channel —
//     this is exactly the "zombie" shape a pre-2026-07-16 bug produced (see
//     cleanupZombieDraftedLeads.js); excluding it here stops history from
//     quietly repeating even though the drafting-time guard is now fixed.
const PIPELINE_STATUSES = ['new', 'enriched', 'scored', 'drafted'];

// Prevent overlapping runs (an Apollo search + enrichment takes a while).
let running = false;

/**
 * Top up every eligible campaign whose unsent pipeline has run low.
 *
 * Eligible = status 'active', auto_replenish on, and not topped up within the
 * last COOLDOWN_HOURS. For each, count leads still pending on the EMAIL
 * channel (new/enriched/scored/drafted, minus linkedin-only leads already
 * routed to Aimfox and leads unreachable on any channel — see
 * PIPELINE_STATUSES above); if below the campaign's replenish_threshold, run
 * one findLeadsForCampaign (Apollo search + enrich + blacklist/HubSpot/
 * dedupe + insert) and stamp last_replenished_at — even on a zero-insert
 * result, so an exhausted ICP isn't re-searched every hour.
 *
 * Requires APOLLO_API_KEY; the whole run is a no-op without it.
 *
 * @returns {Promise<{eligible:number, checked:number, topped_up:number,
 *   inserted:number, errors:number}>}
 */
async function replenishCampaigns() {
  const summary = { eligible: 0, checked: 0, topped_up: 0, inserted: 0, errors: 0 };

  if (!process.env.APOLLO_API_KEY) return summary;

  const { rows: campaigns } = await db.query(
    `SELECT id, name, replenish_threshold
     FROM campaigns
     WHERE status = 'active'
       AND auto_replenish = true
       AND (last_replenished_at IS NULL
            OR last_replenished_at < now() - ($1 || ' hours')::interval)
     ORDER BY last_replenished_at ASC NULLS FIRST`,
    [COOLDOWN_HOURS]
  );
  summary.eligible = campaigns.length;

  for (const campaign of campaigns) {
    summary.checked += 1;
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM leads
         WHERE campaign_id = $1 AND status = ANY($2)
           AND NOT (status = 'scored' AND 'linkedin-only' = ANY(tags))
           AND NOT (contact_email IS NULL AND contact_linkedin IS NULL)`,
        [campaign.id, PIPELINE_STATUSES]
      );
      const depth = Number(rows[0].cnt);
      if (depth >= campaign.replenish_threshold) continue;

      console.log(
        `[leadReplenisher] campaign ${campaign.id} (${campaign.name}) has ${depth}/` +
          `${campaign.replenish_threshold} pipeline leads — topping up from Apollo`
      );

      // Top up TO the threshold: findLeadsForCampaign walks Apollo pages
      // (resuming from the campaign's apollo_page cursor) until the shortfall
      // is inserted or the page cap is hit. saveLeadIfNew applies blacklist +
      // HubSpot + dedupe, so only genuinely new, contactable leads land.
      const result = await findLeadsForCampaign(campaign.id, {
        target: campaign.replenish_threshold - depth,
        maxPages: REPLENISH_MAX_PAGES,
      });
      summary.topped_up += 1;
      summary.inserted += result.inserted;

      console.log(
        `[leadReplenisher] campaign ${campaign.id}: fetched ${result.pages} page(s), ` +
          `found ${result.found}, inserted ${result.inserted} ` +
          `(${result.duplicates} duplicate, ${result.blacklisted} blacklisted)` +
          (result.exhausted ? ' — ICP exhausted' : '')
      );
      await recordProcessRun('lead_replenisher', campaign.id, {
        found: result.found,
        inserted: result.inserted,
      });
    } catch (err) {
      summary.errors += 1;
      console.error(`[leadReplenisher] campaign ${campaign.id} top-up failed:`, err.message);
      await recordProcessRun('lead_replenisher', campaign.id, { errors: 1 });
    } finally {
      // Stamp the attempt regardless of outcome — the cooldown is the credit
      // cap, and it must hold even when the search errors or inserts nothing.
      await db
        .query('UPDATE campaigns SET last_replenished_at = now() WHERE id = $1', [campaign.id])
        .catch((err) =>
          console.error(`[leadReplenisher] failed to stamp campaign ${campaign.id}:`, err.message)
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
    console.warn('[leadReplenisher] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    const summary = await replenishCampaigns();
    if (summary.topped_up > 0 || summary.errors > 0) {
      console.log(
        `[leadReplenisher] topped up ${summary.topped_up} campaign(s): ` +
          `${summary.inserted} new lead(s), ${summary.errors} error(s)`
      );
    }
  } catch (err) {
    console.error('[leadReplenisher] run failed:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Start the hourly replenisher. Returns the interval handle so callers can
 * clear it if needed (e.g. in tests).
 *
 * @param {number} [intervalMs=3600000] - Poll interval; defaults to one hour.
 * @returns {NodeJS.Timeout}
 */
function startLeadReplenisher(intervalMs = HOURLY_MS) {
  console.log(
    `[leadReplenisher] starting — polling every ${Math.round(intervalMs / 60000)} min`
  );
  return setInterval(tick, intervalMs);
}

module.exports = { replenishCampaigns, startLeadReplenisher };
