const axios = require('axios');
const db = require('../config/db');

// HeyGen API client — personalized video generation from a template.
//
// Generation model: POST a template id with per-lead `variables`, get back a
// video_id, then poll GET /v3/videos/:id until it's rendered. `enable_sharing`
// makes the finished video's HeyGen-hosted share page public, giving us a
// link to drop straight into the outreach email.
//
// Docs: https://developers.heygen.com/template-api
//   POST /v3/templates/:template_id  { variables, enable_sharing } -> { data: { video_id } }
//   GET  /v3/videos/:video_id        -> { data: { status, video_url } }
//
// Environment:
//   HEYGEN_API_KEY      - API key (X-Api-Key header).
//   HEYGEN_TEMPLATE_ID  - Template used for every generation.

const API_BASE = 'https://api.heygen.com';

// How long sendSequenceEmail holds Instantly enrollment waiting for the video
// before giving up and sending without it.
const HOLD_TIMEOUT_MS = 15 * 60 * 1000;

// Wallet safety: hard ceiling on generations per day, independent of lead
// volume — a scoring bug or a big high-scoring batch must not run up an
// open-ended HeyGen bill overnight.
const DAILY_CAP = 25;

// Rough cost estimate for logging only (not billed/metered exactly): HeyGen's
// default Avatar IV engine runs $0.05-0.0667/sec; a typical ~30s personalized
// clip lands around here. Actual cost depends on the template's rendered
// length, which we don't know until the video completes.
const ESTIMATED_COST_PER_VIDEO_USD = 2.0;

// Split a "First Last" contact name into a first name only (all the template
// needs), same convention as instantly.js's splitName.
function firstNameOf(contactName) {
  if (!contactName || typeof contactName !== 'string') return 'there';
  return contactName.trim().split(/\s+/)[0] || 'there';
}

// A short personalized line for templates that have a `script_line` variable
// slot. Built from data already on the lead — no extra Claude call.
function buildScriptLine(lead) {
  const company = lead.company_name || 'your fleet';
  return `Hi, this one's for the team at ${company} - here's how Safely helps fleets like yours cut accidents and costs.`;
}

/**
 * How many videos have been requested today (UTC) — the DAILY_CAP ledger.
 * Counted off heygen_requested_at directly on the leads table rather than a
 * separate table, since one row is written per generation.
 *
 * @returns {Promise<number>}
 */
async function getGeneratedTodayCount() {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM leads
     WHERE heygen_requested_at >= date_trunc('day', now())`
  );
  return Number(rows[0].cnt);
}

/**
 * Look up the template's variable slots, best-effort, to decide whether to
 * include a `script_line` variable. A lookup failure (network, wrong API
 * version, template not found) must never block generation — it just falls
 * back to first_name + company_name only.
 *
 * @param {string} apiKey
 * @param {string} templateId
 * @returns {Promise<Set<string>>} variable names the template defines (empty on failure).
 */
async function getTemplateVariableNames(apiKey, templateId) {
  try {
    const { data } = await axios.get(`${API_BASE}/v3/templates/${templateId}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    const variables = data?.data?.variables ?? data?.variables ?? {};
    return new Set(Object.keys(variables));
  } catch (err) {
    console.warn(
      `[heygen] could not fetch template ${templateId} variable schema (continuing without script_line): ${err.message}`
    );
    return new Set();
  }
}

/**
 * Generate a personalized video for a lead from HEYGEN_TEMPLATE_ID.
 *
 * Variables sent: first_name, company_name, and script_line — the last one
 * ONLY if the template actually defines that slot (checked via a best-effort
 * template lookup). enable_sharing is set so the finished video gets a public
 * HeyGen share link. Persists heygen_video_id / heygen_video_status='pending'
 * / heygen_requested_at on the lead immediately; heygenPoller fills in the
 * share URL once rendering completes.
 *
 * No-ops (does not call the API) when HEYGEN_API_KEY or HEYGEN_TEMPLATE_ID is
 * unset, or the DAILY_CAP has been reached — callers proceed without a video.
 *
 * @param {object} lead - Lead row. Requires `id`; uses `contact_name`, `company_name`.
 * @returns {Promise<{outcome:('requested'|'skipped'|'capped'), reason?:string, videoId?:string}>}
 */
