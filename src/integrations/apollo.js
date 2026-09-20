const axios = require('axios');

// Apollo.io People Search for API callers (POST). Returns up to `per_page`
// people per call. The older `mixed_people/search` path is deprecated for API
// keys and 422s; `mixed_people/api_search` is the supported endpoint.
// Docs: https://docs.apollo.io/reference/people-api-search
const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';

// People Enrichment (bulk_match). api_search only returns obfuscated previews
// (masked names, `has_*` flags). bulk_match resolves person IDs into real
// contact data — email, country, LinkedIn, org industry/domain — and costs
// Apollo credits per matched contact.
// Docs: https://docs.apollo.io/reference/bulk-people-enrichment
const APOLLO_BULK_MATCH_URL = 'https://api.apollo.io/api/v1/people/bulk_match';

// Apollo caps bulk_match at 10 records per request. We also pace requests with
// a short delay so a large page can't hammer the API (and credits) in a burst.
const BULK_MATCH_BATCH_SIZE = 10;
const BULK_MATCH_DELAY_MS = 200;

// Apollo caps per_page at 100.
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 25;

// Apollo's people search hard-rejects (HTTP 422, "Page * per page number is
// over threshold") once page * per_page exceeds this offset — confirmed
// empirically 2026-07-23: offset 30,000 (page 3000 @ per_page 10) returns a
// normal empty page, offset ~1,000,000 (page 99999 @ per_page 10) 422s. 50,000
// is Apollo's documented total-results ceiling for a single search, used here
// as the conservative cutoff so findLeadsForCampaign can stop BEFORE hitting
// the error rather than only recovering after one.
const MAX_PAGINATION_OFFSET = 50000;

// Apollo locks emails behind credits; locked addresses come back as this
// placeholder rather than a real address.
const LOCKED_EMAIL_MARKER = 'email_not_unlocked';

// Verbose request/response logging, enabled with APOLLO_DEBUG=1.
function debugEnabled() {
  return Boolean(process.env.APOLLO_DEBUG);
}

