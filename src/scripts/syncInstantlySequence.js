// Re-attach the current SAFELY_SEQUENCE_STEPS to an EXISTING Instantly
// campaign. Sequences are set at campaign creation, so campaigns created
// before a sequence change keep the old copy until this is run.
//
// Per the project Safety Rules, this makes ONE API call per run (a single
// PATCH). Requires INSTANTLY_API_KEY in .env. Run with:
//   node src/scripts/syncInstantlySequence.js [instantly-campaign-id]
// Defaults to INSTANTLY_CAMPAIGN_ID from .env when no id is given.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { addCampaignSequence } = require('../integrations/instantly');

const campaignId = process.argv[2] || process.env.INSTANTLY_CAMPAIGN_ID;

async function main() {
  if (!process.env.INSTANTLY_API_KEY) {
    console.error('INSTANTLY_API_KEY is not set in .env — cannot call Instantly.');
    process.exit(1);
  }
  if (!campaignId) {
    console.error(
      'No campaign id: pass one as an argument or set INSTANTLY_CAMPAIGN_ID in .env.'
    );
    process.exit(1);
  }

  console.log(`Updating sequence on Instantly campaign ${campaignId} (single PATCH)\n`);

  // One call only — do not loop here.
  await addCampaignSequence(process.env.INSTANTLY_API_KEY, campaignId);
  console.log('Sequence updated — step 1 now renders {{personalized_subject}}/{{personalized_body}}.');
}

main().catch((err) => {
  console.error('Sequence sync failed:', err.message);
  process.exit(1);
});
