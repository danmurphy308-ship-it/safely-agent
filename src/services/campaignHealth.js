const db = require('../config/db');
const instantly = require('../integrations/instantly');
const { OTHER_PROVIDER, providerConfigured } = require('../pipeline/findLeads');

// A locally-active campaign counts as unhealthy if its Instantly campaign
// isn't actually sending, has no sending accounts attached, or couldn't be
// checked at all. This is the same failure class that let California Health
// & Safety Firms accumulate 61 queued-but-never-sent leads before an ad-hoc
// audit caught it — this module is that audit, live, for the Dashboard.
const STUCK_LEAD_HOURS = 24;
const ZERO_SEND_HOURS = 48;

/**
 * Live Instantly status for every campaign that has an instantly_campaign_id
 * (regardless of local status — draft/paused campaigns are included too, so
 * the Dashboard's "at a glance" table can show a dual status for all of
 * them, not just the active ones). One GET per campaign; campaigns are few
 * enough (single digits today) that this stays fast and cheap.
 *
 * @returns {Promise<Array<{id:number, name:string, localStatus:string,
 *   instantlyStatus:(number|null), instantlyStatusLabel:string,
 *   hasSendingAccounts:(boolean|null), dailyLimit:(number|null),
 *   error:(string|null)}>>}
 */
async function getCampaignLiveHealth() {
  const { rows: campaigns } = await db.query(
    `SELECT id, name, status, instantly_campaign_id
     FROM campaigns
     WHERE instantly_campaign_id IS NOT NULL
     ORDER BY id`
  );

  return Promise.all(
    campaigns.map(async (c) => {
      try {
        const live = await instantly.fetchCampaignCadence(c.instantly_campaign_id);
        // Sending capacity comes from EITHER an explicit email_list OR
        // membership in a tag-based shared pool (email_tag_list) — this
        // workspace uses both. Checking email_list alone flagged three
        // genuinely-healthy campaigns as having "no sending accounts" when
        // they were actually drawing from the tag-based pool the whole time
        // (2026-07-20 finding — see HANDOVER.md's Instantly quirks section).
        const hasSendingAccounts = live.emailList.length > 0 || live.emailTagList.length > 0;
        return {
          id: c.id,
          name: c.name,
          localStatus: c.status,
          instantlyStatus: live.status,
          instantlyStatusLabel: instantly.INSTANTLY_STATUS_LABELS[live.status] ?? `unknown (${live.status})`,
          hasSendingAccounts,
          dailyLimit: live.dailyLimit,
          error: null,
        };
      } catch (err) {
        return {
          id: c.id,
          name: c.name,
          localStatus: c.status,
          instantlyStatus: null,
          instantlyStatusLabel: 'unavailable',
          hasSendingAccounts: null,
          dailyLimit: null,
          error: err.message,
        };
      }
    })
  );
}

// Real, unresolved replies awaiting a human decision — reads leads.status
// directly (the authoritative signal as of this week's webhook fix, which
// reverts auto-replies rather than leaving them mismarked), same source
// GET /api/replies now reads from. `reply_handled_at IS NULL` is what
// actually clears an entry here: booking/rejecting moves `status` away from
// 'replied'/'not_interested' anyway, but categories like wrong_person/
// pricing/send_info have no terminal status of their own, so without this
// column they showed as unhandled forever once actioned any other way
// (2026-07-27 finding).
async function getUnhandledReplies() {
  const { rows } = await db.query(
    `SELECT l.id AS lead_id, l.contact_name, l.company_name, l.campaign_id,
            c.name AS campaign_name, l.updated_at,
            ra.channel, ra.category, ra.suggested_response
     FROM leads l
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN LATERAL (
       SELECT channel, category, suggested_response
       FROM reply_assists
       WHERE lead_id = l.id
       ORDER BY created_at DESC
       LIMIT 1
     ) ra ON true
     WHERE l.status IN ('replied', 'not_interested')
       AND l.reply_handled_at IS NULL
     ORDER BY l.updated_at DESC`
  );
  return rows;
}

const ZERO_SEND_LOOKBACK_DAYS = 14; // wide enough to find an actual last-sent date to display

const toDateStr = (d) => d.toISOString().slice(0, 10);

