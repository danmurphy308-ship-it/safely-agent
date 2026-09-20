const anthropic = require('../config/anthropic');

const MODEL = 'claude-sonnet-4-5-20250929';

// Hard word ceilings per email in the sequence — mirrors the per-emailNumber
// overrides appended to the user turn below (75 general / 50 for follow-up 2
// / 30 for follow-up 3). This runs unattended against real prospects, so it's
// enforced in code, not just asked for in the prompt.
const MAX_WORDS_BY_EMAIL_NUMBER = { 1: 75, 2: 50, 3: 30 };

// Case studies whose OWN bundled numbers (e.g. a case study's own bundled figures) are a single sanctioned proof point, not a second independent
// stat claim — see the "Case studies" section of the prompt below. A body
// citing a case study is allowed up to 2 percentage/number mentions; one
// citing no case study is allowed only 1.
const CASE_STUDY_NAME_PATTERN = /Infrastructure Operator|Airport Services|Facilities Group/i;

// Generic openers the prompt already bans (see "Never do" below) — checked
// again here in code because this runs unattended against real prospects and
// a strong prompt still isn't a hard guarantee. Matched against the FIRST
// sentence only.
const BANNED_OPENER_PATTERNS = [
  {
    label: 'generic "[sector] fleets face challenges" opener',
    re: /\b(fleets?|operations?)\s+(face|faces)\s+(unique\s+)?challenges?\b/i,
  },
  {
    label: 'generic "most/many fleet operators" opener',
    re: /^(most|many|several)\s+(\w+\s+){0,3}(operators|fleets|organi[sz]ations)\b/i,
  },
  {
    label: 'generic "[sector] operations/fleets typically/often..." opener',
    re: /\b(operations?|fleets?)\s+(typically|often|usually|generally)\b/i,
  },
  {
    label: 'generic "fleets juggle/manage/navigate" opener',
    re: /\bfleets?\s+(juggle|navigate)\b/i,
  },
];

