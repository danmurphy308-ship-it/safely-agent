const axios = require('axios');

// HubSpot CRM client — implements the "never email existing Safely customers"
// Critical Rule by checking leads against Transpoco's HubSpot before we save
// or send.
//
// Check ORDER matters: many customer contacts aren't in HubSpot individually,
// but their company is (matched by domain) — so the company check runs FIRST,
// and the contact-email check is the fallback.
//   1. company match: a HubSpot company with the lead's domain (`domain`
//      property) whose lifecyclestage is 'customer' OR that has open deals
//      (hs_num_open_deals > 0). Prospect companies with no open deal do NOT
//      block (marketing imports would otherwise wipe out most outreach).
//   2. contact match: ANY HubSpot contact with the lead's email. If the person
//      is in the CRM at all, someone at Transpoco already has a relationship
//      with them — cold outreach would step on it.
//
// Docs: https://developers.hubspot.com/docs/api/crm/search
//
// Environment:
//   HUBSPOT_ACCESS_TOKEN - private app token. When unset, checks are skipped
//                          (isExistingContact returns not-existing) so the app
//                          still works before HubSpot is connected — a warning
//                          is logged once per boot.

const API_BASE = 'https://api.hubapi.com';

// The HubSpot search API is rate-limited (~4 req/s), and imports check up to
// 100 leads in a loop — cache results in-memory so repeated emails/domains
// within a run cost nothing. Entries expire so a contact added to HubSpot
// mid-session is picked up within minutes.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { value: boolean, expires: number }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

let warnedNoToken = false;

function getToken() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token && !warnedNoToken) {
    warnedNoToken = true;
    console.warn(
      '[hubspot] HUBSPOT_ACCESS_TOKEN is not set — existing-customer checks are SKIPPED. ' +
        'Set it in .env to enforce the "never email existing customers" rule.'
    );
  }
  return token || null;
}

/**
 * Run one CRM search and return the first matching record (or null).
 *
 * POST /crm/v3/objects/:objectType/search; limit 1 — we only need existence
 * plus enough properties to derive a block reason.
 *
 * @param {string} token
 * @param {('contacts'|'companies')} objectType
 * @param {object[]} filterGroups - HubSpot filterGroups (OR of AND-groups).
 * @param {string[]} [properties] - Properties to return on the match.
 * @returns {Promise<object|null>}
 */
async function searchFirst(token, objectType, filterGroups, properties = []) {
  const { data } = await axios.post(
    `${API_BASE}/crm/v3/objects/${objectType}/search`,
    { filterGroups, properties, limit: 1 },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
  );
  return data?.results?.[0] ?? null;
}

// Company-by-domain check: blocks when the domain belongs to a HubSpot company
// that is a customer OR has open deals. Returns the block reason, or false.
async function checkCompanyDomain(token, domain) {
  const domainFilter = { propertyName: 'domain', operator: 'EQ', value: domain };
  const match = await searchFirst(
    token,
    'companies',
    [
      { filters: [domainFilter, { propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] },
      { filters: [domainFilter, { propertyName: 'hs_num_open_deals', operator: 'GT', value: '0' }] },
    ],
    ['domain', 'lifecyclestage', 'hs_num_open_deals']
  );
  if (!match) return false;
  return match.properties?.lifecyclestage === 'customer' ? 'existing_customer' : 'active_deal';
}

/**
 * Check whether a lead already has a relationship with Safely/Transpoco in
 * HubSpot. Company-domain check FIRST (customer lifecycle stage or open
 * deals), contact-email check as the fallback — many customer contacts are
 * not in HubSpot individually but their company is (see module header).
 *
 * Returns `{ existing: false }` without calling HubSpot when no token is
 * configured. On a HubSpot API error this THROWS — callers decide whether to
 * fail open (sourcing) or closed (sending).
 *
 * @param {string} [email]  - Lead contact email.
 * @param {string} [domain] - Lead company domain.
 * @returns {Promise<{existing:boolean, reason:(string|null)}>}
 *   reason is 'existing_customer' (customer lifecycle stage), 'active_deal'
 *   (open deals on the company), or 'existing_hubspot_contact' (email match).
 */
async function isExistingContact(email, domain) {
  const token = getToken();
  if (!token) return { existing: false, reason: null };

  // 1. Company by domain — customer lifecycle stage or open deals block.
  if (domain) {
    const key = `company:${domain.toLowerCase()}`;
    let reason = cacheGet(key);
    if (reason === undefined) {
      reason = await checkCompanyDomain(token, domain);
      cacheSet(key, reason);
    }
    if (reason) return { existing: true, reason };
  }

  // 2. Fallback: contact by email — any CRM contact blocks.
  if (email) {
    const key = `contact:${email.toLowerCase()}`;
    let match = cacheGet(key);
    if (match === undefined) {
      match = Boolean(
        await searchFirst(token, 'contacts', [
          { filters: [{ propertyName: 'email', operator: 'EQ', value: email }] },
        ])
      );
      cacheSet(key, match);
    }
    if (match) return { existing: true, reason: 'existing_hubspot_contact' };
  }

  return { existing: false, reason: null };
}

module.exports = { isExistingContact };
