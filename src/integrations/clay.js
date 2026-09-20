const axios = require('axios');
const { stripCredentialSuffixes, matchByNameAndDomain, LOCKED_EMAIL_MARKER } = require('./apollo');

// Clay integration — two independent models:
//
// 1. PUBLIC API (synchronous, preferred): findLeads() searches Clay's GTM
//    database over plain HTTPS and enriches work emails via a Clay-managed
//    routine. No CLI, no callback endpoint. See "Public API" section below.
//    Docs: https://developers.clay.com (base https://api.clay.com/public/v0)
//
// 2. WEBHOOK MODEL (legacy, async): push an ICP trigger into a Clay table's
//    inbound webhook; the table enriches (minutes) and POSTs each row back to
//    our /api/webhooks/clay callback. Kept for tables already wired up.
//    Docs: https://university.clay.com/docs/http-api-integration-overview
//
// Environment:
//   CLAY_PUBLIC_API_KEY  - Public API key (Clay: Settings → Account → API keys).
//                          Unset ⇒ findLeads() is a no-op returning [].
//   CLAY_EMAIL_ROUTINE_ID- Routine id of the work-email function (function:t_...).
//                          Unset ⇒ search still runs, email enrichment is skipped.
//   CLAY_API_KEY         - webhook-model bearer token (legacy flow only).
//   CLAY_WEBHOOK_URL     - webhook-model Clay table inbound URL (legacy flow only).
//   CLAY_DEBUG=1         - verbose request/response logging.

// ============================================================
// Public API — search + email enrichment
// ============================================================

const CLAY_PUBLIC_API_BASE = 'https://api.clay.com/public/v0';

// Retry/backoff for 429s: honor Retry-After when present, else exponential
// backoff with jitter (per https://developers.clay.com/public-api/rate-limits).
const MAX_RATE_LIMIT_RETRIES = 4;

// Routine runs accept at most 100 items per call.
const ROUTINE_BATCH_LIMIT = 100;

// Poll async routine results at a modest interval (the docs ask for this
// explicitly) and give up after a bounded wait — leads are then saved without
// emails rather than failing the whole sourcing run.
const ENRICH_POLL_INTERVAL_MS = 3000;
const ENRICH_POLL_TIMEOUT_MS = 3 * 60 * 1000;

// Clay caps search page size at 500.
const MAX_PER_PAGE = 500;
const DEFAULT_PER_PAGE = 25;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debugEnabled() {
  return Boolean(process.env.CLAY_DEBUG);
}

// Never log the full API key — show only a masked hint.
function maskKey(key) {
  if (!key) return '(missing)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Whether the Public API is usable (key present). */
function isPublicApiConfigured() {
  return Boolean(process.env.CLAY_PUBLIC_API_KEY);
}

// One HTTP call to the Public API with 429 retry handling. Throws a
// descriptive Error on any other failure.
async function clayPublicRequest(method, path, { params, data } = {}) {
  const apiKey = process.env.CLAY_PUBLIC_API_KEY;
  if (!apiKey) {
    throw new Error('Clay Public API: CLAY_PUBLIC_API_KEY is not set in the environment');
  }

  for (let attempt = 0; ; attempt++) {
    if (debugEnabled()) {
      console.error(`[clay] → ${method.toUpperCase()} ${path}`, {
        params: params ?? {},
        data: data ?? {},
        key: maskKey(apiKey),
      });
    }
    try {
      const response = await axios.request({
        method,
        url: `${CLAY_PUBLIC_API_BASE}${path}`,
        params,
        data,
        headers: { 'Content-Type': 'application/json', 'clay-api-key': apiKey },
      });
      if (debugEnabled()) {
        console.error(`[clay] ← ${response.status}`, JSON.stringify(response.data).slice(0, 2000));
      }
      return response;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(err.response.headers?.['retry-after']);
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
        if (debugEnabled()) {
          console.error(`[clay] ← 429, retrying in ${waitMs}ms (attempt ${attempt + 1})`);
        }
        await delay(waitMs);
        continue;
      }
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(
        `Clay Public API ${method.toUpperCase()} ${path} failed${
          status ? ` (HTTP ${status})` : ''
        }: ${detail}`
      );
    }
  }
}

