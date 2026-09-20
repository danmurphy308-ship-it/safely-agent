const db = require('../config/db');

// Configurable pre-score lead filter. Two settings rows hold JSON arrays of
// bad-fit keywords (editable on the Settings page → Lead Filters):
//   filter_company_keywords — matched against leads.company_name
//   filter_title_keywords   — matched against leads.contact_title
// A case-insensitive substring hit deprioritises the lead BEFORE Claude
// scoring, so obvious bad fits (per the ICP: companies whose core business IS
// driving, marine/warehouse roles, ...) never spend an Anthropic call.

const SETTING_KEYS = {
  company: 'filter_company_keywords',
  title: 'filter_title_keywords',
};

// Fallbacks when the settings rows are missing (fresh DB before migration 007)
// or hold unparsable JSON. Mirrors the seeded defaults.
const DEFAULT_KEYWORDS = {
  company: [
    'marine', 'shipping', 'yacht', 'vessel', 'maritime', 'logistics',
    'courier', 'haulage', 'freight', 'trucking', 'taxi', 'chauffeur',
    'removals',
  ],
  title: ['marine', 'vessel', 'shipping', 'warehouse'],
};

// Batch runs call the filter once per lead — cache the rules briefly so a run
// costs one settings read, while UI edits still take effect within a minute.
const CACHE_TTL_MS = 60 * 1000;
let cached = null; // { rules, expires }

// Parse a settings value into a clean lowercase keyword list, or null when the
// value is missing/invalid (caller falls back to the defaults).
function parseKeywords(value) {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((k) => typeof k === 'string' && k.trim() !== '')
      .map((k) => k.trim().toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Load the current bad-fit keyword lists from settings (60s cache).
 *
 * @returns {Promise<{company:string[], title:string[]}>} lowercase keywords.
 */
async function getFilterRules() {
  if (cached && Date.now() < cached.expires) return cached.rules;

  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [
    Object.values(SETTING_KEYS),
  ]);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const rules = {
    company: parseKeywords(byKey[SETTING_KEYS.company]) ?? DEFAULT_KEYWORDS.company,
    title: parseKeywords(byKey[SETTING_KEYS.title]) ?? DEFAULT_KEYWORDS.title,
  };
  cached = { rules, expires: Date.now() + CACHE_TTL_MS };
  return rules;
}

/**
 * Check a lead against the bad-fit keyword lists.
 *
 * @param {object} lead - Uses `company_name` and `contact_title`.
 * @returns {Promise<{field:('company_name'|'contact_title'), keyword:string}|null>}
 *   The first match found, or null when the lead passes.
 */
async function findBadFitMatch(lead) {
  const rules = await getFilterRules();

  const company = (lead?.company_name ?? '').toLowerCase();
  const title = (lead?.contact_title ?? '').toLowerCase();

  for (const keyword of rules.company) {
    if (company && company.includes(keyword)) {
      return { field: 'company_name', keyword };
    }
  }
  for (const keyword of rules.title) {
    if (title && title.includes(keyword)) {
      return { field: 'contact_title', keyword };
    }
  }
  return null;
}

// Test hook: drop the cache so a fresh settings read happens on the next call.
function clearFilterRulesCache() {
  cached = null;
}

module.exports = { getFilterRules, findBadFitMatch, clearFilterRulesCache, SETTING_KEYS };
