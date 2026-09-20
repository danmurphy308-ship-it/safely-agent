// Import leads from a CSV file into the `leads` table.
//
// Thin CLI wrapper around the shared importer in src/pipeline/importCsv.js, so
// command-line imports and the /api/campaigns/:id/upload-csv route follow the
// exact same rules (map columns → blacklist + dedupe + insert → backfill emails).
//
// Usage:
//   node src/scripts/importCSV.js <path-to-csv> [campaign_id]
//   npm run import:csv -- <path-to-csv> [campaign_id]
//
// Expected CSV headers (case-sensitive):
//   Company Name, First Name, Last Name, Work Email, Job Title,
//   Location, Company Domain, LinkedIn Profile

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');

const db = require('../config/db');
const { importLeadsFromCsv } = require('../pipeline/importCsv');

async function main() {
  const [csvPath, campaignArg] = process.argv.slice(2);

  if (!csvPath) {
    console.error('Usage: node src/scripts/importCSV.js <path-to-csv> [campaign_id]');
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  let campaignId = null;
  if (campaignArg !== undefined) {
    campaignId = Number(campaignArg);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      console.error(`Invalid campaign_id: ${campaignArg} (must be a positive integer)`);
      process.exit(1);
    }
  }

  const content = fs.readFileSync(csvPath, 'utf8');

  console.log(`Reading ${csvPath}`);
  if (campaignId != null) console.log(`Attributing to campaign ${campaignId}`);

  const summary = await importLeadsFromCsv(content, campaignId, {
    onProgress: (processed, total) => console.log(`Processed ${processed} / ${total} row(s)`),
  });

  console.log('\nImport complete:');
  console.log(`  inserted:    ${summary.inserted}`);
  console.log(`  updated:     ${summary.updated} (backfilled missing email)`);
  console.log(`  duplicates:  ${summary.duplicates}`);
  console.log(`  blacklisted: ${summary.blacklisted}`);
  console.log(`  skipped:     ${summary.skipped} (no company name)`);

  await db.pool.end();
}

main().catch(async (err) => {
  console.error('\nCSV import failed:', err.message);
  try {
    await db.pool.end();
  } catch (_) {
    // ignore pool shutdown errors during failure path
  }
  process.exit(1);
});
