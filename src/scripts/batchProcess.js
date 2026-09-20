// Batch-process new leads for a campaign through the scoring → drafting pipeline.
//
// Fetches leads with status 'new' for a campaign and runs each through
// processLead (Claude scoring + email drafting), ONE AT A TIME with a delay
// between leads to respect API rate limits.
//
// Safety Rules (see CLAUDE.md): processLead calls the Anthropic API, so leads
// are processed sequentially with a >=500ms gap, and the batch SIZE is capped
// at BATCH_SIZE (10). Two modes:
//   - default: process at most BATCH_SIZE (10) leads in a single run.
//   - --all:   process EVERY 'new' lead, in successive batches of BATCH_SIZE,
//              with a longer pause between batches. Still 500ms per lead.
//
// Usage:
//   node src/scripts/batchProcess.js <campaign_id> [limit]
//   node src/scripts/batchProcess.js <campaign_id> --all
//   npm run batch:process -- <campaign_id> [limit | --all]

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../config/db');
const { processLead } = require('../services/pipeline');

// Maximum batch size — the per-batch cap required by the Safety Rules.
const BATCH_SIZE = 10;
// Minimum gap between Anthropic API calls (one per lead).
const LEAD_DELAY_MS = 500;
// Longer pause between batches in --all mode, to ease sustained API load.
const BATCH_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Separate the --all flag from positional args so order doesn't matter.
  const rawArgs = process.argv.slice(2);
  const all = rawArgs.includes('--all');
  const positional = rawArgs.filter((a) => a !== '--all');
  const [campaignArg, limitArg] = positional;

  const campaignId = Number(campaignArg);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    console.error('Usage: node src/scripts/batchProcess.js <campaign_id> [limit | --all]');
    console.error(`Invalid campaign_id: ${campaignArg ?? '(missing)'} (must be a positive integer)`);
    process.exit(1);
  }

  if (all && limitArg !== undefined) {
    console.error('Pass either a limit or --all, not both.');
    process.exit(1);
  }

  // In default mode, fetch at most BATCH_SIZE leads. The limit arg is capped at
  // BATCH_SIZE. In --all mode there is no fetch limit — we page through all
  // 'new' leads in batches of BATCH_SIZE instead.
  let fetchLimit = BATCH_SIZE;
  if (!all && limitArg !== undefined) {
    const parsed = Number(limitArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`Invalid limit: ${limitArg} (must be a positive integer)`);
      process.exit(1);
    }
    fetchLimit = parsed;
    if (fetchLimit > BATCH_SIZE) {
      console.warn(
        `Requested limit ${fetchLimit} exceeds the batch-size cap; processing at most ${BATCH_SIZE} leads.`
      );
      fetchLimit = BATCH_SIZE;
    }
  }

  const { rows: leads } = await db.query(
    all
      ? `SELECT * FROM leads
         WHERE campaign_id = $1 AND status = 'new'
         ORDER BY id`
      : `SELECT * FROM leads
         WHERE campaign_id = $1 AND status = 'new'
         ORDER BY id
         LIMIT $2`,
    all ? [campaignId] : [campaignId, fetchLimit]
  );

  if (leads.length === 0) {
    console.log(`No 'new' leads found for campaign ${campaignId}. Nothing to do.`);
    await db.pool.end();
    return;
  }

  const totalBatches = Math.ceil(leads.length / BATCH_SIZE);
  console.log(
    `Processing ${leads.length} 'new' lead(s) for campaign ${campaignId} ` +
      `in ${totalBatches} batch(es) of up to ${BATCH_SIZE}` +
      `${all ? ' (--all)' : ''}\n`
  );

  const summary = {};
  let processed = 0;

  for (let start = 0; start < leads.length; start += BATCH_SIZE) {
    const batchNumber = Math.floor(start / BATCH_SIZE) + 1;
    const batch = leads.slice(start, start + BATCH_SIZE);

    // Longer pause between batches (not before the first).
    if (start > 0) await sleep(BATCH_DELAY_MS);

    console.log(`Batch ${batchNumber}/${totalBatches} — ${batch.length} lead(s):`);

    for (let i = 0; i < batch.length; i++) {
      const lead = batch[i];
      // Keep every API call >=500ms apart, including across batch boundaries
      // (the batch pause already covers the first lead of later batches).
      if (i > 0) await sleep(LEAD_DELAY_MS);

      const label = `lead #${lead.id} (${lead.company_name})`;
      try {
        const result = await processLead(lead);
        summary[result.outcome] = (summary[result.outcome] || 0) + 1;
        const scoreNote = result.score != null ? ` score=${result.score}` : '';
        console.log(`  ${label} → ${result.outcome}${scoreNote}`);
      } catch (err) {
        summary.error = (summary.error || 0) + 1;
        console.error(`  ${label} → ERROR: ${err.message}`);
      }
      processed += 1;
    }

    console.log(`  Progress: ${processed}/${leads.length} processed\n`);
  }

  console.log('Batch complete:');
  for (const [outcome, count] of Object.entries(summary)) {
    console.log(`  ${outcome}: ${count}`);
  }

  await db.pool.end();
}

main().catch(async (err) => {
  console.error('\nBatch processing failed:', err.message);
  try {
    await db.pool.end();
  } catch (_) {
    // ignore pool shutdown errors during failure path
  }
  process.exit(1);
});