// Per-campaign fallback using our OWN table — only reached when Instantly's
// daily analytics can't be reached. Misses Instantly's own follow-up sends
// (steps 2-7), which is exactly why this is the fallback, not the primary
// check, but it's better than reporting nothing when the API is down.
async function zeroSendFromOurTable(campaign) {
  const { rows } = await db.query(
    `SELECT MAX(e.sent_at) AS last_sent_at
     FROM leads l
     LEFT JOIN emails e ON e.lead_id = l.id AND e.sent_at IS NOT NULL
     WHERE l.campaign_id = $1`,
    [campaign.id]
  );
  const lastSentAt = rows[0]?.last_sent_at ?? null;
  const isStale = !lastSentAt || new Date(lastSentAt) < new Date(Date.now() - ZERO_SEND_HOURS * 3_600_000);
  return isStale ? { id: campaign.id, name: campaign.name, last_sent_at: lastSentAt } : null;
}

// Active campaigns with leads but nothing actually sent in the last 48h —
// a live campaign that's gone quiet. Source of truth is Instantly's own
// per-day analytics (fetchCampaignDailyAnalytics), NOT our `emails.sent_at`
// table — that table only captures OUR app-side enrollments (email 1), not
// Instantly's own follow-up sends (steps 2-7), which fire from Instantly's
// sequence engine without our app being called again. Checking our table
// alone flagged campaigns that were actively sending dozens of step 3s
// (2026-07-20 finding). Falls back to our table only if Instantly's API is
// unreachable for a given campaign.
async function getZeroSendCampaigns() {
  const { rows: campaigns } = await db.query(
    `SELECT id, name, instantly_campaign_id
     FROM campaigns
     WHERE status = 'active' AND total_leads > 0`
  );

  const now = new Date();
  const windowStart = toDateStr(new Date(now.getTime() - ZERO_SEND_HOURS * 3_600_000));
  const lookbackStart = toDateStr(new Date(now.getTime() - ZERO_SEND_LOOKBACK_DAYS * 86_400_000));
  const today = toDateStr(now);

  const results = await Promise.all(
    campaigns.map(async (c) => {
      if (!c.instantly_campaign_id) {
        return zeroSendFromOurTable(c);
      }
      try {
        const daily = await instantly.fetchCampaignDailyAnalytics(c.instantly_campaign_id, lookbackStart, today);
        const sentInWindow = daily
          .filter((d) => d.date >= windowStart)
          .reduce((sum, d) => sum + d.sent, 0);
        if (sentInWindow > 0) return null; // actively sending — not a problem
        const lastSentDay = daily
          .filter((d) => d.sent > 0)
          .map((d) => d.date)
          .sort()
          .pop();
        return { id: c.id, name: c.name, last_sent_at: lastSentDay ?? null };
      } catch (err) {
        console.error(
          `[campaignHealth] Instantly daily analytics unavailable for campaign ${c.id} — falling back to our own table:`,
          err.message
        );
        return zeroSendFromOurTable(c);
      }
    })
  );

  return results.filter(Boolean);
}

// Leads that have sat at 'new' (never scored/drafted) longer than expected —
// usually means the hourly leadProcessor isn't keeping up, or the campaign
// isn't active so nothing is picking them up.
//
// Measured from `updated_at`, NOT `created_at`. A lead's original creation
// date is irrelevant to whether it's actually stuck — a bulk requeue (e.g.
// cleanupZombieDraftedLeads.js resetting a rescued lead to 'new') sets
// status='new' on a lead that might be weeks old, and that's a fresh,
// pending-for-the-next-tick lead, not a neglected one. created_at produced
// exactly that false alarm: 11 rescued UK leads showing as "stuck" for
// hundreds of hours because their original creation date was old, when in
// truth they'd been waiting under an hour (2026-07-20 finding).
//
// `updated_at` isn't a dedicated "entered this status" timestamp — leads
// has no such column, so any UPDATE to the row (not just a status change)
// resets it. In practice that's the right behavior here: the only things
// that touch a 'new' lead before the pipeline moves it past 'new' are
// exactly the actions that mean "treat this as fresh" (a bulk requeue, a
// CSV backfill filling in a missing email). If that stops being true, a
// dedicated status_changed_at column would be the more precise fix.
async function getStuckLeads() {
  const { rows } = await db.query(
    `SELECT l.campaign_id, c.name AS campaign_name, COUNT(*)::int AS count,
            MIN(l.updated_at) AS oldest_new_at
     FROM leads l
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.status = 'new' AND l.updated_at < now() - make_interval(hours => $1)
     GROUP BY l.campaign_id, c.name
     ORDER BY count DESC`,
    [STUCK_LEAD_HOURS]
  );
  return rows;
}