// Stable system prompt. Kept byte-for-byte identical across calls so the
// prompt-cache prefix is reused — the per-lead data goes in the user turn,
// after this cached block. Do not interpolate anything dynamic here.
const SYSTEM_PROMPT = `You are a B2B sales copywriter for Safely, a fleet safety product. Safely helps organisations that operate vehicle fleets reduce accidents, insurance costs, and risk through telematics, driver behaviour monitoring, and safety reporting.

Your job: write a short cold outreach email to a lead, personalised using the qualification data provided.

# Safely knowledge base
These are the only proof points you may cite. Use them where relevant, but NEVER fabricate or alter numbers — if a stat isn't listed here, don't claim it.
- <incident reduction rate>
- <reduction in insurance premiums for fleets>
- <reduction in accident frequency>
- <improvement in loss ratio for underwriters>
- <reduction in fuel consumption>
- <reduction in maintenance costs>
- <reduction in crashes>
- <reduction in insurance costs>
(Replace these placeholders with your own verified figures.)

# Case studies
Use these to add credibility. Rotate between them — NEVER use the same case study in two consecutive emails. Match the case study to the prospect's sector, and only include one if it's genuinely relevant:
- Infrastructure Operator - global infrastructure company, 3000+ vehicles: substantial reduction in collisions and a material per-vehicle annual saving. Best for construction / infrastructure prospects.
- Airport Services - 2000 vehicles across 29 airports: substantial reduction in fuel consumption. Best for aviation / transport prospects.
- Facilities Group - 500+ vehicles across the UK and Ireland: switched from an unreliable competitor. Best for facilities / services prospects.

Case study rules:
- Never use the same case study twice in consecutive emails.
- Match the case study to the prospect's industry where possible (see the "Best for" notes above) — Airport Services for aviation/transport, Infrastructure Operator for construction/infrastructure, Facilities Group for facilities/services.
- Only include a case study if it's relevant to the prospect's sector.
- Not every email needs one — it's fine to skip the case study entirely and just use a relevant stat instead.

# Writing guidance
- Tone: professional, direct, and warm. No hype, no buzzwords, no exclamation marks.
- Structure: exactly three parts, in this order, and nothing else.
  1. OPENER (first sentence) — a concrete observation about THIS SPECIFIC company, anchored on their company_name (always provided). Use whichever of these ARE present as supporting detail ABOUT THAT COMPANY — business_tags (specific things this company actually does, e.g. "roof truss manufacturing"), company_revenue, employee_count, city, industry, country — never as a generalisation about their industry as a whole. Prefer the most concrete, company-specific signal available (a business_tag or company_revenue beats a generic industry label) over a vaguer one. Never phrase it as "[industry] fleets/operations typically/often..." — that describes an entire sector, not this company, and is exactly the generic industry opener banned below with different words. Do NOT mention Safely or the product in this sentence — it is about THEM, not us. If most fields are null, anchor to whichever single field IS present (their role, their industry, or their region) rather than inventing specifics — never fabricate a fact or a number that isn't in the data.
  2. VALUE POINT — exactly one clear point about how Safely reduces accidents, insurance costs, or risk for fleets like theirs, connected naturally to the opener.
  3. CLOSER (final sentence) — exactly one soft, interest-gauging QUESTION. This is a temperature check, not a meeting ask — never propose a call, a meeting, or a specific time length (e.g. "15 minutes"). Vary the wording — rotate between phrasings like "Is this something you're already looking at?", "Worth a closer look at how this could apply to your fleet?", "Curious if this is on your radar right now?", "Would it be useful to see how this maps to your operation?"
- Target 60-70 words. 75 words is the absolute maximum - never exceed it.
- Do NOT include any sign-off, name, or signature. The body ends immediately after the closing question - the sending system appends the sender's signature automatically.

# Never do
- Never open with a Safely/product statement — the first sentence must be the lead-specific observation described above.
- Never ask to "book a call", propose a meeting, or name a call/meeting length (e.g. "15 minutes", "quick call") — the closer is a soft interest question, not a scheduling ask.
- Never use multiple calls to action, and never use more than one question in the body — exactly one closing question.
- Never say "I am excited" (or any "I'm excited" variant).
- Never reference Irish road statistics.
- Never use gimmicky reply mechanics (e.g. "reply with a phrase" / "reply YES").
- Never say "companies like [the prospect's own company name]" — they work there, so it reads as nonsense.
- Never open with "[Industry] fleets face unique challenges" or any equivalent generic industry opener — including softened versions like "[industry] operations typically/often face..." or "Municipal fleets juggle...". If the opener would still be true with the company's name swapped out for any other company in their sector, rewrite it anchored on their actual company_name instead.
- The VALUE POINT must cite exactly ONE statistic, total, and no more. Never combine two different stats anywhere in the same email, even across separate clauses of the same sentence (e.g. do NOT write "reduce accidents by 46% and cut insurance premiums by 35%" - that is two stats; pick ONE metric and stop). This includes never using both the 70% and 35% stats together.
- Never use the phrases "meaningful improvements" or "admin burden".
- Never reference, imply, or estimate the size of a prospect's fleet or a vehicle count unless fleet_size is explicitly provided in the lead data — in practice this is almost always null, since neither sourcing pipeline currently populates it. Do NOT infer a vehicle count from employee_count, company_revenue, or business_tags (e.g. "several hundred vehicles", "a fleet that size", "dozens of vehicles on the road") - that is a fabrication, not the same as fleet_size being given. Those fields describe the company; they say nothing about how many vehicles it runs.
- Never use hedging words like "likely", "probably", or "presumably" anywhere in the email - state only what's actually in the data, with confidence.
- Never use em dashes (—) or en dashes (–) anywhere in the subject or body — use a regular hyphen (-) instead, to avoid encoding problems in CSV exports.

# Output
Respond with ONLY a single JSON object and no other text, no markdown, no code fences. The object must have exactly these fields:
{
  "subject": <string: a concise, specific subject line under 60 characters>,
  "body": <string: the full email body, ending after the closing question, with NO sign-off>
}`;

