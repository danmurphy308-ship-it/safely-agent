const express = require('express');
const db = require('../config/db');
const { mapClayRecordToLead } = require('../integrations/clay');
const { saveLeadIfNew, incrementCampaignLeads } = require('../pipeline/findLeads');
const { cancelPendingEmails } = require('../services/pipeline');
const { notifyReply } = require('../services/notifier');
const { classifyReply } = require('../services/replyAssist');

const router = express.Router();

// Pull the reply body text out of the shapes Instantly's reply webhooks use.
function extractReplyText(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.reply_text,
    body.reply_text_snippet,
    body.reply_snippet,
    body.text,
    body.email_body,
    typeof body.body === 'string' ? body.body : body.body?.text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Reply-assist tail: classify an inbound reply with Claude, persist the
 * suggestion, and send the team notification (with the draft inline). Runs
 * AFTER the webhook has responded — a Claude call must never make the sender
 * retry the delivery — so all failures are logged, never thrown. Sending
 * stays manual: this drafts, it does not respond to the prospect.
 *
 * The webhook handler marks the lead 'replied' synchronously (so the Replies
 * page reflects it immediately, without waiting on Claude) — but an
 * auto-reply (out-of-office, etc.) isn't a genuine human reply. Once
 * classification confirms that, this reverts the lead back to whatever it
 * was immediately before this event, so an auto-responder bounce can't leave
 * a lead permanently mismarked as 'replied'.
 *
 * @param {object} p
 * @param {number|null} p.eventId  - events row for this delivery.
 * @param {object} p.lead          - matched lead row.
 * @param {('email'|'linkedin')} p.channel
 * @param {string|null} p.replyText
 * @param {string|null} [p.replySubject]
 * @param {string|null} [p.previousStatus] - lead.status immediately before
 *   this event flipped it to 'replied'; null if it wasn't captured.
 */
async function runReplyAssist({
  eventId,
  lead,
  channel,
  replyText,
  replySubject = null,
  previousStatus = null,
}) {
  let assist = null;

  if (replyText) {
    try {
      const [{ rows: scoreRows }, { rows: stepRows }] = await Promise.all([
        db.query(
          'SELECT reasoning FROM scores WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
          [lead.id]
        ),
        db.query(
          'SELECT MAX(email_number)::int AS step FROM emails WHERE lead_id = $1 AND sent_at IS NOT NULL',
          [lead.id]
        ),
      ]);

      assist = await classifyReply({
        replyText,
        replySubject,
        channel,
        lead,
        scoreReasoning: scoreRows[0]?.reasoning ?? null,
        emailStep: stepRows[0]?.step ?? null,
      });

      await db.query(
        `INSERT INTO reply_assists
           (event_id, lead_id, channel, category, reply_text, suggested_response,
            referral_name, referral_draft, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          lead.id,
          channel,
          assist.category,
          replyText,
          assist.suggested_response,
          assist.referral_name,
          assist.referral_draft,
          assist.note,
        ]
      );

      if (assist.category === 'not_interested') {
        // Visible-but-marked: the human still sends the graceful close from
        // the Replies page, then triages it (which sets 'rejected' and hides it).
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
            [lead.id, `[auto-reply ${new Date().toISOString().slice(0, 10)}] ${assist.note}`]
          );
        }
        // Not a genuine human reply — revert the synchronous 'replied' flip.
        // Guarded to only revert if still 'replied' (untouched since), so a
        // real event that landed in between (or a manual triage) isn't clobbered.
        if (previousStatus) {
          await db.query(`UPDATE leads SET status = $2 WHERE id = $1 AND status = 'replied'`, [
            lead.id,
            previousStatus,
          ]);
        }
      }
    } catch (err) {
      console.error(`[reply-assist] classification for lead ${lead.id} failed:`, err.message);
      assist = null; // fall through to the plain notification
    }
  }

  // Auto-replies don't page a human; everything else notifies (with the draft
  // inline when classification succeeded, plain when it didn't).
  if (assist?.category === 'auto_reply') return;
  try {
    await notifyReply(lead, { channel, assist });
  } catch (err) {
    console.error(`[reply-assist] notification for lead ${lead.id} failed:`, err.message);
  }
}

// Pull the enriched records out of whatever envelope Clay posts. Accepts a bare
// array, a single record object, or { records: [...] } / { leads: [...] }.
function extractRecords(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.leads)) return body.leads;
  if (Array.isArray(body.data)) return body.data;
  return [body];
}

// POST /api/webhooks/clay — receive Clay-enriched records, map -> blacklist ->
// dedupe -> insert into `leads`. Asynchronous sourcing callback (see clay.js).
router.post('/clay', async (req, res, next) => {
  try {
    // Optional shared-secret check. If CLAY_WEBHOOK_SECRET is set, require it via
    // Authorization: Bearer <secret>; otherwise the endpoint is open.
    const secret = process.env.CLAY_WEBHOOK_SECRET;
    if (secret) {
      const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (provided !== secret) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const body = req.body || {};
    const records = extractRecords(body);

    // campaign_id attribution: per-record wins, else body-level, else query param.
    const bodyCampaignId = body.campaign_id ?? req.query.campaign_id ?? null;

    const summary = {
      received: records.length,
      inserted: 0,
      blacklisted: 0,
      duplicates: 0,
      missing_email: 0,
      skipped: 0,
      errors: 0,
    };
    const insertsByCampaign = new Map();

    for (const record of records) {
      const campaignId = record?.campaign_id ?? bodyCampaignId ?? null;
      const lead = mapClayRecordToLead(record);

      // Reject leads without a usable contact_email — an emailless lead can never
      // be drafted or sent, so saving it (with a null email) just clogs the pipeline.
      const email = typeof lead.contact_email === 'string' ? lead.contact_email.trim() : '';
      if (!email) {
        summary.missing_email += 1;
        console.warn(
          `[clay webhook] rejected lead without contact_email (company="${lead.company_name || 'unknown'}", campaign=${campaignId ?? 'none'})`
        );
        continue;
      }

      try {
        const { status } = await saveLeadIfNew(campaignId, lead);
        if (status === 'inserted') {
          summary.inserted += 1;
          if (campaignId != null) {
            insertsByCampaign.set(campaignId, (insertsByCampaign.get(campaignId) || 0) + 1);
          }
        } else if (status === 'blacklisted') summary.blacklisted += 1;
        else if (status === 'duplicate') summary.duplicates += 1;
        else summary.skipped += 1;
      } catch (err) {
        // Don't let one bad record fail the whole batch.
        summary.errors += 1;
        console.error('[clay webhook] failed to save record:', err.message);
      }
    }

    // Keep each campaign's lead counter in sync with inserts.
    for (const [campaignId, count] of insertsByCampaign) {
      await incrementCampaignLeads(campaignId, count);
    }

    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Pull the lead's email out of whatever shape Instantly posts.
function extractReplyEmail(body) {
  if (!body || typeof body !== 'object') return null;
  return (
    body.lead_email ||
    body.email ||
    body.lead?.email ||
    body.data?.lead_email ||
    body.data?.email ||
    null
  );
}

// POST /api/webhooks/instantly — receive Instantly event webhooks. On a reply
// event we advance the matching lead to 'replied' and log the raw event. Other
// event types are still logged (for later processing) but don't change status.
router.post('/instantly', async (req, res, next) => {
  try {
    // Optional shared-secret check, mirroring the Clay webhook. If
    // INSTANTLY_WEBHOOK_SECRET is set, require it via Authorization: Bearer.
    const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
    if (secret) {
      const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (provided !== secret) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const body = req.body || {};
    const eventType = body.event_type || body.type || body.event || 'unknown';
    const email = extractReplyEmail(body);

    // A reply is signalled by event types like "reply_received" / "email_reply".
    const isReply = /repl/i.test(String(eventType));

    // Find the matching lead by email so we can attribute the event and update
    // its status. Email may be missing on some event shapes.
    let lead = null;
    if (email) {
      const { rows } = await db.query(
        `SELECT id, contact_name, company_name, contact_title, industry, country, status
         FROM leads WHERE contact_email = $1 ORDER BY id LIMIT 1`,
        [email]
      );
      if (rows.length > 0) lead = rows[0];
    }
    const leadId = lead ? lead.id : null;
    // Captured BEFORE the reply flips status below — runReplyAssist reverts to
    // this if the reply turns out to be an auto-reply, not a genuine human one.
    const previousStatus = lead ? lead.status : null;

    let leadUpdated = false;
    let cancelledEmails = 0;
    if (isReply && leadId != null) {
      // Don't downgrade leads that are already further along (booked) or opted out.
      const { rowCount } = await db.query(
        `UPDATE leads
         SET status = 'replied'
         WHERE id = $1
           AND status NOT IN ('replied', 'booked', 'unsubscribed')`,
        [leadId]
      );
      leadUpdated = rowCount > 0;

      // A fresh reply un-triages the lead even if it was already 'replied' and
      // marked handled from a PRIOR reply (the status guard above wouldn't
      // touch it in that case) — always clear the handled marker here so the
      // new reply surfaces on the Replies page / Needs Attention.
      await db.query(`UPDATE leads SET reply_handled_at = NULL WHERE id = $1`, [leadId]);

      // The lead replied — stop the sequence: cancel any still-pending follow-ups.
      cancelledEmails = await cancelPendingEmails(leadId);
    }

    // Always log the raw event (lead_id may be null if we couldn't match it).
    const { rows: eventRows } = await db.query(
      `INSERT INTO events (lead_id, event_type, payload)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [leadId, eventType, body]
    );

    const assistQueued = isReply && lead != null;
    res.json({
      received: true,
      event_type: eventType,
      lead_id: leadId,
      lead_updated: leadUpdated,
      cancelled_emails: cancelledEmails,
      assist_queued: assistQueued,
    });

    // Reply-assist + team notification run after the response so Claude
    // latency never makes Instantly retry the delivery.
    if (assistQueued) {
      setImmediate(() =>
        runReplyAssist({
          eventId: eventRows[0]?.id ?? null,
          lead,
          channel: 'email',
          replyText: extractReplyText(body),
          replySubject: body.reply_subject || body.subject || null,
          previousStatus,
        })
      );
    }
  } catch (err) {
    next(err);
  }
});

// ── Aimfox (LinkedIn outreach) ──────────────────────────────────────────────
//
// Payloads: { id, event_type, event: {...}, workspace } (see docs.aimfox.com/
// webhooks). The lead's LinkedIn profile lives in a different sub-object per
// event type; its `public_identifier` is the /in/<slug> of the profile URL,
// which we match against leads.contact_linkedin.

// Which event sub-object carries the LEAD's profile for each event type.
const AIMFOX_PROFILE_FIELDS = {
  connect: 'target',
  accepted: 'target',
  new_connection: 'connected_profile',
  reply: 'target',
  inmail_reply: 'target',
  new_reply: 'sender',
  campaign_reply: 'sender',
};

// linkedin_status each event advances a lead to. Transitions are forward-only
// (see rank below) so an out-of-order delivery can't downgrade a lead.
const AIMFOX_STATUS_FOR_EVENT = {
  connect: 'requested',
  accepted: 'accepted',
  new_connection: 'accepted',
  reply: 'replied',
  inmail_reply: 'replied',
  new_reply: 'replied',
  campaign_reply: 'replied',
};

const LINKEDIN_STATUS_RANK = { queued: 1, requested: 2, accepted: 3, replied: 4 };

// POST /api/webhooks/aimfox — receive Aimfox event webhooks. Matches the
// profile to a lead by LinkedIn slug, advances linkedin_status, and on a reply
// also advances the lead to 'replied' (Replies page) + fires the same email
// notification as Instantly replies. Unmatched profiles are logged and
// ignored — new_connection/new_reply fire for the whole LinkedIn account, not
// just campaign targets.
router.post('/aimfox', async (req, res, next) => {
  try {
    // Optional shared-secret check, mirroring the other webhooks. Configure the
    // same value as the webhook's Authentication Header in Aimfox.
    const secret = process.env.AIMFOX_WEBHOOK_SECRET;
    if (secret) {
      const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (provided !== secret) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const body = req.body || {};
    const eventType = String(body.event_type || 'unknown');
    const profile = body.event?.[AIMFOX_PROFILE_FIELDS[eventType]] ?? null;
    const slug = typeof profile?.public_identifier === 'string' ? profile.public_identifier : null;

    // Match the lead by its LinkedIn URL slug. Anchor the end so a slug never
    // matches a longer one it prefixes (john-doe vs john-doe-2); escape regex
    // metacharacters since slugs may contain dots.
    let lead = null;
    if (slug && /^[A-Za-z0-9._%-]+$/.test(slug)) {
      const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const { rows } = await db.query(
        `SELECT id, contact_name, company_name, contact_title, industry, country,
                status, linkedin_status
         FROM leads
         WHERE contact_linkedin ~* ('/in/' || $1 || '([/?]|$)')
         ORDER BY id
         LIMIT 1`,
        [escaped]
      );
      if (rows.length > 0) lead = rows[0];
    }

    const newStatus = AIMFOX_STATUS_FOR_EVENT[eventType] ?? null;
    let linkedinUpdated = false;
    let leadUpdated = false;
    let cancelledEmails = 0;

    if (lead && newStatus) {
      // Forward-only: never downgrade (e.g. a late 'accepted' after 'replied').
      const currentRank = LINKEDIN_STATUS_RANK[lead.linkedin_status] ?? 0;
      if (LINKEDIN_STATUS_RANK[newStatus] > currentRank) {
        await db.query('UPDATE leads SET linkedin_status = $1 WHERE id = $2', [
          newStatus,
          lead.id,
        ]);
        linkedinUpdated = true;
      }

      if (newStatus === 'replied') {
        // Same handling as an Instantly reply: surface on the Replies page,
        // stop pending email follow-ups. The team alert (with the reply-assist
        // draft) is sent in the async tail below.
        const { rowCount } = await db.query(
          `UPDATE leads
           SET status = 'replied'
           WHERE id = $1
             AND status NOT IN ('replied', 'booked', 'unsubscribed')`,
          [lead.id]
        );
        leadUpdated = rowCount > 0;

        // See the matching comment in the Instantly handler above: always
        // clear the handled marker, even when the status guard above was a
        // no-op because the lead was already 'replied' but marked handled.
        await db.query(`UPDATE leads SET reply_handled_at = NULL WHERE id = $1`, [lead.id]);

        cancelledEmails = await cancelPendingEmails(lead.id);
      }
    }

    // Always log the raw event, matched or not (lead_id null when unmatched).
    const { rows: eventRows } = await db.query(
      `INSERT INTO events (lead_id, event_type, payload)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [lead?.id ?? null, `aimfox_${eventType}`, body]
    );

    const assistQueued = newStatus === 'replied' && lead != null;
    res.json({
      received: true,
      event_type: eventType,
      lead_id: lead?.id ?? null,
      linkedin_status: linkedinUpdated ? newStatus : (lead?.linkedin_status ?? null),
      lead_updated: leadUpdated,
      cancelled_emails: cancelledEmails,
      assist_queued: assistQueued,
    });

    if (assistQueued) {
      // Aimfox reply payloads carry the message in a few shapes; take the
      // first non-empty. Missing text falls back to a plain notification.
      const ev = body.event || {};
      const replyText =
        (typeof ev.message === 'object' ? ev.message?.body : ev.message) ||
        ev.text ||
        ev.reply ||
        null;
      setImmediate(() =>
        runReplyAssist({
          eventId: eventRows[0]?.id ?? null,
          lead,
          channel: 'linkedin',
          replyText: typeof replyText === 'string' && replyText.trim() ? replyText.trim() : null,
          // `lead` was fetched before the status update above and never
          // re-assigned in JS, so lead.status is still the pre-reply value.
          previousStatus: lead.status,
        })
      );
    }
  } catch (err) {
    next(err);
  }
});

// ── HeyReach (LinkedIn outreach) ────────────────────────────────────────────
//
// Payload shape NOT independently confirmed against a real delivery —
// HeyReach's webhook creation appears to be a web-UI-only feature (see
// heyreach.js's header comment for the full verify-first writeup), so no
// live payload has been observed yet. Field extraction below is deliberately
// defensive/multi-candidate, the same approach extractReplyEmail/
// extractReplyText above use for uncertain shapes, anchored on the field
// names HeyReach's own REST API uses elsewhere (`profileUrl`). Adjust once a
// real delivery lands — the raw payload is logged to `events` regardless of
// whether extraction succeeds, so the first real one is fully recoverable.
//
// We only act on two of HeyReach's ~12 event types; everything else is
// still logged (for later use) but doesn't change any lead state.
const HEYREACH_HANDLED_EVENTS = new Set(['CONNECTION_REQUEST_ACCEPTED', 'MESSAGE_REPLY_RECEIVED']);

// Pull whichever profileUrl-shaped field is present in an unknown envelope.
function extractHeyReachProfileUrl(body) {
  const candidates = [
    body?.lead?.profileUrl,
    body?.profileUrl,
    body?.data?.lead?.profileUrl,
    body?.data?.profileUrl,
    body?.linkedInProfileUrl,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

// Pull the reply text out of an unknown MESSAGE_REPLY_RECEIVED envelope —
// same defensive multi-candidate approach as extractReplyText above.
function extractHeyReachMessageText(body) {
  const candidates = [
    body?.message?.text,
    body?.message?.body,
    body?.messageText,
    body?.text,
    typeof body?.message === 'string' ? body.message : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

// Match a lead by LinkedIn profile URL — same slug-anchored approach as the
// Aimfox handler (contact_linkedin ~* '/in/' || slug || '([/?]|$)'), so
// trailing slashes/query params on either side don't break the match, and a
// slug never matches a longer one it prefixes.
async function findLeadByLinkedInUrl(profileUrl) {
  if (!profileUrl) return null;
  const match = profileUrl.match(/\/in\/([A-Za-z0-9._%-]+)/);
  const slug = match ? match[1] : null;
  if (!slug || !/^[A-Za-z0-9._%-]+$/.test(slug)) return null;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { rows } = await db.query(
    `SELECT id, contact_name, company_name, contact_title, industry, country,
            status, linkedin_status
     FROM leads
     WHERE contact_linkedin ~* ('/in/' || $1 || '([/?]|$)')
     ORDER BY id
     LIMIT 1`,
    [escaped]
  );
  return rows[0] ?? null;
}

// POST /api/webhooks/heyreach — receive HeyReach event webhooks. Matches the
// lead by LinkedIn profile URL; on CONNECTION_REQUEST_ACCEPTED advances
// linkedin_status (forward-only, same rank table as Aimfox); on
// MESSAGE_REPLY_RECEIVED advances the lead to 'replied' (Replies page),
// cancels pending email follow-ups, and runs the same reply-assist +
// auto_reply-revert tail as Instantly/Aimfox. Unmatched profiles are logged
// and ignored.
router.post('/heyreach', async (req, res, next) => {
  try {
    // Optional shared-secret check, mirroring the other webhooks. HeyReach's
    // actual outbound auth mechanism isn't confirmed (no real delivery seen
    // yet) — this assumes the same Authorization: Bearer convention as
    // Instantly/Aimfox/Clay until proven otherwise.
    const secret = process.env.HEYREACH_WEBHOOK_SECRET;
    if (secret) {
      const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (provided !== secret) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const body = req.body || {};
    const eventType = String(body.eventType || body.event_type || body.type || 'unknown');
    const profileUrl = extractHeyReachProfileUrl(body);
    const lead = await findLeadByLinkedInUrl(profileUrl);

    let linkedinUpdated = false;
    let leadUpdated = false;
    let cancelledEmails = 0;

    if (lead && eventType === 'CONNECTION_REQUEST_ACCEPTED') {
      const currentRank = LINKEDIN_STATUS_RANK[lead.linkedin_status] ?? 0;
      if (LINKEDIN_STATUS_RANK.accepted > currentRank) {
        await db.query('UPDATE leads SET linkedin_status = $1 WHERE id = $2', ['accepted', lead.id]);
        linkedinUpdated = true;
      }
    }

    if (lead && eventType === 'MESSAGE_REPLY_RECEIVED') {
      const currentRank = LINKEDIN_STATUS_RANK[lead.linkedin_status] ?? 0;
      if (LINKEDIN_STATUS_RANK.replied > currentRank) {
        await db.query('UPDATE leads SET linkedin_status = $1 WHERE id = $2', ['replied', lead.id]);
        linkedinUpdated = true;
      }

      // Same handling as an Instantly/Aimfox reply: surface on the Replies
      // page, stop pending email follow-ups. The team alert (with the
      // reply-assist draft) is sent in the async tail below.
      const { rowCount } = await db.query(
        `UPDATE leads
         SET status = 'replied'
         WHERE id = $1
           AND status NOT IN ('replied', 'booked', 'unsubscribed')`,
        [lead.id]
      );
      leadUpdated = rowCount > 0;

      // Always clear the handled marker, even when the status guard above
      // was a no-op because the lead was already 'replied' but marked
      // handled — see the matching comment in the Instantly handler above.
      await db.query(`UPDATE leads SET reply_handled_at = NULL WHERE id = $1`, [lead.id]);

      cancelledEmails = await cancelPendingEmails(lead.id);
    }

    // Always log the raw event, matched or not (lead_id null when unmatched)
    // — this is also the recovery path if extraction above turns out wrong
    // once a real delivery is observed.
    const { rows: eventRows } = await db.query(
      `INSERT INTO events (lead_id, event_type, payload)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [lead?.id ?? null, `heyreach_${eventType}`, body]
    );

    const assistQueued = eventType === 'MESSAGE_REPLY_RECEIVED' && lead != null;
    res.json({
      received: true,
      event_type: eventType,
      handled: HEYREACH_HANDLED_EVENTS.has(eventType),
      lead_id: lead?.id ?? null,
      linkedin_status_updated: linkedinUpdated,
      lead_updated: leadUpdated,
      cancelled_emails: cancelledEmails,
      assist_queued: assistQueued,
    });

    if (assistQueued) {
      setImmediate(() =>
        runReplyAssist({
          eventId: eventRows[0]?.id ?? null,
          lead,
          channel: 'linkedin',
          replyText: extractHeyReachMessageText(body),
          // `lead` was fetched before the status update above and never
          // re-assigned in JS, so lead.status is still the pre-reply value.
          previousStatus: lead.status,
        })
      );
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
