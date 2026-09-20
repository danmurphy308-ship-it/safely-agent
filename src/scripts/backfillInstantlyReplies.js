// One-off backfill: the Instantly reply webhook only covered campaign 8 from
// 2026-06-24 until today (2026-07-23), and campaigns 10/21/24/26 had no
// webhook at all — see the reply-picture audit that found this. Every real
// inbound email across all active campaigns' whole history is pulled directly
// from Instantly's GET /emails?email_type=received and replayed through the
// exact same logic POST /api/webhooks/instantly runs live: match the lead by
// email, log an `events` row, advance status to 'replied' (unless terminal),
// cancel pending follow-ups, classify via reply-assist, and persist the
// suggested draft — so historical replies show up on the Replies page like
// they would have all along.
//
// Deliberately DOES NOT call notifyReply for any backfilled item — these are
// historical (some over a month old); paging the team about them now as if
// they just landed would be noise, not signal. Everything else matches the
// live path exactly.
//
// Idempotent: each Instantly message id is checked against events.payload->>
// 'id' before processing, so a second run only picks up anything new since
// the last one (harmless to re-run after the webhook fix goes live).
//
// Usage:
//   npm run backfill:instantly-replies              # apply
//   node src/scripts/backfillInstantlyReplies.js --dry-run

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const axios = require('axios');
const db = require('../config/db');
const { cancelPendingEmails } = require('../services/pipeline');
const { classifyReply } = require('../services/replyAssist');

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';
const PAGE_DELAY_MS = 3200; // Instantly's own limit is 20 requests/minute.
const CLASSIFY_DELAY_MS = 300; // matches the project's "space out API calls" convention.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAllReceived(apiKey, instantlyCampaignId) {
  const all = [];
  let cursor;
  for (;;) {
    const { data } = await axios.get(`${INSTANTLY_API_BASE}/emails`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: {
        campaign_id: instantlyCampaignId,
        email_type: 'received',
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      },
    });
    all.push(...(data?.items ?? []));
    cursor = data?.next_starting_after;
    if (!cursor) break;
    await delay(PAGE_DELAY_MS);
  }
  return all;
}

function replyTextFrom(item) {
  return item.body?.text || item.body?.html || item.content_preview || null;
}

async function alreadyProcessed(messageId) {
  const { rows } = await db.query(`SELECT 1 FROM events WHERE payload->>'id' = $1 LIMIT 1`, [
    messageId,
  ]);
  return rows.length > 0;
}

