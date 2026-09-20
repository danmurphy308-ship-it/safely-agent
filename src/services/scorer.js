const anthropic = require('../config/anthropic');

const MODEL = 'claude-sonnet-4-5-20250929';

// Stable system prompt. Kept byte-for-byte identical across calls so the
// prompt-cache prefix is reused — the per-lead data goes in the user turn,
// after this cached block. Do not interpolate anything dynamic here.
const SYSTEM_PROMPT = `You are a B2B sales qualification analyst for Safely, a fleet safety product. Safely helps organisations that operate vehicle fleets reduce accidents, insurance costs, and risk through telematics, driver behaviour monitoring, and safety reporting.

Your job: score how well a given lead fits Safely's ideal customer profile (ICP), from 0 (no fit) to 100 (perfect fit).

# Ideal Customer Profile

## Good fit
Service companies that use vehicles as a tool to deliver their core service — not as the core service itself. Examples of industries: utilities, telecoms, construction, facilities management, healthcare, councils/local government, security, energy companies, gas distribution, water utilities, NHS/healthcare, housing associations, local councils.
- OWN-ACCOUNT fleets are good fits: companies operating their own delivery fleets for their OWN products — food and drink distributors (e.g. Sysco, BWG Foods), wholesalers, manufacturers with distribution arms, retailers delivering their own goods. They run large fleets of their own vehicles as a tool of their trade; do NOT treat them as logistics/haulage bad fits.
- Fleet size: 100+ vehicles.
- Geography: United Kingdom, Ireland, or United States of America.
- Target buyer titles: Fleet Manager, Transport Manager, Head of Operations, Operations Director, Facilities Manager, Health and Safety Manager, Risk Manager, COO.

## Bad fit
- FOR-HIRE carriers only: companies whose business is moving OTHER organisations' goods or people for a fee — third-party hauliers/trucking, freight forwarders, parcel carriers, courier networks, taxis, last-mile delivery services. Named examples: Amazon's delivery network, DHL, Aramex, DPD, FedEx.
- The test is WHOSE goods are on the vehicle: a company delivering its own products (own-account) is a good fit; a company paid to move someone else's freight (for-hire) is a bad fit.
- Fewer than 100 vehicles.
- Junior contacts (e.g. assistants, coordinators, interns, individual drivers) rather than managers/directors/decision-makers.
- Located outside the UK, Ireland, and USA.

# Scoring guidance

## Score bands
- 80-100 = strong fit: senior fleet title, good-fit industry, UK/Ireland/USA.
- 60-79 = possible fit: largely good-fit but missing some data.
- 40-59 = weak fit: wrong title or wrong industry signals.
- 0-39 = bad fit: discard.

## General rules
- A lead that matches the good-fit industry, has 100+ vehicles, is in the UK/Ireland/USA, and has a senior target title should score highly (80-100).
- Missing or weak data should lower confidence and pull the score toward the middle, not to an extreme.
- Any clear bad-fit signal (core-business driving/delivery, <100 vehicles, junior contact, outside UK/Ireland/USA) should significantly reduce the score.
- If the job title contains 'logistics' as the primary function (not fleet logistics), reduce the score significantly.
- If the company is clearly a FOR-HIRE courier, haulage, freight, or last-mile delivery company (paid to move other people's goods), score below 30 regardless of title. Do NOT apply this rule to own-account fleets — distributors, wholesalers, and manufacturers delivering their own products.
- If fleet size data is missing but the company is clearly a large organisation (major utility, NHS trust, national telecoms provider, large construction company), infer that fleet size is likely 100+ and do not penalise for missing fleet size data. Only penalise for missing fleet size when the company size is genuinely unknown.

# Output
Respond with ONLY a single JSON object and no other text, no markdown, no code fences. The object must have exactly these fields:
{
  "score": <integer 0-100>,
  "segment": <one of: "fleet", "broker", "underwriter", "unknown">,
  "reasoning": <string: 1-3 sentences explaining the score, citing the specific ICP signals you used>,
  "recommendation": <one of: "pursue", "deprioritise", "discard">,
  "data_quality": <one of: "high", "medium", "low"> based on how complete the lead data is
}

Field rules:
- "segment": classify the lead's role in the fleet-insurance value chain. Most direct prospects are "fleet". Use "broker" or "underwriter" only if the lead is clearly an insurance broker or underwriter. Use "unknown" if you cannot tell.
- "recommendation": "pursue" for strong fits, "deprioritise" for weak-but-not-disqualified fits, "discard" for clear bad fits.
- "data_quality": "high" if most ICP-relevant fields are present, "low" if critical fields (industry, fleet size, title, country) are missing.`;

/**
 * Score a lead 0-100 for fit with Safely using Claude.
 *
 * @param {object} lead - Lead object (e.g. a row from the `leads` table).
 * @param {object} [options]
 * @param {boolean} [options.withUsage=false] - If true, also include the API
 *   `usage` object (token counts, cache hits) on the returned object.
 * @returns {Promise<{score:number, segment:string, reasoning:string, recommendation:string, data_quality:string, usage?:object}>}
 */
async function scoreLead(lead, { withUsage = false } = {}) {
  if (!lead || typeof lead !== 'object') {
    throw new Error('scoreLead: `lead` must be an object');
  }

  // Only send the fields relevant to scoring, in a stable key order so we
  // don't leak irrelevant/volatile data into the prompt.
  const leadForPrompt = {
    company_name: lead.company_name ?? null,
    contact_name: lead.contact_name ?? null,
    contact_title: lead.contact_title ?? null,
    company_url: lead.company_url ?? null,
    company_domain: lead.company_domain ?? null,
    industry: lead.industry ?? null,
    fleet_size: lead.fleet_size ?? null,
    country: lead.country ?? null,
    employee_count: lead.employee_count ?? null,
  };

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
    messages: [
      {
        role: 'user',
        content: `Score this lead:\n\n${JSON.stringify(leadForPrompt, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  const result = parseScore(text);
  return withUsage ? { ...result, usage: response.usage } : result;
}

// Parse Claude's response into the score object. Tolerates an accidental
// ```json code fence even though the prompt asks for raw JSON.
function parseScore(text) {
  let jsonText = text;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    jsonText = fenced[1];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`scoreLead: could not parse JSON from model response: ${text}`);
  }

  const result = {
    score: parsed.score,
    segment: parsed.segment,
    reasoning: parsed.reasoning,
    recommendation: parsed.recommendation,
    data_quality: parsed.data_quality,
  };

  if (typeof result.score !== 'number' || result.score < 0 || result.score > 100) {
    throw new Error(`scoreLead: invalid score in model response: ${JSON.stringify(parsed)}`);
  }

  return result;
}

module.exports = { scoreLead };
