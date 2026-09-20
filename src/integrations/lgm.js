const axios = require('axios');

// LaGrowthMachine (LGM) API client — LinkedIn + email outreach automation.
// FIRST PHASE / EXPLORATORY: every function here was verified against the
// live API on 2026-07-23 (LGM Pro, one workspace, one identity with
// linkedinConnected:false). Nothing in this file is wired into the pipeline
// yet — see the probe report in conversation for the full write-up.
//
// Sending model: campaign-first, like Aimfox — you add a lead to an
// AUDIENCE (not directly to a campaign), and any LGM campaign already
// attached to that audience runs its own connect/message sequence
// automatically. There is NO direct "send this LinkedIn message now" endpoint
// in the public API: every plausible path (/flow/messages, /flow/message,
// /flow/leads/:id/message) returned a genuine 404. This was cross-checked
// against LGM's own documented tool list (13 tools, via Composio's toolkit
// page) which likewise has no send-message action. Treat this the same way
// aimfox.js treats sending: addLeadToAudience() is the whole interface: LGM's
// own automation (a campaign attached to the audience) does the rest.
//
// Auth: NOT a header — the API key goes in the query string as `apikey` on
// every request (both GET and POST). Docs: base
// https://apiv2.lagrowthmachine.com/flow (Postman collection linked from
// LGM's settings page; the rendered doc page itself 404s to automated
// fetches, so every endpoint/field below was rediscovered by probing the
// live API's Joi-style validation errors, which are unusually informative —
// e.g. POST /flow/leads with an unknown top-level key returns exactly
// `"body.<key>" is not allowed`).
//
// Environment:
//   LGM_API_KEY - query-param API key (Settings -> Integrations & API in the
//                 LGM app). Unset -> every function here is a no-op/throws
//                 the same way aimfox.js behaves without AIMFOX_API_KEY.

const API_BASE = 'https://apiv2.lagrowthmachine.com/flow';

// Never log the full API key — show only a masked hint (matches
// apollo.js/clay.js's maskKey convention).
function maskKey(key) {
  if (!key) return '(missing)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function debugEnabled() {
  return Boolean(process.env.LGM_DEBUG);
}

/** Whether LGM is usable (key present). Mirrors clay.js's isPublicApiConfigured(). */
function isConfigured() {
  return Boolean(process.env.LGM_API_KEY);
}

