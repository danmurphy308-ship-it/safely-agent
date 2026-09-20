const nodemailer = require('nodemailer');

// Outbound notification email via Gmail SMTP.
//
// Used to alert the team when something needs a human — currently a reply
// landing on an active outreach sequence (see the Instantly webhook handler).
//
// Environment:
//   NOTIFICATION_EMAIL - recipient address for alerts (required to send).
//   SMTP_HOST          - SMTP server host (default smtp.gmail.com).
//   SMTP_PORT          - SMTP server port (default 587, STARTTLS).
//   SMTP_USER          - Gmail address used to authenticate / send from.
//   SMTP_PASS          - Gmail App Password (NOT the account password).
//   SMTP_FROM          - optional From address (defaults to SMTP_USER).

let transporter = null;

// Build (once) and reuse a nodemailer transport from the SMTP_* env vars.
function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('notifier: SMTP_USER and SMTP_PASS must be set in the environment');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 uses STARTTLS
    auth: { user, pass },
  });
  return transporter;
}

/**
 * Notify the team that a lead replied to our outreach.
 *
 * Sends to NOTIFICATION_EMAIL. No-op (returns { sent: false }) if
 * NOTIFICATION_EMAIL is not configured, so the webhook still succeeds when
 * notifications aren't set up.
 *
 * @param {object} lead - Lead row; uses `contact_name` and `company_name`.
 * @param {object} [options]
 * @param {('email'|'linkedin')} [options.channel='email'] - Where the reply
 *   landed, so the alert points at the right inbox (Instantly vs Aimfox).
 * @param {object|null} [options.assist] - Reply-assist result: { category,
 *   suggested_response, referral_name, referral_draft }. When present, both
 *   go in the alert inline so the reply can be handled from a phone.
 * @returns {Promise<{sent:boolean, messageId?:string, reason?:string}>}
 */
async function notifyReply(lead, { channel = 'email', assist = null } = {}) {
  const to = process.env.NOTIFICATION_EMAIL;
  if (!to) {
    return { sent: false, reason: 'NOTIFICATION_EMAIL not configured' };
  }

  const company = lead?.company_name || 'an unknown company';
  const contact = lead?.contact_name || 'A contact';
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const inbox = channel === 'linkedin' ? 'the Aimfox inbox' : 'Instantly';
  const subject =
    (assist ? `[${assist.category}] ` : '') +
    (channel === 'linkedin'
      ? `LinkedIn reply from ${company}`
      : `Reply received from ${company}`);

  let body =
    channel === 'linkedin'
      ? `${contact} at ${company} has replied to your Safely LinkedIn outreach.`
      : `${contact} at ${company} has replied to your Safely outreach.`;

  if (assist) {
    body += `\n\nCategory: ${assist.category}`;
    if (assist.suggested_response) {
      body +=
        `\n\nSuggested response (review, then send from ${inbox}):\n` +
        `----------------------------------------\n` +
        `${assist.suggested_response}\n` +
        `----------------------------------------`;
    }
    if (assist.referral_name && assist.referral_draft) {
      body +=
        `\n\nThey referred you to ${assist.referral_name}. Draft outreach to them:\n` +
        `----------------------------------------\n` +
        `${assist.referral_draft}\n` +
        `----------------------------------------`;
    }
  } else {
    body += ` Log in to ${inbox} to respond.`;
  }

  const info = await getTransporter().sendMail({
    from,
    to,
    subject,
    text: body,
  });

  return { sent: true, messageId: info.messageId };
}

module.exports = { notifyReply };