async function generateVideoForLead(lead) {
  const apiKey = process.env.HEYGEN_API_KEY;
  const templateId = process.env.HEYGEN_TEMPLATE_ID;
  if (!apiKey || !templateId) {
    return { outcome: 'skipped', reason: 'HEYGEN_API_KEY/HEYGEN_TEMPLATE_ID not set' };
  }
  if (!lead || typeof lead !== 'object' || lead.id == null) {
    throw new Error('generateVideoForLead: `lead` must be an object with an `id`');
  }

  const generatedToday = await getGeneratedTodayCount();
  if (generatedToday >= DAILY_CAP) {
    return { outcome: 'capped', reason: `daily cap reached (${generatedToday}/${DAILY_CAP})` };
  }

  const templateVariables = await getTemplateVariableNames(apiKey, templateId);

  const variables = {
    first_name: { type: 'text', content: firstNameOf(lead.contact_name) },
    company_name: { type: 'text', content: lead.company_name || 'your fleet' },
  };
  if (templateVariables.has('script_line')) {
    variables.script_line = { type: 'text', content: buildScriptLine(lead) };
  }

  try {
    const { data } = await axios.post(
      `${API_BASE}/v3/templates/${templateId}`,
      { variables, enable_sharing: true },
      { headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' } }
    );
    const videoId = data?.data?.video_id ?? data?.video_id ?? null;
    if (!videoId) {
      throw new Error(`no video_id in response: ${JSON.stringify(data)}`);
    }

    await db.query(
      `UPDATE leads
       SET heygen_video_id = $2, heygen_video_status = 'pending',
           heygen_video_url = NULL, heygen_requested_at = now()
       WHERE id = $1`,
      [lead.id, videoId]
    );

    console.log(
      `[heygen] requested video ${videoId} for lead ${lead.id} (${lead.company_name}) — ` +
        `estimated cost ~$${ESTIMATED_COST_PER_VIDEO_USD.toFixed(2)} ` +
        `(${generatedToday + 1}/${DAILY_CAP} today)`
    );

    return { outcome: 'requested', videoId };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `generateVideoForLead: HeyGen POST /v3/templates/${templateId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

// HeyGen video statuses seen in practice, normalised to our 3-state model.
const COMPLETED_STATUSES = new Set(['completed', 'success']);
const FAILED_STATUSES = new Set(['failed', 'error']);

/**
 * Poll a single video's render status.
 *
 * @param {string} videoId
 * @returns {Promise<{status:('pending'|'completed'|'failed'), videoUrl:(string|null)}>}
 */
async function getVideoStatus(videoId) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    throw new Error('getVideoStatus: HEYGEN_API_KEY is not set in the environment');
  }
  try {
    const { data } = await axios.get(`${API_BASE}/v3/videos/${videoId}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    const raw = (data?.data?.status ?? data?.status ?? '').toLowerCase();
    const videoUrl = data?.data?.video_url ?? data?.data?.share_url ?? data?.video_url ?? null;

    let status = 'pending';
    if (COMPLETED_STATUSES.has(raw)) status = 'completed';
    else if (FAILED_STATUSES.has(raw)) status = 'failed';

    return { status, videoUrl: status === 'completed' ? videoUrl : null };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `getVideoStatus: HeyGen GET /v3/videos/${videoId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

module.exports = {
  generateVideoForLead,
  getVideoStatus,
  getGeneratedTodayCount,
  HOLD_TIMEOUT_MS,
  DAILY_CAP,
  ESTIMATED_COST_PER_VIDEO_USD,
};
