const express = require('express');
const db = require('../config/db');
const { fetchAllCampaignAnalytics } = require('../integrations/instantly');

const router = express.Router();

// Funnel dashboard data. Per campaign, two funnels:
//
//   Email:    Sourced → Emailed (sequence started) → Replied → Meetings
//   LinkedIn: Queued → Requested → Accepted → Replied   (from linkedin_status)
//
// Counts are cumulative reached-stage numbers from our own DB. Where a
// campaign has an instantly_campaign_id and the Instantly analytics API is
// reachable, the Emailed/Replied stages also carry a `live_total` straight
// from Instantly (may exceed our DB counts — Instantly also sees leads added
// outside this app). "This week" / "last week" are rolling 7-day windows
// (now-7d vs now-14d..now-7d) computed from our own timestamps, since
// Instantly's overview analytics aren't windowed.

// Reply events logged by the webhooks: Instantly posts reply_received for
// EVERY reply, auto or not (there is no distinct auto_reply_received event
// type in practice) — so the human-vs-automated split can't be read off
// event_type. It has to come from Claude's actual classification in
// reply_assists.category instead: 'auto_reply' is automated, every other
// category ('interested', 'send_info', 'wrong_person', 'pricing',
// 'not_interested') is a genuine human reply. 'interested'/'send_info'/
// 'pricing' additionally count as "actionable" — real sales engagement, as
// opposed to a human reply that's just a decline or a dead end. A booked
// lead always counts as actionable too, regardless of category, since a
// booked meeting is the clearest engagement signal there is.
const EMAIL_FUNNEL_SQL = `
  WITH email_replies AS (
    SELECT lead_id, MIN(created_at) AS first_reply_at
    FROM events
    WHERE lead_id IS NOT NULL
      AND event_type ~* 'repl'
      AND event_type NOT ILIKE 'aimfox%'
    GROUP BY lead_id
  ),
  any_replies AS (
    SELECT DISTINCT lead_id FROM events
    WHERE lead_id IS NOT NULL AND event_type ~* 'repl'
  ),
  reply_classification AS (
    SELECT lead_id,
           BOOL_OR(category IS DISTINCT FROM 'auto_reply') AS has_human,
           BOOL_OR(category IN ('interested', 'send_info', 'pricing')) AS has_actionable
    FROM reply_assists
    WHERE channel = 'email'
    GROUP BY lead_id
  ),
  first_sent AS (
    SELECT lead_id, MIN(sent_at) AS first_sent_at
    FROM emails
    WHERE sent_at IS NOT NULL
    GROUP BY lead_id
  )
  SELECT
    l.campaign_id,
    COUNT(*)::int AS sourced_total,
    COUNT(*) FILTER (WHERE l.created_at >= now() - interval '7 days')::int AS sourced_this,
    COUNT(*) FILTER (WHERE l.created_at >= now() - interval '14 days'
                       AND l.created_at <  now() - interval '7 days')::int AS sourced_last,

    COUNT(*) FILTER (WHERE fs.lead_id IS NOT NULL
                        OR l.status IN ('sent','replied','booked','bounced','unsubscribed'))::int AS emailed_total,
    COUNT(*) FILTER (WHERE fs.first_sent_at >= now() - interval '7 days')::int AS emailed_this,
    COUNT(*) FILTER (WHERE fs.first_sent_at >= now() - interval '14 days'
                       AND fs.first_sent_at <  now() - interval '7 days')::int AS emailed_last,

    -- Replied: leads with an Instantly reply event, plus replied/booked leads
    -- with no reply event at all (status set manually/pre-webhook — counted
    -- human). Leads whose only reply signal is a LinkedIn (aimfox) event
    -- belong to the LinkedIn funnel, not here. An unclassified reply (the
    -- async reply_assists row hasn't landed yet) defaults to human, same as
    -- the pre-webhook fallback, but never to actionable — that needs actual
    -- classification evidence, not an assumption.
    COUNT(*) FILTER (WHERE er.lead_id IS NOT NULL
                        OR (l.status IN ('replied','booked') AND ar.lead_id IS NULL))::int AS replied_total,
    COUNT(*) FILTER (WHERE (er.lead_id IS NOT NULL AND (rc.has_human IS NOT FALSE))
                        OR (l.status IN ('replied','booked') AND ar.lead_id IS NULL))::int AS replied_human,
    COUNT(*) FILTER (WHERE er.lead_id IS NOT NULL AND rc.has_human IS FALSE)::int AS replied_auto,
    COUNT(*) FILTER (WHERE (er.lead_id IS NOT NULL AND rc.has_actionable)
                        OR l.status = 'booked')::int AS replied_actionable,
    COUNT(*) FILTER (WHERE er.first_reply_at >= now() - interval '7 days')::int AS replied_this,
    COUNT(*) FILTER (WHERE er.first_reply_at >= now() - interval '14 days'
                       AND er.first_reply_at <  now() - interval '7 days')::int AS replied_last,

    -- Meetings: no meeting_booked events exist yet, so the weekly windows use
    -- updated_at of booked leads — approximate (any later edit moves it), but
    -- booked leads are rarely touched afterwards.
    COUNT(*) FILTER (WHERE l.status = 'booked')::int AS booked_total,
    COUNT(*) FILTER (WHERE l.status = 'booked'
                       AND l.updated_at >= now() - interval '7 days')::int AS booked_this,
    COUNT(*) FILTER (WHERE l.status = 'booked'
                       AND l.updated_at >= now() - interval '14 days'
                       AND l.updated_at <  now() - interval '7 days')::int AS booked_last
  FROM leads l
  LEFT JOIN first_sent          fs ON fs.lead_id = l.id
  LEFT JOIN email_replies       er ON er.lead_id = l.id
  LEFT JOIN any_replies         ar ON ar.lead_id = l.id
  LEFT JOIN reply_classification rc ON rc.lead_id = l.id
  WHERE l.campaign_id IS NOT NULL
  GROUP BY l.campaign_id
`;

