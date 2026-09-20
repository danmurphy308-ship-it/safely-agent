// Manual test: check ONE email + domain against HubSpot's CRM search to verify
// the existing-customer gate works end to end, then exit.
//
// Per the project Safety Rules, this makes at most TWO API calls per run (one
// contact search, one company search). Requires HUBSPOT_ACCESS_TOKEN in .env.
// Run with:
//   node src/scripts/testHubspot.js [email] [domain]
// Defaults to a known-existing address (dan.murphy@transpoco.com) so a working
// token should print existing: true.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { isExistingContact } = require('../integrations/hubspot');

const email = process.argv[2] || 'dan.murphy@transpoco.com';
const domain = process.argv[3] || null;

async function main() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    console.error('HUBSPOT_ACCESS_TOKEN is not set in .env — cannot call HubSpot.');
    process.exit(1);
  }

  console.log(`Checking HubSpot for email=${email} domain=${domain ?? '(none)'}\n`);

  // One check only — do not loop here.
  const result = await isExistingContact(email, domain);
  console.log(result);
  if (result.existing) {
    console.log('\n→ this lead would be BLOCKED (blacklisted at source, cancelled at send).');
  } else {
    console.log('\n→ this lead would be allowed through.');
  }
}

main().catch((err) => {
  console.error('HubSpot check failed:', err.message);
  process.exit(1);
});
