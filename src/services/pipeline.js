const db = require('../config/db');
const { scoreLead } = require('./scorer');
const { draftEmail } = require('./drafter');
const { isBlacklisted } = require('./blacklist');
const { findBadFitMatch } = require('./filterRules');
const { checkExistingCustomer } = require('./customerCheck');
const { sendEmail } = require('../integrations/instantly');
const { verifyEmailWithRetry } = require('./emailVerification');
const { addLeadToCampaign } = require('../integrations/aimfox');
const heyreach = require('../integrations/heyreach');
const { generateVideoForLead, HOLD_TIMEOUT_MS } = require('../integrations/heygen');

// Leads scoring below this are deprioritised and not drafted.
const SCORE_THRESHOLD = 50;

// Leads scoring at or above this ALSO get LinkedIn outreach: added to the
// campaign's Aimfox campaign (no-op when AIMFOX_API_KEY is unset).
const AIMFOX_SCORE_THRESHOLD = 70;

// Same threshold, second LinkedIn channel: leads also get added to the
// HeyReach campaign (no-op when HEYREACH_API_KEY/HEYREACH_CAMPAIGN_ID is
// unset). Both can run for the same lead — they're independent tools, not
// alternatives, until a decision is made to consolidate.
const HEYREACH_SCORE_THRESHOLD = 70;

// Leads scoring at or above this ALSO get a HeyGen personalized video,
// requested at the same moment they'd otherwise be enrolled into Instantly
// (no-op when HEYGEN_API_KEY/HEYGEN_TEMPLATE_ID is unset).
const HEYGEN_SCORE_THRESHOLD = 85;

// Batch-processing defaults. Safety Rules: process one lead at a time with a
// >=500ms gap between Anthropic calls, and cap the batch SIZE (default 10).
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEAD_DELAY_MS = 500;

