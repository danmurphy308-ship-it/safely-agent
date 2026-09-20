// Standalone test for the Clay Public API integration: runs ONE findLeads
// call (a single search page) against a small Safely-shaped ICP and prints
// the mapped leads. Needs CLAY_PUBLIC_API_KEY; email enrichment additionally
// needs CLAY_EMAIL_ROUTINE_ID and SPENDS CLAY CREDITS per lookup.
//
// Usage: npm run test:clay-search [-- <perPage>] [--no-enrich]
//        (default perPage 3; --no-enrich skips the work-email routine)
//
// Per the safety rules this makes exactly one search request per run (plus
// the enrichment routine's submit/poll calls when enabled).

require('dotenv').config();
const clay = require('../integrations/clay');

async function main() {
  const args = process.argv.slice(2);
  const enrich = !args.includes('--no-enrich');
  const perPage = Math.max(1, Number(args.find((a) => /^\d+$/.test(a))) || 3);

  if (!clay.isPublicApiConfigured()) {
    console.error('CLAY_PUBLIC_API_KEY is not set — add it to .env first.');
    process.exit(1);
  }

  const icp = {
    titles: ['Fleet Manager'],
    industries: ['utilities'],
    locations: ['United Kingdom'],
    minCompanySize: 100,
  };

  console.log('ICP:', JSON.stringify(icp));
  console.log('Filters sent to Clay:', JSON.stringify(clay.buildPeopleFilters(icp), null, 2));
  console.log(`Fetching ${perPage} leads (enrich: ${enrich})...\n`);

  const leads = await clay.findLeads(icp, { perPage, enrich });

  console.log(`search_id: ${leads.searchId}`);
  console.log(`has_more:  ${leads.hasMore}`);
  console.log(`leads:     ${leads.length}\n`);

  for (const lead of leads) {
    console.log(
      [
        `- ${lead.contact_name ?? '(no name)'} — ${lead.contact_title ?? '(no title)'}`,
        `  ${lead.company_name}${lead.company_domain ? ` (${lead.company_domain})` : ''}`,
        `  email:    ${lead.contact_email ?? '(none)'}`,
        `  linkedin: ${lead.contact_linkedin ?? '(none)'}`,
        `  country:  ${lead.country ?? '(unknown)'}  employees: ${lead.employee_count ?? '?'}`,
      ].join('\n')
    );
  }

  if (!leads.length) {
    console.log('No leads returned — inspect the raw response with CLAY_DEBUG=1.');
  }
}

main().catch((err) => {
  console.error('test:clay-search failed:', err.message);
  process.exit(1);
});
