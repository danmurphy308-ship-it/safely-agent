// Shared CSV → leads import logic, used by both the CLI script
// (src/scripts/importCSV.js) and the upload route
// (POST /api/campaigns/:id/upload-csv) so they import identically:
// map columns → blacklist + dedupe + insert (saveLeadIfNew) → backfill emails.
//
// Expected CSV headers (case-sensitive):
//   Company Name, First Name, Last Name, Work Email, Job Title,
//   Location, Company Domain, LinkedIn Profile

const { parse } = require('csv-parse/sync');

const db = require('../config/db');
const { saveLeadIfNew, incrementCampaignLeads } = require('./findLeads');

// Process rows in chunks, pausing between them, so a large CSV doesn't hold the
// database connection open in one long uninterrupted burst.
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Backfill the contact_email of an existing lead matched on company_name +
// contact_name when that lead's email is currently NULL and the CSV row carries
// a real one. Returns true if an existing row was updated. The `contact_email
// IS NULL` guard means we only fill gaps — we never overwrite an existing email.
async function backfillContactEmail(lead) {
  if (!lead.company_name || !lead.contact_name || !lead.contact_email) return false;

  const { rowCount } = await db.query(
    `UPDATE leads
        SET contact_email = $1
      WHERE company_name = $2
        AND contact_name = $3
        AND contact_email IS NULL`,
    [lead.contact_email, lead.company_name, lead.contact_name]
  );
  return rowCount > 0;
}

// Map one CSV record (keyed by header) to a `leads` table row shape.
function mapCsvRecordToLead(record) {
  const trim = (value) => {
    if (value === undefined || value === null) return null;
    const cleaned = String(value).trim();
    return cleaned === '' ? null : cleaned;
  };

  const contactName =
    [trim(record['First Name']), trim(record['Last Name'])].filter(Boolean).join(' ') ||
    null;

  return {
    company_name: trim(record['Company Name']),
    contact_name: contactName,
    contact_email: trim(record['Work Email']),
    contact_title: trim(record['Job Title']),
    country: trim(record['Location']),
    company_domain: trim(record['Company Domain']),
    contact_linkedin: trim(record['LinkedIn Profile']),
  };
}

// Import already-parsed CSV records (each keyed by header) into the `leads`
// table for a campaign. Returns a summary; an optional onProgress(processed,
// total) callback is invoked after each batch (used by the CLI for logging).
async function importLeadRecords(records, campaignId, { onProgress } = {}) {
  const summary = { inserted: 0, updated: 0, blacklisted: 0, duplicates: 0, skipped: 0 };

  let processed = 0;
  for (let start = 0; start < records.length; start += BATCH_SIZE) {
    // Pause between batches (not before the first) to ease DB connection load.
    if (start > 0) await sleep(BATCH_DELAY_MS);

    const batch = records.slice(start, start + BATCH_SIZE);
    for (const record of batch) {
      const lead = mapCsvRecordToLead(record);
      const { status } = await saveLeadIfNew(campaignId, lead);

      if (status === 'inserted') summary.inserted += 1;
      else if (status === 'blacklisted') summary.blacklisted += 1;
      else if (status === 'duplicate') {
        // The lead already exists. If we matched a name-only row whose email was
        // never captured, fill it in from this CSV row; otherwise it's a plain dupe.
        if (await backfillContactEmail(lead)) summary.updated += 1;
        else summary.duplicates += 1;
      } else summary.skipped += 1;
    }

    processed += batch.length;
    if (onProgress) onProgress(processed, records.length);
  }

  // Keep the campaign's lead counter in sync with what we just inserted.
  await incrementCampaignLeads(campaignId, summary.inserted);

  return summary;
}

// Parse raw CSV content (string or Buffer) and import it for a campaign.
// Returns { total, inserted, updated, blacklisted, duplicates, skipped }.
async function importLeadsFromCsv(content, campaignId, options = {}) {
  const records = parse(content, {
    columns: true, // first row is the header
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const summary = await importLeadRecords(records, campaignId, options);
  return { total: records.length, ...summary };
}

module.exports = {
  mapCsvRecordToLead,
  backfillContactEmail,
  importLeadRecords,
  importLeadsFromCsv,
};
