// Export all approved-but-unsent emails (approval_status = 'approved' AND
// sent_at IS NULL) that have a verified recipient address to a CSV, ready to
// hand to a sending tool.
//
// Thin CLI wrapper around the shared exporter in src/services/emailExport.js,
// so the command line and the GET /api/emails/export route produce the same
// file (columns: first_name, last_name, email, company, subject, body).
//
// Output: emails-ready-to-send.csv in the project root.
//
// Usage:
//   node src/scripts/exportEmails.js
//   npm run export:emails

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const db = require('../config/db');
const { fetchExportableEmails, recordsToCsv } = require('../services/emailExport');

const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'emails-ready-to-send.csv');

async function main() {
  const records = await fetchExportableEmails();
  fs.writeFileSync(OUTPUT_PATH, recordsToCsv(records), 'utf8');
  console.log(`Exported ${records.length} email(s) to ${OUTPUT_PATH}`);
}

main()
  .catch((err) => {
    console.error('export:emails failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