// linkedin_status is forward-only, so reached-stage counts are cumulative
// (a 'replied' lead has also been queued, requested, and accepted).
const LINKEDIN_FUNNEL_SQL = `
  SELECT
    campaign_id,
    COUNT(*) FILTER (WHERE linkedin_status IS NOT NULL)::int AS queued,
    COUNT(*) FILTER (WHERE linkedin_status IN ('requested','accepted','replied'))::int AS requested,
    COUNT(*) FILTER (WHERE linkedin_status IN ('accepted','replied'))::int AS accepted,
    COUNT(*) FILTER (WHERE linkedin_status = 'replied')::int AS replied
  FROM leads
  WHERE campaign_id IS NOT NULL
  GROUP BY campaign_id
`;

// LinkedIn weekly deltas come from the aimfox_* webhook events (the
// linkedin_status column itself has no per-stage timestamps). Queued has no
// event either, so its weekly numbers stay null in the response.
const LINKEDIN_DELTA_SQL = `
  SELECT
    l.campaign_id,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type = 'aimfox_connect'
        AND e.created_at >= now() - interval '7 days')::int AS requested_this,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type = 'aimfox_connect'
        AND e.created_at >= now() - interval '14 days'
        AND e.created_at <  now() - interval '7 days')::int AS requested_last,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type IN ('aimfox_accepted','aimfox_new_connection')
        AND e.created_at >= now() - interval '7 days')::int AS accepted_this,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type IN ('aimfox_accepted','aimfox_new_connection')
        AND e.created_at >= now() - interval '14 days'
        AND e.created_at <  now() - interval '7 days')::int AS accepted_last,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type IN ('aimfox_reply','aimfox_inmail_reply','aimfox_new_reply','aimfox_campaign_reply')
        AND e.created_at >= now() - interval '7 days')::int AS replied_this,
    COUNT(DISTINCT e.lead_id) FILTER (
      WHERE e.event_type IN ('aimfox_reply','aimfox_inmail_reply','aimfox_new_reply','aimfox_campaign_reply')
        AND e.created_at >= now() - interval '14 days'
        AND e.created_at <  now() - interval '7 days')::int AS replied_last
  FROM events e
  JOIN leads l ON l.id = e.lead_id
  WHERE e.event_type LIKE 'aimfox_%'
    AND l.campaign_id IS NOT NULL
  GROUP BY l.campaign_id
`;

const stage = (total, thisWeek, lastWeek) => ({
  total: total || 0,
  this_week: thisWeek ?? null,
  last_week: lastWeek ?? null,
});

/**
 * Assemble the full funnel payload. Exported separately from the router so it
 * can be exercised without starting the server (which boots the hourly jobs).
 */
