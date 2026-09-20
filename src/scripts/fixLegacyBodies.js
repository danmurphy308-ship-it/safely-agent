// One-time fixup: leads enrolled in Instantly BEFORE the no-sign-off change
// carry a personalized_body custom variable ending in "Dan | Safely". The
// sequence template now appends "{{sendingAccountFirstName}} | Safely" itself,
// so those leads would render a double signature. This walks every lead in
// our three Instantly campaigns, strips the legacy sign-off from
// personalized_body, and PATCHes the lead's custom variables back.
//
// Instantly API calls are paced (200ms between writes) and paginated at 100
// leads per page. Re-runnable: already-clean leads are skipped.
//
// Run with:
//   npm run instantly:fix-legacy-bodies

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const axios = require('axios');
const { stripLegacySignOff } = require('../integrations/instantly');

const API_BASE = 'https://api.instantly.ai/api/v2';

const CAMPAIGNS = [
  { name: 'UK', id: '<uk-campaign-uuid>' },
  { name: 'USA', id: '<usa-campaign-uuid>' },
  { name: 'Ireland', id: '<instantly-campaign-uuid>' },
];

const PAGE_SIZE = 100;
const WRITE_DELAY_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
  };
}

// Fetch every lead in a campaign via POST /leads/list, following pagination.
async function listCampaignLeads(campaignId) {
  const leads = [];
  let startingAfter;
  for (;;) {
    const body = { campaign: campaignId, limit: PAGE_SIZE };
    if (startingAfter) body.starting_after = startingAfter;
    const { data } = await axios.post(`${API_BASE}/leads/list`, body, {
      headers: authHeaders(),
    });
    const items = data?.items ?? data?.data ?? [];
    leads.push(...items);
    startingAfter = data?.next_starting_after ?? null;
    if (!startingAfter || items.length === 0) break;
  }
  return leads;
}

// A lead's custom variables come back under `payload` on Instantly v2 lead
// objects (they are SET via `custom_variables` on create/update).
function customVarsOf(lead) {
  return lead?.payload ?? lead?.custom_variables ?? {};
}

async function fixLead(lead, vars, strippedBody) {
  // Send the complete variable set with only personalized_body changed, in
  // case the API replaces rather than merges the object.
  await axios.patch(
    `${API_BASE}/leads/${lead.id}`,
    { custom_variables: { ...vars, personalized_body: strippedBody } },
    { headers: authHeaders() }
  );
}

async function main() {
  if (!process.env.INSTANTLY_API_KEY) {
    console.error('INSTANTLY_API_KEY is not set in .env — cannot call Instantly.');
    process.exit(1);
  }

  let totalChecked = 0;
  let totalFixed = 0;

  for (const campaign of CAMPAIGNS) {
    const leads = await listCampaignLeads(campaign.id);
    let fixed = 0;
    let errors = 0;

    for (const lead of leads) {
      const vars = customVarsOf(lead);
      const body = vars?.personalized_body;
      if (typeof body !== 'string' || !/Dan\s*\|\s*Safely/i.test(body)) continue;

      const stripped = stripLegacySignOff(body);
      if (stripped === body) continue; // sign-off not at the end — leave as-is

      try {
        await fixLead(lead, vars, stripped);
        fixed += 1;
        console.log(`  fixed ${lead.email ?? lead.id}`);
      } catch (err) {
        errors += 1;
        const status = err.response?.status;
        console.error(
          `  FAILED ${lead.email ?? lead.id}${status ? ` (HTTP ${status})` : ''}: ${err.message}`
        );
      }
      await sleep(WRITE_DELAY_MS);
    }

    totalChecked += leads.length;
    totalFixed += fixed;
    console.log(
      `${campaign.name}: checked ${leads.length}, fixed ${fixed}` +
        (errors ? `, ${errors} error(s)` : '')
    );
  }

  console.log(`\nTotal: checked ${totalChecked}, fixed ${totalFixed}`);
}

main().catch((err) => {
  const status = err.response?.status;
  const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error(`fix-legacy-bodies failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
  process.exit(1);
});
