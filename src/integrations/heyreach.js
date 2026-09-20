const axios = require('axios');
const db = require('../config/db');

// HeyReach API client (LinkedIn outreach) — verify-first pass, 2026-07-27.
//
// Sending model: campaign-first, like Aimfox/Instantly — a lead is added to a
// campaign's audience, paired with the SENDING LinkedIn seat (a HeyReach
// campaign can have more than one sender account attached), and HeyReach runs
// its own connect/message sequence from there. addLeadToCampaign() looks up
// the campaign's own sender account via GetById, then adds the lead's
// contact_linkedin bound to that sender.
//
// Docs: https://help.heyreach.io/ — auth is `X-API-KEY: <key>`, NOT a Bearer
// token (confirmed live; a Bearer header would silently 401).
// Base: https://api.heyreach.io/api/public
//
// VERIFIED LIVE 2026-07-27 against campaign <campaignId> ("Example Campaign"):
//   GET  /campaign/GetById?campaignId=<id>
//     -> { id, name, status, campaignAccountIds:[<linkedInAccountId>],
//          progressStats:{ totalUsers, totalUsersPending, ... }, ... }
//     Confirmed status values seen/documented: DRAFT, IN_PROGRESS, PAUSED,
//     FINISHED, CANCELED, FAILED, STARTING, SCHEDULED. Campaign <campaignId> was
//     FINISHED (brand new, zero leads — an empty campaign auto-finishes
//     immediately) before this session's test.
//   POST /campaign/AddLeadsToCampaignV2
//     body:  { campaignId, accountLeadPairs: [{ linkedInAccountId,
//              lead: { profileUrl, firstName, lastName } }] }
//     -> { addedLeadsCount, updatedLeadsCount, failedLeadsCount }
//     `accountLeadPairs` is the real (undocumented in secondary sources)
//     required field name — discovered via the validation error on a first
//     guess ({leads: [...]}) that named it explicitly. The older
//     /campaign/AddLeadsToCampaign (v1) accepts the same body but only
//     returns a bare integer, not a usable per-outcome breakdown — v2 is
//     used here.
//   IMPORTANT, contradicts secondary docs: adding a lead to a FINISHED
//     campaign does NOT require manually resuming it first — the add call
//     itself flipped campaign <campaignId> from FINISHED to IN_PROGRESS. Do not
//     assume "campaign must already be ACTIVE" without re-checking if
//     HeyReach ever changes this.
//   POST /campaign/Pause?campaignId=<id>  (campaignId as a QUERY param, not
//     body — a body-only attempt 400s with "campaignId field is required"
//     even though it's present in the JSON body). /campaign/Resume mirrors
//     this (confirmed for Pause; Resume inferred from the same pattern, not
//     independently called this session).
//
// GetById's progressStats LAGS — it is NOT instant (2026-07-27 finding,
//   later corrected the same day). Added a real lead (Lizzie Imisson) via
//   AddLeadsToCampaignV2 — got back a real, non-zero updatedLeadsCount, and
//   separately confirmed IN THE HEYREACH UI that she landed. But
//   progressStats.totalUsers stayed unchanged for a while afterward, which
//   this session first (wrongly) wrote up as "these reads are unreliable,
//   don't trust them." A later check on the SAME campaign showed
//   totalUsers correctly at 2 — it just needed more time than expected to
//   catch up. Correction: progressStats is eventually accurate, just not
//   synchronous with a write. Don't assume a just-added lead shows up
//   immediately; re-check after a delay (this session saw it resolve within
//   a few minutes) rather than concluding the add failed.
//   /list/GetLeadsFromList (via the campaign's own linkedInUserListId),
//   however, is still UNCONFIRMED either way — it consistently showed only
//   an unrelated throwaway test profile and never Lizzie, even after
//   progressStats caught up. Don't use it as a membership check without
//   re-verifying what it actually tracks.
//
// CAMPAIGN CREATION, SEQUENCE, AND STATE — verified live 2026-07-27
//   (second pass) by creating and configuring a real throwaway campaign
//   (523900, "__PROBE_DELETE_ME__") end to end:
//
//   POST /list/CreateEmptyList  { name }
//     -> full list object, including `id` (this is the linkedInUserListId
//     campaign creation needs) and `listType: "USER_LIST"`.
//
//   POST /campaign/Create  { name, linkedInAccountIds: [int],
//     linkedInUserListId, excludeInOtherCampaigns?, schedule?, ... }
//     -> { campaignId }. Required fields (from live validation errors, not
//     secondary docs): name, linkedInAccountIds. linkedInUserListId isn't
//     flagged by the same model-validation pass, but omitting it (or
//     passing one that doesn't exist) fails a separate check:
//     {"errorMessage":"The list does not exist!"} — so a real list must
//     already exist first. No `sequence` field needed at creation time;
//     campaigns are created bare and sequenced afterward.
//
//   GetById 404s for a campaign that's still DRAFT
//     ("There is no campaign with provided id.") — confirmed by creating
//     523900 and immediately querying it, repeatedly, over several
//     minutes. GetById only started working once... actually it never did
//     for this campaign, even after attaching a sequence — DRAFT status
//     itself appears to be what GetById can't see, not a delay.
//     POST /campaign/GetAll  { offset, limit, filters?: { keyword } } WORKS
//     for DRAFT campaigns and is the reliable lookup regardless of status
//     — use this, not GetById, for anything that might still be DRAFT.
//
//   POST /campaign/UpdateSequence  { campaignId, sequence: <tree> }
//     -> 200, empty body. The tree (PublicSequenceNodeDto):
//       { nodeType, actionDelay, actionDelayUnit: 'HOUR'|'DAY', payload?,
//         conditionalNode?, unconditionalNode? }
//     Confirmed node types used: CONNECTION_REQUEST, MESSAGE, END.
//     Branching (per secondary docs, consistent with what got accepted):
//       - CONNECTION_REQUEST/CHECK_IS_CONNECTION/CHECK_IS_OPEN_PROFILE
//         require BOTH conditionalNode (true/accepted branch) and
//         unconditionalNode (false/not-yet branch).
//       - Every other non-END node type takes only unconditionalNode.
//       - END is a leaf — no children — but still needs actionDelay set
//         (see below); it's the required terminator for every path
//         through the tree.
//     CONFIRMED VALIDATION RULES (via live error messages, in the order
//     they were hit — later errors only surface once earlier ones are
//     fixed):
//       1. CONNECTION_REQUEST's payload needs BOTH `messages` (string[])
//          AND `fallbackMessage` (string) — omitting fallbackMessage:
//          {"errorMessage":"...The fallback message is invalid in the
//          \"Connection request\" action."}
//       2. EVERY node in the tree — including END — needs a valid
//          actionDelay/actionDelayUnit, minimum 3 hours, maximum 500 days.
//          An END node with no delay set (defaults to 0) fails:
//          {"errorMessage":"Node at: UNCND-START/.../UNCND-END has invalid
//          delay: 00:00:00, delay must be at least 3 hours..."} — that
//          error's node-path notation (UNCND-/COND- prefixes tracing the
//          branch taken) is itself useful for debugging a rejected tree.
//       3. MESSAGE's payload needs `messages` (string[], ≥1 entry).
//
//   LAUNCHING A DRAFT CAMPAIGN — CORRECTED 2026-07-27. An earlier pass of
//     this file concluded first activation was HeyReach-UI-only, based on
//     404s against 8 guessed names (Launch, Start, Activate, Run, Enable,
//     Publish, UpdateStatus, SetStatus). That conclusion was WRONG — the
//     real endpoint is POST /campaign/StartCampaign?campaignId=<id>
//     (campaignId as a query param, same convention as Pause/Resume; the
//     long form, unlike Pause/Resume's short names, is why it wasn't among
//     the 8 guesses). CONFIRMED LIVE: called against a fresh DRAFT campaign
//     (524038) and it flipped DRAFT -> IN_PROGRESS with `startedAt`
//     populated; GetById (which 404s for DRAFT — see above) started working
//     immediately afterward on the same campaignId. Lesson: a batch of
//     plausible-name guesses that all 404 is NOT proof an endpoint doesn't
//     exist — see startCampaign() below.
//
//   NO DELETE ENDPOINT FOUND for either a campaign or a list. Tried and
//     404'd: /campaign/Delete, /campaign/DeleteCampaign, /campaign/Remove,
//     /campaign/Archive, /list/Delete, /list/Remove, /list/DeleteList (GET
//     query param and POST body forms of each). The throwaway probe
//     campaign (523900, list 821152) could NOT be cleaned up
//     programmatically as a result — it's stuck in DRAFT, can't accept
//     leads (confirmed above), and is harmless, but still sitting in the
//     HeyReach account. Remove it by hand via the UI if you want it gone.
//     CORROBORATED 2026-07-27: given the StartCampaign miss above, this
//     "no delete" conclusion was independently re-checked rather than
//     trusted — a third-party API audit of HeyReach's public API cites
//     campaign deletion as a "planned Q3" item, i.e. confirmed not shipped
//     yet, not just undiscovered. Higher confidence than the original pass,
//     but still worth a quick re-probe (GetAll for a `/campaign/Delete`-
//     shaped 200, not just a 404) if this ever actually matters.
//
// WEBHOOK CREATION IS UI-ONLY — CONFIRMED 2026-07-27 against HeyReach's own
// first-party Help Center article (help.heyreach.io/en/articles/9877965-
// webhooks), not from name-guessing or a third-party aggregator. The
// article documents the entire flow as dashboard-only: "go to the
// 'Integrations' section... under the settings icon... Navigate to
// 'Webhooks' and click on 'View and Create'... Name your webhook, and fill
// in the parameters... Click on 'Create Webhook'." No API method or
// endpoint is mentioned anywhere in it. This is a materially stronger basis
// than the earlier pass's "12 tried names all 404'd" reasoning (the same
// kind of reasoning that wrongly ruled out StartCampaign) — here the
// first-party docs affirmatively describe a UI-only flow rather than just
// staying silent. No webhook-creation endpoint is implemented here as a
// result. The 12 event types (incl. CONNECTION_REQUEST_ACCEPTED,
// MESSAGE_REPLY_RECEIVED) come from secondary research, not a live call,
// since there's no endpoint to list them from HeyReach directly.
//
// Environment:
//   HEYREACH_API_KEY    - X-API-KEY value.
//   HEYREACH_CAMPAIGN_ID - Campaign id leads are added to. No per-campaign DB
//                          column exists yet (unlike Aimfox's
//                          aimfox_campaign_id) — this is a verify-only pass,
//                          not wired into the pipeline, so there is nothing
//                          to resolve per-lead yet.

