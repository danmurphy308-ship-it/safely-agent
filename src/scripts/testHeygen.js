// Manual test: generate ONE HeyGen personalized video for ONE real lead
// scoring 85+ already in the database, then poll for completion and print
// the share link.
//
// Per the project Safety Rules, this makes exactly one generation request
// (POST /v3/templates/:id) plus a bounded status-poll loop (max 10 polls,
// 15s apart — HeyGen renders typically take 1-3 minutes) — the same pattern
// testVerifyEmail.js uses for Instantly's async verification. Requires
// HEYGEN_API_KEY and HEYGEN_TEMPLATE_ID in .env. Run with:
//   node src/scripts/testHeygen.js [lead_id]
// Defaults to the most recently scored lead with score >= 85.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../config/db');
const { generateVideoForLead, getVideoStatus } = require('../integrations/heygen');

const MAX_POLLS = 10;
const POLL_DELAY_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findLead(leadId) {
  if (leadId) {
    const { rows } = await db.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    return rows[0] || null;
  }
  const { rows } = await db.query(
    `SELECT l.*
     FROM leads l
     JOIN scores s ON s.lead_id = l.id
     WHERE s.score >= 85
       AND s.id = (SELECT s2.id FROM scores s2 WHERE s2.lead_id = l.id ORDER BY s2.created_at DESC LIMIT 1)
     ORDER BY s.created_at DESC
     LIMIT 1`
  );
  return rows[0] || null;
}

async function main() {
  if (!process.env.HEYGEN_API_KEY || !process.env.HEYGEN_TEMPLATE_ID) {
    console.error('HEYGEN_API_KEY/HEYGEN_TEMPLATE_ID not set in .env — cannot call HeyGen.');
    process.exit(1);
  }

  const leadId = process.argv[2] ? Number(process.argv[2]) : null;
  const lead = await findLead(leadId);
  if (!lead) {
    console.error(
      leadId
        ? `Lead ${leadId} not found.`
        : 'No lead scoring >= 85 found in the database — pass a lead id explicitly.'
    );
    process.exit(1);
  }

  console.log(`Generating HeyGen video for lead ${lead.id} (${lead.company_name}, ${lead.contact_name || 'no contact name'})\n`);

  // One generation request only — do not loop here.
  const genResult = await generateVideoForLead(lead);
  if (genResult.outcome !== 'requested') {
    console.log(`→ not requested: ${genResult.outcome} (${genResult.reason})`);
    process.exit(genResult.outcome === 'skipped' ? 1 : 0);
  }
  console.log(`video_id: ${genResult.videoId}\nPolling for completion (up to ${MAX_POLLS} x ${POLL_DELAY_MS / 1000}s)...\n`);

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_DELAY_MS);
    const { status, videoUrl } = await getVideoStatus(genResult.videoId);
    console.log(`[poll ${i + 1}/${MAX_POLLS}] status: ${status}`);

    if (status === 'completed') {
      await db.query(
        `UPDATE leads SET heygen_video_status = 'completed', heygen_video_url = $2 WHERE id = $1`,
        [lead.id, videoUrl]
      );
      console.log(`\n→ share link: ${videoUrl}`);
      process.exit(0);
    }
    if (status === 'failed') {
      await db.query(`UPDATE leads SET heygen_video_status = 'failed' WHERE id = $1`, [lead.id]);
      console.log('\n→ generation failed on HeyGen\'s side.');
      process.exit(1);
    }
  }

  console.log(
    '\n→ still pending after the poll budget — heygenPoller will keep checking ' +
      `(video_id: ${genResult.videoId}), or re-run: node src/scripts/testHeygen.js ${lead.id}`
  );
}

main().catch((err) => {
  console.error('HeyGen test failed:', err.message);
  process.exit(1);
});
