const db = require('../config/db');
const instantly = require('../integrations/instantly');
const aimfox = require('../integrations/aimfox');

// Guardrails (Cadence Editor spec).
const MAX_STEPS = 8;
const MIN_DAYS_BETWEEN_STEPS = 2;
const MAX_DAILY_LIMIT = 50;

// Defaults applied when a campaign has never had its schedule edited — mirror
// createCampaign's own default (Mon-Fri 9-17). Index 0=Sun..6=Sat, matching
// Instantly's own `days` object shape.
const DEFAULT_SENDING_DAYS = [false, true, true, true, true, true, false];
const DEFAULT_WINDOW_START = '09:00';
const DEFAULT_WINDOW_END = '17:00';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ============================================
// Step shape conversion
//
// Our shape: ordered {subject, body, delayDays}, delayDays = days AFTER THE
// PREVIOUS step that this one fires (step 0's is always 0) — a natural fit
// for a "Day 0 -> 3 -> 6" timeline UI.
//
// Instantly's shape: {type:'email', delay, variants:[{subject, body}]}, where
// `delay` sits on the CURRENT step and means "days to wait AFTER this step
// before the next" — i.e. shifted by one position from ours, and only ONE
// variant per step (Instantly supports A/B variants; the cadence editor
// doesn't, so every step gets exactly one).
// ============================================

/**
 * Convert our step shape to Instantly's wire shape.
 * @param {Array<{subject:string, body:string, delayDays:number}>} steps
 * @returns {object[]}
 */
function ourStepsToInstantlySteps(steps) {
  return steps.map((step, i) => ({
    type: 'email',
    delay: i < steps.length - 1 ? Number(steps[i + 1].delayDays) || 0 : 0,
    variants: [{ subject: step.subject, body: step.body }],
  }));
}

/**
 * Convert Instantly's wire shape back to ours.
 * @param {object[]} instantlySteps
 * @returns {Array<{subject:string, body:string, delayDays:number}>}
 */
function instantlyStepsToOurSteps(instantlySteps) {
  return instantlySteps.map((step, i) => ({
    subject: step.variants?.[0]?.subject ?? '',
    body: step.variants?.[0]?.body ?? '',
    delayDays: i === 0 ? 0 : Number(instantlySteps[i - 1]?.delay) || 0,
  }));
}

/** The built-in Safely sequence, in OUR shape — the default when a campaign
 * has no custom sequence_steps. */
function defaultSequenceSteps() {
  return instantlyStepsToOurSteps(instantly.SAFELY_SEQUENCE_STEPS);
}

/** Cumulative day offsets for a step list, for the UI timeline (Day 0, 3, 6, ...). */
function dayOffsets(steps) {
  let offset = 0;
  return steps.map((step, i) => {
    if (i > 0) offset += Number(step.delayDays) || 0;
    return offset;
  });
}

// ============================================
// Resolve a campaign's effective cadence — every column is NULL-as-default.
// ============================================

/**
 * @param {object} campaign - A campaigns row.
 * @returns {{
 *   steps: Array<{subject, body, delayDays, dayOffset}>, isDefaultSequence: boolean,
 *   schedule: {days:boolean[], windowStart:string, windowEnd:string, timezone:string,
 *     isDefaultDays:boolean, isDefaultWindow:boolean, isDefaultTimezone:boolean},
 *   dailyLimit: number, isDefaultDailyLimit: boolean,
 * }}
 */
function resolveCadence(campaign) {
  const isDefaultSequence = campaign.sequence_steps == null;
  const steps = isDefaultSequence ? defaultSequenceSteps() : campaign.sequence_steps;
  const offsets = dayOffsets(steps);
  const stepsWithOffsets = steps.map((step, i) => ({ ...step, dayOffset: offsets[i] }));

  const isDefaultDays = campaign.sending_days == null;
  const isDefaultWindow = campaign.sending_window_start == null && campaign.sending_window_end == null;
  const isDefaultTimezone = campaign.sending_timezone == null;
  const isDefaultDailyLimit = campaign.daily_limit == null;

  return {
    steps: stepsWithOffsets,
    isDefaultSequence,
    schedule: {
      days: isDefaultDays ? DEFAULT_SENDING_DAYS : campaign.sending_days,
      windowStart: campaign.sending_window_start ?? DEFAULT_WINDOW_START,
      windowEnd: campaign.sending_window_end ?? DEFAULT_WINDOW_END,
      timezone:
        campaign.sending_timezone ?? instantly.timezoneForLocations(campaign.icp_locations ?? []),
      isDefaultDays,
      isDefaultWindow,
      isDefaultTimezone,
    },
    dailyLimit: campaign.daily_limit ?? instantly.CAMPAIGN_DAILY_LIMIT,
    isDefaultDailyLimit,
  };
}