// Our common industry phrasings → Clay's LinkedIn-taxonomy industry names.
// Field names and allowed values verified against
// GET /search/filters-mode/fields?source_type=people on 2026-07-13.
// Unmapped values pass through verbatim (Clay rejects unknown ones loudly).
const CLAY_INDUSTRY_TAXONOMY = {
  utilities: 'Utilities',
  construction: 'Construction',
  healthcare: 'Hospitals and Health Care',
  'health care': 'Hospitals and Health Care',
  health: 'Hospitals and Health Care',
  nhs: 'Hospitals and Health Care',
  telecoms: 'Telecommunications',
  telecom: 'Telecommunications',
  telecommunications: 'Telecommunications',
  facilities: 'Facilities Services',
  'facilities management': 'Facilities Services',
  councils: 'Government Administration',
  government: 'Government Administration',
  'local government': 'Government Administration',
  environmental: 'Environmental Services',
  waste: 'Environmental Services',
  energy: 'Oil and Gas',
  security: 'Security and Investigations',
};

// Clay expresses company size as fixed headcount buckets (company_sizes).
const COMPANY_SIZE_BUCKETS = [
  { label: '1', max: 1 },
  { label: '2-10', max: 10 },
  { label: '11-50', max: 50 },
  { label: '51-200', max: 200 },
  { label: '201-500', max: 500 },
  { label: '501-1,000', max: 1000 },
  { label: '1,001-5,000', max: 5000 },
  { label: '5,001-10,000', max: 10000 },
  { label: '10,001+', max: Infinity },
];

// Title fragments excluded from every people search — roles that never buy
// road-fleet safety (sales) or belong to other transport modes (mirrors
// apollo.js's person_not_titles exclusions).
const EXCLUDED_TITLE_KEYWORDS = ['sales', 'aviation', 'marine', 'rail', 'warehouse', 'aircraft'];

// Translate ICP criteria into Clay filters-mode people filters.
function buildPeopleFilters(icp = {}) {
  const industries = icp.industries ?? icp.icp_industries ?? [];
  const locations = icp.locations ?? icp.icp_locations ?? [];
  const titles = icp.titles ?? icp.icp_titles ?? [];
  const minCompanySize =
    icp.minCompanySize ?? icp.min_company_size ?? icp.icp_min_fleet_size ?? null;

  const filters = {
    job_title_exclude_keywords: EXCLUDED_TITLE_KEYWORDS,
  };

  if (titles.length) filters.job_title_keywords = titles;
  // `locations` accepts cities and countries alike — matches how our ICP
  // stores them (e.g. "United Kingdom", "Dublin").
  if (locations.length) filters.locations = locations;

  if (industries.length) {
    filters.company_industries_include = [
      ...new Set(
        industries.map((industry) => {
          if (typeof industry !== 'string') return industry;
          return CLAY_INDUSTRY_TAXONOMY[industry.trim().toLowerCase()] ?? industry;
        })
      ),
    ];
  }

  // Include every bucket that can contain a company at/above the minimum
  // (a straddling bucket like 51-200 for min 100 stays in — filtering it out
  // would drop qualifying companies).
  if (minCompanySize != null && minCompanySize !== '') {
    const min = Number(minCompanySize);
    filters.company_sizes = COMPANY_SIZE_BUCKETS.filter((b) => b.max >= min).map((b) => b.label);
  }

  return filters;
}

/**
 * Create a filters-mode people search and return its search id. The id is a
 * stateful server-side iterator: each fetchSearchPage() call advances it.
 *
 * @param {object} icp - ICP criteria (campaign-row or plain field names).
 * @returns {Promise<string>} search_id
 */
async function createPeopleSearch(icp = {}) {
  const { data } = await clayPublicRequest('post', '/search/filters-mode', {
    data: { source_type: 'people', filters: buildPeopleFilters(icp) },
  });
  if (!data?.search_id) {
    throw new Error(`createPeopleSearch: Clay returned no search_id: ${JSON.stringify(data)}`);
  }
  return data.search_id;
}

/**
 * Fetch the next page of an existing search. Clay advances the iterator
 * server-side — there is no way to re-fetch or seek an earlier page.
 *
 * @param {string} searchId
 * @param {object} [options]
 * @param {number} [options.limit=25] - Records to fetch (max 500).
 * @returns {Promise<{records: object[], hasMore: boolean}>}
 */