// Never log the full API key — show only a masked hint.
function maskKey(key) {
  if (!key) return '(missing)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Find contacts via Apollo's People Search matching the ICP criteria.
 *
 * Accepts either the campaign-row field names (`icp_industries`,
 * `icp_locations`, `icp_titles`, `icp_min_fleet_size`) or plain ones
 * (`industries`, `locations`, `titles`, `minCompanySize`).
 *
 * @param {object} icp - ICP targeting criteria.
 * @param {string[]} [icp.industries]
 * @param {string[]} [icp.locations]
 * @param {string[]} [icp.titles]
 * @param {number}   [icp.minCompanySize] - Minimum company headcount.
 * @param {number[]} [icp.industryTagIds] - Apollo organization industry tag IDs
 *   (precise industry filtering; strings fall back to keyword search).
 * @param {object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.perPage=25] - Results per page (max 100).
 * @param {boolean} [options.enrich=true] - When true, resolve the obfuscated
 *   api_search previews into real contact data via bulk_match (spends Apollo
 *   credits, one per matched contact). When false, return the previews as-is.
 * @returns {Promise<object[]>} Lead objects shaped for the `leads` table.
 */
async function findLeads(icp = {}, options = {}) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error('findLeads: APOLLO_API_KEY is not set in the environment');
  }

  const body = buildSearchBody(icp, options);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': apiKey,
  };

  if (debugEnabled()) {
    console.error('[apollo] → POST', APOLLO_SEARCH_URL);
    console.error('[apollo] → headers', { ...headers, 'X-Api-Key': maskKey(apiKey) });
    console.error('[apollo] → body', JSON.stringify(body, null, 2));
  }

  let response;
  try {
    response = await axios.post(APOLLO_SEARCH_URL, body, { headers });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    if (debugEnabled()) {
      console.error('[apollo] ✗ request failed, HTTP', status ?? '(none)');
      console.error('[apollo] ✗ error body', err.response?.data ?? err.message);
    }
    // A cursor that's drifted past MAX_PAGINATION_OFFSET (e.g. an old
    // campaign whose apollo_page has climbed for months) hits this instead of
    // the graceful empty-page response other exhaustion looks like. Tag it so
    // callers (findLeadsForCampaign) can treat it as exhaustion too, rather
    // than a real failure.
    const isPageThresholdError =
      status === 422 && /over threshold/i.test(err.response?.data?.error ?? '');
    const wrapped = new Error(
      `findLeads: Apollo People Search failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
    wrapped.isPageThresholdError = isPageThresholdError;
    throw wrapped;
  }

  if (debugEnabled()) {
    console.error('[apollo] ← status', response.status);
    console.error('[apollo] ← pagination', response.data?.pagination ?? '(none)');
    console.error('[apollo] ← people in page', response.data?.people?.length ?? 0);
    if (response.data?.error) {
      console.error('[apollo] ← response.error', response.data.error);
    }
    // Full response body for debugging.
    console.error('[apollo] ← full response body', JSON.stringify(response.data, null, 2));
  }

  const people = response.data?.people ?? [];

  // api_search returns obfuscated previews. Resolve them into real contact data
  // via bulk_match unless the caller opts out.
  const enrich = options.enrich !== false;
  const records = enrich ? await enrichPeople(people, apiKey) : people;

  return (
    records
      .map(mapPersonToLead)
      // leads.company_name is NOT NULL — drop anyone without an org name.
      .filter((lead) => Boolean(lead.company_name))
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run Apollo's bulk_match over an arbitrary list of detail objects (each one
 * of: {id} | {name/first_name/last_name, organization_name, domain, ...} per
 * https://docs.apollo.io/reference/bulk-people-enrichment), chunked to
 * Apollo's 10-per-call cap and paced with a short delay between batches.
 *
 * Returns matches ALIGNED to `details` (Apollo fills unmatched slots with
 * null) so callers can zip the result back onto whatever list they built
 * `details` from by index.
 *
 * @param {object[]} details - Apollo bulk_match detail objects.
 * @param {string} apiKey - Apollo API key.
 * @returns {Promise<(object|null)[]>} Matches aligned to `details`.
 */
async function runBulkMatch(details, apiKey) {
  if (!details.length) return [];

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': apiKey,
  };

  const matches = [];
  for (let i = 0; i < details.length; i += BULK_MATCH_BATCH_SIZE) {
    const batch = details.slice(i, i + BULK_MATCH_BATCH_SIZE);
    const body = { details: batch, reveal_personal_emails: true };

    if (debugEnabled()) {
      console.error(
        `[apollo] → POST ${APOLLO_BULK_MATCH_URL} (batch of ${batch.length})`
      );
      console.error('[apollo] → body', JSON.stringify(body, null, 2));
    }

    let response;
    try {
      response = await axios.post(APOLLO_BULK_MATCH_URL, body, { headers });
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      if (debugEnabled()) {
        console.error('[apollo] ✗ bulk_match failed, HTTP', status ?? '(none)');
        console.error('[apollo] ✗ error body', err.response?.data ?? err.message);
      }
      throw new Error(
        `runBulkMatch: Apollo bulk_match failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
      );
    }

    // bulk_match returns a `matches` array aligned to the request; unmatched
    // entries come back as null. Keep the nulls here so position is preserved —
    // callers decide whether/how to filter.
    const batchMatches = response.data?.matches ?? [];
    if (debugEnabled()) {
      console.error('[apollo] ← status', response.status);
      console.error(
        `[apollo] ← matched ${batchMatches.filter(Boolean).length} of ${batch.length} in batch`
      );
      console.error(
        '[apollo] ← full response body',
        JSON.stringify(response.data, null, 2)
      );
    }
    matches.push(...batchMatches);

    // Pace successive batches; skip the wait after the final one.
    if (i + BULK_MATCH_BATCH_SIZE < details.length) {
      await delay(BULK_MATCH_DELAY_MS);
    }
  }

  return matches;
}

/**
 * Resolve obfuscated api_search previews into real contact records via Apollo's
 * bulk_match enrichment. Only previews flagged `has_email: true` are enriched —
 * the rest can't yield a usable email, so spending a credit on them is wasteful.
 *
 * @param {object[]} previews - Raw api_search person previews.
 * @param {string} apiKey - Apollo API key.
 * @returns {Promise<object[]>} Full Apollo person records (matched contacts).
 */
