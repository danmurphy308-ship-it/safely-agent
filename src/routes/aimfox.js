const express = require('express');
const db = require('../config/db');
const { getCampaignMetrics } = require('../integrations/aimfox');

const router = express.Router();

// GET /api/aimfox/stats — LinkedIn outreach KPIs for the Dashboard.
//
// Preferred source is Aimfox's own campaign metrics (summed across every
// distinct Aimfox campaign our campaigns point at, plus the env fallback).
// When Aimfox is unconfigured or unreachable, fall back to counting our own
// leads.linkedin_status column — same shape, `source` tells the UI which one
// it got.
router.get('/stats', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE linkedin_status IS NOT NULL)                            AS queued,
         COUNT(*) FILTER (WHERE linkedin_status IN ('requested','accepted','replied')) AS requests_sent,
         COUNT(*) FILTER (WHERE linkedin_status IN ('accepted','replied'))             AS accepted,
         COUNT(*) FILTER (WHERE linkedin_status = 'replied')                           AS replied
       FROM leads`
    );
    const dbStats = {
      queued: Number(rows[0].queued),
      requests_sent: Number(rows[0].requests_sent),
      accepted: Number(rows[0].accepted),
      replied: Number(rows[0].replied),
    };

    if (!process.env.AIMFOX_API_KEY) {
      return res.json({ source: 'db', ...dbStats });
    }

    // Every Aimfox campaign we feed: per-campaign ids plus the env fallback.
    const { rows: campaignRows } = await db.query(
      `SELECT DISTINCT aimfox_campaign_id FROM campaigns WHERE aimfox_campaign_id IS NOT NULL`
    );
    const aimfoxIds = new Set(campaignRows.map((r) => r.aimfox_campaign_id));
    if (process.env.AIMFOX_CAMPAIGN_ID) aimfoxIds.add(process.env.AIMFOX_CAMPAIGN_ID);

    if (aimfoxIds.size === 0) {
      return res.json({ source: 'db', ...dbStats });
    }

    try {
      let requests_sent = 0;
      let accepted = 0;
      let replied = 0;
      for (const id of aimfoxIds) {
        const m = await getCampaignMetrics(id);
        requests_sent += m.sent_connections ?? 0;
        accepted += m.accepted_connections ?? 0;
        replied += (m.replies ?? 0) + (m.inmail_replies ?? 0);
      }
      res.json({ source: 'aimfox', queued: dbStats.queued, requests_sent, accepted, replied });
    } catch (err) {
      // Aimfox down or a campaign id stale — degrade to our own counts.
      console.error('[aimfox] stats fell back to DB counts:', err.message);
      res.json({ source: 'db', ...dbStats });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