async function buildFunnel() {
  const [campaignsRes, emailRes, linkedinRes, linkedinDeltaRes] = await Promise.all([
    db.query(
      `SELECT id, name, status, instantly_campaign_id FROM campaigns ORDER BY id`
    ),
    db.query(EMAIL_FUNNEL_SQL),
    db.query(LINKEDIN_FUNNEL_SQL),
    db.query(LINKEDIN_DELTA_SQL),
  ]);

  // Live Instantly overlay — best-effort; the DB numbers stand alone.
  let instantly = null;
  if (process.env.INSTANTLY_API_KEY) {
    try {
      instantly = await fetchAllCampaignAnalytics();
    } catch (err) {
      console.error('[funnel] Instantly overlay unavailable, using DB only:', err.message);
    }
  }

  const emailByCampaign = new Map(emailRes.rows.map((r) => [r.campaign_id, r]));
  const linkedinByCampaign = new Map(linkedinRes.rows.map((r) => [r.campaign_id, r]));
  const linkedinDeltaByCampaign = new Map(
    linkedinDeltaRes.rows.map((r) => [r.campaign_id, r])
  );

  const campaigns = campaignsRes.rows.map((c) => {
    const e = emailByCampaign.get(c.id) || {};
    const li = linkedinByCampaign.get(c.id) || {};
    const lid = linkedinDeltaByCampaign.get(c.id) || {};
    const live = (c.instantly_campaign_id && instantly?.get(String(c.instantly_campaign_id))) || null;

    return {
      id: c.id,
      name: c.name,
      status: c.status,
      email: {
        sourced: stage(e.sourced_total, e.sourced_this, e.sourced_last),
        emailed: {
          ...stage(e.emailed_total, e.emailed_this, e.emailed_last),
          live_total: live ? live.contacted : null,
        },
        replied: {
          ...stage(e.replied_total, e.replied_this, e.replied_last),
          human: e.replied_human || 0,
          automated: e.replied_auto || 0,
          actionable: e.replied_actionable || 0,
          live_total: live ? live.replies : null,
        },
        booked: stage(e.booked_total, e.booked_this, e.booked_last),
      },
      linkedin:
        (li.queued || 0) > 0
          ? {
              queued: { total: li.queued || 0, this_week: null, last_week: null },
              requested: stage(li.requested, lid.requested_this, lid.requested_last),
              accepted: stage(li.accepted, lid.accepted_this, lid.accepted_last),
              replied: stage(li.replied, lid.replied_this, lid.replied_last),
            }
          : null,
    };
  });

  // Aggregate across all campaigns, stage by stage.
  const sum = (path) =>
    campaigns.reduce((acc, c) => {
      const v = path(c);
      return v == null ? acc : acc + v;
    }, 0);
  const sumOrNull = (path) => (campaigns.some((c) => path(c) != null) ? sum(path) : null);

  const totalStage = (get) => ({
    total: sum((c) => get(c)?.total),
    this_week: sumOrNull((c) => get(c)?.this_week),
    last_week: sumOrNull((c) => get(c)?.last_week),
  });

  const totals = {
    email: {
      sourced: totalStage((c) => c.email.sourced),
      emailed: {
        ...totalStage((c) => c.email.emailed),
        live_total: sumOrNull((c) => c.email.emailed.live_total),
      },
      replied: {
        ...totalStage((c) => c.email.replied),
        human: sum((c) => c.email.replied.human),
        automated: sum((c) => c.email.replied.automated),
        actionable: sum((c) => c.email.replied.actionable),
        live_total: sumOrNull((c) => c.email.replied.live_total),
      },
      booked: totalStage((c) => c.email.booked),
    },
    linkedin: {
      queued: { total: sum((c) => c.linkedin?.queued.total), this_week: null, last_week: null },
      requested: totalStage((c) => c.linkedin?.requested),
      accepted: totalStage((c) => c.linkedin?.accepted),
      replied: totalStage((c) => c.linkedin?.replied),
    },
  };

  return {
    window: { days: 7, note: 'rolling 7 days vs the 7 days before' },
    instantly_live: instantly != null,
    totals,
    campaigns,
  };
}

// GET /api/funnel — per-campaign conversion funnel for the dashboard.
router.get('/', async (req, res, next) => {
  try {
    res.json(await buildFunnel());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildFunnel = buildFunnel;