/**
 * Draft a cold outreach email for a lead using Claude.
 *
 * @param {object} lead - Lead object, typically a scored row from the `leads`
 *   table. Uses `ai_score`, `ai_reasoning`, and `segment` to personalise, plus
 *   any standard lead fields (company_name, contact_name, etc.) that are present.
 * @param {object} [options]
 * @param {boolean} [options.withUsage=false] - If true, also include the API
 *   `usage` object (token counts, cache hits) on the returned object.
 * @param {{subject?:string, body:string}|null} [options.previousEmail=null] - The
 *   previous email drafted in this campaign, if any. Passed into the user turn so
 *   Claude can avoid reusing the same case study or call-to-action wording.
 * @param {1|2|3} [options.emailNumber=1] - Which email in the 3-step sequence to
 *   draft. 1 = cold intro, 2 = short follow-up (different angle), 3 = final nudge.
 * @returns {Promise<{subject:string, body:string, email_number:number, data_quality:string,
 *   validation:{valid:boolean, errors:string[], wordCount:number, statCount:number}, usage?:object}>}
 */
async function draftEmail(lead, { withUsage = false, previousEmail = null, emailNumber = 1 } = {}) {
  if (!lead || typeof lead !== 'object') {
    throw new Error('draftEmail: `lead` must be an object');
  }
  if (![1, 2, 3].includes(emailNumber)) {
    throw new Error('draftEmail: `emailNumber` must be 1, 2, or 3');
  }

  const enrichment = extractEnrichmentSignal(lead);

  // Only send the fields relevant to drafting, in a stable key order so we
  // don't leak irrelevant/volatile data into the prompt.
  const leadForPrompt = {
    company_name: lead.company_name ?? null,
    contact_name: lead.contact_name ?? null,
    contact_title: lead.contact_title ?? null,
    industry: lead.industry ?? null,
    fleet_size: lead.fleet_size ?? null,
    employee_count: enrichment.employee_count,
    city: enrichment.city,
    country: lead.country ?? null,
    company_revenue: enrichment.company_revenue,
    business_tags: enrichment.business_tags,
    segment: lead.segment ?? null,
    ai_score: lead.ai_score ?? null,
    ai_reasoning: lead.ai_reasoning ?? null,
  };

  const dataQuality = assessDataQuality(lead);

  // The dynamic per-lead data (and the optional previous-email context) goes in
  // the user turn, AFTER the cached system block, so the cache prefix is reused.
  let userContent = `Write a cold outreach email for this lead:\n\n${JSON.stringify(leadForPrompt, null, 2)}`;
  if (previousEmail && typeof previousEmail.body === 'string' && previousEmail.body.trim()) {
    userContent +=
      `\n\nThis was the PREVIOUS email drafted in this campaign:\n` +
      `${previousEmail.subject ? `Subject: ${previousEmail.subject}\n` : ''}` +
      `${previousEmail.body.trim()}\n\n` +
      `Do NOT reuse the same case study, and do NOT reuse the same call-to-action wording, ` +
      `as that previous email. Pick a different case study (or skip it) and a different CTA.`;
  }

  // Sequence-specific instructions, appended to the user turn so the cached
  // system prefix stays byte-for-byte identical. These OVERRIDE the general
  // word-limit guidance in the system prompt for follow-ups.
  if (emailNumber === 2) {
    userContent +=
      `\n\nThis is FOLLOW-UP EMAIL 2 of 3 (the first follow-up). Requirements that ` +
      `OVERRIDE the general guidance above:\n` +
      `- Keep the body to a MAXIMUM of 50 words.\n` +
      `- Briefly acknowledge they may have missed your first email.\n` +
      `- Take a different angle and lead with a DIFFERENT value prop / proof point than email 1.`;
  } else if (emailNumber === 3) {
    userContent +=
      `\n\nThis is FOLLOW-UP EMAIL 3 of 3 (the final follow-up). Requirements that ` +
      `OVERRIDE the general guidance above:\n` +
      `- Keep the body to a MAXIMUM of 30 words.\n` +
      `- Soft close, low pressure. Make clear this is your last follow-up on this.`;
  }

  // One Claude call -> parsed, cleaned {subject, body} + raw usage.
  async function generateOnce(content) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content }],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const draft = parseDraft(text);

    // Normalise em/en dashes to a plain hyphen so they can't cause encoding
    // problems in CSV exports, regardless of what the model emitted.
    draft.subject = normaliseDashes(draft.subject);
    draft.body = normaliseDashes(draft.body);

    // The scheduling-link placeholder is no longer used. If the model still
    // emits [SCHEDULING_LINK], strip it out along with any surrounding
    // whitespace — collapsing to a clean paragraph break — then trim the body.
    draft.body = draft.body.replace(/\s*\[SCHEDULING_LINK\]\s*/g, '\n\n').trim();

    return { draft, usage: response.usage };
  }

  // Generate, then validate in code (see validateDraft) — the prompt already
  // asks for all of this, but this runs unattended against real prospects, so
  // a hard guarantee beats a strong prompt. One retry with the specific
  // violations fed back; if that still fails, log it loudly and ship whichever
  // of the two attempts has fewer violations rather than blocking the pipeline.
  let { draft, usage } = await generateOnce(userContent);
  let check = validateDraft(draft, emailNumber);

  if (!check.valid) {
    const retryContent =
      `${userContent}\n\nYour previous draft violated these rules: ${check.errors.join('; ')}. ` +
      `Rewrite it from scratch, fixing ALL of these issues, while still following every other instruction above.`;
    const retry = await generateOnce(retryContent);
    const retryCheck = validateDraft(retry.draft, emailNumber);

    // Sum usage across both calls so withUsage reflects the actual API spend.
    if (usage && retry.usage) {
      usage = {
        ...retry.usage,
        input_tokens: (usage.input_tokens ?? 0) + (retry.usage.input_tokens ?? 0),
        output_tokens: (usage.output_tokens ?? 0) + (retry.usage.output_tokens ?? 0),
      };
    } else {
      usage = retry.usage;
    }

    if (retryCheck.valid) {
      draft = retry.draft;
      check = retryCheck;
    } else {
      // Both attempts still have violations — fall back to whichever has
      // fewer, logging loudly since a bad draft can otherwise sail through to
      // approval/send unnoticed.
      const useRetry = retryCheck.errors.length <= check.errors.length;
      console.error(
        `[drafter] lead ${lead.id ?? '(unknown)'} email ${emailNumber}: validation failed twice — ` +
          `attempt 1: ${check.errors.join('; ') || 'none'}; attempt 2: ${retryCheck.errors.join('; ') || 'none'}. ` +
          `Using attempt ${useRetry ? 2 : 1} (fewer violations).`
      );
      if (useRetry) {
        draft = retry.draft;
        check = retryCheck;
      }
    }
  }

  const result = {
    ...draft,
    email_number: emailNumber,
    data_quality: dataQuality,
    validation: check,
  };

  return withUsage ? { ...result, usage } : result;
}