async function enrichPeople(previews, apiKey) {
  // Only enrich previews that have both an ID to match on and an email to gain.
  const enrichable = previews.filter((p) => p && p.id && p.has_email);

  if (debugEnabled()) {
    const skipped = previews.length - enrichable.length;
    console.error(
      `[apollo] enrich: ${enrichable.length} of ${previews.length} previews have has_email` +
        ` (${skipped} skipped to save credits)`
    );
  }

  if (!enrichable.length) return [];

  const matches = await runBulkMatch(
    enrichable.map((p) => ({ id: p.id })),
    apiKey
  );
  return matches.filter(Boolean);
}

/**
 * Resolve contacts sourced from a non-Apollo provider (e.g. Clay) into Apollo
 * contact records by matching on name + company, rather than an Apollo person
 * id (which those leads don't have). Used as a fallback enrichment path when
 * a provider's own email lookup is unavailable or fails.
 *
 * Every candidate is sent to bulk_match as-is — callers should pre-filter to
 * candidates with enough identifying detail (a name plus a domain or company
 * name) so credits aren't spent on unmatchable requests.
 *
 * @param {Array<{name?: string, companyName?: string, companyDomain?: string}>} candidates
 * @returns {Promise<(object|null)[]>} Apollo person records, aligned to
 *   `candidates` (null where nothing matched).
 */
async function matchByNameAndDomain(candidates = []) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error('matchByNameAndDomain: APOLLO_API_KEY is not set in the environment');
  }
  if (!candidates.length) return [];

  const details = candidates.map((c) => {
    const detail = {};
    if (c.name) detail.name = c.name;
    if (c.companyName) detail.organization_name = c.companyName;
    if (c.companyDomain) detail.domain = c.companyDomain;
    return detail;
  });

  return runBulkMatch(details, apiKey);
}

// Maps common user phrasing for an industry to Apollo's exact industry
// taxonomy string. Keys are lowercased; lookup is case-insensitive and
// whitespace-trimmed. Anything not listed is sent to Apollo unchanged.
const INDUSTRY_TAXONOMY = {
  healthcare: 'hospital & health care',
  'health care': 'hospital & health care',
  health: 'hospital & health care',
  nhs: 'hospital & health care',
  telecoms: 'telecommunications',
  telecom: 'telecommunications',
  telecommunications: 'telecommunications',
  facilities: 'facilities services',
  'facilities management': 'facilities services',
  construction: 'construction',
  utilities: 'utilities',
  energy: 'oil & energy',
  security: 'security & investigations',
  councils: 'government administration',
  government: 'government administration',
  'local government': 'government administration',
  housing: 'real estate',
  transport: 'transportation/trucking/railroad',
  transportation: 'transportation/trucking/railroad',
  'food distribution': 'food & beverages',
  food: 'food & beverages',
  logistics: 'logistics & supply chain',
  engineering: 'mechanical or industrial engineering',
  environmental: 'environmental services',
  waste: 'environmental services',
};

// Normalise a single industry string to Apollo's taxonomy. Unmapped values are
// returned exactly as supplied.
function normalizeIndustry(industry) {
  if (typeof industry !== 'string') return industry;
  const key = industry.trim().toLowerCase();
  return INDUSTRY_TAXONOMY[key] ?? industry;
}

// Apollo's numeric tag IDs for our ICP industries, keyed by the normalized
// taxonomy name (the values normalizeIndustry produces). Using
// organization_industry_tag_ids filters PRECISELY on the company's LinkedIn
// industry, unlike the fuzzy q_keywords fallback. IDs fetched from Apollo's
// live taxonomy (POST /api/v1/tags/search, kind=linkedin_industry) on
// 2026-07-09 — they are stable MongoDB ObjectIds, not per-account values.
const INDUSTRY_TAG_IDS = {
  utilities: '5567e2127369642420170000',
  construction: '5567cd4773696439dd350000',
  'hospital & health care': '5567cdde73696439812c0000',
  telecommunications: '5567cd4c7369644d39080000',
  'facilities services': '5567ce9c7369643bc9980000',
  'government administration': '5567cd527369643981050000',
  'environmental services': '5567ce5b736964540d280000',
  'oil & energy': '5567cdd97369645624020000',
  'security & investigations': '5567e19b7369641ead740000',
  // Fetched from the live taxonomy 2026-07-16, same endpoint as the rest.
  'food & beverages': '5567ce1e7369643b806a0000',
  'food production': '5567e1b3736964208b280000',
};