// The 3-email sequence: every qualified lead gets all three drafted up front.
const SEQUENCE_EMAIL_NUMBERS = [1, 2, 3];
// Send cadence relative to drafting: email 1 now, email 2 +2 days, email 3 +6 days.
const SEQUENCE_OFFSET_DAYS = { 1: 0, 2: 2, 3: 6 };
// If a lead reaches any of these, the remaining follow-ups must NOT be sent.
const TERMINAL_STATUSES = ['replied', 'booked', 'unsubscribed', 'bounced'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a single lead through the scoring → drafting pipeline.
 *
 * Order of operations:
 *   1. Blacklist check — if blacklisted, skip (no writes) and return.
 *   2. Bad-fit keyword filter (Settings → Lead Filters) — a company-name or
 *      title match deprioritises the lead WITHOUT calling Claude.
 *   3. Email verification (Instantly) — an invalid address deprioritises the
 *      lead WITHOUT calling Claude, UNLESS the lead has a contact_linkedin:
 *      then the dead address is cleared, the lead is tagged 'linkedin-only',
 *      and it continues to scoring for the Aimfox path. The verification
 *      result is cached on the lead row. Fails open: verification errors
 *      never block a lead.
 *   4. Score with Claude (scoreLead). Persist to `scores`.
 *   5. If score < 50, mark the lead deprioritised and return.
 *   6. If score >= 50, draft email 1, persist it to `emails` (auto-approved)
 *      with a matching `sequences` row, advance the lead to 'drafted', and
 *      send it to Instantly immediately when INSTANTLY_API_KEY is configured.
 *   7. If score >= 70 and the lead has a LinkedIn URL, add them to the
 *      campaign's Aimfox campaign too (no-op when AIMFOX_API_KEY is unset).
 *
 *
 * @param {object} lead - A lead row (must include `id`).
 * @param {object} [options]
 * @param {{subject?:string, body:string}|null} [options.previousEmail=null] - The
 *   previously drafted email in this campaign, forwarded to draftEmail so Claude
 *   can avoid repeating the same case study / CTA in consecutive emails.
 * @param {number} [options.delayMs=500] - Min gap between the Anthropic calls
 *   made within this lead (1 score + 3 drafts), per the Safety Rules.
 * @returns {Promise<{outcome:string, leadId:number, score?:number, status?:string,
 *   scoreId?:number, emailIds?:number[], reason?:string, draft?:object}>}
 */
async function processLead(lead, { previousEmail = null, delayMs = DEFAULT_LEAD_DELAY_MS } = {}) {
  if (!lead || typeof lead !== 'object' || lead.id == null) {
    throw new Error('processLead: `lead` must be an object with an `id`');
  }

  // 1. Blacklist — skip entirely if any identifier is on the do-not-contact list.
  const blacklisted = await isBlacklisted(
    lead.contact_email,
    lead.company_domain,
    lead.contact_linkedin
  );
  if (blacklisted) {
    return { outcome: 'blacklisted', leadId: lead.id, reason: 'blacklisted' };
  }

  // 2. Configurable bad-fit filter — obvious bad fits (per the keyword lists
  // in Settings → Lead Filters) are deprioritised without a Claude call. No
  // score row is written: there was no scoring.
  const badFit = await findBadFitMatch(lead);
  if (badFit) {
    await db.query(`UPDATE leads SET status = 'deprioritised' WHERE id = $1`, [lead.id]);
    const reason = `bad-fit filter: ${badFit.field} contains "${badFit.keyword}"`;
    console.log(`[pipeline] lead ${lead.id} (${lead.company_name}) deprioritised — ${reason}`);
    return {
      outcome: 'filtered',
      leadId: lead.id,
      status: 'deprioritised',
      reason,
    };
  }

  // 3. Verify the email address before spending Claude calls on it. Every
  // import path now verifies at insert time (src/pipeline/findLeads.js,
  // src/routes/leads.js) — see verifyEmailWithRetry in emailVerification.js
  // for the shared fail-open-with-one-retry logic — so this is normally just
  // reading a value that's already cached. Still re-checked here as a
  // backstop: a lead imported before this shipped, or one whose import-time
  // check came back 'pending'/'unknown', gets caught here instead of being
  // silently unverified forever. Only a definitive 'invalid' blocks —
  // risky/catch_all/pending/unknown pass through.
  if (lead.contact_email && process.env.INSTANTLY_API_KEY) {
    let verification = lead.email_verification;
    if (!verification || verification === 'pending' || verification === 'unknown') {
      const freshResult = await verifyEmailWithRetry(lead.contact_email, { leadId: lead.id });
      if (freshResult !== null) {
        verification = freshResult;
        await db.query(
          `UPDATE leads SET email_verification = $2, email_verified_at = now() WHERE id = $1`,
          [lead.id, verification]
        );
      } else {
        verification = null;
      }
    }
    if (verification === 'invalid') {
      if (lead.contact_linkedin) {
        // LinkedIn-only path: the address is dead but the person is still
        // reachable on LinkedIn. Clear the bad email (nothing must ever send
        // to it), tag the lead, and fall through to scoring — 70+ still gets
        // the Aimfox route.
        await db.query(
          `UPDATE leads
           SET contact_email = NULL,
               tags = CASE WHEN 'linkedin-only' = ANY(tags) THEN tags
                           ELSE array_append(tags, 'linkedin-only') END
           WHERE id = $1`,
          [lead.id]
        );
        lead.contact_email = null;
        console.log(
          `[pipeline] lead ${lead.id} (${lead.company_name}) email invalid — ` +
            'tagged linkedin-only, scoring for the Aimfox path'
        );
      } else {
        await db.query(`UPDATE leads SET status = 'deprioritised' WHERE id = $1`, [lead.id]);
        const reason = `invalid email address: ${lead.contact_email}`;
        console.log(`[pipeline] lead ${lead.id} (${lead.company_name}) deprioritised — ${reason}`);
        return { outcome: 'invalid_email', leadId: lead.id, status: 'deprioritised', reason };
      }
    }
  }

  // 4. Score the lead.
  const score = await scoreLead(lead);

  // 5. Below threshold — persist the score, deprioritise, and stop.
  if (score.score < SCORE_THRESHOLD) {
    const { scoreId } = await persist(lead.id, score, [], 'deprioritised');
    return {
      outcome: 'deprioritised',
      leadId: lead.id,
      score: score.score,
      status: 'deprioritised',
      scoreId,
    };
  }

  // 6a. No usable email (linkedin-only, or sourced without one) — drafting
  // would only create undeliverable emails the sequence runner retries
  // forever. Persist the score, park at 'scored', and give strong leads the
  // HeyReach route. These leads are only reachable on LinkedIn.
  if (!lead.contact_email) {
    const { scoreId } = await persist(lead.id, score, [], 'scored');
    // maybeAddToAimfox(lead, score.score) intentionally not called — see the
    // note by its definition below (2026-07-27: switched to HeyReach as the
    // sole LinkedIn channel, no double-routing).
    await maybeAddToHeyReach(lead, score.score);
    return {
      outcome: 'linkedin_only',
      leadId: lead.id,
      score: score.score,
      status: 'scored',
      scoreId,
    };
  }

  // 6. Strong enough — draft email 1 only, for now. Follow-ups (emails 2 and 3)
  // are intentionally NOT generated here: drafting all three roughly tripled the
  // per-lead Anthropic time. The sequence table structure is unchanged — only
  // an email-1 row + its sequence step are created — so follow-up drafting can
  // be re-enabled later (loop over SEQUENCE_EMAIL_NUMBERS) without a migration.
  const leadContext = {
    ...lead,
    ai_score: score.score,
    ai_reasoning: score.reasoning,
    segment: score.segment,
  };

  const draft = await draftEmail(leadContext, { previousEmail, emailNumber: 1 });

  const { scoreId, emailIds } = await persist(lead.id, score, [draft], 'drafted');

  // Auto-send: emails are approved on creation, so push them to Instantly now
  // (sendSequenceEmail no-ops when INSTANTLY_API_KEY is unset). A send failure
  // must not fail the pipeline — the email stays approved and the hourly
  // sequence runner will retry it. Successful enrolments are counted so run
  // summaries (and the process_runs ledger) report real sends.
  let sentNow = 0;
  for (const emailId of emailIds) {
    try {
      const sendResult = await sendSequenceEmail(emailId);
      if (sendResult.outcome === 'sent') sentNow += 1;
    } catch (err) {
      console.error(`[pipeline] auto-send for email ${emailId} failed:`, err.message);
    }
  }

  // LinkedIn outreach: strong-scoring leads with a LinkedIn URL are added to
  // HeyReach. maybeAddToAimfox(lead, score.score) intentionally not called
  // here either — see the note by its definition below.
  await maybeAddToHeyReach(lead, score.score);

  return {
    outcome: 'drafted',
    leadId: lead.id,
    score: score.score,
    status: 'drafted',
    scoreId,
    emailIds,
    sent: sentNow,
    // Feed the cold intro forward so the NEXT lead's intro varies.
    draft,
  };
}

/**
 * Add a strong-scoring lead with a LinkedIn URL to its Aimfox campaign
 * (addLeadToCampaign no-ops when AIMFOX_API_KEY is unset). Best-effort — an
 * Aimfox failure must never fail the pipeline. Shared by the drafted path and
 * the linkedin-only path.
 *
 * DORMANT as of 2026-07-27: no longer called from processLead — the pipeline
 * switched to HeyReach (maybeAddToHeyReach) as the sole LinkedIn channel, to
 * stop double-routing the same lead to two tools. Left defined, not deleted,
 * so re-enabling Aimfox later is just re-adding the two call sites rather
 * than rewriting this. AIMFOX_API_KEY/AIMFOX_CAMPAIGN_ID can stay set with no
 * effect; nothing calls this path anymore.
 *
 * @param {object} lead
 * @param {number} scoreValue
 */
async function maybeAddToAimfox(lead, scoreValue) {
  if (scoreValue < AIMFOX_SCORE_THRESHOLD || !lead.contact_linkedin) return;
  try {
    const aimfox = await addLeadToCampaign(lead);
    if (aimfox.outcome === 'added') {
      console.log(
        `[pipeline] lead ${lead.id} (${lead.company_name}) added to Aimfox campaign ${aimfox.campaignId}`
      );
    } else if (aimfox.outcome === 'rejected') {
      console.log(
        `[pipeline] Aimfox declined lead ${lead.id} (${lead.company_name}): ${aimfox.reason}`
      );
    }
  } catch (err) {
    console.error(`[pipeline] Aimfox add for lead ${lead.id} failed:`, err.message);
  }
}

/**
 * Add a strong-scoring lead with a LinkedIn URL to the HeyReach campaign
 * (HEYREACH_CAMPAIGN_ID) — a second, independent LinkedIn channel alongside
 * Aimfox, not a replacement for it. addLeadToCampaign no-ops cleanly when
 * HEYREACH_API_KEY/HEYREACH_CAMPAIGN_ID is unset. Best-effort — a HeyReach
 * failure must never fail the pipeline. Shared by the drafted path and the
 * linkedin-only path, same as maybeAddToAimfox.
 *
 * @param {object} lead
 * @param {number} scoreValue
 */
async function maybeAddToHeyReach(lead, scoreValue) {
  if (scoreValue < HEYREACH_SCORE_THRESHOLD || !lead.contact_linkedin) return;
  try {
    const result = await heyreach.addLeadToCampaign(lead);
    if (result.outcome === 'added' || result.outcome === 'updated') {
      console.log(
        `[pipeline] lead ${lead.id} (${lead.company_name}) ${result.outcome} in HeyReach campaign ${result.campaignId}`
      );
    } else if (result.outcome === 'failed') {
      console.log(`[pipeline] HeyReach reported a failed add for lead ${lead.id} (${lead.company_name})`);
    }
  } catch (err) {
    console.error(`[pipeline] HeyReach add for lead ${lead.id} failed:`, err.message);
  }
}

/**
 * Persist a score row, any drafted emails (each with a scheduled sequence row),
 * and update the lead's status — all in one transaction so the records stay
 * consistent.
 *
 * @param {number} leadId
 * @param {object} score - Result from scoreLead.
 * @param {object[]} drafts - Results from draftEmail (each has email_number),
 *   in sequence order. Empty when not drafting (e.g. deprioritised leads).
 * @param {string} status - New value for leads.status.
 * @returns {Promise<{scoreId:number, emailIds:number[]}>}
 */
async function persist(leadId, score, drafts, status) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const scoreRes = await client.query(
      `INSERT INTO scores (lead_id, score, segment, reasoning, recommendation, data_quality)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        leadId,
        score.score,
        score.segment,
        score.reasoning,
        score.recommendation,
        score.data_quality,
      ]
    );

    const emailIds = [];
    for (const draft of drafts) {
      const emailNumber = draft.email_number ?? 1;

      // Drafted emails are AUTO-APPROVED on creation (no manual review step).
      // The actual send happens after this transaction commits, via
      // sendSequenceEmail, which still gates on INSTANTLY_API_KEY and the
      // email-1-first rule for follow-ups.
      const emailRes = await client.query(
        `INSERT INTO emails (lead_id, subject, body, email_number, approval_status, approved_at)
         VALUES ($1, $2, $3, $4, 'approved', now())
         RETURNING id`,
        [leadId, draft.subject, draft.body, emailNumber]
      );
      const emailId = emailRes.rows[0].id;
      emailIds.push(emailId);

      // Schedule the send: email 1 now, email 2 +2d, email 3 +6d.
      const offsetDays = SEQUENCE_OFFSET_DAYS[emailNumber] ?? 0;
      await client.query(
        `INSERT INTO sequences (lead_id, email_id, email_number, scheduled_at, status)
         VALUES ($1, $2, $3, now() + make_interval(days => $4::int), 'scheduled')`,
        [leadId, emailId, emailNumber, offsetDays]
      );
    }

    await client.query('UPDATE leads SET status = $1 WHERE id = $2', [status, leadId]);

    await client.query('COMMIT');
    return { scoreId: scoreRes.rows[0].id, emailIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancel a lead's still-pending, unsent emails and their scheduled sequence
 * steps. Used when a lead replies/books/unsubscribes/bounces so we stop the
 * follow-up sequence. Idempotent.
 *
 * @param {number} leadId
 * @returns {Promise<number>} Number of emails cancelled.
 */
async function cancelPendingEmails(leadId) {
  const { rowCount } = await db.query(
    `UPDATE emails
     SET approval_status = 'cancelled'
     WHERE lead_id = $1 AND approval_status = 'pending' AND sent_at IS NULL`,
    [leadId]
  );
  await db.query(
    `UPDATE sequences
     SET status = 'cancelled'
     WHERE lead_id = $1 AND status = 'scheduled'`,
    [leadId]
  );
  return rowCount;
}

/**
 * Send one sequence email via Instantly, with the sequence guards applied:
 *   - If the lead is in a terminal state (replied/booked/unsubscribed/bounced),
 *     cancel all remaining pending emails and stop — do NOT send.
 *   - ONLY sends approved emails (approval_status 'approved'). Drafted emails
 *     are auto-approved by the pipeline; pending/rejected are never sent.
 *   - Only sends when INSTANTLY_API_KEY is configured.
 *   - Email 2 and 3 are blocked until email 1 has actually been sent.
 *   - Already-sent or cancelled emails are no-ops.
 *   - Blacklisted leads, invalid-email leads, and existing HubSpot customers
 *     are cancelled, never sent (fails closed if HubSpot can't be reached).
 * On success, records sent_at + instantly_id, marks the sequence row 'sent',
 * and keeps the lead at 'sent' (without downgrading a terminal status).
 *
 * Driven by the hourly sequence runner once a step's cadence is due — but it
 * will only ever send an email that was manually approved first.
 *
 * @param {number} emailId
 * @returns {Promise<{outcome:string, emailId:number, leadId:number,
 *   reason?:string, instantlyId?:(string|null), cancelled?:number}>}
 */
async function sendSequenceEmail(emailId) {
  const { rows: emailRows } = await db.query('SELECT * FROM emails WHERE id = $1', [emailId]);
  if (emailRows.length === 0) {
    throw new Error(`sendSequenceEmail: email ${emailId} not found`);
  }
  const email = emailRows[0];

  const { rows: leadRows } = await db.query('SELECT * FROM leads WHERE id = $1', [email.lead_id]);
  if (leadRows.length === 0) {
    throw new Error(`sendSequenceEmail: lead ${email.lead_id} not found`);
  }
  const lead = leadRows[0];

  // Guard 1: lead has replied/booked/unsubscribed/bounced — cancel and stop.
  if (TERMINAL_STATUSES.includes(lead.status)) {
    const cancelled = await cancelPendingEmails(lead.id);
    return { outcome: 'cancelled', emailId, leadId: lead.id, cancelled };
  }

  if (email.sent_at) {
    return { outcome: 'already_sent', emailId, leadId: lead.id };
  }
  if (email.approval_status === 'cancelled') {
    return { outcome: 'cancelled', emailId, leadId: lead.id };
  }

  // Guard 2: only ever send approved emails. The pipeline auto-approves drafts,
  // but anything pending/rejected/cancelled must never be sent.
  if (email.approval_status !== 'approved') {
    return { outcome: 'not_approved', emailId, leadId: lead.id };
  }

  // Guard 3: only send when Instantly is configured.
  if (!process.env.INSTANTLY_API_KEY) {
    return { outcome: 'no_api_key', emailId, leadId: lead.id };
  }

  // Guard 4: follow-ups wait until email 1 has actually been sent.
  if (email.email_number > 1) {
    const { rows: firstSent } = await db.query(
      `SELECT 1 FROM emails
       WHERE lead_id = $1 AND email_number = 1 AND sent_at IS NOT NULL
       LIMIT 1`,
      [lead.id]
    );
    if (firstSent.length === 0) {
      return { outcome: 'blocked', reason: 'email 1 not yet sent', emailId, leadId: lead.id };
    }
  }

  // Guard 5: never send to an address that failed verification (a lead can be
  // verified/re-verified after drafting, e.g. via a manual import).
  if (lead.email_verification === 'invalid') {
    const cancelled = await cancelPendingEmails(lead.id);
    return { outcome: 'cancelled', reason: 'invalid email', emailId, leadId: lead.id, cancelled };
  }

  // Guard 6: never email existing Safely customers (Critical Rule). Catches
  // both leads blacklisted after drafting and live HubSpot relationships.
  // Fails CLOSED: if HubSpot can't be reached we don't send — the hourly
  // runner retries the still-scheduled step later.
  const alreadyBlacklisted = await isBlacklisted(
    lead.contact_email,
    lead.company_domain,
    lead.contact_linkedin
  );
  if (alreadyBlacklisted) {
    const cancelled = await cancelPendingEmails(lead.id);
    return { outcome: 'cancelled', reason: 'blacklisted', emailId, leadId: lead.id, cancelled };
  }
  try {
    const { existing, reason } = await checkExistingCustomer(lead);
    if (existing) {
      const cancelled = await cancelPendingEmails(lead.id);
      return { outcome: 'cancelled', reason, emailId, leadId: lead.id, cancelled };
    }
  } catch (err) {
    console.error('[pipeline] HubSpot customer check failed — blocking send:', err.message);
    return { outcome: 'blocked', reason: 'hubspot check failed', emailId, leadId: lead.id };
  }

  // Guard 7: HeyGen personalized video for high-scoring leads (85+) — placed
  // right after the HubSpot gate and before Instantly enrollment, on email 1
  // only (the one that actually enrolls the lead; steps 2-7 fire from
  // Instantly's own sequence engine). First time through, kick off generation
  // (best-effort: a HeyGen failure must never block the send). While the
  // video is 'pending' and under the 15-minute hold window, don't enrol yet —
  // heygenPoller retries this same send on a short interval and will get the
  // video URL (or let the timeout lapse and send without it).
  if (email.email_number === 1) {
    if (lead.heygen_video_id == null) {
      const scoreRow = await db.query(
        `SELECT score FROM scores WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [lead.id]
      );
      const score = scoreRow.rows[0]?.score ?? null;
      if (score != null && score >= HEYGEN_SCORE_THRESHOLD) {
        try {
          const genResult = await generateVideoForLead(lead);
          if (genResult.outcome === 'requested') {
            lead.heygen_video_id = genResult.videoId;
            lead.heygen_video_status = 'pending';
            lead.heygen_requested_at = new Date();
          }
        } catch (err) {
          console.error(
            `[pipeline] HeyGen video generation for lead ${lead.id} failed (continuing without video):`,
            err.message
          );
        }
      }
    }

    if (lead.heygen_video_status === 'pending') {
      const elapsedMs = Date.now() - new Date(lead.heygen_requested_at).getTime();
      if (elapsedMs < HOLD_TIMEOUT_MS) {
        return { outcome: 'awaiting_video', emailId, leadId: lead.id };
      }
      console.log(
        `[pipeline] lead ${lead.id} HeyGen video hold timed out (15 min) — sending without it`
      );
    }
  }

  // Clear to send.
  const result = await sendEmail(lead, email);
  await db.query(
    `UPDATE emails SET sent_at = now(), instantly_id = $2 WHERE id = $1`,
    [email.id, result.instantlyId]
  );
  await db.query(
    `UPDATE sequences SET status = 'sent', sent_at = now() WHERE email_id = $1`,
    [email.id]
  );
  await db.query(
    `UPDATE leads SET status = 'sent'
     WHERE id = $1 AND status NOT IN ('replied', 'booked', 'unsubscribed', 'bounced')`,
    [lead.id]
  );
  return { outcome: 'sent', emailId, leadId: lead.id, instantlyId: result.instantlyId };
}