async function fetchSearchPage(searchId, options = {}) {
  const limit = Math.min(MAX_PER_PAGE, Math.max(1, Number(options.limit) || DEFAULT_PER_PAGE));
  const { data } = await clayPublicRequest('post', `/search/filters-mode/${searchId}/run`, {
    data: { limit },
  });
  return { records: data?.data ?? [], hasMore: Boolean(data?.has_more) };
}

// First non-empty value among the given keys on a record.
function pick(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

// Map one Clay people-search record to a `leads` table row shape. Record shape
// verified against a live response on 2026-07-13: { name, first_name,
// last_name, url, domain, structured_location: {city, state, country, ...},
// latest_experience_title, latest_experience_company, ... }. Search results
// never carry emails (enrichLeadsWithEmails fills those) nor employee counts
// (company_sizes filtering happens server-side; the count itself isn't returned).
function mapClaySearchRecordToLead(record = {}) {
  const contactName = stripCredentialSuffixes(
    pick(record, ['name', 'full_name']) ||
      [record.first_name, record.last_name].filter(Boolean).join(' ') ||
      null
  );

  const location =
    record.structured_location && typeof record.structured_location === 'object'
      ? record.structured_location
      : {};

  return {
    company_name: pick(record, ['latest_experience_company', 'company_name', 'company']),
    contact_name: contactName,
    contact_email: pick(record, ['email', 'work_email']),
    contact_title: pick(record, ['latest_experience_title', 'title', 'job_title']),
    contact_linkedin: pick(record, ['url', 'linkedin_url', 'linkedin', 'profile_url']),
    company_url: pick(record, ['company_url', 'company_website', 'website']),
    company_domain: pick(record, ['domain', 'company_domain']),
    industry: pick(record, ['company_industry', 'industry']),
    // Clay search has no fleet-size signal; left for enrichment downstream.
    fleet_size: null,
    country: pick(location, ['country', 'country_name']) ?? pick(record, ['country']),
    employee_count: pick(record, ['employee_count', 'company_size', 'headcount']),
    raw_enrichment: record,
  };
}

// Find the first email-shaped string in a routine result, checking the common
// key names before falling back to a value scan — routine output field names
// depend on which Clay-managed function CLAY_EMAIL_ROUTINE_ID points at.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function extractEmail(result) {
  if (!result || typeof result !== 'object') return null;
  const direct = pick(result, ['email', 'work_email', 'business_email', 'contact_email']);
  if (typeof direct === 'string' && EMAIL_RE.test(direct.trim())) return direct.trim();
  for (const value of Object.values(result)) {
    if (typeof value === 'string' && EMAIL_RE.test(value.trim())) return value.trim();
    if (value && typeof value === 'object') {
      const nested = extractEmail(value);
      if (nested) return nested;
    }
  }
  return null;
}

// Poll a routine run until complete, then return every per-item result
// (following the results cursor). Throws on timeout.
async function fetchRoutineRunResults(runId) {
  const startedAt = Date.now();
  for (;;) {
    const response = await clayPublicRequest('get', `/routines/run/${runId}/results`, {
      params: { limit: 100 },
    });

    if (response.status === 200 && response.data?.status === 'complete') {
      let items = response.data.data ?? [];
      let cursor = response.data.cursor;
      // Follow the cursor for large runs; bounded so a misbehaving cursor
      // can't loop forever (100 items/page × 50 pages ≫ any batch we submit).
      for (let pages = 0; cursor && pages < 50; pages++) {
        const next = await clayPublicRequest('get', `/routines/run/${runId}/results`, {
          params: { limit: 100, cursor },
        });
        const pageItems = next.data?.data ?? [];
        if (!pageItems.length) break;
        items = items.concat(pageItems);
        cursor = next.data?.cursor;
      }
      return items;
    }

    if (Date.now() - startedAt > ENRICH_POLL_TIMEOUT_MS) {
      throw new Error(`routine run ${runId} still in progress after ${ENRICH_POLL_TIMEOUT_MS}ms`);
    }
    await delay(ENRICH_POLL_INTERVAL_MS);
  }
}

