// Manual test: a SINGLE Apollo People Search call for Fleet Managers at
// utilities companies in the UK, prints the results, and exits.
//
// Per the project Safety Rules, this makes exactly ONE API call per run.
// Requires APOLLO_API_KEY in .env. Run with:
//   node src/scripts/testApollo.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { findLeads } = require('../integrations/apollo');

const icp = {
  industries: ['utilities'],
  locations: ['United Kingdom'],
  titles: ['Fleet Manager'],
};

async function main() {
  if (!process.env.APOLLO_API_KEY) {
    console.error('APOLLO_API_KEY is not set in .env — cannot call Apollo.');
    process.exit(1);
  }

  console.log('Searching Apollo for: Fleet Managers @ utilities companies in the UK');
  console.log('(single API call)\n');

  // One call only — do not loop or paginate here.
  const leads = await findLeads(icp, { perPage: 10 });

  console.log(`Found ${leads.length} lead(s):\n`);
  leads.forEach((lead, i) => {
    console.log(`${i + 1}. ${lead.contact_name ?? '(no name)'} — ${lead.contact_title ?? '(no title)'}`);
    console.log(`   Company:  ${lead.company_name ?? '—'} (${lead.industry ?? 'industry unknown'})`);
    console.log(`   Location: ${lead.country ?? '—'}   Employees: ${lead.employee_count ?? '—'}`);
    console.log(`   Email:    ${lead.contact_email ?? '— (locked/unavailable)'}`);
    console.log(`   LinkedIn: ${lead.contact_linkedin ?? '—'}\n`);
  });
}

main().catch((err) => {
  console.error('\nApollo test failed:', err.message);
  process.exit(1);
});