async function processItem(item, campaign, { dryRun }) {
  const email = item.lead;
  if (!email) return { outcome: 'no_email' };

  if (await alreadyProcessed(item.id)) {
    return { outcome: 'already_backfilled' };
  }

  const { rows: leadRows } = await db.query(
    `SELECT id, contact_name, company_name, contact_title, industry, country, status
     FROM leads WHERE contact_email = $1 ORDER BY id LIMIT 1`,
    [email]
  );
  const lead = leadRows[0] ?? null;

  if (!lead) {
    console.log(`  [no-match] ${email} (campaign ${campaign.name}) — no lead with this email in our DB`);
    if (!dryRun) {
      await db.query(`INSERT INTO events (lead_id, event_type, payload) VALUES (NULL, $1, $2)`, [
        'reply_received',
        { ...item, _backfilled: true, _backfilled_at: new Date().toISOString() },
      ]);
    }
    return { outcome: 'no_lead_match' };
  }

  if (dryRun) {
    console.log(
      `  [would-process] lead #${lead.id} ${lead.contact_name ?? '?'} @ ${lead.company_name} ` +
        `(campaign ${campaign.name}, status='${lead.status}') — "${(item.subject || '').slice(0, 60)}"`
    );
    return { outcome: 'dry_run' };
  }

  const previousStatus = lead.status;

  const { rows: eventRows } = await db.query(
    `INSERT INTO events (lead_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id`,
    [lead.id, 'reply_received', { ...item, _backfilled: true, _backfilled_at: new Date().toISOString() }]
  );
  const eventId = eventRows[0]?.id ?? null;

  const { rowCount: statusChanged } = await db.query(
    `UPDATE leads SET status = 'replied'
     WHERE id = $1 AND status NOT IN ('replied', 'booked', 'unsubscribed')`,
    [lead.id]
  );
  const cancelledEmails = statusChanged > 0 ? await cancelPendingEmails(lead.id) : 0;

  const replyText = replyTextFrom(item);
  let category = null;
  if (replyText) {
    try {
      const [{ rows: scoreRows }, { rows: stepRows }] = await Promise.all([
        db.query('SELECT reasoning FROM scores WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1', [
          lead.id,
        ]),
        db.query(
          'SELECT MAX(email_number)::int AS step FROM emails WHERE lead_id = $1 AND sent_at IS NOT NULL',
          [lead.id]
        ),
      ]);

      const assist = await classifyReply({
        replyText,
        replySubject: item.subject || null,
        channel: 'email',
        lead,
        scoreReasoning: scoreRows[0]?.reasoning ?? null,
        emailStep: stepRows[0]?.step ?? null,
      });
      category = assist.category;

      await db.query(
        `INSERT INTO reply_assists
           (event_id, lead_id, channel, category, reply_text, suggested_response,
            referral_name, referral_draft, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          lead.id,
          'email',
          assist.category,
          replyText,
          assist.suggested_response,
          assist.referral_name,
          assist.referral_draft,
          assist.note,
        ]
      );

      if (assist.category === 'not_interested') {
        await db.query(
          `UPDATE leads SET status = 'not_interested'
           WHERE id = $1 AND status NOT IN ('booked', 'unsubscribed', 'rejected')`,
          [lead.id]
        );
      }

      if (assist.category === 'auto_reply') {
        if (assist.note) {
          await db.query(
            `UPDATE leads SET notes = COALESCE(notes || E'\\n', '') || $2 WHERE id = $1`,
            [lead.id, `[auto-reply, backfilled ${new Date().toISOString().slice(0, 10)}] ${assist.note}`]
          );
        }
        await db.query(`UPDATE leads SET status = $2 WHERE id = $1 AND status = 'replied'`, [
          lead.id,
          previousStatus,
        ]);
      }
    } catch (err) {
      console.error(`  [classify-failed] lead ${lead.id}:`, err.message);
    }
    await delay(CLASSIFY_DELAY_MS);
  }

  console.log(
    `  [backfilled] lead #${lead.id} ${lead.contact_name ?? '?'} @ ${lead.company_name} ` +
      `(campaign ${campaign.name}) — category=${category ?? '(no reply text)'}, ` +
      `status ${previousStatus} -> ${statusChanged > 0 ? 'replied' : previousStatus}` +
      (cancelledEmails ? `, cancelled ${cancelledEmails} pending email(s)` : '') +
      ` — notification NOT sent (backfilled, historical)`
  );

  return { outcome: 'backfilled', category };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    console.error('backfillInstantlyReplies: INSTANTLY_API_KEY is not set');
    process.exit(1);
  }

  const { rows: campaigns } = await db.query(
    `SELECT id, name, instantly_campaign_id FROM campaigns
     WHERE status = 'active' AND instantly_campaign_id IS NOT NULL
     ORDER BY id`
  );

  const summary = { fetched: 0, backfilled: 0, alreadyBackfilled: 0, noLeadMatch: 0, byCategory: {} };

  for (const campaign of campaigns) {
    console.log(`\n=== ${campaign.name} (campaign ${campaign.id}) ===`);
    const items = await fetchAllReceived(apiKey, campaign.instantly_campaign_id);
    // Oldest first — process history in the order it actually happened.
    items.sort((a, b) => new Date(a.timestamp_email) - new Date(b.timestamp_email));
    console.log(`  ${items.length} historical received email(s)`);
    summary.fetched += items.length;

    for (const item of items) {
      const result = await processItem(item, campaign, { dryRun });
      if (result.outcome === 'backfilled') {
        summary.backfilled += 1;
        summary.byCategory[result.category] = (summary.byCategory[result.category] ?? 0) + 1;
      } else if (result.outcome === 'already_backfilled') {
        summary.alreadyBackfilled += 1;
      } else if (result.outcome === 'no_lead_match') {
        summary.noLeadMatch += 1;
      }
    }
    await delay(PAGE_DELAY_MS);
  }

  console.log(`\n=== Summary${dryRun ? ' (dry run — no writes)' : ''} ===`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-instantly-replies] failed:', err.message);
  process.exit(1);
});