/**
 * Enrich mapped leads with work emails, in two layers:
 *
 *  1. The Clay-managed routine (CLAY_EMAIL_ROUTINE_ID) — the preferred path.
 *  2. Apollo bulk_match, matched by name + company domain — a fallback used
 *     whenever the routine is unset OR a routine call fails (e.g. it's
 *     blocked by an admin toggle on Clay's side). This lets a
 *     lead_source=clay campaign run end to end even while the routine is
 *     unavailable; Clay takes back over automatically once it's working.
 *
 * Every enriched lead is tagged with which path resolved its email
 * (lead.raw_enrichment.email_enrichment_source: 'clay_routine' |
 * 'apollo_bulk_match'), and a summary is logged. Neither path is a hard
 * dependency — sourcing must not die on an enrichment hiccup, so a lead that
 * neither path can resolve is simply saved without an email.
 *
 * NOTE: the Clay routine's input schema must accept (a subset of) the input
 * names sent here: full_name, company_name, company_domain, linkedin_url.
 * Check the chosen function's inputs in the Clay app and adjust if it differs.
 *
 * @param {object[]} leads - Leads as produced by mapClaySearchRecordToLead.
 * @returns {Promise<object[]>} The same leads, with contact_email filled where found.
 */
async function enrichLeadsWithEmails(leads = []) {
  // Only look up leads that can be identified and don't already have an email.
  const enrichable = leads.filter(
    (lead) =>
      lead &&
      !lead.contact_email &&
      lead.contact_name &&
      (lead.company_domain || lead.company_name || lead.contact_linkedin)
  );
  if (!enrichable.length) return leads;

  const viaRoutine = await enrichViaClayRoutine(enrichable);

  // Apollo bulk_match needs a name plus something to identify the company —
  // leads with only a LinkedIn URL can't be matched this way and are left as
  // they are (still eligible for the linkedin-only routing downstream).
  const stillNeeded = enrichable.filter(
    (lead) => !lead.contact_email && (lead.company_domain || lead.company_name)
  );
  const viaApollo = stillNeeded.length ? await enrichViaApolloFallback(stillNeeded) : 0;

  const resolved = enrichable.filter((lead) => lead.contact_email).length;
  console.log(
    `[clay] email enrichment: ${resolved}/${enrichable.length} lead(s) got an email ` +
      `(clay_routine: ${viaRoutine}, apollo_bulk_match: ${viaApollo}, none: ${
        enrichable.length - resolved
      })`
  );
  for (const lead of enrichable) {
    console.log(
      `[clay] enrichment path — ${lead.contact_name} @ ${lead.company_name}: ` +
        `${lead.raw_enrichment?.email_enrichment_source ?? 'none'}`
    );
  }

  return leads;
}

// Layer 1: the Clay-managed routine (CLAY_EMAIL_ROUTINE_ID). Batches of ≤100,
// polled to completion with Retry-After-aware backoff. Spends Clay credits
// per lookup. Returns the count of leads it resolved an email for.
//
// Never throws: a missing key/routine id, a failed routine-run POST (the
// admin-toggle case), or a timed-out poll are all caught and logged so the
// caller falls through to the Apollo fallback instead of the whole
// enrichment (or the pipeline run) dying.
async function enrichViaClayRoutine(enrichable) {
  const routineId = process.env.CLAY_EMAIL_ROUTINE_ID;
  if (!isPublicApiConfigured() || !routineId) {
    console.warn(
      '[clay] CLAY_EMAIL_ROUTINE_ID is not set — skipping the Clay routine, ' +
        `falling back to Apollo bulk_match for ${enrichable.length} lead(s)`
    );
    return 0;
  }

  let resolved = 0;
  for (let offset = 0; offset < enrichable.length; offset += ROUTINE_BATCH_LIMIT) {
    const batch = enrichable.slice(offset, offset + ROUTINE_BATCH_LIMIT);
    const items = batch.map((lead, idx) => {
      const inputs = {
        full_name: lead.contact_name,
        company_name: lead.company_name,
        company_domain: lead.company_domain,
        linkedin_url: lead.contact_linkedin,
      };
      // Drop empty inputs rather than sending nulls the routine may reject.
      for (const key of Object.keys(inputs)) {
        if (inputs[key] == null || inputs[key] === '') delete inputs[key];
      }
      return { id: String(offset + idx), inputs };
    });

    let runId;
    try {
      const { data } = await clayPublicRequest('post', `/routines/${routineId}/run`, {
        data: { items },
      });
      runId = data?.routine_run_id;
      if (!runId) {
        console.warn(`[clay] email routine returned no routine_run_id: ${JSON.stringify(data)}`);
        continue;
      }
    } catch (err) {
      console.warn(
        `[clay] email routine call failed (likely blocked by an admin toggle) — ` +
          `this batch will fall back to Apollo: ${err.message}`
      );
      continue;
    }

    let results;
    try {
      results = await fetchRoutineRunResults(runId);
    } catch (err) {
      console.warn(
        `[clay] email enrichment run ${runId} unresolved: ${err.message} — ` +
          'this batch will fall back to Apollo'
      );
      continue;
    }

    for (const item of results) {
      if (item?.status !== 'complete') continue;
      const lead = enrichable[Number(item.id)];
      const email = extractEmail(item.result);
      if (lead && email) {
        lead.contact_email = email;
        lead.raw_enrichment = {
          ...lead.raw_enrichment,
          clay_email_enrichment: item.result,
          email_enrichment_source: 'clay_routine',
        };
        resolved++;
      }
    }
  }

  return resolved;
}

