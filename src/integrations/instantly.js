const axios = require('axios');
const db = require('../config/db');

// Instantly API v2 client.
//
// Sending model: Instantly sends on behalf of an active CAMPAIGN. There is no
// "send this exact body now" endpoint — instead you add a lead to a campaign and
// Instantly enrols them into that campaign's sequence and sends automatically.
// So sendEmail() adds the lead to INSTANTLY_CAMPAIGN_ID; the campaign's own
// template drives the copy that's sent.
//
// Docs: https://developer.instantly.ai/api/v2
//
// Environment:
//   INSTANTLY_API_KEY     - Bearer token for the Instantly API.
//   INSTANTLY_CAMPAIGN_ID - UUID of the campaign leads are added to / sent from.

const API_BASE = 'https://api.instantly.ai/api/v2';

// Emails drafted before the no-sign-off prompt change end with "Dan | Safely".
// The sequence template now appends the sign-off itself, so strip a trailing
// legacy one from the body to avoid a double signature. New drafts are
// unaffected (nothing to strip).
function stripLegacySignOff(body) {
  if (typeof body !== 'string') return body;
  return body.replace(/\s*\n\s*Dan\s*\|\s*Safely\s*$/i, '').trimEnd();
}

// Split a "First Last" contact name into first/last parts for Instantly's fields.
function splitName(contactName) {
  if (!contactName || typeof contactName !== 'string') {
    return { firstName: null, lastName: null };
  }
  const parts = contactName.trim().split(/\s+/);
  const firstName = parts.shift() || null;
  const lastName = parts.length ? parts.join(' ') : null;
  return { firstName, lastName };
}

/**
 * Resolve which Instantly campaign a lead should be enrolled into: prefer the
 * lead's own campaign's `instantly_campaign_id`, falling back to the
 * INSTANTLY_CAMPAIGN_ID env var when the campaign has none set (or the lookup
 * fails). Throws when neither is available so the caller can cancel the email
 * gracefully rather than attempting a doomed send.
 *
 * @param {object} lead - Lead row (may carry `campaign_id`).
 * @returns {Promise<string>}
 * @throws {Error} when no Instantly campaign is configured.
 */
async function resolveInstantlyCampaignId(lead) {
  if (lead && lead.campaign_id != null) {
    try {
      const { rows } = await db.query(
        'SELECT instantly_campaign_id FROM campaigns WHERE id = $1',
        [lead.campaign_id]
      );
      if (rows[0] && rows[0].instantly_campaign_id) {
        return rows[0].instantly_campaign_id;
      }
    } catch (err) {
      // Lookup failed (e.g. DB hiccup) — fall back to the env var below.
    }
  }
  if (process.env.INSTANTLY_CAMPAIGN_ID) {
    return process.env.INSTANTLY_CAMPAIGN_ID;
  }
  throw new Error(
    "resolveInstantlyCampaignId: no Instantly campaign configured — set the lead's " +
      'campaign instantly_campaign_id or the INSTANTLY_CAMPAIGN_ID env var'
  );
}

/**
 * Add a lead to its Instantly campaign and trigger sending.
 *
 * Adds the lead via POST /api/v2/leads with the lead's email, first_name,
 * last_name, and company_name. The campaign is the lead's campaign's
 * `instantly_campaign_id` (falling back to the INSTANTLY_CAMPAIGN_ID env var).
 * When that campaign is active, Instantly enrols the new lead into its sequence
 * and sends automatically.
 *
 * @param {object} lead  - Lead row. Requires `contact_email`; uses `campaign_id`
 *                         to resolve the target Instantly campaign.
 * @param {object} email - Drafted email ({ subject, body }); used as an approval
 *                         guard — we only enrol leads that have a drafted body.
 * @returns {Promise<{status:number, data:any, instantlyId:(string|null)}>}
 */
