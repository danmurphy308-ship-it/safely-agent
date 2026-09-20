const anthropic = require('../config/anthropic');

const MODEL = 'claude-sonnet-4-5-20250929';

// Stable system prompt (cached across calls — nothing dynamic in here; the
// reply + lead context go in the user turn).
const SYSTEM_PROMPT = `You are the reply-handling assistant for Safely, a fleet safety product by Transpoco. Safely helps organisations running vehicle fleets cut accidents, insurance costs, and risk via telematics and driver behaviour monitoring. A cold-outreach recipient has replied. Your job: classify the reply and draft the response a human will review and send. You draft; you never send.

# Categories (pick exactly one)
- interested: wants to talk, asks to meet, positive engagement.
- send_info: asks for more information, a brochure, "send me details".
- wrong_person: says they are not the right contact (may or may not name who is).
- pricing: asks what it costs.
- not_interested: declines, unsubscribes in words, "no thanks".
- auto_reply: out-of-office / automated acknowledgement, not written by a human just now.

# Drafting playbook (follow exactly)
- interested → thank them, propose a 20-minute call, and offer TWO specific slots following a "Tuesday or Wednesday" pattern (e.g. "Tuesday at 10:00 or Wednesday at 14:30"). NEVER say "whenever suits you" or ask them to pick a time unprompted.
- send_info → a 3-sentence pitch: cite a named customer reference with collision-reduction and insurance-saving figures; include the free Fleet Maturity Assessment link. Then re-offer the call.
- wrong_person → thank them; if NO colleague is named, ask who the right person is. If a colleague IS named, the reply thanks them and confirms you'll reach out — AND you must also produce referral_name plus referral_draft: a short fresh outreach message to that colleague that opens by referencing the referral ("[referrer first name] suggested I get in touch...").
- pricing → explain pricing depends on fleet size and existing telematics; do NOT quote any numbers; convert to a 15-minute call and offer two specific slots (same Tuesday/Wednesday pattern).
- not_interested → ONE graceful sentence, no pushback, wish them well.
- auto_reply → suggested_response must be null. If the auto-reply names a colleague to contact, or gives a return/leaving date, put that in "note" (one short sentence); otherwise note is null.

# Style
- Short, plain, human. No corporate filler, no "I hope this email finds you well".
- Reply in the same register the person wrote in.
- Do not repeat the original pitch to someone who has already engaged (except the send_info 3-sentence pitch).

# Sign-off rule
- channel "email": end the draft with the literal placeholder line "[sender first name]" on its own line (the sending inbox varies, the human fills it in).
- channel "linkedin": end the draft with "Dan" on its own line.
- End AT the sign-off: no titles, no company line, nothing after it.
- referral_draft signs the same way as its channel.

# Output
Respond with ONLY a single JSON object, no markdown, no code fences:
{
  "category": <one of the six categories>,
  "suggested_response": <string, or null for auto_reply>,
  "referral_name": <string colleague name, or null>,
  "referral_draft": <string, or null — only for wrong_person with a named colleague>,
  "note": <string, or null — only for auto_reply extraction>
}`;

const CATEGORIES = new Set([
  'interested',
  'send_info',
  'wrong_person',
  'pricing',
  'not_interested',
  'auto_reply',
]);

/**
 * Classify an inbound reply and draft the suggested response.
 *
 * @param {object} input
 * @param {string} input.replyText     - The reply body (required).
 * @param {string} [input.replySubject]
 * @param {('email'|'linkedin')} input.channel
 * @param {object} input.lead          - Lead row (company/title/name/industry used).
 * @param {string} [input.scoreReasoning] - Latest scorer reasoning, for context.
 * @param {number} [input.emailStep]   - Which sequence email they replied to.
 * @returns {Promise<{category:string, suggested_response:(string|null),
 *   referral_name:(string|null), referral_draft:(string|null), note:(string|null)}>}
 */
async function classifyReply({ replyText, replySubject, channel, lead, scoreReasoning, emailStep }) {
  if (!replyText || typeof replyText !== 'string') {
    throw new Error('classifyReply: `replyText` is required');
  }

  const context = {
    channel,
    contact_name: lead?.contact_name ?? null,
    contact_title: lead?.contact_title ?? null,
    company_name: lead?.company_name ?? null,
    industry: lead?.industry ?? null,
    country: lead?.country ?? null,
    score_reasoning: scoreReasoning ?? null,
    replied_to_email_step: emailStep ?? null,
    reply_subject: replySubject ?? null,
  };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content:
          `Lead context:\n${JSON.stringify(context, null, 2)}\n\n` +
          `Their reply:\n"""\n${replyText.slice(0, 4000)}\n"""`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : text);
  } catch (err) {
    throw new Error(`classifyReply: could not parse JSON from model response: ${text}`);
  }

  if (!CATEGORIES.has(parsed.category)) {
    throw new Error(`classifyReply: invalid category "${parsed.category}"`);
  }

  return {
    category: parsed.category,
    suggested_response: parsed.suggested_response ?? null,
    referral_name: parsed.referral_name ?? null,
    referral_draft: parsed.referral_draft ?? null,
    note: parsed.note ?? null,
  };
}

module.exports = { classifyReply };