/**
 * Fetch up to `limit` 'new' leads for a campaign and run each through
 * processLead, sequentially, in batches with a delay between every Anthropic
 * call. Shared by the CLI batch script and the process-leads route so the
 * rate-limiting and outcome accounting stay identical.
 *
 * @param {number} campaignId
 * @param {object} [options]
 * @param {number} [options.limit=10]      - Max leads to process this run.
 * @param {number} [options.batchSize=10]  - Leads per batch (Safety Rules cap).
 * @param {number} [options.delayMs=500]   - Min gap between API calls.
 * @returns {Promise<{found:number, processed:number, scored:number,
 *   drafted:number, deprioritised:number, blacklisted:number, errors:number}>}
 */
async function processCampaignLeads(campaignId, options = {}) {
  if (campaignId == null) {
    throw new Error('processCampaignLeads: `campaignId` is required');
  }

  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs ?? DEFAULT_LEAD_DELAY_MS;

  // Confirm the campaign exists so callers can surface a clean 404.
  const { rows: campaignRows } = await db.query(
    'SELECT id FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (campaignRows.length === 0) {
    throw new Error(`processCampaignLeads: campaign ${campaignId} not found`);
  }

  const { rows: leads } = await db.query(
    `SELECT * FROM leads
     WHERE campaign_id = $1 AND status = 'new'
     ORDER BY id
     LIMIT $2`,
    [campaignId, limit]
  );

  // Seed the "previous email" with the most recent draft already in this
  // campaign so the first lead of this run doesn't repeat the last run's
  // case study / CTA. It's then updated in-memory after each new draft below.
  const { rows: prevRows } = await db.query(
    `SELECT e.subject, e.body
     FROM emails e
     JOIN leads l ON l.id = e.lead_id
     WHERE l.campaign_id = $1
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 1`,
    [campaignId]
  );
  let previousEmail = prevRows[0] ?? null;

  const summary = {
    found: leads.length,
    processed: 0,
    scored: 0,
    drafted: 0,
    deprioritised: 0,
    filtered: 0,
    invalid_email: 0,
    linkedin_only: 0,
    blacklisted: 0,
    sent: 0,
    errors: 0,
  };

  for (let start = 0; start < leads.length; start += batchSize) {
    const batch = leads.slice(start, start + batchSize);
    for (let i = 0; i < batch.length; i++) {
      // Delay before every call except the very first, keeping calls >=delayMs apart.
      if (start > 0 || i > 0) await sleep(delayMs);

      try {
        const result = await processLead(batch[i], { previousEmail });
        summary.processed += 1;
        if (result.outcome === 'drafted') {
          // Feed this draft forward so the next lead avoids repeating it.
          if (result.draft) previousEmail = result.draft;
          summary.drafted += 1;
          summary.scored += 1; // a drafted lead was also scored
          summary.sent += result.sent ?? 0;
        } else if (result.outcome === 'deprioritised') {
          summary.deprioritised += 1;
          summary.scored += 1; // deprioritised leads are scored too, just below threshold
        } else if (result.outcome === 'filtered') {
          // Bad-fit keyword hit — deprioritised WITHOUT scoring, so it counts
          // toward deprioritised but not scored.
          summary.filtered += 1;
          summary.deprioritised += 1;
        } else if (result.outcome === 'invalid_email') {
          // Failed verification — deprioritised WITHOUT scoring.
          summary.invalid_email += 1;
          summary.deprioritised += 1;
        } else if (result.outcome === 'linkedin_only') {
          // Scored but not drafted (no usable email) — LinkedIn is the only
          // channel; Aimfox was attempted inside processLead at 70+.
          summary.linkedin_only += 1;
          summary.scored += 1;
        } else if (result.outcome === 'blacklisted') {
          summary.blacklisted += 1;
        }
      } catch (err) {
        summary.errors += 1;
      }
    }
  }

  return summary;
}

module.exports = {
  processLead,
  processCampaignLeads,
  sendSequenceEmail,
  cancelPendingEmails,
};