const API_BASE = 'https://api.heyreach.io/api/public';

// Verbose request/response logging, enabled with HEYREACH_DEBUG=1.
function debugEnabled() {
  return Boolean(process.env.HEYREACH_DEBUG);
}

// Never log the full API key — show only a masked hint.
function maskKey(key) {
  if (!key) return '(missing)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function headersFor(apiKey) {
  return { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };
}

/**
 * Whether HeyReach is configured at all — used by callers to no-op cleanly
 * rather than throw when this integration hasn't been set up.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(process.env.HEYREACH_API_KEY);
}

/**
 * Fetch a campaign by id — its status and sender account ids
 * (campaignAccountIds), the linkedInAccountId(s) leads must be bound to when
 * added.
 *
 * GET /campaign/GetById?campaignId=<id>
 *
 * @param {number|string} campaignId
 * @returns {Promise<object>} the raw campaign object
 */
async function getCampaignById(campaignId) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('getCampaignById: HEYREACH_API_KEY is not set in the environment');
  }
  const url = `${API_BASE}/campaign/GetById`;
  const params = { campaignId };

  if (debugEnabled()) {
    console.error('[heyreach] → GET', url, params);
    console.error('[heyreach] → headers', { ...headersFor(apiKey), 'X-API-KEY': maskKey(apiKey) });
  }

  try {
    const { data } = await axios.get(url, { headers: headersFor(apiKey), params });
    if (debugEnabled()) {
      console.error('[heyreach] ← status', data?.status, '| campaignAccountIds', data?.campaignAccountIds);
    }
    return data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    if (debugEnabled()) {
      console.error('[heyreach] ✗ request failed, HTTP', status ?? '(none)', detail);
    }
    throw new Error(
      `getCampaignById: HeyReach GET /campaign/GetById failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * List campaigns, optionally filtered by a name keyword. Unlike
 * getCampaignById, this WORKS for DRAFT campaigns — confirmed live 2026-07-27
 * (see the header comment) — so this is the reliable lookup for anything
 * that might not be active yet, e.g. right after createCampaign.
 *
 * POST /campaign/GetAll  { offset, limit, filters?: { keyword } }
 *
 * @param {object} [options]
 * @param {string} [options.keyword] - Filter by name substring.
 * @param {number} [options.offset=0]
 * @param {number} [options.limit=20]
 * @returns {Promise<{totalCount:number, items:object[]}>}
 */
async function listCampaigns({ keyword, offset = 0, limit = 20 } = {}) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('listCampaigns: HEYREACH_API_KEY is not set in the environment');
  }
  const url = `${API_BASE}/campaign/GetAll`;
  const body = { offset, limit, ...(keyword ? { filters: { keyword } } : {}) };

  if (debugEnabled()) {
    console.error('[heyreach] → POST', url, JSON.stringify(body));
    console.error('[heyreach] → headers', { ...headersFor(apiKey), 'X-API-KEY': maskKey(apiKey) });
  }

  try {
    const { data } = await axios.post(url, body, { headers: headersFor(apiKey) });
    if (debugEnabled()) {
      console.error('[heyreach] ← totalCount', data?.totalCount, '| items', data?.items?.length);
    }
    return data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    if (debugEnabled()) {
      console.error('[heyreach] ✗ request failed, HTTP', status ?? '(none)', detail);
    }
    throw new Error(
      `listCampaigns: HeyReach POST /campaign/GetAll failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Create an empty lead list — a prerequisite for createCampaign, which
 * requires an existing linkedInUserListId (verified live: creating a
 * campaign without one, or with one that doesn't exist, fails with
 * {"errorMessage":"The list does not exist!"}).
 *
 * POST /list/CreateEmptyList  { name }
 *
 * @param {string} name
 * @returns {Promise<{id:number, name:string, listType:string}>} the full
 *   list object — `id` is the linkedInUserListId createCampaign needs.
 */
async function createEmptyList(name) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('createEmptyList: HEYREACH_API_KEY is not set in the environment');
  }
  const url = `${API_BASE}/list/CreateEmptyList`;
  const body = { name };

  if (debugEnabled()) {
    console.error('[heyreach] → POST', url, JSON.stringify(body));
  }

  try {
    const { data } = await axios.post(url, body, { headers: headersFor(apiKey) });
    if (debugEnabled()) {
      console.error('[heyreach] ← list created, id', data?.id);
    }
    return data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `createEmptyList: HeyReach POST /list/CreateEmptyList failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Create a campaign. Campaigns are created bare (DRAFT, no sequence) —
 * attach one afterward with setCampaignSequence. `linkedInUserListId` must
 * already exist (see createEmptyList); `linkedInAccountIds` are the sender
 * seat(s) allowed to run this campaign.
 *
 * POST /campaign/Create  { name, linkedInAccountIds, linkedInUserListId,
 *   excludeInOtherCampaigns?, excludeHasOtherAccConversations?,
 *   excludeContactedFromSenderInOtherCampaign?, excludeListId?, schedule? }
 * -> { campaignId }
 *
 * The resulting campaign is DRAFT — launch it with startCampaign() once a
 * sequence is attached (Resume and AddLeadsToCampaignV2 both explicitly
 * reject DRAFT campaigns; StartCampaign is the real first-activation call,
 * see header comment).
 *
 * @param {string} name - 1-50 chars.
 * @param {object} options
 * @param {number[]} options.linkedInAccountIds - 1-100 sender account ids.
 * @param {number} options.linkedInUserListId - Must already exist (see
 *   createEmptyList) and be type USER_LIST.
 * @param {boolean} [options.excludeInOtherCampaigns]
 * @param {boolean} [options.excludeHasOtherAccConversations]
 * @param {boolean} [options.excludeContactedFromSenderInOtherCampaign]
 * @param {number} [options.excludeListId] - Must differ from linkedInUserListId.
 * @param {object} [options.schedule] - Defaults to Mon-Fri 09:00-17:00 UTC
 *   when omitted (per secondary docs, not independently re-verified here).
 * @returns {Promise<number>} the new campaignId
 */
async function createCampaign(name, options) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('createCampaign: HEYREACH_API_KEY is not set in the environment');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('createCampaign: `name` is required');
  }
  if (!options?.linkedInAccountIds?.length) {
    throw new Error('createCampaign: `options.linkedInAccountIds` (non-empty array) is required');
  }
  if (!options?.linkedInUserListId) {
    throw new Error('createCampaign: `options.linkedInUserListId` is required');
  }

  const url = `${API_BASE}/campaign/Create`;
  const body = { name, ...options };

  if (debugEnabled()) {
    console.error('[heyreach] → POST', url, JSON.stringify(body, null, 2));
  }

  try {
    const { data } = await axios.post(url, body, { headers: headersFor(apiKey) });
    if (debugEnabled()) {
      console.error('[heyreach] ← campaignId', data?.campaignId);
    }
    return data?.campaignId;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `createCampaign: HeyReach POST /campaign/Create failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Attach (or replace) a campaign's automation sequence — the node tree
 * HeyReach walks per lead (connection request, messages, branching on
 * accepted/not-yet, etc.).
 *
 * POST /campaign/UpdateSequence  { campaignId, sequence }
 *
 * The tree (PublicSequenceNodeDto), CONFIRMED LIVE 2026-07-27 (see the
 * header comment for the exact validation errors this was built against):
 *   {
 *     nodeType: 'CONNECTION_REQUEST'|'MESSAGE'|'END'|... ,
 *     actionDelay: number,          // REQUIRED on every node, incl. END
 *     actionDelayUnit: 'HOUR'|'DAY',// min 3 hours, max 500 days
 *     payload?: {...},              // node-type-specific, see below
 *     conditionalNode?: {...},      // true/accepted branch
 *     unconditionalNode?: {...},    // false/not-yet branch, or "next" for
 *                                   // non-branching node types
 *   }
 * - CONNECTION_REQUEST/CHECK_IS_CONNECTION/CHECK_IS_OPEN_PROFILE need BOTH
 *   conditionalNode and unconditionalNode. Every other non-END node type
 *   takes only unconditionalNode. END is a leaf (no children) and
 *   terminates every path — every branch must end in one.
 * - CONNECTION_REQUEST payload needs `messages` (string[]) AND
 *   `fallbackMessage` (string) — omitting fallbackMessage is rejected.
 * - MESSAGE payload needs `messages` (string[], >=1 entry).
 *
 * @param {number|string} campaignId
 * @param {object} sequence - A PublicSequenceNodeDto tree, see above.
 * @returns {Promise<void>}
 */
async function setCampaignSequence(campaignId, sequence) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('setCampaignSequence: HEYREACH_API_KEY is not set in the environment');
  }
  const url = `${API_BASE}/campaign/UpdateSequence`;
  const body = { campaignId, sequence };

  if (debugEnabled()) {
    console.error('[heyreach] → POST', url, JSON.stringify(body, null, 2));
  }

  try {
    await axios.post(url, body, { headers: headersFor(apiKey) });
    if (debugEnabled()) {
      console.error('[heyreach] ← sequence accepted for campaign', campaignId);
    }
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `setCampaignSequence: HeyReach POST /campaign/UpdateSequence failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Pause a campaign. campaignId is a QUERY param, not the body (verified
 * live — a body-only attempt 400s with "campaignId field is required" even
 * though it's present in the JSON body).
 *
 * POST /campaign/Pause?campaignId=<id>
 *
 * @param {number|string} campaignId
 * @returns {Promise<void>}
 */
async function pauseCampaign(campaignId) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('pauseCampaign: HEYREACH_API_KEY is not set in the environment');
  }
  try {
    await axios.post(`${API_BASE}/campaign/Pause`, null, {
      headers: headersFor(apiKey),
      params: { campaignId },
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `pauseCampaign: HeyReach POST /campaign/Pause failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Resume a paused/finished/failed campaign. Same query-param convention as
 * pauseCampaign. CONFIRMED LIVE: explicitly rejects a DRAFT campaign
 * ({"errorMessage":"The campaign you are trying to resume is not paused,
 * finished or failed."}) — for a brand-new DRAFT campaign's first
 * activation, use startCampaign() instead.
 *
 * POST /campaign/Resume?campaignId=<id>
 *
 * @param {number|string} campaignId
 * @returns {Promise<void>}
 */
async function resumeCampaign(campaignId) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('resumeCampaign: HEYREACH_API_KEY is not set in the environment');
  }
  try {
    await axios.post(`${API_BASE}/campaign/Resume`, null, {
      headers: headersFor(apiKey),
      params: { campaignId },
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `resumeCampaign: HeyReach POST /campaign/Resume failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Launch a DRAFT campaign for the first time — CONFIRMED LIVE 2026-07-27
 * (see header comment): flips DRAFT -> IN_PROGRESS and sets `startedAt`.
 * Same query-param convention as pauseCampaign/resumeCampaign. This is the
 * correct call for a campaign's first activation; Resume rejects DRAFT.
 *
 * POST /campaign/StartCampaign?campaignId=<id>
 *
 * @param {number|string} campaignId
 * @returns {Promise<void>}
 */
async function startCampaign(campaignId) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    throw new Error('startCampaign: HEYREACH_API_KEY is not set in the environment');
  }
  try {
    await axios.post(`${API_BASE}/campaign/StartCampaign`, null, {
      headers: headersFor(apiKey),
      params: { campaignId },
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `startCampaign: HeyReach POST /campaign/StartCampaign failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

// Split "First Last" into { firstName, lastName } the same way instantly.js
// does for Instantly leads — first word is the first name, the rest (if any)
// is the last name; null when contact_name itself is missing.
function splitName(fullName) {
  if (!fullName || typeof fullName !== 'string') return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() || null;
  const lastName = parts.length ? parts.join(' ') : null;
  return { firstName, lastName };
}

/**
 * Add a lead's LinkedIn profile to a HeyReach campaign, bound to that
 * campaign's own sender account (its first campaignAccountIds entry).
 *
 * Looks the campaign up first (GetById) to get a live linkedInAccountId
 * rather than requiring one to be configured separately — one fewer env var,
 * and it can never point at a sender account not actually on the campaign.
 *
 * POST /campaign/AddLeadsToCampaignV2
 *   { campaignId, accountLeadPairs: [{ linkedInAccountId,
 *     lead: { profileUrl, firstName, lastName } }] }
 *
 * On 'added' or 'updated', best-effort stamps leads.linkedin_status =
 * 'queued' (COALESCE, so a webhook that already advanced it further is
 * never downgraded) — mirrors aimfox.js, so the Dashboard/stats reflect a
 * HeyReach add immediately rather than waiting on the first webhook event.
 *
 * Never a hard dependency: returns { outcome: 'skipped' } when
 * HEYREACH_API_KEY or HEYREACH_CAMPAIGN_ID is unset, the lead has no
 * contact_linkedin, or the campaign has no sender account attached. Only an
 * unexpected API failure throws.
 *
 * @param {object} lead - Lead row. Requires `contact_linkedin`; `contact_name`
 *   is split into firstName/lastName when present.
 * @returns {Promise<{outcome:('added'|'updated'|'skipped'|'failed'),
 *   reason?:string, campaignId?:(number|string), linkedInAccountId?:number}>}
 */
async function addLeadToCampaign(lead) {
  const apiKey = process.env.HEYREACH_API_KEY;
  if (!apiKey) {
    return { outcome: 'skipped', reason: 'HEYREACH_API_KEY is not set' };
  }

  if (!lead || typeof lead !== 'object' || !lead.contact_linkedin) {
    return { outcome: 'skipped', reason: 'lead has no contact_linkedin' };
  }

  const campaignId = process.env.HEYREACH_CAMPAIGN_ID;
  if (!campaignId) {
    return { outcome: 'skipped', reason: 'HEYREACH_CAMPAIGN_ID is not set' };
  }

  const campaign = await getCampaignById(campaignId);
  const linkedInAccountId = campaign?.campaignAccountIds?.[0];
  if (!linkedInAccountId) {
    return {
      outcome: 'skipped',
      reason: 'campaign has no sender account (campaignAccountIds is empty)',
      campaignId,
    };
  }

  const { firstName, lastName } = splitName(lead.contact_name);
  const body = {
    campaignId,
    accountLeadPairs: [
      {
        linkedInAccountId,
        lead: { profileUrl: lead.contact_linkedin, firstName, lastName },
      },
    ],
  };
  const url = `${API_BASE}/campaign/AddLeadsToCampaignV2`;

  if (debugEnabled()) {
    console.error('[heyreach] → POST', url, JSON.stringify(body, null, 2));
    console.error('[heyreach] → headers', { ...headersFor(apiKey), 'X-API-KEY': maskKey(apiKey) });
  }

  try {
    const { data } = await axios.post(url, body, { headers: headersFor(apiKey) });
    if (debugEnabled()) {
      console.error('[heyreach] ← response', JSON.stringify(data));
    }
    if (data?.failedLeadsCount > 0) {
      return { outcome: 'failed', reason: 'HeyReach reported a failed lead', campaignId, linkedInAccountId };
    }
    if (data?.addedLeadsCount > 0 || data?.updatedLeadsCount > 0) {
      // 'updated' means HeyReach found the profileUrl already on this
      // campaign (e.g. a duplicate add) rather than creating a fresh entry
      // — either way the lead IS confirmed in the campaign, so both
      // outcomes get the same DB stamp. Mirrors aimfox.js's addLeadToCampaign
      // (COALESCE so a webhook that already advanced this further, e.g. to
      // 'accepted', is never downgraded back to 'queued'). Best-effort:
      // never fail the add itself over this — 2026-07-27 finding, added
      // after a real add (Lizzie Imisson, lead 18417) left linkedin_status
      // NULL with no way to tell from our own dashboard/stats that she'd
      // actually been added.
      if (lead.id != null) {
        try {
          await db.query(
            `UPDATE leads SET linkedin_status = COALESCE(linkedin_status, 'queued') WHERE id = $1`,
            [lead.id]
          );
        } catch (err) {
          console.error(`[heyreach] failed to mark lead ${lead.id} queued:`, err.message);
        }
      }
      return {
        outcome: data.addedLeadsCount > 0 ? 'added' : 'updated',
        campaignId,
        linkedInAccountId,
      };
    }
    // All three counts were 0/undefined — HeyReach accepted the request but
    // did nothing (2026-07-27 finding: this happened on a real lead and was
    // NOT reflected in the campaign's leads afterward). Previously this
    // fell through to a hardcoded 'added', silently reporting success for a
    // request that visibly did nothing — do not repeat that.
    return {
      outcome: 'failed',
      reason: `HeyReach returned no added/updated/failed count: ${JSON.stringify(data)}`,
      campaignId,
      linkedInAccountId,
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    if (debugEnabled()) {
      console.error('[heyreach] ✗ request failed, HTTP', status ?? '(none)', detail);
    }
    throw new Error(
      `addLeadToCampaign: HeyReach POST /campaign/AddLeadsToCampaignV2 failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

module.exports = {
  isConfigured,
  getCampaignById,
  listCampaigns,
  createEmptyList,
  createCampaign,
  setCampaignSequence,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
  addLeadToCampaign,
};
