const { verifyEmail } = require('../integrations/instantly');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Small pacing gap after a real Instantly call, so back-to-back verifications
// during bulk sourcing/import (Apollo pagination, Clay search pages, CSV
// rows) don't hammer the API with zero delay between them.
const POST_VERIFY_DELAY_MS = 150;

/**
 * Verify an email address via Instantly, retrying once on a transient API
 * error before giving up. Shared by every place that needs this exact
 * fail-open-with-one-retry behaviour: `src/pipeline/findLeads.js` and
 * `src/routes/leads.js` (verification at import time, for every lead source —
 * Apollo, Clay, CSV, manual add) and `src/services/pipeline.js` (the
 * pre-scoring/pre-send gate, which now mostly just finds the value already
 * cached from import).
 *
 * @param {string} email
 * @param {object} [context] - For logging only, e.g. `{ leadId }`.
 * @returns {Promise<string|null>} verification status
 *   ('verified'|'invalid'|'risky'|'catch_all'|'pending'|'unknown'), or null
 *   if both attempts failed — fail-open; callers should treat null the same
 *   as "not yet verified", never as 'invalid'.
 */
async function verifyEmailWithRetry(email, context = {}) {
  const label = context.leadId != null ? `lead ${context.leadId}` : email;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await verifyEmail(email);
      await sleep(POST_VERIFY_DELAY_MS);
      return result;
    } catch (err) {
      lastErr = err;
      console.error(`[email-verification] attempt ${attempt} for ${label} failed:`, err.message);
      if (attempt === 1) await sleep(500);
    }
  }
  console.error(
    `[email-verification] failed after retry for ${label} (continuing unverified):`,
    lastErr?.message
  );
  return null;
}

module.exports = { verifyEmailWithRetry };
