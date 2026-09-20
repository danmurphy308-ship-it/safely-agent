// Re-verify sent/enrolled leads on a campaign whose email_verification was
// never checked, and remove any that come back 'invalid' from Instantly so
// they stop receiving the campaign's remaining follow-up steps.
//
// This backfills leads created before email verification shipped (2026-07-09,
// commit f04cc9c) — they'd already advanced past 'new' by then, so the
// pipeline's verify-before-sending gate never ran on them. That backlog is
// the root cause behind campaign 8 (UK Fleet Managers Targeted) tripping
// Instantly's bounce-protect auto-pause: 91% of its leads had never been
// verified, including 445 that were actually sent to.
//
// For each candidate:
//   1. Call Instantly's email-verification API and persist the result.
//   2. If 'invalid': DELETE the lead from Instantly (via emails.instantly_id,
//      the id captured when it was first sent) — this is what stops it
//      receiving Instantly's remaining sequence steps — and set the local
//      lead status to 'bounced'.
//   3. Anything else (verified/risky/catch_all/pending/unknown) is just
//      persisted; no other action.
//
// Per the project Safety Rules: paced batches (default 10), one lead at a
// time, minimum 100ms between API calls.
//
// Usage:
//   node src/scripts/reverifyCampaignBacklog.js               # campaign 8
//   node src/scripts/reverifyCampaignBacklog.js --campaign 10
//   node src/scripts/reverifyCampaignBacklog.js --batch-size 5 --delay-ms 500
//   node src/scripts/reverifyCampaignBacklog.js --dry-run       # verify + report only, no writes/removals

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../config/db');
const { verifyEmail, deleteLead } = require('../integrations/instantly');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const campaignId = Number(argValue('--campaign', 8));
  const batchSize = Math.max(1, Number(argValue('--batch-size', 10)) || 10);
  const delayMs = Math.max(100, Number(argValue('--delay-ms', 300)) || 300);
  const dryRun = process.argv.includes('--dry-run');

  const { rows: candidates } = await db.query(
    `SELECT l.id, l.contact_email, l.company_name,
            (SELECT e.instantly_id FROM emails e
             WHERE e.lead_id = l.id AND e.sent_at IS NOT NULL
             ORDER BY e.email_number ASC LIMIT 1) AS instantly_lead_id
     FROM leads l
     WHERE l.campaign_id = $1
       AND l.email_verification IS NULL
       AND l.contact_email IS NOT NULL
       AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.sent_at IS NOT NULL)
     ORDER BY l.id`,
    [campaignId]
  );

  console.log(
    `[reverify] campaign ${campaignId}: ${candidates.length} sent lead(s) never verified` +
      `${dryRun ? ' (dry run — verifying and reporting only, no writes/removals)' : ''}`
  );

  const summary = {
    checked: 0,
    verifyFailed: 0,
    verified: 0,
    risky: 0,
    catch_all: 0,
    pending: 0,
    unknown: 0,
    invalid: 0,
    removedFromInstantly: 0,
    removeFailed: 0,
    noInstantlyId: 0,
  };

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    console.log(`[reverify] batch ${i / batchSize + 1}/${Math.ceil(candidates.length / batchSize)} (${batch.length} leads)`);

    for (const lead of batch) {
      let result;
      try {
        result = await verifyEmail(lead.contact_email);
      } catch (err) {
        summary.verifyFailed += 1;
        console.error(`[reverify] lead ${lead.id} (${lead.contact_email}) verification failed:`, err.message);
        await sleep(delayMs);
        continue;
      }

      summary.checked += 1;
      summary[result] = (summary[result] ?? 0) + 1;

      if (!dryRun) {
        await db.query(
          `UPDATE leads SET email_verification = $2, email_verified_at = now() WHERE id = $1`,
          [lead.id, result]
        );
      }

      if (result === 'invalid') {
        console.log(`[reverify] lead ${lead.id} (${lead.company_name} <${lead.contact_email}>) INVALID`);
        if (!lead.instantly_lead_id) {
          summary.noInstantlyId += 1;
          console.warn('[reverify]   no Instantly lead id on record — cannot remove from Instantly');
        } else if (!dryRun) {
          try {
            await deleteLead(lead.instantly_lead_id);
            summary.removedFromInstantly += 1;
            console.log(`[reverify]   removed from Instantly (lead ${lead.instantly_lead_id})`);
          } catch (err) {
            summary.removeFailed += 1;
            console.error('[reverify]   FAILED to remove from Instantly:', err.message);
          }
        }

        if (!dryRun) {
          await db.query(
            `UPDATE leads SET status = 'bounced'
             WHERE id = $1 AND status NOT IN ('replied', 'booked', 'unsubscribed')`,
            [lead.id]
          );
        }
      }

      await sleep(delayMs);
    }
  }

  console.log('\n[reverify] summary:', JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[reverify] failed:', err.message);
  process.exit(1);
});