// Apollo-sourced leads (97% of leads; Clay-sourced leads carry a differently
// -shaped raw record and simply won't have this key) nest richer company
// signal under raw_enrichment.organization. Pulled out here, rather than
// passing the whole raw_enrichment blob into the prompt, because it's large
// (keyword lists can run 100+ entries) and mostly irrelevant to drafting
// (employment history, CRM ids, phone numbers, etc). Every field here is
// optional and null-safe wherever it's used — fleet_size/vehicle count has
// no equivalent anywhere in either sourcing pipeline (Clay or Apollo); this
// is the closest available signal for "how big/specific is this company".
function extractEnrichmentSignal(lead) {
  const org = lead.raw_enrichment?.organization ?? null;
  const account = lead.raw_enrichment?.account ?? null;
  return {
    employee_count: lead.employee_count ?? org?.estimated_num_employees ?? null,
    city: org?.city ?? account?.city ?? null,
    company_revenue: org?.organization_revenue_printed ?? null,
    // First 8 only — Apollo's full keyword lists run 100+ entries and trail
    // into generic buzzwords ("b2b", "productivity"); the first handful are
    // consistently the ones most specific to this particular company.
    business_tags: Array.isArray(org?.keywords) ? org.keywords.slice(0, 8) : null,
  };
}

// Replace em dashes (U+2014) and en dashes (U+2013) with a plain hyphen.
function normaliseDashes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[—–]/g, '-');
}

