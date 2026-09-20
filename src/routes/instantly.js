const express = require('express');
const { fetchCampaignStats } = require('../integrations/instantly');

const router = express.Router();

// GET /api/instantly/stats — live analytics for the configured Instantly
// campaign: total sent, open rate, and reply rate (plus the underlying counts).
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await fetchCampaignStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