// Layer 2 (fallback): Apollo bulk_match, matched by name + company domain
// since these leads have no Apollo person id. Never throws: a missing
// APOLLO_API_KEY or a failed bulk_match call is caught and logged, leaving
// those leads without an email rather than failing the whole sourcing run.
async function enrichViaApolloFallback(leads) {
  if (!process.env.APOLLO_API_KEY) {
    console.warn(
      `[clay] Apollo fallback unavailable (APOLLO_API_KEY not set) — ` +
        `${leads.length} lead(s) left without an email`
    );
    return 0;
  }

  const candidates = leads.map((lead) => ({
    name: lead.contact_name,
    companyName: lead.company_name,
    companyDomain: lead.company_domain,
  }));

  let matches;
  try {
    matches = await matchByNameAndDomain(candidates);
  } catch (err) {
    console.warn(
      `[clay] Apollo bulk_match fallback failed: ${err.message} — ` +
        `${leads.length} lead(s) left without an email`
    );
    return 0;
  }

  let resolved = 0;
  leads.forEach((lead, idx) => {
    const match = matches[idx];
    const email =
      match?.email && !match.email.includes(LOCKED_EMAIL_MARKER) ? match.email : null;
    if (email) {
      lead.contact_email = email;
      lead.raw_enrichment = {
        ...lead.raw_enrichment,
        apollo_fallback_match: match,
        email_enrichment_source: 'apollo_bulk_match',
      };
      resolved++;
    }
  });

  return resolved;
}

/**
 * Find contacts via Clay's Public API people search matching the ICP criteria,
 * with work emails enriched via CLAY_EMAIL_ROUTINE_ID. Same call shape as
 * apollo.findLeads, with one difference: Clay pages via a stateful server-side
 * search iterator, not page numbers.
 *
 * - Pass no `searchId` to create a fresh search from the ICP.
 * - Pass the previous call's `searchId` to continue where it left off.
 * - The returned array carries `searchId` and `hasMore` properties so callers
 *   can persist the cursor (see findLeadsForCampaign) — iteration, .length,
 *   and .map are unaffected.
 *
 * No-op (returns [] with a warning) when CLAY_PUBLIC_API_KEY is unset.
 *
 * @param {object} icp - ICP criteria (campaign-row or plain field names).
 * @param {object} [options]
 * @param {string} [options.searchId] - Existing search to continue.
 * @param {number} [options.perPage=25] - Records per page (max 500).
 * @param {boolean} [options.enrich=true] - Look up work emails (spends credits).
 * @returns {Promise<object[] & {searchId: string|null, hasMore: boolean}>}
 *   Lead objects shaped for the `leads` table.
 */