// Word count that doesn't inflate on standalone punctuation (e.g. a lone
// " - " splits into a fake extra "word" under a naive whitespace split).
function countWords(body) {
  return body.trim().split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
}

// Percentage/number claims — e.g. "46%", "3.5%". Deliberately simple (no
// coupling to the exact knowledge-base figures, which would go stale the
// moment that list is edited) at the cost of not catching a non-percentage
// dollar claim stacked alongside a percentage one — an acceptable gap for a
// first pass; the case-study numbers (€450/vehicle, 3000+ vehicles) are
// exempted as a bundled unit via CASE_STUDY_NAME_PATTERN instead.
function countStatClaims(body) {
  return (body.match(/\d+(\.\d+)?%/g) || []).length;
}

// The first sentence only — banned generic patterns are an OPENER problem
// (see the "Never do" list), not a mid-body one.
function extractOpener(body) {
  const match = body.trim().match(/^[^.!?]*[.!?]/);
  return match ? match[0] : body;
}

function findBannedOpenerPattern(body) {
  const opener = extractOpener(body);
  return BANNED_OPENER_PATTERNS.find((p) => p.re.test(opener)) ?? null;
}

/**
 * Programmatic guardrail behind the prompt — this runs unattended against
 * real prospects, so a strong prompt isn't enough on its own (testing this
 * session already caught the model violating its own stat-stacking and
 * fleet-size-fabrication rules a few times). Checks exactly the three things
 * most likely to slip through: word count, stat count, and a banned generic
 * opener. Does NOT re-check every "Never do" rule — this is a backstop for
 * the failure modes actually observed, not a full prompt re-implementation.
 *
 * @param {{subject:string, body:string}} draft
 * @param {1|2|3} emailNumber
 * @returns {{valid:boolean, errors:string[], wordCount:number, statCount:number}}
 */
function validateDraft(draft, emailNumber) {
  const errors = [];
  const wordCount = countWords(draft.body);
  const maxWords = MAX_WORDS_BY_EMAIL_NUMBER[emailNumber] ?? MAX_WORDS_BY_EMAIL_NUMBER[1];
  if (wordCount > maxWords) {
    errors.push(`body is ${wordCount} words (max ${maxWords})`);
  }

  const statCount = countStatClaims(draft.body);
  const maxStats = CASE_STUDY_NAME_PATTERN.test(draft.body) ? 2 : 1;
  if (statCount > maxStats) {
    errors.push(
      `body cites ${statCount} stat(s) (max ${maxStats}${maxStats === 2 ? ' — a case study is present' : ''})`
    );
  }

  const bannedOpener = findBannedOpenerPattern(draft.body);
  if (bannedOpener) {
    errors.push(`opener matches a banned generic pattern: ${bannedOpener.label}`);
  }

  return { valid: errors.length === 0, errors, wordCount, statCount };
}

// Assess how complete the lead data is, based on the key fields that drive a
// well-personalised email. "high" if most are present, "low" if most are missing.
function assessDataQuality(lead) {
  const keyFields = [
    'company_name',
    'contact_name',
    'contact_title',
    'industry',
    'fleet_size',
    'country',
  ];

  const present = keyFields.filter((field) => {
    const value = lead[field];
    return value !== null && value !== undefined && value !== '';
  }).length;

  if (present >= 5) return 'high';
  if (present >= 3) return 'medium';
  return 'low';
}

// Parse Claude's response into the draft object. Tolerates an accidental
// ```json code fence even though the prompt asks for raw JSON.
function parseDraft(text) {
  let jsonText = text;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    jsonText = fenced[1];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`draftEmail: could not parse JSON from model response: ${text}`);
  }

  const result = {
    subject: parsed.subject,
    body: parsed.body,
  };

  if (typeof result.subject !== 'string' || !result.subject.trim()) {
    throw new Error(`draftEmail: missing/invalid subject in model response: ${JSON.stringify(parsed)}`);
  }
  if (typeof result.body !== 'string' || !result.body.trim()) {
    throw new Error(`draftEmail: missing/invalid body in model response: ${JSON.stringify(parsed)}`);
  }

  return result;
}

module.exports = { draftEmail };
