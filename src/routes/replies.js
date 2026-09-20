const express = require('express');
const db = require('../config/db');

const router = express.Router();

// Lead statuses that represent a reply still awaiting a human decision.
// 'not_interested' stays visible so the human can send the graceful close
// before triaging it (mark-not-interested -> 'rejected', which then hides it).
const OPEN_REPLY_STATUSES = ['replied', 'not_interested'];

// GET /api/replies — replies awaiting triage, read the same way as the
// Dashboard's "Needs attention" panel (leads.status + reply_handled_at), not
// a live Instantly fetch. The old Instantly-based version only ever queried
// the single campaign in INSTANTLY_CAMPAIGN_ID (silently missing every other
// campaign's replies) and dropped rows whose subject matched an "automatic
// reply:" heuristic — which also matches genuine wrong_person auto-forward
// bounces ("no longer with the company, contact X instead"), not just real
// out-of-office noise. leads.status is already the authoritative signal: a
// webhook-classified true auto_reply reverts the lead off 'replied' before
// this table is ever touched (see webhooks.js runReplyAssist), so nothing
// extra needs filtering here (2026-07-27 finding — 3 wrong_person replies
// visible on the Dashboard never appeared on this page).
//
// `reply_handled_at IS NULL` is what makes a reply leave this list once
// actioned — booking/rejecting also moves `status` off 'replied'/
// 'not_interested', but categories like wrong_person/pricing/send_info have
// no terminal status of their own, so mark-reply-handled is the only thing
// that clears them.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT l.id AS lead_id, l.contact_email, l.company_name, l.updated_at,
              ra.channel, ra.category, ra.reply_text, ra.suggested_response,
              ra.referral_name, ra.referral_draft, ra.note AS assist_note,
              ra.created_at AS assist_created_at,
              ev.payload->>'subject' AS subject
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT event_id, channel, category, reply_text, suggested_response,
                referral_name, referral_draft, note, created_at
         FROM reply_assists
         WHERE lead_id = l.id
         ORDER BY created_at DESC
         LIMIT 1
       ) ra ON true
       LEFT JOIN events ev ON ev.id = ra.event_id
       WHERE l.status = ANY($1)
         AND l.reply_handled_at IS NULL
       ORDER BY COALESCE(ra.created_at, l.updated_at) DESC`,
      [OPEN_REPLY_STATUSES]
    );

    const mapped = rows.map((r) => ({
      id: r.lead_id,
      lead_id: r.lead_id,
      contact_email: r.contact_email,
      company_name: r.company_name,
      subject: r.subject,
      body: r.reply_text,
      timestamp: r.assist_created_at ?? r.updated_at,
      category: r.category,
      suggested_response: r.suggested_response,
      referral_name: r.referral_name,
      referral_draft: r.referral_draft,
      assist_note: r.assist_note,
    }));

    res.json(mapped);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