// Title fragments excluded from EVERY people search via person_not_titles —
// roles that never buy road-fleet safety (sales) or belong to other transport
// modes outside the ICP (aviation/marine/rail/warehouse).
const EXCLUDED_TITLE_KEYWORDS = ['sales', 'aviation', 'marine', 'rail', 'warehouse', 'aircraft'];

// Translate ICP criteria into Apollo's People Search request body.
function buildSearchBody(icp, options) {
  const industries = icp.industries ?? icp.icp_industries ?? [];
  const locations = icp.locations ?? icp.icp_locations ?? [];
  const titles = icp.titles ?? icp.icp_titles ?? [];
  const minCompanySize =
    icp.minCompanySize ?? icp.min_company_size ?? icp.icp_min_fleet_size ?? null;
  const industryTagIds = icp.industryTagIds ?? icp.organization_industry_tag_ids ?? [];

  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Number(options.perPage) || DEFAULT_PER_PAGE)
  );

  const body = { page, per_page: perPage };

  if (titles.length) body.person_titles = titles;
  if (locations.length) body.person_locations = locations;

  // Always exclude roles that never fit the ICP (sales, other transport modes).
  body.person_not_titles = EXCLUDED_TITLE_KEYWORDS;

  // Apollo expresses company size as "min,max" headcount range strings.
  if (minCompanySize != null && minCompanySize !== '') {
    body.organization_num_employees_ranges = [`${Number(minCompanySize)},1000000`];
  }

  // Precise industry filtering needs Apollo's numeric tag IDs. Priority:
  //   1. Caller-supplied tag IDs, verbatim.
  //   2. Industries whose normalized taxonomy name is in INDUSTRY_TAG_IDS —
  //      filtered precisely via organization_industry_tag_ids.
  //   3. Any remaining unmapped industries fall back to the fuzzy q_keywords
  //      match (only when nothing produced a tag ID, so the precise filter
  //      isn't diluted by a keyword OR).
  // Dedupe so synonyms that map to the same taxonomy (e.g. "waste" and
  // "environmental" → "environmental services") aren't repeated.
  if (industryTagIds.length) {
    body.organization_industry_tag_ids = industryTagIds;
  } else if (industries.length) {
    const normalized = [...new Set(industries.map(normalizeIndustry))];
    const mappedIds = normalized
      .map((name) => INDUSTRY_TAG_IDS[typeof name === 'string' ? name.toLowerCase() : name])
      .filter(Boolean);
    const unmapped = normalized.filter(
      (name) => !INDUSTRY_TAG_IDS[typeof name === 'string' ? name.toLowerCase() : name]
    );

    if (mappedIds.length) {
      body.organization_industry_tag_ids = [...new Set(mappedIds)];
    }
    if (unmapped.length && !mappedIds.length) {
      body.q_keywords = unmapped.join(' ');
    }
  }

  return body;
}

// Professional post-nominal letters Apollo sometimes appends to (or mis-parses
// into) names. Stripped from contact_name so cold emails read naturally.
// Stored as clean uppercase alphanumerics; name tokens are normalised the same
// way before lookup, so dotted/parenthesised forms ("B.Sc.", "BA(Hons)") match.
// Deliberately EXCLUDES ambiguous 2-letter tokens (MA, BA, MD, MS, EdD) that
// are also real surnames/initials — better to under-strip than mangle a name.
const CREDENTIAL_SUFFIXES = new Set([
  // Academic degrees
  'BSC', 'BENG', 'BAHONS', 'BSCHONS', 'HONS', 'MSC', 'MENG', 'MBA', 'MPHIL',
  'PHD', 'DPHIL', 'LLB', 'LLM', 'HND', 'HNC', 'PGDIP', 'PGCE',
  // Logistics & transport (CILT)
  'CILT', 'MILT', 'MCILT', 'FCILT', 'CMILT',
  // Road transport engineering (IRTE / SOE) & engineering technician grades
  'IRTE', 'MIRTE', 'FIRTE', 'AMIRTE', 'MSOE', 'AMSOE', 'FSOE', 'IENG', 'CENG', 'ENGTECH',
  // Health & safety (IOSH / NEBOSH)
  'IOSH', 'TECHIOSH', 'GRADIOSH', 'CMIOSH', 'CFIOSH', 'NEBOSH',
  // Engineering institutions (IET / ICE / IMechE)
  'MIET', 'FIET', 'MICE', 'FICE', 'IMECHE', 'MIMECHE', 'FIMECHE',
  // Accountancy & chartered management
  'ACA', 'FCA', 'ACCA', 'FCCA', 'CIMA', 'ACMA', 'FCMA', 'FCMI', 'MCMI',
  // Procurement (CIPS)
  'MCIPS', 'FCIPS',
  // Project management
  'PMP', 'MAPM', 'FAPM', 'PRINCE2',
  // Misc professional
  'MAFP',
]);

