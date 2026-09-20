const express = require('express');
const db = require('../config/db');
const { clearFilterRulesCache, SETTING_KEYS } = require('../services/filterRules');

const router = express.Router();

// Keys the Dashboard demo summary card manages. Whitelisted so a PUT can't be
// used to write arbitrary settings from the client. Each is stored as TEXT;
// these four are numeric (open_rate is a percentage, the rest are counts).
const DEMO_STAT_KEYS = [
  'demo_emails_sent',
  'demo_open_rate',
  'demo_replies',
  'demo_meetings_booked',
];

// Lead Filters keys (Settings page): each value is an array of bad-fit
// keywords, stored as a JSON string. Consumed by src/services/filterRules.js
// before every Claude scoring call.
const FILTER_KEYS = Object.values(SETTING_KEYS);

// Return every setting as a flat { key: value } map.
async function readAllSettings() {
  const { rows } = await db.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// GET /api/settings — all settings as a { key: value } map.
router.get('/', async (req, res, next) => {
  try {
    res.json(await readAllSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings — upsert one or more settings. Body is a { key: value } map;
// only whitelisted keys are written: demo-stat keys take finite non-negative
// numbers, Lead Filters keys take arrays of non-empty strings (stored as JSON).
// Returns the full settings map after the update.
router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const entries = Object.entries(body).filter(
      ([key]) => DEMO_STAT_KEYS.includes(key) || FILTER_KEYS.includes(key)
    );

    if (entries.length === 0) {
      return res.status(400).json({
        error: `No editable settings in request. Allowed keys: ${[
          ...DEMO_STAT_KEYS,
          ...FILTER_KEYS,
        ].join(', ')}`,
      });
    }

    for (const [key, raw] of entries) {
      let value;
      if (FILTER_KEYS.includes(key)) {
        if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string' || !k.trim())) {
          return res
            .status(400)
            .json({ error: `\`${key}\` must be an array of non-empty strings` });
        }
        // Normalise: trim, lowercase, dedupe — matching is case-insensitive.
        value = JSON.stringify([...new Set(raw.map((k) => k.trim().toLowerCase()))]);
      } else {
        const num = Number(raw);
        if (!Number.isFinite(num) || num < 0) {
          return res.status(400).json({ error: `\`${key}\` must be a non-negative number` });
        }
        value = String(num);
      }
      await db.query(
        `INSERT INTO settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }

    // Filter edits should apply to the very next processed lead, not after the
    // 60s cache expires.
    clearFilterRulesCache();

    res.json(await readAllSettings());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
