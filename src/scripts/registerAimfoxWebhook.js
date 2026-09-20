// One-off: register (or verify) the Aimfox webhook that feeds
// POST /api/webhooks/aimfox. Idempotent — if a webhook already points at our
// receiver URL, it reports it and exits without creating a duplicate.
//
// Usage: npm run aimfox:register-webhook
//        APP_PUBLIC_URL overrides the receiver base URL (default the Fly app).
//
// Events subscribed (see docs.aimfox.com/webhooks):
//   connect        → linkedin_status 'requested' (request actually sent)
//   accepted       → 'accepted' (campaign request accepted)
//   new_connection → 'accepted' (connection detected account-wide)
//   reply / new_reply / campaign_reply → 'replied' + lead status 'replied'

require('dotenv').config();
const axios = require('axios');

const API_BASE = 'https://api.aimfox.com/api/v2';
const WEBHOOK_EVENTS = [
  'connect',
  'accepted',
  'new_connection',
  'reply',
  'new_reply',
  'campaign_reply',
];

async function main() {
  const apiKey = process.env.AIMFOX_API_KEY;
  if (!apiKey) {
    console.error('AIMFOX_API_KEY is not set — add it to .env first.');
    process.exit(1);
  }

  const base = (process.env.APP_PUBLIC_URL || 'https://safely-agent.fly.dev').replace(/\/$/, '');
  const url = `${base}/api/webhooks/aimfox`;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const { data: existing } = await axios.get(`${API_BASE}/webhooks`, { headers });
  const match = (existing?.webhooks ?? []).find((w) => w.url === url && !w.deleted);
  if (match) {
    console.log(`Webhook already registered (id ${match.id}):`);
    console.log(`  url:    ${match.url}`);
    console.log(`  events: ${(match.events ?? []).join(', ')}`);
    const missing = WEBHOOK_EVENTS.filter((e) => !(match.events ?? []).includes(e));
    if (missing.length) {
      console.warn(`  WARNING: missing events: ${missing.join(', ')} — update it in Aimfox.`);
    }
    return;
  }

  const body = {
    name: 'Safely SDR LinkedIn events',
    events: WEBHOOK_EVENTS,
    url,
    integration: false,
  };
  // Optional delivery auth: the receiver checks AIMFOX_WEBHOOK_SECRET when set.
  const secret = process.env.AIMFOX_WEBHOOK_SECRET;
  if (secret) {
    body.headers = { Authorization: `Bearer ${secret}` };
  }

  let created;
  try {
    created = (await axios.post(`${API_BASE}/webhooks`, body, { headers })).data;
  } catch (err) {
    // The documented create body has no headers field — if Aimfox rejects it,
    // retry without and warn (delivery auth can be added in the Aimfox UI).
    if (secret && [400, 422].includes(err.response?.status)) {
      console.warn('Create with auth header rejected — retrying without delivery auth.');
      console.warn('Add the Authentication Header in Aimfox UI, or unset AIMFOX_WEBHOOK_SECRET.');
      delete body.headers;
      created = (await axios.post(`${API_BASE}/webhooks`, body, { headers })).data;
    } else {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`webhook create failed (HTTP ${err.response?.status ?? '?'}): ${detail}`);
    }
  }

  const webhook = created?.webhook ?? created;
  console.log('Webhook registered:');
  console.log(`  id:     ${webhook?.id}`);
  console.log(`  url:    ${webhook?.url}`);
  console.log(`  events: ${(webhook?.events ?? []).join(', ')}`);
}

main().catch((err) => {
  console.error('aimfox:register-webhook failed:', err.message);
  process.exit(1);
});
