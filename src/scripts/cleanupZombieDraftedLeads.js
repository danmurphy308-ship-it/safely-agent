// One-off cleanup: leads stuck at status='drafted' with no contact_email —
// "zombies" from before commit 956ac61 (2026-07-16 10:49 BST), when
// processLead had no guard against drafting a lead with no usable email.
// The inline auto-send then threw inside sendSequenceEmail (sendEmail
// requires contact_email), and the next hourly sequenceRunner tick found the
// still-scheduled row, saw no contact_email, and permanently cancelled the
// email + sequence — but nothing ever moved the LEAD off 'drafted'. They've
// sat there since, still counted by leadReplenisher's pipeline-depth check
// as if they were live capacity, which is part of why auto-replenish looked
// like it had stopped working.
//
// Two outcomes, never a silent delete:
//   - Has a LinkedIn URL: rescued exactly like rescueLinkedinOnly.js — tagged
//     'linkedin-only' and reset to 'new' so the hourly leadProcessor re-scores
//     it under the current (fixed) code. A good lead may be in there.
//   - No LinkedIn URL either: closed out as 'deprioritised' — no channel left
//     to reach them, and that status is what actually excludes them from
//     PIPELINE_STATUSES going forward.
//
// Idempotent: both outcomes move the lead off 'drafted', so a second run
// finds nothing left to do.
//
// Usage:
//   npm run cleanup:zombie-drafts
//   node src/scripts/cleanupZombieDraftedLeads.js --dry-run

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../config/db');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows: zombies } = await db.query(
    `SELECT id, campaign_id, contact_name, company_name, contact_linkedin, tags
     FROM leads
     WHERE status = 'drafted' AND contact_email IS NULL
     ORDER BY id`
  );

  const toRescue = zombies.filter((l) => l.contact_linkedin);
  const toClose = zombies.filter((l) => !l.contact_linkedin);

  console.log(
    `[cleanup-zombies] ${zombies.length} zombie drafted lead(s) found` +
      `${dryRun ? ' (dry run — no writes)' : ''}: ` +
      `${toRescue.length} to rescue (has LinkedIn), ${toClose.length} to close out (no channel left)`
  );

  if (dryRun) {
    for (const l of toRescue) {
      console.log(`  RESCUE  #${l.id} ${l.contact_name ?? '?'} @ ${l.company_name} (campaign ${l.campaign_id ?? 'none'})`);
    }
    for (const l of toClose) {
      console.log(`  CLOSE   #${l.id} ${l.contact_name ?? '?'} @ ${l.company_name} (campaign ${l.campaign_id ?? 'none'})`);
    }
    process.exit(0);
  }

  let rescued = 0;
  if (toRescue.length) {
    const { rowCount } = await db.query(
      `UPDATE leads
       SET status = 'new',
           tags = CASE WHEN 'linkedin-only' = ANY(tags) THEN tags
                       ELSE array_append(tags, 'linkedin-only') END
       WHERE id = ANY($1::int[])`,
      [toRescue.map((l) => l.id)]
    );
    rescued = rowCount;
  }

  let closed = 0;
  if (toClose.length) {
    const { rowCount } = await db.query(
      `UPDATE leads SET status = 'deprioritised' WHERE id = ANY($1::int[])`,
      [toClose.map((l) => l.id)]
    );
    closed = rowCount;
  }

  console.log(
    `[cleanup-zombies] rescued ${rescued} lead(s) to 'new' (tagged linkedin-only — ` +
      `the hourly leadProcessor will re-score them; 70+ with LinkedIn goes to Aimfox), ` +
      `closed out ${closed} lead(s) as 'deprioritised' (no email, no LinkedIn)`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[cleanup-zombies] failed:', err.message);
  process.exit(1);
});
