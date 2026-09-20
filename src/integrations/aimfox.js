const axios = require('axios');
const db = require('../config/db');

// Aimfox API client (LinkedIn outreach).
//
// Sending model: like Instantly, Aimfox works campaign-first — you add a
// LinkedIn profile to a campaign's audience and Aimfox runs its connect /
// message sequence automatically. addLeadToCampaign() adds the lead's
// contact_linkedin URL to the resolved Aimfox campaign.
//
// Docs: https://docs.aimfox.com/ (rate limit: 60 requests/minute)
//   POST /api/v2/campaigns/:campaign_id/audience  { "profile_url": "<linkedin url>" }
//
// Reply/connection webhooks exist too (POST /api/v2/webhooks with events such
// as `accepted`, `reply`, `new_reply`, `campaign_reply`) but no receiver is
// wired up yet — replies are handled in the Aimfox inbox for now.
//
// Environment:
//   AIMFOX_API_KEY     - Bearer token ("normal" API key, not the master key).
//   AIMFOX_CAMPAIGN_ID - Fallback campaign UUID when the lead's campaign has
//                        no aimfox_campaign_id set.

const API_BASE = 'https://api.aimfox.com/api/v2';

// Rejection codes Aimfox returns as error.data on HTTP 400. These mean this
// profile can't be added to the campaign (permanent for this lead, not a
// transient API failure), so callers treat them as a skip rather than an error.
const REJECTION_REASONS = new Set([
  'blocked', // the target is blocked
  'locked', // the target is locked in another campaign
  'miningFailed', // the target was not found
  'noPFP', // the target has no profile picture
  'alreadyConnected', // the target is already a lead
  'notLead', // the target is not a lead
  'closed', // the target cannot receive free InMails
  // Undocumented but seen in practice (2026-07 backfill): a generic "couldn't
  // add this profile", typically a stale or unresolvable LinkedIn URL.
  'FailedToAddTarget',
]);

/**
 * Resolve which Aimfox campaign a lead belongs in: prefer the lead's own
 * campaign's `aimfox_campaign_id`, falling back to the AIMFOX_CAMPAIGN_ID env
 * var. Returns null when neither is configured (callers no-op) — unlike the
 * Instantly resolver this never throws, because LinkedIn outreach is an
 * optional add-on, not the send path.
 *
 * @param {object} lead - Lead row (may carry `campaign_id`).
 * @returns {Promise<string|null>}
 */
async function resolveAimfoxCampaignId(lead) {
  if (lead && lead.campaign_id != null) {
    try {
      const { rows } = await db.query(
        'SELECT aimfox_campaign_id FROM campaigns WHERE id = $1',
        [lead.campaign_id]
      );
      if (rows[0] && rows[0].aimfox_campaign_id) {
        return rows[0].aimfox_campaign_id;
      }
    } catch (err) {
      // Lookup failed (e.g. column missing pre-migration) — fall back to env.
    }
  }
  return process.env.AIMFOX_CAMPAIGN_ID || null;
}

/**
 * Add a lead's LinkedIn profile to its Aimfox campaign's audience.
 *
 * POST /api/v2/campaigns/:campaign_id/audience with the lead's
 * contact_linkedin as `profile_url`. Aimfox then runs the campaign's own
 * connect/message sequence against the profile.
 *
 * Never a hard dependency: returns { outcome: 'skipped' } when AIMFOX_API_KEY
 * is unset, the lead has no LinkedIn URL, or no campaign is configured; and
 * { outcome: 'rejected' } when Aimfox declines the profile with a known
 * rejection code (e.g. alreadyConnected). Only unexpected API failures throw.
 *
 * @param {object} lead - Lead row. Requires `contact_linkedin`; uses
 *                        `campaign_id` to resolve the target Aimfox campaign.
 * @returns {Promise<{outcome:('added'|'skipped'|'rejected'), reason?:string,
 *   campaignId?:string}>}
 */