async function findLeads(icp = {}, options = {}) {
  if (!isPublicApiConfigured()) {
    console.warn('[clay] CLAY_PUBLIC_API_KEY is not set — Clay findLeads is a no-op');
    return Object.assign([], { searchId: options.searchId ?? null, hasMore: false });
  }

  const searchId = options.searchId || (await createPeopleSearch(icp));
  const { records, hasMore } = await fetchSearchPage(searchId, { limit: options.perPage });

  let leads = records
    .map(mapClaySearchRecordToLead)
    // leads.company_name is NOT NULL — drop anyone without one.
    .filter((lead) => Boolean(lead.company_name));

  if (options.enrich !== false) {
    leads = await enrichLeadsWithEmails(leads);
  }

  return Object.assign(leads, { searchId, hasMore });
}

// ============================================================
// Webhook model (legacy) — async table-driven sourcing
// ============================================================

/**
 * Kick off Clay lead sourcing for an ICP by pushing a trigger row into a Clay
 * table's inbound webhook. This is FIRE-AND-FORGET: Clay enriches asynchronously
 * and posts results back to the callback endpoint configured on the Clay table.
 * It does NOT return leads.
 *
 * Accepts campaign-row field names (`icp_industries`, ...) or plain ones.
 *
 * @param {object} icp
 * @param {object} [options]
 * @param {string} [options.webhookUrl] - Override CLAY_WEBHOOK_URL.
 * @param {object} [options.extra] - Extra fields merged into the trigger payload
 *   (e.g. campaign_id so the callback can attribute results).
 * @returns {Promise<{status:number, data:any}>} Clay's acknowledgement.
 */
async function triggerLeadSourcing(icp = {}, options = {}) {
  const apiKey = process.env.CLAY_API_KEY;
  if (!apiKey) {
    throw new Error('triggerLeadSourcing: CLAY_API_KEY is not set in the environment');
  }

  const webhookUrl = options.webhookUrl || process.env.CLAY_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error(
      'triggerLeadSourcing: CLAY_WEBHOOK_URL (or options.webhookUrl) is required'
    );
  }

  const payload = {
    industries: icp.industries ?? icp.icp_industries ?? [],
    locations: icp.locations ?? icp.icp_locations ?? [],
    titles: icp.titles ?? icp.icp_titles ?? [],
    min_company_size: icp.minCompanySize ?? icp.icp_min_fleet_size ?? null,
    ...(options.extra || {}),
  };

  try {
    const { status, data } = await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        // Clay table webhooks can require an auth token; set it to CLAY_API_KEY
        // in the table's webhook settings to match this header.
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return { status, data };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `triggerLeadSourcing: Clay webhook POST failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Normalize a Clay-enriched record (as delivered to our callback webhook) into a
 * `leads` table row shape. Clay column names are table-specific, so this checks
 * the common variants; adjust the key lists to match your Clay table's output.
 *
 * @param {object} record - One enriched row from Clay.
 * @returns {object} Lead object shaped for the `leads` table.
 */
function mapClayRecordToLead(record = {}) {
  const contactName =
    pick(record, ['name', 'full_name', 'contact_name']) ||
    [record.first_name, record.last_name].filter(Boolean).join(' ') ||
    null;

  return {
    company_name: pick(record, [
      'company_name',
      'company',
      'organization',
      'organization_name',
    ]),
    contact_name: contactName,
    contact_email: pick(record, ['email', 'work_email', 'contact_email']),
    contact_title: pick(record, ['title', 'job_title', 'contact_title']),
    contact_linkedin: pick(record, ['linkedin_url', 'linkedin', 'contact_linkedin']),
    company_url: pick(record, ['company_url', 'website', 'company_website']),
    company_domain: pick(record, ['domain', 'company_domain']),
    industry: pick(record, ['industry', 'company_industry']),
    fleet_size: pick(record, ['fleet_size']),
    country: pick(record, ['country', 'location_country', 'location']),
    employee_count: pick(record, ['employee_count', 'company_size', 'headcount']),
    raw_enrichment: record,
  };
}

module.exports = {
  // Public API model
  findLeads,
  createPeopleSearch,
  fetchSearchPage,
  enrichLeadsWithEmails,
  buildPeopleFilters,
  isPublicApiConfigured,
  // Webhook model (legacy)
  triggerLeadSourcing,
  mapClayRecordToLead,
};
