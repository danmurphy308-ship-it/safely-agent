// Manual test: score one sample lead and print the result + token usage.
//
// Requires ANTHROPIC_API_KEY in .env. Run with:
//   node src/scripts/testScorer.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { scoreLead } = require('../services/scorer');

const sampleLead = {
  company_name: 'Virgin Media',
  contact_name: 'James Murphy',
  contact_title: 'Head of Fleet Operations',
  industry: 'telecoms',
  fleet_size: 500,
  country: 'UK',
  segment: null,
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in .env — cannot run the scorer.');
    process.exit(1);
  }

  console.log('Scoring lead:', sampleLead.company_name);

  const { usage, ...result } = await scoreLead(sampleLead, { withUsage: true });

  console.log('\n=== Result ===');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== Usage ===');
  console.log(JSON.stringify(usage, null, 2));
  if (usage) {
    console.log(
      `\ncache_read_input_tokens: ${usage.cache_read_input_tokens ?? 0} ` +
        `(if 0 on a repeat run, the cached prefix is below the model's minimum)`
    );
  }
}

main().catch((err) => {
  console.error('\nScorer test failed:', err.message);
  process.exit(1);
});