async function sendEmail(lead, email) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('sendEmail: INSTANTLY_API_KEY is not set in the environment');
  }

  if (!lead || typeof lead !== 'object' || !lead.contact_email) {
    throw new Error('sendEmail: `lead` must have a `contact_email`');
  }
  if (!email || typeof email !== 'object' || !email.body) {
    throw new Error('sendEmail: `email` must have a `body`');
  }

  // Throws (caught upstream) when no campaign is configured for this lead.
  const campaignId = await resolveInstantlyCampaignId(lead);

  const { firstName, lastName } = splitName(lead.contact_name);

  const payload = {
    campaign: campaignId,
    email: lead.contact_email,
    first_name: firstName,
    last_name: lastName,
    company_name: lead.company_name ?? null,
    // Carry OUR drafted copy onto the lead so the campaign's step 1 — whose
    // template is {{personalized_subject}} / {{personalized_body}} — sends the
    // personalised draft instead of generic copy. Instantly's custom_variables
    // accepts flat primitive values only. The subject falls back in code so
    // the variable is never empty for leads we enrol (a missing variable
    // would otherwise rely on the template-side fallback). The template
    // appends "{{sendingAccountFirstName}} | Safely" after the body, so any
    // legacy "Dan | Safely" sign-off still present on older drafts is stripped
    // here to avoid a double signature.
    custom_variables: {
      personalized_subject:
        email.subject || `${lead.company_name ?? 'Your fleet'} - fleet safety`,
      personalized_body: stripLegacySignOff(email.body),
      // HeyGen personalized video link (leads scoring 85+ only). Empty for
      // every other lead — the template's {{personalized_video_link|}}
      // pipe-fallback renders nothing for them, so the email stays clean.
      personalized_video_link: lead.heygen_video_url || '',
    },
  };

  try {
    const { status, data } = await axios.post(`${API_BASE}/leads`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    // Instantly returns the created lead; its id is our send reference.
    const instantlyId = data?.id ?? data?.lead_id ?? null;
    return { status, data, instantlyId };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `sendEmail: Instantly POST /leads failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

// The Safely cold-outreach sequence added to every new Instantly campaign.
// `delay` is the number of days to wait AFTER this step before the next email:
// delays (3, 3, 4, 4, 4, 3, 0) land the seven steps on days
// 0, 3, 6, 10, 14, 18 and 21.
//
// Step 1 renders the lead's personalized_subject/personalized_body custom
// variables — set by sendEmail() from OUR Claude-drafted email — so each lead
// gets their personalised draft, not generic copy. Instantly's {{var|fallback}}
// pipe syntax provides generic copy for any lead that somehow lacks the
// variables (e.g. added to the campaign by hand in the Instantly UI); the
// fallback must stay single-line, so it is a condensed version of the old
// step-1 copy. Step 1 also carries personalized_video_link — a HeyGen share
// link for leads scoring 85+ (src/integrations/heygen.js), empty-string
// fallback for everyone else, so the line renders as nothing rather than a
// broken placeholder. Steps 2-7 are standard follow-ups, one value angle each:
// insurance, fuel, maintenance, driver behaviour, graceful close, free
// assessment. Every body ends at the CTA; the template appends the
// "{{sendingAccountFirstName}} | Safely" signature so it always matches
// whichever inbox Instantly actually sends from.
const SAFELY_SEQUENCE_STEPS = [
  {
    type: 'email',
    delay: 3,
    variants: [
      {
        subject: '{{personalized_subject|{{companyName}} - fleet safety}}',
        body: `{{personalized_body|Hi {{firstName|there}},We helped a 3,000-vehicle infrastructure operator cut collisions by half through real-time driver behaviour monitoring.
{{personalized_video_link|}}

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 3 — insurance savings.
    type: 'email',
    delay: 3,
    variants: [
      {
        subject: 'Insurance costs - {{companyName}}',
        body: `Hi {{firstName}},

Fleet insurance premiums keep climbing - but insurers reward fleets that can prove safe driving.

Safely customers typically see a material reduction in premiums within the first year, backed by driver behaviour data insurers actually trust.

Worth a quick chat?

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 6 — fuel fraud.
    type: 'email',
    delay: 4,
    variants: [
      {
        subject: 'Fuel spend at {{companyName}}',
        body: `Hi {{firstName}},

Most fleets lose 5-10% of fuel spend to fraud, unauthorised use, and inefficient driving - and most never spot it.

Safely flags unusual fuel patterns automatically, so you see exactly where the money goes. One airport-services operator cut fuel costs substantially across 2,000 vehicles.
Open to a 15-minute look at how it works?

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 10 — maintenance.
    type: 'email',
    delay: 4,
    variants: [
      {
        subject: 'Fewer breakdowns, longer vehicle life',
        body: `Hi {{firstName}},

Harsh braking and aggressive driving quietly destroy vehicles - tyres, brakes, clutches all wear faster, and downtime follows.

Safely identifies the driving behaviours driving up your maintenance bill, so you fix the cause instead of the symptoms.

Would that be useful for your fleet?

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 14 — driver behaviour.
    type: 'email',
    delay: 4,
    variants: [
      {
        subject: 'Safer drivers at {{companyName}}',
        body: `Hi {{firstName}},

Real-time driver behaviour coaching is where the biggest wins are - a 3,000-vehicle infrastructure operator cut collisions by half and saw a material saving per vehicle per year.Drivers improve when they can see their own scores. No micromanagement needed.

Worth exploring for {{companyName}}?

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 18 — graceful close.
    type: 'email',
    delay: 3,
    variants: [
      {
        subject: 'Last one from us - {{companyName}}',
        body: `Hi {{firstName}},

I'll keep this short - if fleet safety and costs aren't a priority right now, no worries at all.

If timing changes, we're here.

{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
  {
    // Day 21 — free assessment.
    type: 'email',
    delay: 0,
    variants: [
      {
        subject: 'Free fleet check - {{companyName}}',
        body: `Hi {{firstName}},

We helped a 3,000-vehicle infrastructure operator cut collisions by half through real-time driver behaviour monitoring.
{{sendingAccountFirstName}} | Safely`,
      },
    ],
  },
];

/**
 * Update an Instantly campaign's sequence steps, sending schedule, and/or
 * daily limit in ONE PATCH /api/v2/campaigns/:id call (Safety Rules: a single
 * API call, no loop). Every field is optional — only the ones passed are
 * included in the payload, so a schedule-only sync doesn't touch the sequence
 * and vice versa. This is the one place that builds the Instantly cadence
 * payload; addCampaignSequence, the cadence "Save & Sync" API route, and the
 * syncInstantlySequence CLI script all call through here.
 *
 * @param {string} apiKey
 * @param {string} campaignId - The Instantly campaign id to update.
 * @param {object} [cadence]
 * @param {object[]} [cadence.sequenceSteps] - Instantly-shaped steps: each
 *   `{type:'email', delay, variants:[{subject, body}]}` (see SAFELY_SEQUENCE_STEPS).
 * @param {object} [cadence.schedule]
 * @param {boolean[]} [cadence.schedule.days] - 7 flags, index 0=Sun..6=Sat.
 * @param {string} [cadence.schedule.windowStart] - "HH:MM".
 * @param {string} [cadence.schedule.windowEnd] - "HH:MM".
 * @param {string} [cadence.schedule.timezone] - Must be in INSTANTLY_TIMEZONES.
 * @param {number} [cadence.dailyLimit]
 */
async function updateCampaignCadence(apiKey, campaignId, { sequenceSteps, schedule, dailyLimit } = {}) {
  const payload = {};

  if (sequenceSteps) {
    payload.sequences = [{ steps: sequenceSteps }];
  }
  if (schedule) {
    const days = {};
    for (let i = 0; i < 7; i++) days[i] = Boolean(schedule.days?.[i]);
    payload.campaign_schedule = {
      schedules: [
        {
          name: 'Default schedule',
          timing: { from: schedule.windowStart, to: schedule.windowEnd },
          days,
          timezone: schedule.timezone,
        },
      ],
    };
  }
  if (dailyLimit != null) {
    payload.daily_limit = dailyLimit;
  }

  await axios.patch(`${API_BASE}/campaigns/${campaignId}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

/**
 * Add the standard Safely 7-step sequence to a freshly-created Instantly
 * campaign. Thin wrapper over updateCampaignCadence — kept as its own
 * function since createCampaign only ever wants the default sequence, not a
 * schedule/limit change.
 *
 * @param {string} apiKey
 * @param {string} campaignId - The Instantly campaign id to attach the sequence to.
 */
async function addCampaignSequence(apiKey, campaignId) {
  await updateCampaignCadence(apiKey, campaignId, { sequenceSteps: SAFELY_SEQUENCE_STEPS });
}

// Campaign whose sending accounts (email_list) are copied onto every campaign
// we auto-create — the established UK campaign, whose kat@ inboxes are warmed.
const SENDER_SOURCE_CAMPAIGN_ID = '<instantly-campaign-uuid>';

// Instantly's schedule timezone field takes a CLOSED enum — a coarse
// one-value-per-offset list, NOT full IANA ('Europe/London', 'Europe/Dublin',
// and 'Etc/UTC' are all rejected; verified against the live API 2026-07-16).
// 'Atlantic/Canary' is Instantly's UK/Ireland-time value (WET/WEST — same
// clock as London/Dublin year-round; it's what Instantly's own UI writes).
const TZ_UK_IRELAND = 'Atlantic/Canary';
const TZ_USA = 'America/Chicago';

// The FULL closed enum Instantly's campaign_schedule.timezone accepts,
// fetched from https://developer.instantly.ai/api-reference/campaign/list-campaign
// on 2026-07-20. Anything outside this list is rejected by the API (this is
// the "we've hit rejections before" list — validate the cadence editor's
// timezone field against this, not a hand-picked subset).
const INSTANTLY_TIMEZONES = [
  'Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson',
  'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize',
  'America/Chicago', 'America/Bahia_Banderas', 'America/Regina', 'America/Bogota',
  'America/Detroit', 'America/Indiana/Marengo', 'America/Caracas', 'America/Asuncion',
  'America/Glace_Bay', 'America/Campo_Grande', 'America/Anguilla', 'America/Santiago',
  'America/St_Johns', 'America/Sao_Paulo', 'America/Argentina/La_Rioja',
  'America/Araguaina', 'America/Godthab', 'America/Montevideo', 'America/Bahia',
  'America/Noronha', 'America/Scoresbysund', 'Atlantic/Cape_Verde', 'Africa/Casablanca',
  'America/Danmarkshavn', 'Europe/Isle_of_Man', 'Atlantic/Canary', 'Africa/Abidjan',
  'Arctic/Longyearbyen', 'Europe/Belgrade', 'Africa/Ceuta', 'Europe/Sarajevo',
  'Africa/Algiers', 'Africa/Windhoek', 'Asia/Nicosia', 'Asia/Beirut', 'Africa/Cairo',
  'Asia/Damascus', 'Europe/Bucharest', 'Africa/Blantyre', 'Europe/Helsinki',
  'Europe/Istanbul', 'Asia/Jerusalem', 'Africa/Tripoli', 'Asia/Amman', 'Asia/Baghdad',
  'Europe/Kaliningrad', 'Asia/Aden', 'Africa/Addis_Ababa', 'Europe/Kirov',
  'Europe/Astrakhan', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Baku', 'Indian/Mahe',
  'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Kabul', 'Antarctica/Mawson', 'Asia/Yekaterinburg',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Colombo', 'Asia/Kathmandu', 'Antarctica/Vostok',
  'Asia/Dhaka', 'Asia/Rangoon', 'Antarctica/Davis', 'Asia/Novokuznetsk', 'Asia/Hong_Kong',
  'Asia/Krasnoyarsk', 'Asia/Brunei', 'Australia/Perth', 'Asia/Taipei', 'Asia/Choibalsan',
  'Asia/Irkutsk', 'Asia/Dili', 'Asia/Pyongyang', 'Australia/Adelaide', 'Australia/Darwin',
  'Australia/Brisbane', 'Australia/Melbourne', 'Antarctica/DumontDUrville',
  'Australia/Currie', 'Asia/Chita', 'Antarctica/Macquarie', 'Asia/Sakhalin',
  'Pacific/Auckland', 'Etc/GMT-12', 'Pacific/Fiji', 'Asia/Anadyr', 'Asia/Kamchatka',
  'Etc/GMT-13', 'Pacific/Apia',
];
const INSTANTLY_TIMEZONE_SET = new Set(INSTANTLY_TIMEZONES);

// Instantly campaign status codes (v2 API uses numeric statuses) → labels.
// Shared by instantly:audit-campaigns and the Dashboard's live health check
// so "is this campaign actually sending" means the same thing everywhere.
const INSTANTLY_STATUS_LABELS = {
  0: 'draft',
  1: 'active',
  2: 'paused',
  3: 'completed',
  4: 'running subsequences',
  '-99': 'account suspended',
  '-1': 'accounts unhealthy',
  '-2': 'bounce protect',
};

// Statuses that mean "actually sending" — active, or mid-sequence. Anything
// else (draft, paused, completed, suspended, bounce-protect) means a
// locally-active campaign enrolling leads into it is wasted work.
const ACTIVELY_SENDING_STATUSES = new Set([1, 4]);

/**
 * Infer the Instantly schedule timezone from a campaign's ICP locations.
 * UK/Ireland → UK time; USA → Central; mixed or unrecognised → UK time with
 * a logged warning so the operator knows to check the schedule.
 *
 * @param {string[]} [locations]
 * @returns {string} a value from Instantly's timezone enum.
 */
function timezoneForLocations(locations = []) {
  const text = (Array.isArray(locations) ? locations : [locations]).join(' ').toLowerCase();
  const ukIe = /ireland|united kingdom|\buk\b|britain|england|scotland|wales/.test(text);
  const usa = /united states|\busa?\b|america|texas|california|florida|new york/.test(text);

  if (ukIe && !usa) return TZ_UK_IRELAND;
  if (usa && !ukIe) return TZ_USA;

  console.warn(
    `[instantly] could not infer a single sending timezone from ICP locations ` +
      `${JSON.stringify(locations)} — defaulting to UK time (${TZ_UK_IRELAND}; ` +
      `Instantly's enum has no Europe/London). Check the campaign schedule in Instantly.`
  );
  return TZ_UK_IRELAND;
}

// Explicit daily sending cap for auto-created campaigns (emails/day across the
// campaign), instead of whatever default Instantly applies.
const CAMPAIGN_DAILY_LIMIT = 50;

/**
 * Fetch the sending accounts (email_list) attached to an Instantly campaign.
 *
 * @param {string} apiKey
 * @param {string} campaignId
 * @returns {Promise<string[]>} sending account email addresses.
 */
async function fetchCampaignEmailList(apiKey, campaignId) {
  const { data } = await axios.get(`${API_BASE}/campaigns/${campaignId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return Array.isArray(data?.email_list) ? data.email_list : [];
}

/**
 * Create a campaign in Instantly with the given name.
 *
 * POST /api/v2/campaigns with Bearer auth. Instantly v2 requires a
 * `campaign_schedule` (with a timezone from its closed enum) on create; the
 * timezone is inferred from the campaign's ICP locations via
 * timezoneForLocations (Mon–Fri 9–5 in the target market's local time). The
 * name matches the local campaign.
 *
 * The new campaign is created with:
 *   - email_list copied from SENDER_SOURCE_CAMPAIGN_ID (the UK campaign's
 *     warmed sending accounts) — without this a campaign has NO sending
 *     account and silently never sends. Best-effort: if the lookup fails the
 *     campaign is still created (without senders) and the failure is logged
 *     loudly so the operator can attach accounts in the Instantly UI.
 *   - an explicit daily_limit of 50 instead of Instantly's default.
 *
 * After creation, the standard Safely 7-step sequence is attached via
 * addCampaignSequence (best-effort — a sequence failure is logged, not thrown).
 *
 * @param {string} name - Campaign name (mirrors the local campaign's name).
 * @param {object} [options]
 * @param {string[]} [options.locations] - The campaign's ICP locations, used
 *   to pick the sending-schedule timezone (see timezoneForLocations).
 * @returns {Promise<{id:(string|null), data:any}>}
 */
async function createCampaign(name, { locations = [] } = {}) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('createCampaign: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('createCampaign: `name` is required');
  }

  // Reuse the UK campaign's sending accounts. Best-effort: a lookup failure
  // must not block campaign creation, but a campaign without senders never
  // sends — log it loudly.
  let emailList = [];
  try {
    emailList = await fetchCampaignEmailList(apiKey, SENDER_SOURCE_CAMPAIGN_ID);
    if (emailList.length === 0) {
      console.error(
        `[instantly] source campaign ${SENDER_SOURCE_CAMPAIGN_ID} has no email_list — ` +
          'new campaign will have NO sending accounts; attach them in the Instantly UI'
      );
    }
  } catch (err) {
    console.error(
      '[instantly] could not fetch sending accounts from source campaign ' +
        `${SENDER_SOURCE_CAMPAIGN_ID}: ${err.message} — new campaign will have NO ` +
        'sending accounts; attach them in the Instantly UI'
    );
  }

  const payload = {
    name,
    daily_limit: CAMPAIGN_DAILY_LIMIT,
    ...(emailList.length ? { email_list: emailList } : {}),
    campaign_schedule: {
      schedules: [
        {
          name: 'Default schedule',
          timing: { from: '09:00', to: '17:00' },
          days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
          timezone: timezoneForLocations(locations),
        },
      ],
    },
  };

  try {
    const { data } = await axios.post(`${API_BASE}/campaigns`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const id = data?.id ?? data?.campaign_id ?? null;

    // Attach the standard Safely sequence. Best-effort: a failure here must not
    // fail campaign creation — log it and still return the created campaign.
    let sequenceAttached = false;
    if (id) {
      try {
        await addCampaignSequence(apiKey, id);
        sequenceAttached = true;
      } catch (seqErr) {
        const status = seqErr.response?.status;
        const detail = seqErr.response?.data
          ? JSON.stringify(seqErr.response.data)
          : seqErr.message;
        console.error(
          `[instantly] adding sequence steps to campaign ${id} failed${
            status ? ` (HTTP ${status})` : ''
          }: ${detail}`
        );
      }
    }

    // Instantly creates campaigns in DRAFT — nothing enrolled into a draft
    // campaign is ever actually sent (this is exactly how California Health &
    // Safety Firms silently queued 61 leads with zero delivered — caught only
    // by an audit, not by anything in the pipeline). Activate it now, but only
    // once it actually has a sequence to send (best-effort like the step
    // above: a failure must not fail campaign creation) — and log either
    // outcome LOUDLY, because a campaign stuck in draft must be visible, not
    // silent.
    let activated = false;
    if (id && sequenceAttached) {
      try {
        await activateCampaign(id);
        activated = true;
        console.log(`[instantly] campaign ${id} ("${name}") activated — will actually send`);
      } catch (actErr) {
        const status = actErr.response?.status;
        const detail = actErr.response?.data
          ? JSON.stringify(actErr.response.data)
          : actErr.message;
        console.error(
          `[instantly] ACTIVATION FAILED for campaign ${id} ("${name}")${
            status ? ` (HTTP ${status})` : ''
          }: ${detail} — this campaign is still in DRAFT and will silently queue ` +
            'leads without sending until someone activates it manually'
        );
      }
    } else if (id) {
      console.error(
        `[instantly] campaign ${id} ("${name}") was NOT activated (no sequence attached) — ` +
          'it is still in DRAFT and will silently queue leads without sending'
      );
    }

    return { id, data, activated };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `createCampaign: Instantly POST /campaigns failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Activate (start/resume) an Instantly campaign — POST /api/v2/campaigns/:id/activate.
 * Instantly campaigns are created in DRAFT; nothing enrolled into a draft
 * campaign is ever actually sent, so this must be called before a campaign
 * can send anything. Separate from createCampaign/updateCampaignCadence
 * (which only ever create/configure) because Instantly itself splits
 * create/configure/activate into distinct calls.
 *
 * Also the resume action for a campaign Instantly has auto-paused (status 2)
 * or bounce-protected (status -2, triggered by its default 5%-bounce-rate
 * auto-pause once 200+ emails are sent) — Instantly has one "activate" action
 * that both starts a draft and resumes a paused/bounce-protected campaign;
 * there is no separate resume endpoint. Used by the Dashboard's "Resume from
 * bounce protect" action (POST /api/campaigns/:id/resume).
 *
 * @param {string} campaignId
 */
async function activateCampaign(campaignId) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('activateCampaign: INSTANTLY_API_KEY is not set in the environment');
  }
  try {
    await axios.post(
      `${API_BASE}/campaigns/${campaignId}/activate`,
      {},
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `activateCampaign: Instantly POST /campaigns/${campaignId}/activate failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Delete a campaign in Instantly by its id.
 *
 * DELETE /api/v2/campaigns/:id with Bearer auth. Called when the matching local
 * campaign is deleted so the two stay in sync.
 *
 * @param {string} instantlyCampaignId - The Instantly campaign id to delete.
 * @returns {Promise<{status:number, data:any}>}
 */
async function deleteCampaign(instantlyCampaignId) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('deleteCampaign: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!instantlyCampaignId) {
    throw new Error('deleteCampaign: `instantlyCampaignId` is required');
  }

  try {
    const { status, data } = await axios.delete(
      `${API_BASE}/campaigns/${instantlyCampaignId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    return { status, data };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `deleteCampaign: Instantly DELETE /campaigns/${instantlyCampaignId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Delete a lead in Instantly by its Instantly-side lead id (the id sendEmail's
 * POST /leads call returns, persisted as emails.instantly_id) —
 * DELETE /api/v2/leads/:id.
 *
 * Instantly leads only exist inside a campaign/list, so deleting one is how a
 * bad address is removed from a campaign's audience — there is no separate
 * "remove from campaign, keep the lead" call in the v2 API. Used to clean up
 * addresses that verify as 'invalid' after having already been sent to, so
 * they stop receiving the campaign's remaining follow-up steps.
 *
 * @param {string} instantlyLeadId
 * @returns {Promise<{status:number, data:any}>}
 */
async function deleteLead(instantlyLeadId) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('deleteLead: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!instantlyLeadId) {
    throw new Error('deleteLead: `instantlyLeadId` is required');
  }

  try {
    const { status, data } = await axios.delete(`${API_BASE}/leads/${instantlyLeadId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return { status, data };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `deleteLead: Instantly DELETE /leads/${instantlyLeadId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

// Verification statuses Instantly returns. Anything unrecognised is mapped to
// 'unknown' so callers only ever deal with this closed set.
const VERIFICATION_STATUSES = new Set([
  'verified',
  'invalid',
  'risky',
  'catch_all',
  'pending',
]);

const verifySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeVerificationStatus(data) {
  const raw = (data?.verification_status ?? data?.status ?? '').toLowerCase();
  return VERIFICATION_STATUSES.has(raw) ? raw : 'unknown';
}

/**
 * Verify a single email address via Instantly.
 *
 * POST /api/v2/email-verification with the address; Instantly may answer
 * immediately or report 'pending' while it verifies asynchronously — in that
 * case we poll GET /api/v2/email-verification/:email a few times before giving
 * up and returning 'pending' (callers treat anything but 'invalid' as
 * sendable, so an unresolved check never blocks a good lead).
 *
 * @param {string} email
 * @param {object} [options]
 * @param {number} [options.maxPolls=3]    - Status polls after a pending result.
 * @param {number} [options.pollDelayMs=2000] - Gap between polls.
 * @returns {Promise<('verified'|'invalid'|'risky'|'catch_all'|'pending'|'unknown')>}
 */
async function verifyEmail(email, { maxPolls = 3, pollDelayMs = 2000 } = {}) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('verifyEmail: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!email || typeof email !== 'string') {
    throw new Error('verifyEmail: `email` is required');
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  let status;
  try {
    const { data } = await axios.post(`${API_BASE}/email-verification`, { email }, { headers });
    status = normalizeVerificationStatus(data);
  } catch (err) {
    const httpStatus = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `verifyEmail: Instantly POST /email-verification failed${
        httpStatus ? ` (HTTP ${httpStatus})` : ''
      }: ${detail}`
    );
  }

  // Async verification — poll the status endpoint a few times.
  for (let i = 0; status === 'pending' && i < maxPolls; i++) {
    await verifySleep(pollDelayMs);
    try {
      const { data } = await axios.get(
        `${API_BASE}/email-verification/${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      status = normalizeVerificationStatus(data);
    } catch (err) {
      // A failed poll isn't fatal — return the pending status and let the
      // caller proceed (unresolved never blocks a lead).
      break;
    }
  }

  return status;
}

// Pull a bare email address out of the various shapes Instantly uses for
// address fields: a plain string, a "Name <email@x.com>" string, or an array
// of either.
function extractEmailAddress(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const str = String(raw);
  const angle = str.match(/<([^>]+)>/); // "Jane Doe <jane@acme.com>"
  return (angle ? angle[1] : str).trim() || null;
}

// Normalise an Instantly v2 email object into the reply shape our app uses.
// On a reply the lead is the sender, so the lead's address is `lead` (Instantly
// sets this to the lead email) or, failing that, the From address.
function mapReply(item) {
  const body =
    (item.body && (item.body.text || item.body.html)) ||
    item.body_text ||
    item.content_preview ||
    (typeof item.body === 'string' ? item.body : '') ||
    '';

  return {
    id: item.id ?? item.message_id ?? null,
    email:
      extractEmailAddress(item.lead) ||
      extractEmailAddress(item.from_address_email_list) ||
      extractEmailAddress(item.from_address_email) ||
      null,
    subject: item.subject || null,
    body,
    timestamp: item.timestamp_email || item.timestamp_created || item.created_at || null,
  };
}

/**
 * Fetch replies for the configured campaign from Instantly.
 *
 * GET /api/v2/emails?campaign_id=<id>&email_type=received&limit=100 with Bearer
 * auth. `email_type` only accepts received | sent | manual (there is no "reply"
 * value); inbound `received` emails on a cold-outreach campaign are the replies.
 * Instantly wraps list responses under `items` (we tolerate a bare array or a
 * `data` envelope too). Each raw email is normalised via mapReply.
 *
 * @returns {Promise<Array<{id, email, subject, body, timestamp}>>}
 */
async function fetchCampaignReplies() {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('fetchCampaignReplies: INSTANTLY_API_KEY is not set in the environment');
  }

  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;
  if (!campaignId) {
    throw new Error('fetchCampaignReplies: INSTANTLY_CAMPAIGN_ID is not set in the environment');
  }

  try {
    const { data } = await axios.get(`${API_BASE}/emails`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { campaign_id: campaignId, email_type: 'received', limit: 100 },
    });
    const items = Array.isArray(data) ? data : data?.items || data?.data || [];
    return items.map(mapReply);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchCampaignReplies: Instantly GET /emails failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Fetch analytics for the configured campaign from Instantly.
 *
 * GET /api/v2/campaigns/analytics?id=<INSTANTLY_CAMPAIGN_ID> with Bearer auth.
 * The endpoint returns an array (one object per campaign); with an id it's a
 * single-element array (we also tolerate a bare object / { items } envelope).
 * Open and reply rates aren't returned directly — we derive them from the
 * counts against emails sent.
 *
 * @returns {Promise<{total_sent:number, open_count:number, reply_count:number,
 *   contacted_count:number, open_rate:number, reply_rate:number}>}
 */
/**
 * Fetch a campaign's per-day send counts from Instantly for a date range.
 *
 * GET /api/v2/campaigns/analytics/daily?campaign_id=...&start_date=...&end_date=...
 * — deliberately NOT the aggregate GET /campaigns/analytics endpoint
 * (fetchCampaignStats/fetchAllCampaignAnalytics): that one accepts
 * start_date/end_date without erroring but appears to ignore them, returning
 * all-time totals regardless of the window requested (verified 2026-07-20 —
 * a campaign with zero real sends in a 3-day window still showed a large
 * non-zero count for it). This is the one that's actually windowed.
 *
 * This is the source of truth for "is this campaign actually sending" — our
 * own `emails.sent_at` only captures OUR app-side enrollments (email 1, via
 * sendEmail), not Instantly's own follow-up sends (steps 2-7), which fire
 * from Instantly's own sequence engine without our app ever being called
 * again. A campaign can look "dead" in our table while Instantly is
 * actively sending dozens of step 3s to previously-enrolled leads.
 *
 * @param {string} instantlyCampaignId
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @returns {Promise<Array<{date:string, sent:number}>>}
 */
async function fetchCampaignDailyAnalytics(instantlyCampaignId, startDate, endDate) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('fetchCampaignDailyAnalytics: INSTANTLY_API_KEY is not set in the environment');
  }
  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/analytics/daily`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { campaign_id: instantlyCampaignId, start_date: startDate, end_date: endDate },
    });
    return Array.isArray(data)
      ? data.map((d) => ({ date: d.date, sent: Number(d.sent) || 0 }))
      : [];
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchCampaignDailyAnalytics: Instantly GET /campaigns/analytics/daily failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

async function fetchCampaignStats() {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('fetchCampaignStats: INSTANTLY_API_KEY is not set in the environment');
  }

  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;
  if (!campaignId) {
    throw new Error('fetchCampaignStats: INSTANTLY_CAMPAIGN_ID is not set in the environment');
  }

  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/analytics`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { id: campaignId },
    });
    const row = (Array.isArray(data) ? data[0] : data?.items?.[0] || data) || {};

    const sent = Number(row.emails_sent_count) || 0;
    const opens = Number(row.open_count) || 0;
    const replies = Number(row.reply_count) || 0;
    const contacted = Number(row.contacted_count) || 0;

    // Round rates to one decimal place; guard against divide-by-zero.
    const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

    return {
      total_sent: sent,
      open_count: opens,
      reply_count: replies,
      contacted_count: contacted,
      open_rate: rate(opens, sent),
      reply_rate: rate(replies, sent),
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchCampaignStats: Instantly GET /campaigns/analytics failed${status ? ` (HTTP ${status})` : ''}: ${detail}`
    );
  }
}

/**
 * Fetch a campaign's sending schedule from Instantly, normalised for display.
 *
 * GET /api/v2/campaigns/:id → campaign_schedule. Returns the raw schedules
 * array plus the campaign's name and status so the UI can render "Mon–Fri
 * 09:00–17:00 · Atlantic/Canary" without a second call.
 *
 * @param {string} instantlyCampaignId
 * @returns {Promise<{name:string, status:any, schedules:object[]}>}
 */
async function fetchCampaignSchedule(instantlyCampaignId) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('fetchCampaignSchedule: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!instantlyCampaignId) {
    throw new Error('fetchCampaignSchedule: `instantlyCampaignId` is required');
  }

  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/${instantlyCampaignId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return {
      name: data?.name ?? null,
      status: data?.status ?? null,
      schedules: Array.isArray(data?.campaign_schedule?.schedules)
        ? data.campaign_schedule.schedules
        : [],
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchCampaignSchedule: Instantly GET /campaigns/${instantlyCampaignId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Fetch a campaign's full cadence from Instantly — sequence steps, schedule,
 * and daily limit — in one GET, for the cadence editor's diff view. Separate
 * from fetchCampaignSchedule (which only returns the schedule, for the
 * existing read-only display) so that call path is untouched.
 *
 * @param {string} instantlyCampaignId
 * @returns {Promise<{name:string, status:any, schedules:object[],
 *   dailyLimit:(number|null), sequenceSteps:object[]}>}
 */
async function fetchCampaignCadence(instantlyCampaignId) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('fetchCampaignCadence: INSTANTLY_API_KEY is not set in the environment');
  }
  if (!instantlyCampaignId) {
    throw new Error('fetchCampaignCadence: `instantlyCampaignId` is required');
  }

  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/${instantlyCampaignId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return {
      name: data?.name ?? null,
      status: data?.status ?? null,
      schedules: Array.isArray(data?.campaign_schedule?.schedules)
        ? data.campaign_schedule.schedules
        : [],
      dailyLimit: data?.daily_limit ?? null,
      sequenceSteps: Array.isArray(data?.sequences?.[0]?.steps) ? data.sequences[0].steps : [],
      // Same GET already carries both — no extra call. Used by the Dashboard's
      // live health check (a locally-active campaign with no sending capacity
      // at all can never actually send, same failure class as being stuck in
      // draft). IMPORTANT: email_list is NOT the only way Instantly assigns
      // sending accounts — this workspace also uses a tag-based shared pool
      // (email_tag_list; see the "Safely" custom tag, 2026-07-20 finding). A
      // campaign with an empty email_list but a populated email_tag_list can
      // be sending fine, drawing from whichever accounts in the workspace
      // carry that tag. Checking email_list alone produced a real false
      // positive ("no sending accounts") on three genuinely-healthy campaigns.
      emailList: Array.isArray(data?.email_list) ? data.email_list : [],
      emailTagList: Array.isArray(data?.email_tag_list) ? data.email_tag_list : [],
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchCampaignCadence: Instantly GET /campaigns/${instantlyCampaignId} failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

/**
 * Fetch analytics for ALL Instantly campaigns in one call.
 *
 * GET /api/v2/campaigns/analytics with no id filter returns one row per
 * campaign. Used by the funnel dashboard to overlay live contacted/reply
 * counts onto every local campaign at once (matched via each campaign's
 * instantly_campaign_id) instead of one request per campaign.
 *
 * @returns {Promise<Map<string, {contacted:number, replies:number, sent:number}>>}
 *   keyed by Instantly campaign id.
 */
async function fetchAllCampaignAnalytics() {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'fetchAllCampaignAnalytics: INSTANTLY_API_KEY is not set in the environment'
    );
  }

  try {
    const { data } = await axios.get(`${API_BASE}/campaigns/analytics`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const rows = Array.isArray(data) ? data : data?.items || data?.data || [];

    const byId = new Map();
    for (const row of rows) {
      const id = row.campaign_id ?? row.id ?? row.campaign ?? null;
      if (!id) continue;
      byId.set(String(id), {
        contacted: Number(row.contacted_count) || 0,
        replies: Number(row.reply_count) || 0,
        sent: Number(row.emails_sent_count) || 0,
      });
    }
    return byId;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(
      `fetchAllCampaignAnalytics: Instantly GET /campaigns/analytics failed${
        status ? ` (HTTP ${status})` : ''
      }: ${detail}`
    );
  }
}

module.exports = {
  sendEmail,
  verifyEmail,
  createCampaign,
  addCampaignSequence,
  activateCampaign,
  updateCampaignCadence,
  fetchCampaignCadence,
  fetchCampaignDailyAnalytics,
  deleteCampaign,
  deleteLead,
  fetchCampaignReplies,
  fetchCampaignStats,
  fetchAllCampaignAnalytics,
  fetchCampaignSchedule,
  timezoneForLocations,
  stripLegacySignOff,
  SAFELY_SEQUENCE_STEPS,
  INSTANTLY_TIMEZONES,
  INSTANTLY_TIMEZONE_SET,
  INSTANTLY_STATUS_LABELS,
  ACTIVELY_SENDING_STATUSES,
  CAMPAIGN_DAILY_LIMIT,
};