// Active campaigns whose PRIMARY lead_source is marked exhausted (migration
// 019 — apollo_exhausted_at/clay_exhausted_at, stamped by findLeadsForCampaign
// the moment that provider comes back empty for the campaign's current ICP,
// cleared only on an ICP edit). Surfaces whether the source-fallback chain is
// actually covering for it — active, or unavailable and why — so a silently
// dry campaign's fallback state is visible without reading logs.
async function getExhaustedSources() {
  const { rows } = await db.query(
    `SELECT id, name, lead_source, fallback_source_enabled,
            apollo_exhausted_at, clay_exhausted_at
     FROM campaigns
     WHERE status = 'active'
       AND ((lead_source = 'apollo' AND apollo_exhausted_at IS NOT NULL)
         OR (lead_source = 'clay' AND clay_exhausted_at IS NOT NULL))
     ORDER BY GREATEST(apollo_exhausted_at, clay_exhausted_at) DESC`
  );

  return rows.map((c) => {
    const secondary = OTHER_PROVIDER[c.lead_source];
    const secondaryExhaustedAt = secondary === 'clay' ? c.clay_exhausted_at : c.apollo_exhausted_at;
    const exhaustedAt = c.lead_source === 'clay' ? c.clay_exhausted_at : c.apollo_exhausted_at;

    let fallbackStatus = 'active';
    let fallbackReason = `covering via ${secondary}`;
    if (!c.fallback_source_enabled) {
      fallbackStatus = 'unavailable';
      fallbackReason = 'fallback_source_enabled is off';
    } else if (!providerConfigured(secondary)) {
      fallbackStatus = 'unavailable';
      fallbackReason = `${secondary} is not configured`;
    } else if (secondaryExhaustedAt) {
      fallbackStatus = 'unavailable';
      fallbackReason = `${secondary} is also exhausted`;
    }

    return {
      id: c.id,
      name: c.name,
      primaryProvider: c.lead_source,
      secondaryProvider: secondary,
      exhaustedAt,
      fallbackStatus, // 'active' | 'unavailable'
      fallbackReason,
    };
  });
}

/**
 * Everything the Dashboard's "Needs attention" section and "Campaigns at a
 * glance" dual-status column need, in one call.
 */
async function getNeedsAttention() {
  const [campaignHealth, unhandledReplies, zeroSendCampaigns, stuckLeads, exhaustedSources] = await Promise.all([
    getCampaignLiveHealth(),
    getUnhandledReplies(),
    getZeroSendCampaigns(),
    getStuckLeads(),
    getExhaustedSources(),
  ]);

  // Instantly statuses the "activate" endpoint can actually clear — a normal
  // pause (2) or a bounce-protect pause (-2, triggered by Instantly's default
  // 5%-bounce-rate auto-pause once 200+ emails are sent). Draft/unhealthy/
  // suspended/completed need a different fix (a sequence, healthy sending
  // accounts, Instantly support, or are intentionally done), so the Dashboard
  // only offers the resume action for these two.
  const RESUMABLE_INSTANTLY_STATUSES = new Set([2, -2]);

  const inactiveCampaigns = campaignHealth
    .filter((h) => h.localStatus === 'active')
    .filter((h) => h.error || !instantly.ACTIVELY_SENDING_STATUSES.has(h.instantlyStatus) || !h.hasSendingAccounts)
    .map((h) => ({
      id: h.id,
      name: h.name,
      reason: h.error
        ? `Instantly check failed: ${h.error}`
        : !instantly.ACTIVELY_SENDING_STATUSES.has(h.instantlyStatus)
          ? `Instantly status: ${h.instantlyStatusLabel}`
          : 'No sending accounts attached in Instantly',
      instantlyStatus: h.instantlyStatus,
      instantlyStatusLabel: h.instantlyStatusLabel,
      resumable: !h.error && RESUMABLE_INSTANTLY_STATUSES.has(h.instantlyStatus),
    }));

  return {
    unhandledReplies,
    inactiveCampaigns,
    zeroSendCampaigns,
    stuckLeads,
    exhaustedSources,
    campaignHealth,
  };
}

module.exports = {
  getCampaignLiveHealth,
  getUnhandledReplies,
  getZeroSendCampaigns,
  getStuckLeads,
  getExhaustedSources,
  getNeedsAttention,
};
