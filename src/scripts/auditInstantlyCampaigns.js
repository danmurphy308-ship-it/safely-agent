// One-off audit: list every Instantly campaign in the workspace and report
// its attached sending accounts and daily sending limit, so we can spot
// campaigns that would silently never send (no accounts) or send at an
// unintended rate. A campaign can send via an explicit email_list OR via
// membership in a tag-based shared pool (email_tag_list) with an empty
// email_list — checking email_list alone previously flagged several
// genuinely-healthy campaigns (USA, Ireland, Texas, UK Safety Roles, all
// sending from the shared "Safely" tag) as "no sending accounts attached",
// a real false positive fixed here to match campaignHealth.js's check.
// Also flags the other class of silent failure: a local
// campaign marked `active` (so the hourly jobs are drafting/sending leads
// for it) whose Instantly campaign isn't actually active — draft, paused,
// suspended, whatever. That combination is exactly how California Health &
// Safety Firms accumulated 61 queued-but-never-sent leads before anyone
// noticed; this check exists so the next one gets caught by this same audit
// habit instead of by accident.
//
// Read-only — makes only paginated GET /campaigns calls plus one local DB
// query. Requires INSTANTLY_API_KEY in .env. Run with:
//   npm run instantly:audit-campaigns

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const axios = require('axios');
const db = require('../config/db');
const { INSTANTLY_STATUS_LABELS: STATUS_LABELS, ACTIVELY_SENDING_STATUSES } = require('../integrations/instantly');

const API_BASE = 'https://api.instantly.ai/api/v2';

async function listAllCampaigns() {
  const campaigns = [];
  let startingAfter;
  for (;;) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const { data } = await axios.get(`${API_BASE}/campaigns`, {
      headers: { Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}` },
      params,
    });
    const items = data?.items ?? [];
    campaigns.push(...items);
    startingAfter = data?.next_starting_after ?? null;
    if (!startingAfter || items.length === 0) break;
  }
  return campaigns;
}

async function main() {
  if (!process.env.INSTANTLY_API_KEY) {
    console.error('INSTANTLY_API_KEY is not set in .env — cannot call Instantly.');
    process.exit(1);
  }

  const campaigns = await listAllCampaigns();
  console.log(`${campaigns.length} campaign(s) in the workspace:\n`);

  for (const c of campaigns) {
    const accounts = Array.isArray(c.email_list) ? c.email_list : [];
    const tags = Array.isArray(c.email_tag_list) ? c.email_tag_list : [];
    const status = STATUS_LABELS[c.status] ?? `unknown (${c.status})`;
    console.log(`${c.name}  [${status}]`);
    console.log(`  id:          ${c.id}`);
    console.log(`  daily_limit: ${c.daily_limit ?? '(not set)'}`);
    // A campaign can send via an explicit email_list OR via membership in a
    // tag-based shared pool (email_tag_list) with an empty email_list —
    // several real campaigns in this workspace rely on the tag path entirely
    // (see campaignHealth.js). Checking email_list alone flagged those as
    // "no sending accounts" — false positives; only flag when NEITHER is
    // present.
    if (accounts.length) {
      console.log(`  accounts:    ${accounts.join(', ')}`);
    } else if (tags.length) {
      console.log(`  accounts:    (via tag pool) ${tags.join(', ')}`);
    } else {
      console.log('  accounts:    NONE — this campaign cannot send!');
    }
    console.log('');
  }

  console.log('='.repeat(70));
  const byInstantlyId = new Map(campaigns.map((c) => [c.id, c]));
  const { rows: localActive } = await db.query(
    `SELECT id, name, instantly_campaign_id
     FROM campaigns
     WHERE status = 'active' AND instantly_campaign_id IS NOT NULL`
  );

  const drifted = [];
  for (const local of localActive) {
    const live = byInstantlyId.get(local.instantly_campaign_id);
    if (!live) {
      drifted.push({ ...local, liveStatus: 'NOT FOUND in Instantly workspace' });
    } else if (!ACTIVELY_SENDING_STATUSES.has(live.status)) {
      drifted.push({
        ...local,
        liveStatus: STATUS_LABELS[live.status] ?? `unknown (${live.status})`,
      });
    }
  }

  if (drifted.length === 0) {
    console.log(`✓ All ${localActive.length} locally-active campaign(s) are actually sending in Instantly.`);
  } else {
    console.log(
      `⚠️  ${drifted.length} of ${localActive.length} locally-active campaign(s) are NOT actually ` +
        'sending in Instantly — leads are being scored/drafted/"sent" for these but nothing is delivered:'
    );
    for (const d of drifted) {
      console.log(
        `  - "${d.name}" (local id ${d.id}, Instantly ${d.instantly_campaign_id}): ${d.liveStatus}`
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`audit failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
    process.exit(1);
  });
