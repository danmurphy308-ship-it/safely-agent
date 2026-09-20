// One-off backfill: add a campaign's existing qualified leads to its Aimfox
// campaign audience. Qualified = latest score >= 70, has a contact_linkedin,
// and status drafted/approved/sent (i.e. leads the pipeline already judged
// strong, processed before the Aimfox step existed).
//
// Usage: npm run aimfox:backfill [-- <campaignId> [<maxLeads>]]
//        (default campaign 8, capped at the 100 highest-scoring leads)
//
// Rate-limited to ~50 requests/minute (Aimfox allows 60). Leads Aimfox
// declines with a known rejection code (alreadyConnected, locked, ...) are
// counted as rejected and the run continues — expected for profiles already
// uploaded to Aimfox by hand.

require('dotenv').config();
const db = require('../config/db');
const { addLeadToCampaign } = require('../integrations/aimfox');

// 1.2s between Aimfox calls keeps us at ~50 req/min, under the 60/min limit.
const DELAY_MS = 1200;

// Cap the run at the highest-scoring leads rather than every qualifier.
const DEFAULT_MAX_LEADS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const campaignId = Number(process.argv[2] ?? 8);
  const maxLeads = Number(process.argv[3] ?? DEFAULT_MAX_LEADS);
  if (
    !Number.isInteger(campaignId) || campaignId < 1 ||
    !Number.isInteger(maxLeads) || maxLeads < 1
  ) {
    console.error('Usage: npm run aimfox:backfill [-- <campaignId> [<maxLeads>]]');
    process.exit(1);
  }

  // Best first: rank qualifiers by their latest score and take the top slice.
  const { rows: leads } = await db.query(
    `SELECT l.*, latest.score AS latest_score
     FROM leads l
     JOIN LATERAL (
       SELECT s.score
       FROM scores s
       WHERE s.lead_id = l.id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE l.campaign_id = $1
       AND l.contact_linkedin IS NOT NULL
       AND l.contact_linkedin <> ''
       AND l.status IN ('drafted', 'approved', 'sent')
       AND latest.score >= 70
     ORDER BY latest.score DESC, l.id
     LIMIT $2`,
    [campaignId, maxLeads]
  );

  console.log(
    `[aimfox:backfill] campaign ${campaignId}: ${leads.length} leads to add ` +
      `(top ${maxLeads} by latest score, >= 70, has LinkedIn URL, status drafted/approved/sent)`
  );

  const counts = { added: 0, rejected: 0, skipped: 0, errors: 0 };
  const reasons = {}; // rejection/skip reason -> count

  for (let i = 0; i < leads.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const lead = leads[i];

    try {
      const result = await addLeadToCampaign(lead);
      counts[result.outcome === 'added' ? 'added' : result.outcome] += 1;
      if (result.reason) {
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      }
      console.log(
        `[aimfox:backfill] ${i + 1}/${leads.length} lead ${lead.id} ` +
          `(${lead.company_name}, score ${lead.latest_score}): ` +
          `${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`
      );

      // A skip for missing config applies to every lead — stop instead of
      // logging the same skip hundreds of times.
      if (
        result.outcome === 'skipped' &&
        /AIMFOX_API_KEY|no Aimfox campaign/.test(result.reason ?? '')
      ) {
        console.error(`[aimfox:backfill] aborting: ${result.reason}`);
        break;
      }
    } catch (err) {
      counts.errors += 1;
      console.error(`[aimfox:backfill] lead ${lead.id} failed: ${err.message}`);
    }
  }

  console.log('\n[aimfox:backfill] summary:', JSON.stringify(counts));
  if (Object.keys(reasons).length > 0) {
    console.log('[aimfox:backfill] reasons:', JSON.stringify(reasons));
  }

  await db.pool.end();
}

main().catch((err) => {
  console.error('[aimfox:backfill] fatal:', err);
  process.exit(1);
});
