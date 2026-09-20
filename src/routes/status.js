const express = require('express');
const db = require('../config/db');

const router = express.Router();

// API keys / connection strings the app uses or will use. We only report
// whether each is set — never the value itself.
const TRACKED_ENV_KEYS = [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAY_API_KEY',
  'APOLLO_API_KEY',
  'INSTANTLY_API_KEY',
  'HUBSPOT_ACCESS_TOKEN',
];

// GET /api/status — environment + database health (no secret values returned)
router.get('/', async (req, res, next) => {
  try {
    const env = TRACKED_ENV_KEYS.map((key) => ({
      key,
      configured: Boolean(process.env[key] && process.env[key].trim()),
    }));

    let database;
    try {
      await db.query('SELECT 1');
      database = { connected: true, error: null };
    } catch (err) {
      database = { connected: false, error: err.message };
    }

    res.json({ env, database });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
