// Manual test: draft a cold email for one sample lead and print the result.
//
// Requires ANTHROPIC_API_KEY in .env. Run with:
//   node src/scripts/testDrafter.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { draftEmail } = require('../services/drafter');

const sampleLead = {
  company_name: 'Virgin Media',
  contact_name: 'James Murphy',
  contact_title: 'Head of Fleet Operations',
  industry: 'telecoms',
  fleet_size: 500,
  country: 'UK',
  segment: 'fleet',
  ai_score: 95,
  ai_reasoning:
    'Virgin Media is a major UK telecoms company with 500 vehicles, senior fleet decision maker.',
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in .env — cannot run the drafter.');
    process.exit(1);
  }

  console.log('Drafting email for lead:', sampleLead.company_name);

  const { subject, body, data_quality } = await draftEmail(sampleLead);

  console.log('\n=== Subject ===');
  console.log(subject);

  console.log('\n=== Body ===');
  console.log(body);

  console.log('\n=== Data quality ===');
  console.log(data_quality);
}

main().catch((err) => {
  console.error('\nDrafter test failed:', err.message);
  process.exit(1);
});
