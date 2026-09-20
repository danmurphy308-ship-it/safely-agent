const { isExistingContact } = require('../integrations/hubspot');
const { addToBlacklist } = require('./blacklist');

// Shared "is this lead already a Safely/Transpoco relationship?" gate, used at
// both ends of the pipeline:
//   - source time (saveLeadIfNew): fail OPEN — a HubSpot outage must not stop
//     lead sourcing; the send-time gate still protects the actual send.
//   - send time (sendSequenceEmail / approve route): fail CLOSED — if we can't
//     verify against HubSpot, we don't send. The hourly runner retries later.

/**
 * Check a lead against HubSpot and, on a match, persist it to the local
 * blacklist so every future check (source or send) is a free DB lookup and the
 * lead shows up in blacklist counts.
 *
 * @param {object} lead - Needs `contact_email` and/or `company_domain`.
 * @returns {Promise<{existing:boolean, reason:(string|null)}>}
 * @throws When the HubSpot API call itself fails — callers pick their failure
 *   mode (see module header).
 */
async function checkExistingCustomer(lead) {
  const email = lead?.contact_email || null;
  const domain = lead?.company_domain || null;
  if (!email && !domain) return { existing: false, reason: null };

  const { existing, reason } = await isExistingContact(email, domain);
  if (!existing) return { existing: false, reason: null };

  // Persist the hit: an email match blacklists the address; a company-level
  // match (customer lifecycle stage or open deals) blacklists the whole
  // domain (nobody there should be cold-emailed).
  const domainLevel = reason === 'existing_customer' || reason === 'active_deal';
  if (domainLevel && domain) {
    await addToBlacklist('domain', domain, reason);
  } else if (email) {
    await addToBlacklist('email', email, reason);
  }
  console.log(
    `[customerCheck] blocked ${email || domain} (${reason}) — added to blacklist`
  );

  return { existing: true, reason };
}

module.exports = { checkExistingCustomer };