// Strip trailing credential suffixes from a person's name, e.g.
// "Jane Doe, FCILT MSc" → "Jane Doe", "Simon Mafp" → "Simon". Only trailing
// tokens are removed, and never the entire name.
function stripCredentialSuffixes(name) {
  if (!name) return name;

  const tokens = name.split(/[\s,]+/).filter(Boolean);
  let end = tokens.length;
  while (end > 0) {
    const normalized = tokens[end - 1].replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (CREDENTIAL_SUFFIXES.has(normalized)) {
      end -= 1;
    } else {
      break;
    }
  }

  // Guard against a record that is nothing but credentials.
  if (end === 0) return name.trim();
  return tokens.slice(0, end).join(' ');
}

// Map one Apollo person record to a `leads` table row shape.
function mapPersonToLead(person) {
  const org = person.organization ?? person.account ?? {};

  const fullName = stripCredentialSuffixes(
    person.name ||
      [person.first_name, person.last_name].filter(Boolean).join(' ') ||
      null
  );

  const email =
    person.email && !person.email.includes(LOCKED_EMAIL_MARKER)
      ? person.email
      : null;

  return {
    company_name: org.name ?? null,
    contact_name: fullName,
    contact_email: email,
    contact_title: person.title ?? null,
    contact_linkedin: person.linkedin_url ?? null,
    company_url: org.website_url ?? null,
    company_domain: org.primary_domain ?? null,
    industry: org.industry ?? null,
    // Apollo has no fleet-size signal; left for enrichment downstream.
    fleet_size: null,
    country: person.country ?? org.country ?? null,
    employee_count: org.estimated_num_employees ?? null,
    // Keep the raw record for later enrichment/debugging (leads.raw_enrichment).
    raw_enrichment: person,
  };
}

/**
 * Enrich already-mapped lead objects (e.g. preview leads chosen from an Apollo
 * search) into ones with real contact data. Each preview lead carries its
 * original Apollo record under `raw_enrichment`; those records are run through
 * bulk_match (enrichPeople) and the resolved contact data is merged back onto
 * the lead, matched by Apollo person id.
 *
 * Leads that can't be enriched — no stashed id, no `has_email`, or no
 * bulk_match result — are returned unchanged so a chosen lead is never
 * silently dropped.
 *
 * @param {object[]} leads - Lead rows as produced by mapPersonToLead.
 * @returns {Promise<object[]>} The same leads, enriched where possible.
 */
async function enrichLeads(leads = []) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error('enrichLeads: APOLLO_API_KEY is not set in the environment');
  }

  // Recover the Apollo previews stashed at search time; only previews carrying
  // an id can be resolved by bulk_match.
  const previews = leads
    .map((lead) => lead && lead.raw_enrichment)
    .filter((preview) => preview && preview.id);

  if (!previews.length) return leads;

  const enrichedPeople = await enrichPeople(previews, apiKey);
  const enrichedById = new Map(
    enrichedPeople.map((person) => [person.id, mapPersonToLead(person)])
  );

  return leads.map((lead) => {
    const id = lead && lead.raw_enrichment && lead.raw_enrichment.id;
    return (id && enrichedById.get(id)) || lead;
  });
}

module.exports = {
  findLeads,
  enrichLeads,
  enrichPeople,
  matchByNameAndDomain,
  stripCredentialSuffixes,
  normalizeIndustry,
  LOCKED_EMAIL_MARKER,
  MAX_PAGINATION_OFFSET,
};