// ============================================
// Guardrails
// ============================================

// A step's body/subject may legitimately contain `{{var}}` or `{{var|fallback}}`
// tokens. This regex matches well-formed ones so we can spot ones that don't.
const WELL_FORMED_TOKEN_RE = /\{\{[a-zA-Z0-9_]+(\|[^{}]*)?\}\}/g;

// The step-1 personalization pattern (SAFELY_SEQUENCE_STEPS[0]) — flagged
// separately from generic token-loss because losing it has a specific,
// concrete consequence (new leads' Claude-drafted email goes unused).
const PERSONALIZED_SUBJECT_RE = /\{\{personalized_subject\|/;
const PERSONALIZED_BODY_RE = /\{\{personalized_body\|/;

// A sign-off belongs to the template ("{{sendingAccountFirstName}} | Safely"),
// appended by Instantly at send time — not hardcoded into the body. Matches a
// short trailing line that looks like a person's name (optionally
// "Name | Something") and contains no template braces at all.
const NAME_LIKE_SIGNOFF_RE = /^[A-Z][a-zA-Z'’-]*(\s+[A-Z][a-zA-Z'’-]*){0,3}(\s*\|\s*.+)?$/;

function countUnbalancedBraces(text) {
  const opens = (text.match(/\{\{/g) || []).length;
  const closes = (text.match(/\}\}/g) || []).length;
  return opens !== closes;
}

function lastNonBlankLine(body) {
  const lines = (body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * Validate a candidate cadence against the editor's guardrails.
 *
 * @param {object} cadence
 * @param {Array<{subject:string, body:string, delayDays:number}>} cadence.steps
 * @param {{days:boolean[], windowStart:string, windowEnd:string, timezone:string}} cadence.schedule
 * @param {number} cadence.dailyLimit
 * @returns {{errors:string[], warnings:string[]}}
 */
function validateCadence({ steps, schedule, dailyLimit }) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('A sequence needs at least one step.');
  } else {
    if (steps.length > MAX_STEPS) {
      errors.push(`A sequence can have at most ${MAX_STEPS} steps (this one has ${steps.length}).`);
    }
    steps.forEach((step, i) => {
      const n = i + 1;
      if (!step.subject || !String(step.subject).trim()) {
        errors.push(`Step ${n} is missing a subject.`);
      }
      if (!step.body || !String(step.body).trim()) {
        errors.push(`Step ${n} is missing a body.`);
      }
      if (i > 0) {
        const gap = Number(step.delayDays);
        if (!Number.isFinite(gap) || gap < MIN_DAYS_BETWEEN_STEPS) {
          errors.push(
            `Step ${n} must wait at least ${MIN_DAYS_BETWEEN_STEPS} days after step ${n - 1} ` +
              `(currently ${step.delayDays ?? 'unset'}).`
          );
        }
      }

      if (step.subject && countUnbalancedBraces(String(step.subject))) {
        warnings.push(`Step ${n}: subject has unbalanced {{ }} — a template variable may be broken.`);
      }
      if (step.body && countUnbalancedBraces(String(step.body))) {
        warnings.push(`Step ${n}: body has unbalanced {{ }} — a template variable may be broken.`);
      }

      if (i === 0) {
        const subject = String(step.subject || '');
        const body = String(step.body || '');
        if (!PERSONALIZED_SUBJECT_RE.test(subject) || !PERSONALIZED_BODY_RE.test(body)) {
          warnings.push(
            'Step 1 no longer uses the {{personalized_subject|...}}/{{personalized_body|...}} ' +
              "fallback pattern — each lead's Claude-drafted email won't be used for this step."
          );
        }
      }

      const lastLine = lastNonBlankLine(step.body);
      if (
        lastLine &&
        !lastLine.includes('{{') &&
        NAME_LIKE_SIGNOFF_RE.test(lastLine)
      ) {
        warnings.push(
          `Step ${n}: body ends with what looks like a hardcoded sign-off ("${lastLine}") — ` +
            'the sign-off belongs to the template ({{sendingAccountFirstName}} | Safely), ' +
            "appended automatically so it always matches whichever inbox actually sends it."
        );
      }
    });
  }

  if (!schedule || !Array.isArray(schedule.days) || schedule.days.length !== 7) {
    errors.push('Sending days must be a 7-element list (Sun..Sat).');
  } else if (!schedule.days.some(Boolean)) {
    errors.push('Select at least one sending day.');
  }

  if (!schedule?.windowStart || !TIME_RE.test(schedule.windowStart)) {
    errors.push('Sending window start must be a valid 24h time (HH:MM).');
  }
  if (!schedule?.windowEnd || !TIME_RE.test(schedule.windowEnd)) {
    errors.push('Sending window end must be a valid 24h time (HH:MM).');
  }
  if (
    schedule?.windowStart &&
    schedule?.windowEnd &&
    TIME_RE.test(schedule.windowStart) &&
    TIME_RE.test(schedule.windowEnd) &&
    schedule.windowStart >= schedule.windowEnd
  ) {
    errors.push('Sending window start must be before the end.');
  }

  if (!schedule?.timezone || !instantly.INSTANTLY_TIMEZONE_SET.has(schedule.timezone)) {
    errors.push(
      `"${schedule?.timezone}" is not one of Instantly's accepted timezone values — ` +
        'this would be rejected on sync.'
    );
  }

  if (
    dailyLimit == null ||
    !Number.isInteger(Number(dailyLimit)) ||
    dailyLimit < 1 ||
    dailyLimit > MAX_DAILY_LIMIT
  ) {
    errors.push(`Daily sending limit must be an integer between 1 and ${MAX_DAILY_LIMIT}.`);
  }

  return { errors, warnings };
}

// ============================================
// Diff vs the live Instantly campaign, and sync
// ============================================

function normalizeSteps(instantlySteps) {
  return instantlyStepsToOurSteps(instantlySteps);
}

function stepsEqual(a, b) {
  return (a.subject ?? '') === (b.subject ?? '') && (a.body ?? '') === (b.body ?? '');
}

/**
 * Compare a campaign's resolved LOCAL cadence against what's actually live on
 * its Instantly campaign right now. Never syncs silently — this is what
 * powers the "Save & Sync" confirmation dialog.
 *
 * @param {object} campaign - A campaigns row (must have instantly_campaign_id).
 * @returns {Promise<{hasChanges:boolean, sequence:object, schedule:object, dailyLimit:object}>}
 */
async function computeDiff(campaign) {
  if (!campaign.instantly_campaign_id) {
    throw new Error('computeDiff: campaign has no instantly_campaign_id to diff against');
  }

  const local = resolveCadence(campaign);
  const live = await instantly.fetchCampaignCadence(campaign.instantly_campaign_id);
  const liveStepsRaw = normalizeSteps(live.sequenceSteps);
  const liveOffsets = dayOffsets(liveStepsRaw);
  const liveSteps = liveStepsRaw.map((step, i) => ({ ...step, dayOffset: liveOffsets[i] }));
  const liveSchedule = live.schedules[0] || {};
  const liveDaysArr = Array.from({ length: 7 }, (_, i) => Boolean(liveSchedule.days?.[i]));

  const maxLen = Math.max(local.steps.length, liveSteps.length);
  const stepDiffs = [];
  for (let i = 0; i < maxLen; i++) {
    const before = liveSteps[i] || null;
    const after = local.steps[i] || null;
    const subjectChanged = (before?.subject ?? null) !== (after?.subject ?? null);
    const bodyChanged = (before?.body ?? null) !== (after?.body ?? null);
    const delayChanged = (before?.delayDays ?? null) !== (after?.delayDays ?? null);
    if (before || after) {
      stepDiffs.push({
        index: i,
        before,
        after,
        changed: !before || !after || subjectChanged || bodyChanged || delayChanged,
        subjectChanged,
        bodyChanged,
        delayChanged,
      });
    }
  }
  const sequenceChanged = stepDiffs.some((d) => d.changed);

  const scheduleBefore = {
    days: liveDaysArr,
    windowStart: liveSchedule.timing?.from ?? null,
    windowEnd: liveSchedule.timing?.to ?? null,
    timezone: liveSchedule.timezone ?? null,
  };
  const scheduleAfter = {
    days: local.schedule.days,
    windowStart: local.schedule.windowStart,
    windowEnd: local.schedule.windowEnd,
    timezone: local.schedule.timezone,
  };
  const scheduleChanged =
    JSON.stringify(scheduleBefore.days) !== JSON.stringify(scheduleAfter.days) ||
    scheduleBefore.windowStart !== scheduleAfter.windowStart ||
    scheduleBefore.windowEnd !== scheduleAfter.windowEnd ||
    scheduleBefore.timezone !== scheduleAfter.timezone;

  const dailyLimitChanged = (live.dailyLimit ?? null) !== local.dailyLimit;

  return {
    hasChanges: sequenceChanged || scheduleChanged || dailyLimitChanged,
    sequence: { changed: sequenceChanged, steps: stepDiffs },
    schedule: { changed: scheduleChanged, before: scheduleBefore, after: scheduleAfter },
    dailyLimit: { changed: dailyLimitChanged, before: live.dailyLimit ?? null, after: local.dailyLimit },
  };
}

/**
 * PATCH the campaign's resolved local cadence onto its live Instantly
 * campaign — ONE call via updateCampaignCadence — and then VERIFY it actually
 * landed by re-fetching and re-diffing. A PATCH that returns 2xx does not mean
 * Instantly applied every field (we've seen a daily_limit PATCH report success
 * while the value silently stayed unchanged) — so a non-throwing axios call is
 * not enough evidence on its own. Throws with the specific field(s) that
 * didn't stick if verification fails, rather than reporting a false success.
 *
 * Always call computeDiff first and show it to the operator before calling
 * this — this function itself does not confirm anything, by design (the
 * route layer owns the "never sync silently" rule).
 *
 * @param {object} campaign
 * @returns {Promise<void>}
 */
async function syncCadence(campaign) {
  if (!campaign.instantly_campaign_id) {
    throw new Error('syncCadence: campaign has no instantly_campaign_id to sync to');
  }
  if (!process.env.INSTANTLY_API_KEY) {
    throw new Error('syncCadence: INSTANTLY_API_KEY is not set in the environment');
  }

  const local = resolveCadence(campaign);
  await instantly.updateCampaignCadence(process.env.INSTANTLY_API_KEY, campaign.instantly_campaign_id, {
    sequenceSteps: ourStepsToInstantlySteps(local.steps),
    schedule: local.schedule,
    dailyLimit: local.dailyLimit,
  });

  // Verify: re-fetch what's actually live now and diff again. hasChanges
  // should be false — if it isn't, the PATCH didn't fully apply and we must
  // say so specifically, not just "it worked" because the HTTP call didn't error.
  const after = await computeDiff(campaign);
  if (after.hasChanges) {
    const unstuck = [];
    if (after.dailyLimit.changed) {
      unstuck.push(
        `daily limit still shows ${after.dailyLimit.before} on Instantly (wanted ${after.dailyLimit.after})`
      );
    }
    if (after.schedule.changed) {
      unstuck.push('schedule still differs from what was sent');
    }
    if (after.sequence.changed) {
      unstuck.push(
        `${after.sequence.steps.filter((s) => s.changed).length} sequence step(s) still differ`
      );
    }
    throw new Error(
      `syncCadence: PATCH to Instantly returned success but did not fully apply — ${unstuck.join('; ')}. ` +
        'Instantly may be silently rejecting this field for the campaign in its current state ' +
        '(e.g. a running campaign refusing a limit change) — check the campaign directly in Instantly.'
    );
  }
}

/**
 * Read-only LinkedIn/Aimfox summary for a campaign, for the Cadence editor's
 * LinkedIn panel. Thin pass-through to aimfox.getCampaignFlowSummary.
 *
 * @param {object} campaign
 * @returns {Promise<object>}
 */
async function getAimfoxSummary(campaign) {
  return aimfox.getCampaignFlowSummary(campaign.aimfox_campaign_id);
}

/**
 * Persist a validated cadence onto a campaign row. Caller (the route) must
 * validate first — this just writes whatever it's given.
 *
 * @param {number} campaignId
 * @param {object} cadence
 * @param {Array} cadence.steps
 * @param {object} cadence.schedule
 * @param {number} cadence.dailyLimit
 * @returns {Promise<object>} the updated campaign row
 */
async function saveCadence(campaignId, { steps, schedule, dailyLimit }) {
  // Normalize step 0's delayDays to 0 — it's meaningless (nothing precedes it)
  // and we don't want stale UI state persisted as if it mattered.
  const normalizedSteps = steps.map((step, i) => ({
    subject: step.subject,
    body: step.body,
    delayDays: i === 0 ? 0 : Number(step.delayDays) || 0,
  }));

  const { rows } = await db.query(
    `UPDATE campaigns
     SET sequence_steps = $1,
         sending_days = $2,
         sending_window_start = $3,
         sending_window_end = $4,
         sending_timezone = $5,
         daily_limit = $6
     WHERE id = $7
     RETURNING *`,
    [
      JSON.stringify(normalizedSteps),
      schedule.days,
      schedule.windowStart,
      schedule.windowEnd,
      schedule.timezone,
      dailyLimit,
      campaignId,
    ]
  );
  return rows[0];
}

module.exports = {
  MAX_STEPS,
  MIN_DAYS_BETWEEN_STEPS,
  MAX_DAILY_LIMIT,
  DEFAULT_SENDING_DAYS,
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
  ourStepsToInstantlySteps,
  instantlyStepsToOurSteps,
  defaultSequenceSteps,
  dayOffsets,
  resolveCadence,
  validateCadence,
  computeDiff,
  syncCadence,
  saveCadence,
  getAimfoxSummary,
};
