// Shared "emails ready to send" CSV export logic, used by both the CLI script
// (src/scripts/exportEmails.js) and the GET /api/emails/export route so they
// produce an identical file.
//
// Includes emails that are APPROVED but not yet sent (approval_status =
// 'approved' AND sent_at IS NULL) whose lead has a verified (non-null)
// contact_email. The lead's full contact_name is split into first/last for the
// CSV.

const db = require('../config/db');

const EXPORT_COLUMNS = ['first_name', 'last_name', 'email', 'company', 'subject', 'body'];

// "Jane Q. Doe" -> { first: "Jane", last: "Q. Doe" }
function splitName(name) {
  if (!name) return { first: '', last: '' };
  const parts = String(name).trim().split(/\s+/);
  const first = parts.shift() || '';
  return { first, last: parts.join(' ') };
}

// Quote every field and escape embedded quotes so commas/newlines in bodies
// don't break the CSV.
function csvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function recordsToCsv(records) {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const row of records) {
    lines.push(EXPORT_COLUMNS.map((col) => csvField(row[col])).join(','));
  }
  // CRLF line endings for broad spreadsheet compatibility.
  return lines.join('\r\n') + '\r\n';
}

// Approved-but-unsent emails with a verified recipient address, mapped to
// export records (one object per email, keyed by EXPORT_COLUMNS).
async function fetchExportableEmails() {
  const { rows } = await db.query(
    `SELECT e.subject, e.body, l.contact_name, l.contact_email, l.company_name
     FROM emails e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.approval_status = 'approved'
       AND e.sent_at IS NULL
       AND l.contact_email IS NOT NULL
     ORDER BY e.created_at DESC`
  );

  return rows.map((r) => {
    const { first, last } = splitName(r.contact_name);
    return {
      first_name: first,
      last_name: last,
      email: r.contact_email,
      company: r.company_name,
      subject: r.subject,
      body: r.body,
    };
  });
}

module.exports = { EXPORT_COLUMNS, splitName, csvField, recordsToCsv, fetchExportableEmails };
