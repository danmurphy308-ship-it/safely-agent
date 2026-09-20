const express = require('express');
const db = require('../config/db');

const router = express.Router();

// Statuses that mean "don't put this lead on a call sheet" — already replied
// (or past that: booked), already triaged as not interested, or opted out.
// Kept as an explicit list (rather than an allowlist of "active" statuses) so
// it reads the same way the request was phrased: exclude already-replied and
// not-interested leads.
const EXCLUDED_STATUSES = ['replied', 'booked', 'not_interested', 'rejected', 'unsubscribed'];

// GET /api/call-list — prioritised cold-calling sheet: leads ranked by score
// descending, each with its latest score reasoning, for reps to work down.
//
// Excludes, unconditionally:
//   - existing Safely/Transpoco customers — normally these never reach `leads`
//     at all (checkExistingCustomer blocks the save), but a HubSpot-outage
//     fail-open or a manually-added lead could slip through, so this also
//     cross-checks the blacklist table (existing_customer/active_deal) by
//     domain or email as a second gate.
//   - leads already replied/booked/not_interested/rejected/unsubscribed
//     (EXCLUDED_STATUSES) — the point of this list is leads not yet worked.
//   - leads with no score yet — nothing to rank them by.
//
// Optional filters: campaign_id, min_score (score threshold, inclusive).
router.get('/', async (req, res, next) => {
  try {
    const { campaign_id, min_score } = req.query;

    const params = [];
    const conditions = [];

    if (campaign_id !== undefined) {
      params.push(campaign_id);
      conditions.push(`l.campaign_id = $${params.length}`);
    }
    if (min_score !== undefined) {
      const threshold = Number(min_score);
      if (!Number.isFinite(threshold)) {
        return res.status(400).json({ error: '`min_score` must be a number' });
      }
      params.push(threshold);
      conditions.push(`s.score >= $${params.length}`);
    }

    params.push(EXCLUDED_STATUSES);
    conditions.push(`l.status <> ALL($${params.length}::text[])`);

    // Second existing-customer gate (see comment above) — belongs in the
    // WHERE clause alongside the rest, not bolted on afterwards.
    conditions.push('bd.value IS NULL');
    conditions.push('be.value IS NULL');

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await db.query(
      `SELECT
         l.id,
         l.company_name,
         l.contact_name,
         l.contact_title,
         l.contact_email,
         l.contact_linkedin,
         l.country,
         l.status,
         l.campaign_id,
         c.name AS campaign_name,
         s.score,
         s.reasoning
       FROM leads l
       -- INNER: a lead with no score row yet has nothing to rank it by, so it
       -- drops out of the call list rather than sorting to one end.
       JOIN LATERAL (
         SELECT score, reasoning
         FROM scores
         WHERE lead_id = l.id
         ORDER BY created_at DESC
         LIMIT 1
       ) s ON true
       LEFT JOIN campaigns c ON c.id = l.campaign_id
       LEFT JOIN blacklist bd
         ON bd.type = 'domain' AND bd.value = l.company_domain
         AND bd.reason IN ('existing_customer', 'active_deal')
       LEFT JOIN blacklist be
         ON be.type = 'email' AND be.value = l.contact_email
         AND be.reason IN ('existing_customer', 'active_deal')
       ${where}
       ORDER BY s.score DESC, l.created_at ASC`,
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