async function addLeadToCampaign(lead) {
  const apiKey = process.env.AIMFOX_API_KEY;
  if (!apiKey) {
    return { outcome: 'skipped', reason: 'AIMFOX_API_KEY is not set' };
  }

  if (!lead || typeof lead !== 'object' || !lead.contact_linkedin) {
    return { outcome: 'skipped', reason: 'lead has no contact_linkedin' };
  }

  const campaignId = await resolveAimfoxCampaignId(lead);
  if (!campaignId) {
    return { outcome: 'skipped', reason: 'no Aimfox campaign configured' };
  }

  try {
    await axios.post(
      `${API_BASE}/campaigns/${campaignId}/audience`,
      { profile_url: lead.contact_linkedin },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
    // The profile is now queued in Aimfox's audience — reflect that on the
    // lead so the LinkedIn column/stats show it before any webhook arrives.
    // COALESCE keeps a further-along status (requested/accepted/replied) if a
    // webhook somehow beat us here. Best-effort: never fail the add over it.
    if (lead.id != null) {
      try {
        await db.query(
          `UPDATE leads SET linkedin_status = COALESCE(linkedin_status, 'queued') WHERE id = $1`,
          [lead.id]
        );
      } catch (err) {
        console.error(`[aimfox] failed to mark lead ${lead.id} queued:`, err.message);
      }
    }
    return { outcome: 'added', campaignId };
  } catch (err) {
    // A 400 with a known rejection code means "this profile, no" — skip it.
    const rejection = err.response?.data?.error?.data;
    if (err.response?.status === 400 && REJECTION_REASONS.has(rejection)) {
      return { outcome: 'rejected', reason: rejection, campaignId };
    }
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `addLeadToCampaign: Aimfox POST /campaigns/${campaignId}/audience failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Fetch a campaign's interaction metrics from Aimfox.
 *
 * GET /api/v2/campaigns/:campaign_id/metrics →
 *   { sent_connections, accepted_connections, sent_messages, replies,
 *     inmail_replies, sent_inmails, message_requests, views, ... }
 *
 * @param {string} aimfoxCampaignId
 * @returns {Promise<object>} the metrics object (empty object if absent)
 */
async function getCampaignMetrics(aimfoxCampaignId) {
  const apiKey = process.env.AIMFOX_API_KEY;
  if (!apiKey) {
    throw new Error('getCampaignMetrics: AIMFOX_API_KEY is not set in the environment');
  }
  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/${aimfoxCampaignId}/metrics`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return data?.metrics ?? {};
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `getCampaignMetrics: Aimfox GET /campaigns/${aimfoxCampaignId}/metrics failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

// Aimfox's web app — used to build a "Manage in Aimfox" deep link. Confirmed
// live: app.aimfox.com/workspaces/{workspace_id}/campaigns/{campaign_id}
// (workspace_id comes back on every /accounts row).
const APP_BASE = 'https://app.aimfox.com';

/**
 * Read-only summary of a campaign's connection/message flow and its owning
 * account's warmup limits, for the Cadence editor's LinkedIn panel. Aimfox's
 * API has no endpoint to EDIT a flow, so this is display-only by design —
 * changes still have to be made in the Aimfox UI (the returned `manageUrl`
 * links straight there).
 *
 * GET /api/v2/campaigns/:id returns the campaign plus its `flows` (each with
 * type, name, and `flow_message_templates` — the actual message steps and
 * their delay in hours) and `schedule` (per-weekday sending intervals +
 * timezone). GET /api/v2/accounts/:id/limits (keyed by the campaign's first
 * owner) returns the weekly connect/message/InMail limits and the warmup
 * sub-object (enabled, per-type warmup caps, ramp speed) — this is
 * account-level in Aimfox, not campaign-level, so it reflects the limits for
 * whichever LinkedIn seat is running this campaign.
 *
 * Never a hard dependency: returns { available: false, reason } when
 * AIMFOX_API_KEY is unset or the campaign id is missing, so the panel can
 * render an honest "not available" state instead of erroring.
 *
 * @param {string} aimfoxCampaignId
 * @returns {Promise<{available:boolean, reason?:string, campaign?:object,
 *   flows?:object[], limits?:(object|null), manageUrl?:string}>}
 */
async function getCampaignFlowSummary(aimfoxCampaignId) {
  const apiKey = process.env.AIMFOX_API_KEY;
  if (!apiKey) {
    return { available: false, reason: 'AIMFOX_API_KEY is not set' };
  }
  if (!aimfoxCampaignId) {
    return { available: false, reason: 'no Aimfox campaign configured' };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  let campaign;
  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/${aimfoxCampaignId}`, { headers });
    campaign = data?.campaign;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `getCampaignFlowSummary: Aimfox GET /campaigns/${aimfoxCampaignId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
  if (!campaign) {
    return { available: false, reason: 'campaign not found in Aimfox' };
  }

  // Flows with actual message steps are the ones worth summarising (a
  // connect-only flow with no follow-up messages has an empty template list).
  const flows = (campaign.flows ?? []).map((flow) => ({
    type: flow.type,
    name: flow.name || flow.type,
    messageCount: flow.flow_message_templates?.length ?? 0,
    steps: (flow.flow_message_templates ?? []).map((t) => ({
      delayHours: t.delay ?? null,
      preview: (t.message ?? '').slice(0, 200),
    })),
  }));

  // Warmup limits are per-account, not per-campaign — use the campaign's
  // first owner. GET /accounts also carries each account's workspace_id (not
  // present on the campaign object itself), used to build a direct
  // "Manage in Aimfox" link. Best-effort: either lookup failing shouldn't
  // hide the flow summary we already have.
  let limits = null;
  let ownerName = null;
  let workspaceId = null;
  const ownerId = campaign.owners?.[0];
  if (ownerId) {
    try {
      const { data } = await axios.get(`${API_BASE}/accounts/${ownerId}/limits`, { headers });
      limits = data?.limit ?? null;
    } catch (err) {
      console.error(
        `[aimfox] could not fetch warmup limits for account ${ownerId}:`,
        err.response?.data ?? err.message
      );
    }
    try {
      const { data } = await axios.get(`${API_BASE}/accounts`, { headers });
      const owner = (data?.accounts ?? []).find((a) => String(a.id) === String(ownerId));
      ownerName = owner?.full_name ?? null;
      workspaceId = owner?.workspace_id ?? null;
    } catch (err) {
      console.error('[aimfox] could not fetch account list for owner name/workspace:', err.message);
    }
  }

  return {
    available: true,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      state: campaign.state,
      outreachType: campaign.outreach_type,
      targetCount: campaign.target_count,
      audienceSize: campaign.audience_size,
      completion: campaign.completion,
      schedule: campaign.schedule,
    },
    flows,
    limits,
    ownerName,
    manageUrl: workspaceId
      ? `${APP_BASE}/workspaces/${workspaceId}/campaigns/${aimfoxCampaignId}`
      : `${APP_BASE}/campaigns/${aimfoxCampaignId}`,
  };
}

module.exports = {
  addLeadToCampaign,
  resolveAimfoxCampaignId,
  getCampaignMetrics,
  getCampaignFlowSummary,
};