// One HTTP call to the LGM API. Auth is a query param, not a header — every
// call needs `apikey` merged into `params`. Throws a descriptive Error (with
// the key masked) on any non-2xx response.
async function lgmRequest(method, path, { params, data } = {}) {
  const apikey = process.env.LGM_API_KEY;
  if (!apikey) {
    throw new Error('LGM: LGM_API_KEY is not set in the environment');
  }

  if (debugEnabled()) {
    console.error(`[lgm] → ${method.toUpperCase()} ${path}`, {
      params: { ...(params ?? {}), apikey: maskKey(apikey) },
      data: data ?? {},
    });
  }

  try {
    const response = await axios.request({
      method,
      url: `${API_BASE}${path}`,
      params: { ...(params ?? {}), apikey },
      data,
    });
    if (debugEnabled()) {
      console.error(`[lgm] ← ${response.status}`, JSON.stringify(response.data).slice(0, 2000));
    }
    return response;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`LGM ${method.toUpperCase()} ${path} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
  }
}

/**
 * List every connected identity (sending account) in the LGM workspace.
 * GET /flow/identities -> { statusCode, identities: [{ id, name,
 * linkedinConnected, companyName, companyUrl, location, jobTitle }] }.
 *
 * An identity's `id` is NOT the same as a member's `id` (verified live: two
 * different ids for the same person) — identities are the thing you attach
 * to an audience as the "sender" (see createAudienceFromLinkedinUrl below);
 * members are workspace users (see listMembers).
 *
 * @returns {Promise<object[]>}
 */
async function listIdentities() {
  const { data } = await lgmRequest('get', '/identities');
  return data?.identities ?? [];
}

/**
 * List workspace members (users), each { id, name, label }. This `id` is
 * what the caller referred to as "memberId" for message sending — but see
 * the file-level note: there is no direct send-message endpoint in the
 * public API, so no function here currently consumes it. Kept for parity
 * with what the API exposes.
 *
 * GET /flow/members -> { statusCode, members: [...] }.
 *
 * @returns {Promise<object[]>}
 */
async function listMembers() {
  const { data } = await lgmRequest('get', '/members');
  return data?.members ?? [];
}

/**
 * List every audience in the workspace, each carrying its own `size`,
 * `sourceUrl` (the LinkedIn URL it was seeded from, if any), and `type`
 * (e.g. "CLASSIC"). GET /flow/audiences -> { statusCode, audiences: [...] }.
 *
 * @returns {Promise<object[]>}
 */
async function listAudiences() {
  const { data } = await lgmRequest('get', '/audiences');
  return data?.audiences ?? [];
}

/**
 * Create a NEW audience by scraping an initial LinkedIn URL through one of
 * the workspace's connected identities. CONFIRMED LIVE but not exercised
 * successfully end-to-end here: this endpoint validates the LinkedIn URL by
 * actually trying to resolve/scrape it (a placeholder URL returned "Invalid
 * LinkedIn URL"), and the one identity in this workspace has
 * linkedinConnected:false, so a real run would very likely need a genuinely
 * connected LinkedIn identity to succeed. This is a DIFFERENT creation path
 * than createOrUpdateLead below, which auto-creates an (initially empty)
 * audience by name with no LinkedIn scrape at all — that's the one worth
 * using for pushing our own already-known leads in.
 *
 * POST /flow/audiences { audience: <name>, linkedinUrl: <seed URL>,
 * identityId: <from listIdentities> }.
 *
 * @param {string} name
 * @param {string} linkedinUrl - A real, resolvable LinkedIn URL (search or profile).
 * @param {string} identityId
 * @returns {Promise<object>}
 */
async function createAudienceFromLinkedinUrl(name, linkedinUrl, identityId) {
  const { data } = await lgmRequest('post', '/audiences', {
    data: { audience: name, linkedinUrl, identityId },
  });
  return data;
}

/**
 * Create or update a lead, placing it into an audience (auto-created by name
 * if it doesn't exist yet — CONFIRMED LIVE, no LinkedIn scrape/validation
 * happens on this path, unlike createAudienceFromLinkedinUrl). This is the
 * function that matters for parity with aimfox.js's addLeadToCampaign: same
 * shape (never a hard dependency, structured outcome, no-op when unconfigured).
 *
 * At least one of {persoEmail, proEmail, linkedinUrl, twitter} OR
 * {firstname+lastname plus companyName/companyUrl} is required — confirmed
 * live (firstname+lastname alone, with no company, was rejected as "Missing
 * Parameters for lead"). Passing the SAME linkedinUrl/email again on a lead
 * already in the audience is safe (confirmed: "Lead is a duplicate & has
 * been merged/ignored. Added to existing audience.") but NOT a true update —
 * merge only fills fields that were previously empty. Confirmed live:
 * re-sending customAttribute1/2 with NEW values on a lead that already had
 * values in those slots left the old values untouched and returned
 * "...has been ignored." instead of "...has been merged." Treat this as
 * create-or-attach, not upsert — there's no confirmed way yet to overwrite
 * an already-set field via this endpoint.
 *
 * customAttributes is OUR convention, not LGM's: the API only exposes 20
 * anonymous slots (customAttribute1..customAttribute20, confirmed live via
 * GET /flow/leads/search echoing them back), no per-slot names. Each
 * {key, value} entry here is serialized as "key:value" into the next free
 * slot, in insertion order, so at least the semantic label survives even
 * though LGM itself doesn't store one.
 *
 * POST /flow/leads { audience, firstname, lastname, linkedinUrl, proEmail,
 * persoEmail, companyName, companyUrl, jobTitle, twitter, leadId (to target
 * an update instead of a fresh match), customAttribute1..20 }.
 *
 * Never a hard dependency: returns { outcome: 'skipped' } when LGM_API_KEY
 * is unset or the lead has neither a LinkedIn URL nor an email (nothing LGM
 * can key off). Only unexpected API failures throw.
 *
 * @param {object} lead - Our lead row shape: contact_name, contact_email,
 *   contact_linkedin, company_name, company_url, contact_title.
 * @param {object} options
 * @param {string} options.audienceName - Audience to create/add into.
 * @param {object} [options.customAttributes] - Plain {label: value} map,
 *   packed into customAttribute1.. in insertion order.
 * @param {string} [options.leadId] - Target an existing LGM lead for update.
 * @returns {Promise<{outcome:('added'|'skipped'), leadId?:string,
 *   audienceName?:string, message?:string, reason?:string}>}
 */
async function createOrUpdateLead(lead, options = {}) {
  if (!isConfigured()) {
    return { outcome: 'skipped', reason: 'LGM_API_KEY is not set' };
  }
  if (!options.audienceName) {
    return { outcome: 'skipped', reason: 'options.audienceName is required' };
  }
  if (!lead || (!lead.contact_linkedin && !lead.contact_email)) {
    return { outcome: 'skipped', reason: 'lead has neither contact_linkedin nor contact_email' };
  }

  const [firstname, ...rest] = (lead.contact_name || '').trim().split(/\s+/).filter(Boolean);
  const lastname = rest.join(' ') || undefined;

  const body = {
    audience: options.audienceName,
    linkedinUrl: lead.contact_linkedin || undefined,
    proEmail: lead.contact_email || undefined,
    companyName: lead.company_name || undefined,
    companyUrl: lead.company_url || undefined,
    jobTitle: lead.contact_title || undefined,
    firstname,
    lastname,
    leadId: options.leadId || undefined,
  };

  let slot = 1;
  for (const [label, value] of Object.entries(options.customAttributes ?? {})) {
    if (slot > 20) break; // LGM caps at customAttribute20 (confirmed live).
    body[`customAttribute${slot}`] = `${label}:${value}`;
    slot += 1;
  }

  // Strip undefined keys — the API's Joi-style validator rejects unknown
  // keys outright, so only send fields we actually have.
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  const { data } = await lgmRequest('post', '/leads', { data: body });
  return { outcome: 'added', leadId: data?.leadId, audienceName: options.audienceName, message: data?.message };
}

/**
 * Remove a lead from an audience by name, matched the same way
 * createOrUpdateLead matches ("Missing Parameters for lead" without at least
 * one identifying field — linkedinUrl/proEmail/persoEmail/twitter, `leadId`
 * itself is explicitly rejected: "leadId" is not allowed). Confirmed live:
 * drops the lead's audiences array to not include this audience and the
 * audience's `size` count accordingly — but does NOT delete the lead record
 * itself (still findable via searchLeadByLinkedin afterward, just orphaned
 * from every audience), and there is no confirmed way to delete an audience
 * or a lead outright — this is the only removal primitive LGM's public API
 * exposes (matches its own documented tool list: "Remove Lead From
 * Audiences" exists, "Delete Audience"/"Delete Lead" do not).
 *
 * POST /flow/leads/removeFromAudience { audience: <name>, linkedinUrl (or
 * another identifying field) } -> { statusCode: 200 }.
 *
 * @param {string} audienceName
 * @param {string} linkedinUrl - Must match the lead's stored linkedinUrl exactly.
 * @returns {Promise<boolean>}
 */
async function removeLeadFromAudience(audienceName, linkedinUrl) {
  const { data } = await lgmRequest('post', '/leads/removeFromAudience', {
    data: { audience: audienceName, linkedinUrl },
  });
  return data?.statusCode === 200;
}

/**
 * Look up a lead by LinkedIn URL (the only search field confirmed live).
 * GET /flow/leads/search?linkedinUrl=... -> { statusCode, lead: {...} }
 * (full lead record — see createOrUpdateLead's docstring for the field list,
 * confirmed live including all 20 customAttribute slots).
 *
 * @param {string} linkedinUrl
 * @returns {Promise<object|null>}
 */
async function searchLeadByLinkedin(linkedinUrl) {
  const { data } = await lgmRequest('get', '/leads/search', { params: { linkedinUrl } });
  return data?.lead ?? null;
}

/**
 * List registered inbox webhooks. Note the endpoint's own camelCase name —
 * inconsistent with every other resource path (/identities, /members,
 * /audiences, /leads are all lowercase), but confirmed live as-is.
 *
 * GET /flow/inboxWebhooks -> a bare array (no { statusCode, ... } wrapper,
 * unlike every other GET endpoint here — confirmed live).
 *
 * @returns {Promise<object[]>}
 */
async function listInboxWebhooks() {
  const { data } = await lgmRequest('get', '/inboxWebhooks');
  return data ?? [];
}

/**
 * Register an inbox webhook for real-time LinkedIn/email message
 * notifications. POST /flow/inboxWebhooks { url, name } -> { id, url, key,
 * type: 'INBOX_EVENT', campaigns: ['all'], audiences: ['all'], tags: [],
 * createdAt } — confirmed live; `name` comes back as `key` on the created
 * object. Defaults to every campaign/audience ("all") with no way to scope
 * it narrower observed in this pass — worth re-checking before relying on
 * it for a specific campaign only.
 *
 * @param {string} url - Publicly reachable callback URL.
 * @param {string} name
 * @returns {Promise<object>}
 */
async function createInboxWebhook(url, name) {
  const { data } = await lgmRequest('post', '/inboxWebhooks', { data: { url, name } });
  return data;
}

/**
 * Delete a registered inbox webhook by id. DELETE
 * /flow/inboxWebhooks/:id -> { success: true } — confirmed live.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function deleteInboxWebhook(id) {
  const { data } = await lgmRequest('delete', `/inboxWebhooks/${id}`);
  return Boolean(data?.success);
}

module.exports = {
  isConfigured,
  listIdentities,
  listMembers,
  listAudiences,
  createAudienceFromLinkedinUrl,
  createOrUpdateLead,
  removeLeadFromAudience,
  searchLeadByLinkedin,
  listInboxWebhooks,
  createInboxWebhook,
  deleteInboxWebhook,
};
