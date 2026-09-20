const express = require('express');
const db = require('../config/db');
const { processLead, cancelPendingEmails } = require('../services/pipeline');
const { verifyEmailWithRetry } = require('../services/emailVerification');

const router = express.Router();

// Lead columns a client may set when adding a lead manually.
const INSERTABLE_FIELDS = [
  'campaign_id',
  'company_name',
  'contact_name',
  'contact_email',
  'contact_title',
  'contact_linkedin',
  'company_url',
  'company_domain',
  'industry',
  'fleet_size',
  'country',
  'employee_count',
];

// POST /api/leads — add a lead manually. This is the one insert path that
// doesn't go through src/pipeline/findLeads.js's saveLeadIfNew (no
// blacklist/dedupe check either — pre-existing behaviour, unchanged here),
// so email verification is hooked in separately, right after insert, to
// match every other lead source.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};

    if (!body.company_name || typeof body.company_name !== 'string') {
      return res.status(400).json({ error: '`company_name` is required' });
    }

    const columns = INSERTABLE_FIELDS.filter((f) => body[f] !== undefined);
    const values = columns.map((f) => body[f]);
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const { rows } = await db.query(
      `INSERT INTO leads (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );

    const lead = rows[0];
    if (lead.contact_email && process.env.INSTANTLY_API_KEY) {
      const result = await verifyEmailWithRetry(lead.contact_email, { leadId: lead.id });
      if (result !== null) {
        const verified = await db.query(
          `UPDATE leads SET email_verification = $2, email_verified_at = now()
           WHERE id = $1
           RETURNING email_verification, email_verified_at`,
          [lead.id, result]
        );
        lead.email_verification = verified.rows[0].email_verification;
        lead.email_verified_at = verified.rows[0].email_verified_at;
      }
    }

    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

// GET /api/leads — list leads, optionally filtered by campaign_id and/or status
router.get('/', async (req, res, next) => {
  try {
    const { campaign_id, status } = req.query;

    // Attach each lead's most recent score (scores live in a separate table).
    const base = `
      SELECT l.*, s.score AS score, s.data_quality AS data_quality
      FROM leads l
      LEFT JOIN LATERAL (
        SELECT score, data_quality
        FROM scores
        WHERE lead_id = l.id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON true`;

    // Build the WHERE clause from whichever filters were supplied.
    const conditions = [];
    const params = [];
    if (campaign_id !== undefined) {
      params.push(campaign_id);
      conditions.push(`l.campaign_id = $${params.length}`);
    }
    if (status !== undefined) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
      `${base}${where} ORDER BY l.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id — get a single lead
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/process — run the pipeline on a single lead
router.post('/:id/process', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const result = await processLead(rows[0]);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/mark-replied — manually mark a lead as replied. Use when a
// reply lands via Instantly or Gmail that the Instantly webhook didn't capture.
// Mirrors that webhook: advances the lead to 'replied' without downgrading leads
// already further along (booked) or opted out, and cancels pending follow-ups.
router.post('/:id/mark-replied', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE leads
       SET status = 'replied', reply_handled_at = NULL
       WHERE id = $1
         AND status NOT IN ('replied', 'booked', 'unsubscribed')
       RETURNING *`,
      [req.params.id]
    );

    // No row updated: either the lead is missing, or it's already in a state we
    // don't downgrade. Look it up to return a clear 404 vs the unchanged lead.
    if (rows.length === 0) {
      const { rows: existing } = await db.query('SELECT * FROM leads WHERE id = $1', [
        req.params.id,
      ]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Lead not found' });
      }
      return res.json({ ...existing[0], cancelled_emails: 0 });
    }

    // The lead replied — stop the sequence: cancel any still-pending follow-ups.
    const cancelledEmails = await cancelPendingEmails(rows[0].id);

    res.json({ ...rows[0], cancelled_emails: cancelledEmails });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/mark-booked — a replied lead booked a meeting. Advance it
// to 'booked', the terminal success state in the lifecycle.
router.post('/:id/mark-booked', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE leads
       SET status = 'booked', reply_handled_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/mark-not-interested — a replied lead isn't interested.
// Move it to 'rejected' so it drops out of the active pipeline.
router.post('/:id/mark-not-interested', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE leads
       SET status = 'rejected', reply_handled_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/mark-reply-handled — dismiss the current reply from the
// Replies page / Dashboard's Needs Attention without changing the lead's
// pipeline `status`. For reply categories with no terminal status of their
// own (wrong_person redirected, pricing answered, send_info sent, etc.) —
// booking or rejecting would misrepresent the outcome, but leaving `status`
// at 'replied' forever meant these piled up as "unhandled" with no way to
// clear them (2026-07-27 finding). Reset to NULL by the reply webhooks the
// next time this lead actually replies again.
router.post('/:id/mark-reply-handled', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE leads
       SET reply_handled_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
