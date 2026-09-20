// Requeue invalid-email rejections that have a LinkedIn URL through the
// linkedin-only path.
//
// Finds leads that were deprioritised purely for a failed email verification
// (status 'deprioritised', email_verification 'invalid', never scored) and
// still have a contact_linkedin, then: clears the dead address, tags them
// 'linkedin-only', and resets status to 'new' so the hourly leadProcessor
// scores them under its normal caps — leads scoring 70+ get the Aimfox route.
// No Anthropic or Aimfox calls happen here; the pipeline does that later.
//
// Idempotent: requeued leads leave the 'deprioritised' status, so a second
// run finds nothing. Run AFTER deploying the linkedin-only pipeline change —
// under the old code these leads would be drafted with no address instead.
//
// Usage:
//   npm run rescue:linkedin-only            # last 7 days
//   node src/scripts/rescueLinkedinOnly.js --days 14
//   node src/scripts/rescueLinkedinOnly.js --dry-run

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../config/db');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const days = Math.max(1, Number(argValue('--days', 7)) || 7);
  const dryRun = process.argv.includes('--dry-run');

  const { rows: candidates } = await db.query(
    `SELECT l.id, l.campaign_id, l.company_name, l.contact_title, l.contact_email,
            l.contact_linkedin
     FROM leads l
     WHERE l.status = 'deprioritised'
       AND l.email_verification = 'invalid'
       AND l.contact_linkedin IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.lead_id = l.id)
       AND l.updated_at >= now() - make_interval(days => $1::int)
     ORDER BY l.id`,
    [days]
  );

  console.log(
    `[rescue] ${candidates.length} invalid-email rejection(s) with a LinkedIn URL ` +
      `in the last ${days} day(s)${dryRun ? ' (dry run — no writes)' : ''}`
  );

  for (const lead of candidates) {
    console.log(
      `  #${lead.id} ${lead.company_name} — ${lead.contact_title ?? 'no title'} ` +
        `(campaign ${lead.campaign_id ?? 'none'}) ${lead.contact_linkedin}`
    );
  }

  if (dryRun || candidates.length === 0) {
    process.exit(0);
  }

  const { rowCount } = await db.query(
    `UPDATE leads
     SET contact_email = NULL,
         status = 'new',
         tags = CASE WHEN 'linkedin-only' = ANY(tags) THEN tags
                     ELSE array_append(tags, 'linkedin-only') END
     WHERE id = ANY($1::int[])`,
    [candidates.map((l) => l.id)]
  );

  console.log(
    `[rescue] requeued ${rowCount} lead(s) as 'new' (tagged linkedin-only, email cleared) — ` +
      'the hourly leadProcessor will score them; 70+ with a LinkedIn URL goes to Aimfox'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[rescue] failed:', err.message);
  process.exit(1);
});
