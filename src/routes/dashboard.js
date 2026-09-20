const express = require('express');
const { getNeedsAttention } = require('../services/campaignHealth');

const router = express.Router();

// GET /api/dashboard/needs-attention — everything the Dashboard's mission-
// control view needs: unhandled replies, live Instantly health per campaign
// (also used for the "at a glance" dual-status column), zero-send campaigns,
// and stuck leads. Runs a handful of live Instantly GETs (one per campaign
// with an instantly_campaign_id) — fine at today's scale, worth revisiting
// if the campaign count grows a lot.
router.get('/needs-attention', async (req, res, next) => {
  try {
    res.json(await getNeedsAttention());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
