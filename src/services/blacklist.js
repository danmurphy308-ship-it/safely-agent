const db = require('../config/db');

const VALID_TYPES = ['email', 'domain', 'linkedin'];

/**
 * Check whether a lead is on the do-not-contact blacklist.
 *
 * Each value is matched against a blacklist entry of the corresponding type
 * (email→'email', domain→'domain', linkedin→'linkedin'). Null/empty values are
 * skipped. Returns true if any one matches.
 *
 * @param {string} [email]
 * @param {string} [domain]
 * @param {string} [linkedin]
 * @returns {Promise<boolean>}
 */
async function isBlacklisted(email, domain, linkedin) {
  // Pair each input with its blacklist type, dropping anything not provided.
  const pairs = [
    ['email', email],
    ['domain', domain],
    ['linkedin', linkedin],
  ].filter(([, value]) => value != null && value !== '');

  if (pairs.length === 0) return false;

  // Build an OR of (type = $n AND value = $n+1) conditions, parameterised.
  const conditions = [];
  const params = [];
  for (const [type, value] of pairs) {
    params.push(type, value);
    conditions.push(`(type = $${params.length - 1} AND value = $${params.length})`);
  }

  const sql = `SELECT 1 FROM blacklist WHERE ${conditions.join(' OR ')} LIMIT 1`;
  const { rowCount } = await db.query(sql, params);
  return rowCount > 0;
}

/**
 * Add an entry to the blacklist. Idempotent — a duplicate (type, value) is a
 * no-op thanks to the unique index.
 *
 * @param {('email'|'domain'|'linkedin')} type
 * @param {string} value
 * @param {string} [reason] - e.g. existing_customer, unsubscribed, competitor, manual
 * @returns {Promise<object|null>} The inserted row, or null if it already existed.
 */
async function addToBlacklist(type, value, reason) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`addToBlacklist: \`type\` must be one of ${VALID_TYPES.join(', ')}`);
  }
  if (value == null || value === '') {
    throw new Error('addToBlacklist: `value` is required');
  }

  const { rows } = await db.query(
    `INSERT INTO blacklist (type, value, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (type, value) DO NOTHING
     RETURNING *`,
    [type, value, reason ?? null]
  );

  return rows[0] ?? null;
}

module.exports = { isBlacklisted, addToBlacklist };
