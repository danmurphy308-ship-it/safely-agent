const express = require('express');
const db = require('../config/db');
const { sendEmail } = require('../integrations/instantly');
const { checkExistingCustomer } = require('../services/customerCheck');
const { runDueSequences } = require('../jobs/sequenceRunner');
const { fetchExportableEmails, recordsToCsv } = require('../services/emailExport');

const router = express.Router();

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

// GET /api/emails — list emails, optionally filtered by approval_status and/or
// campaign_id (the email's lead's campaign).
router.get('/', async (req, res, next) => {
  try {
    const { approval_status, campaign_id } = req.query;

    if (approval_status !== undefined && !APPROVAL_STATUSES.includes(approval_status)) {
      return res.status(400).json({
        error: `\`approval_status\` must be one of ${APPROVAL_STATUSES.join(', ')}`,
      });
    }

    if (campaign_id !== undefined && !Number.isInteger(Number(campaign_id))) {
      return res.status(400).json({ error: '`campaign_id` must be an integer' });
    }

    // Join the lead (for company + contact details) and its most recent score
    // (for score + data quality) so the UI can show them in one list.
    const base = `
      SELECT e.*,
             l.company_name AS lead_company_name,
             l.contact_name AS lead_contact_name,
             l.contact_email AS lead_contact_email,
             l.status AS lead_status,
             s.score AS score,
             s.data_quality AS data_quality
      FROM emails e
      LEFT JOIN leads l ON l.id = e.lead_id
      LEFT JOIN LATERAL (
        SELECT score, data_quality
        FROM scores
        WHERE lead_id = e.lead_id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON true`;

    const conditions = [];
    const params = [];
    if (approval_status !== undefined) {
      params.push(approval_status);
      conditions.push(`e.approval_status = $${params.length}`);
    }
    if (campaign_id !== undefined) {
      params.push(Number(campaign_id));
      conditions.push(`l.campaign_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(`${base} ${where} ORDER BY e.created_at DESC`, params);

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/emails/export — download approved-but-unsent emails that have a
// verified recipient address as a CSV (first_name, last_name, email, company,
// subject, body). Same filter and format as the export:emails script.
router.get('/export', async (req, res, next) => {
  try {
    const records = await fetchExportableEmails();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="emails-ready-to-send.csv"');
    res.send(recordsToCsv(records));
  } catch (err) {
    next(err);
  }
});

// POST /api/emails/approve-all — bulk-approve every pending first email
// (email_number = 1) in one shot. Approval only: the hourly sequence runner
// sends approved, due emails via Instantly (when INSTANTLY_API_KEY is set), so
// this stays a fast single UPDATE rather than a long synchronous send loop.
router.post('/approve-all', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE emails
       SET approval_status = 'approved', approved_at = now(), rejected_reason = NULL
       WHERE approval_status = 'pending' AND email_number = 1
       RETURNING id`
    );

    // Send the just-approved (and any other due) emails now instead of waiting
    // for the hourly tick. Approval is already committed, so a runner failure
    // must not fail the request — log it and still report the approved count.
    // Size the batch to the number approved so they all go in one trigger, but
    // cap at 50 to keep the request from timing out; the runner sweeps the rest.
    let sent = null;
    try {
      const maxBatch = Math.min(rows.length, 50);
      const summary = await runDueSequences({ maxBatch });
      sent = summary.sent;
    } catch (err) {
      console.error('[emails approve-all] immediate send run failed:', err.message);
    }

    res.json({ approved: rows.length, sent });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/emails/:id/approve — approve an email draft. If INSTANTLY_API_KEY
// is configured, the approved email is immediately sent via Instantly: the lead
// is added to the campaign, the email is marked sent, and the lead advances to
// 'sent'. A send failure does NOT undo the approval — it's reported on the
// response as `send_error` so the operator can retry.
router.patch('/:id/approve', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE emails
       SET approval_status = 'approved', approved_at = now(), rejected_reason = NULL
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    let email = rows[0];

    // Auto-send via Instantly only when an API key is configured.
    if (process.env.INSTANTLY_API_KEY) {
      try {
        const { rows: leadRows } = await db.query(
          'SELECT * FROM leads WHERE id = $1',
          [email.lead_id]
        );
        if (leadRows.length === 0) {
          throw new Error(`lead ${email.lead_id} not found for email ${email.id}`);
        }

        // Never email existing Safely customers (Critical Rule). A HubSpot hit
        // cancels the email; a HubSpot error blocks the send (fail closed) and
        // is surfaced as send_error so the operator can retry.
        const { existing, reason } = await checkExistingCustomer(leadRows[0]);
        if (existing) {
          await db.query(
            `UPDATE emails SET approval_status = 'cancelled' WHERE id = $1`,
            [email.id]
          );
          await db.query(
            `UPDATE sequences SET status = 'cancelled' WHERE lead_id = $1 AND status = 'scheduled'`,
            [email.lead_id]
          );
          return res.json({
            ...email,
            approval_status: 'cancelled',
            sent: false,
            send_error: `blocked: lead is an existing HubSpot relationship (${reason})`,
          });
        }

        const result = await sendEmail(leadRows[0], email);

        // Record the send on the email and advance the lead to 'sent'.
        const { rows: updated } = await db.query(
          `UPDATE emails
           SET sent_at = now(), instantly_id = $2
           WHERE id = $1
           RETURNING *`,
          [email.id, result.instantlyId]
        );
        email = updated[0];
        // Keep the sequence row in step with the send.
        await db.query(
          `UPDATE sequences SET status = 'sent', sent_at = now() WHERE email_id = $1`,
          [email.id]
        );
        await db.query(`UPDATE leads SET status = 'sent' WHERE id = $1`, [email.lead_id]);

        return res.json({ ...email, sent: true });
      } catch (err) {
        // Approval already committed; surface the send failure without a 500.
        console.error('[emails approve] Instantly send failed:', err.message);
        return res.json({ ...email, sent: false, send_error: err.message });
      }
    }

    res.json(email);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/emails/:id/reject — reject an email draft
router.patch('/:id/reject', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) ?? null;

    const { rows } = await db.query(
      `UPDATE emails
       SET approval_status = 'rejected', rejected_reason = $2, approved_at = NULL
       WHERE id = $1
       RETURNING *`,
      [req.params.id, reason]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/emails/no-contact-email — cleanup: delete every email whose
// associated lead has no contact_email (those can never be sent). FK cascades
// remove each deleted email's sequence rows. Returns the number deleted.
router.delete('/no-contact-email', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM emails e
       USING leads l
       WHERE e.lead_id = l.id
         AND l.contact_email IS NULL`
    );
    res.json({ deleted: rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
