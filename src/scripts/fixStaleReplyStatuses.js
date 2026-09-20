// One-off audit + correction: find leads that have a genuine inbound reply
// event (Instantly or Aimfox) but whose status was never advanced to
// 'replied' — the same class of staleness earlier test events masked
// (they were inserted directly into `events`, bypassing the webhook route
// entirely, so the status-update code in webhooks.js never ran for them).
//
// A lead is "correctable" unless EVERY qualifying reply event for it was
// classified 'auto_reply' by reply-assist (an out-of-office bounce isn't a
// genuine reply and must not flip status — see runReplyAssist in
// webhooks.js). Leads already at 'replied'/'booked'/'unsubscribed'/
// 'not_interested'/'rejected' are left alone (either already correct, or
// intentionally further along / triaged).
//
// Idempotent: correcting a lead moves it to 'replied', so a second run finds
// nothing left to do for it.
//
// Usage:
//   npm run fix:stale-reply-status            # apply
//   node src/scripts/fixStaleReplyStatuses.js --dry-run

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../config/db');
const { cancelPendingEmails } = require('../services/pipeline');

const EXCLUDED_STATUSES = ['replied', 'booked', 'unsubscribed', 'not_interested', 'rejected'];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows: candidates } = await db.query(
    `WITH qualifying_events AS (
       SELECT e.id AS event_id, e.lead_id
       FROM events e
       WHERE (e.event_type ~* 'repl' AND e.event_type NOT ILIKE 'aimfox%')
          OR e.event_type IN ('aimfox_reply', 'aimfox_inmail_reply', 'aimfox_new_reply', 'aimfox_campaign_reply')
     ),
     lead_classification AS (
       SELECT qe.lead_id,
              COUNT(*)::int AS event_count,
              COUNT(*) FILTER (WHERE ra.category = 'auto_reply')::int AS auto_reply_count
       FROM qualifying_events qe
       LEFT JOIN reply_assists ra ON ra.event_id = qe.event_id
       GROUP BY qe.lead_id
     )
     SELECT l.id, l.status, l.company_name, l.contact_name, l.campaign_id,
            lc.event_count, lc.auto_reply_count
     FROM leads l
     JOIN lead_classification lc ON lc.lead_id = l.id
     WHERE l.status NOT IN (${EXCLUDED_STATUSES.map((_, i) => `$${i + 1}`).join(', ')})
     ORDER BY l.id`,
    EXCLUDED_STATUSES
  );

  const correctable = candidates.filter((c) => c.auto_reply_count < c.event_count);
  const autoOnly = candidates.filter((c) => c.auto_reply_count === c.event_count);

  console.log(
    `[fix-stale-reply] ${candidates.length} lead(s) with a reply event but a non-terminal ` +
      `status${dryRun ? ' (dry run — no writes)' : ''}`
  );

  if (autoOnly.length) {
    console.log(`  ${autoOnly.length} left alone (every reply event was auto_reply-classified):`);
    for (const c of autoOnly) {
      console.log(`    #${c.id} ${c.contact_name ?? '?'} @ ${c.company_name} — status stays '${c.status}'`);
    }
  }

  console.log(`  ${correctable.length} correctable to 'replied':`);
  for (const c of correctable) {
    console.log(
      `    #${c.id} ${c.contact_name ?? '?'} @ ${c.company_name} (campaign ${c.campaign_id ?? 'none'}) — was '${c.status}'`
    );
  }

  if (dryRun || correctable.length === 0) {
    process.exit(0);
  }

  const { rows: updated } = await db.query(
    `UPDATE leads
     SET status = 'replied'
     WHERE id = ANY($1::int[])
       AND status NOT IN (${EXCLUDED_STATUSES.map((_, i) => `$${i + 2}`).join(', ')})
     RETURNING id`,
    [correctable.map((c) => c.id), ...EXCLUDED_STATUSES]
  );

  let totalCancelled = 0;
  for (const row of updated) {
    totalCancelled += await cancelPendingEmails(row.id);
  }

  console.log(
    `[fix-stale-reply] corrected ${updated.length} lead(s) to 'replied' ` +
      `(${totalCancelled} pending follow-up email(s) cancelled)`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-stale-reply] failed:', err.message);
  process.exit(1);
});
