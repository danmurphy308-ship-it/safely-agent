const express = require('express');
const multer = require('multer');
const db = require('../config/db');
const {
  findLeadsForCampaign,
  saveLeadIfNew,
  incrementCampaignLeads,
} = require('../pipeline/findLeads');
const { processCampaignLeads } = require('../services/pipeline');
const { importLeadsFromCsv } = require('../pipeline/importCsv');
const clay = require('../integrations/clay');
const apollo = require('../integrations/apollo');
const instantly = require('../integrations/instantly');
const cadence = require('../services/cadence');
const { recordProcessRun, getLatestRunsPerCampaign } = require('../services/processRuns');

const router = express.Router();

// Cap leads processed per request to control Anthropic API cost.
const MAX_LEADS_PER_REQUEST = 50;

// Hold uploaded CSVs in memory (operator uploads, not huge files); cap at 10 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Run multer's single-file middleware, turning its errors (e.g. file too large)
// into a 400 instead of letting them hit the generic 500 error handler.
function uploadCsv(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Sourcing providers a campaign can use (campaigns.lead_source).
const LEAD_SOURCES = ['apollo', 'clay'];

// Campaign ids whose process-leads run is currently in flight. Processing now
// happens in the background (the request returns 202 immediately), so this lets
// process-status report whether a run is still going. In-memory, so it only
// tracks runs started by THIS server instance.
const processingCampaigns = new Set();

// POST /api/campaigns — create a new campaign
router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      status,
      icp_industries,
      icp_locations,
      icp_titles,
      icp_min_fleet_size,
      icp_excluded_industries,
      instantly_campaign_id,
      aimfox_campaign_id,
      lead_source,
    } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: '`name` is required' });
    }
    if (lead_source !== undefined && !LEAD_SOURCES.includes(lead_source)) {
      return res
        .status(400)
        .json({ error: `\`lead_source\` must be one of ${LEAD_SOURCES.join(', ')}` });
    }

    const { rows } = await db.query(
      `INSERT INTO campaigns
         (name, status, icp_industries, icp_locations, icp_titles,
          icp_min_fleet_size, icp_excluded_industries, instantly_campaign_id,
          aimfox_campaign_id, lead_source)
       VALUES ($1, COALESCE($2, 'draft'), $3, $4, $5, COALESCE($6, 100), $7, $8, $9,
               COALESCE($10, 'apollo'))
       RETURNING *`,
      [
        name,
        status ?? null,
        icp_industries ?? null,
        icp_locations ?? null,
        icp_titles ?? null,
        icp_min_fleet_size ?? null,
        icp_excluded_industries ?? null,
        instantly_campaign_id || null,
        aimfox_campaign_id || null,
        lead_source ?? null,
      ]
    );

    const created = rows[0];

    // Auto-provision a matching Instantly campaign (same name) when the operator
    // didn't paste an ID themselves and Instantly is configured. Best-effort: a
    // failure must NOT block local campaign creation — log it and move on.
    if (!created.instantly_campaign_id && process.env.INSTANTLY_API_KEY) {
      try {
        const { id: instantlyId } = await instantly.createCampaign(created.name, {
          locations: created.icp_locations || [],
        });
        if (instantlyId) {
          const { rows: updated } = await db.query(
            'UPDATE campaigns SET instantly_campaign_id = $1 WHERE id = $2 RETURNING *',
            [instantlyId, created.id]
          );
          return res.status(201).json(updated[0]);
        }
        console.error(
          `[campaigns] Instantly campaign created for "${created.name}" but no id was returned`
        );
      } catch (err) {
        console.error(
          `[campaigns] Instantly campaign creation failed for "${created.name}":`,
          err.message
        );
      }
    }

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns — list all campaigns
router.get('/', async (req, res, next) => {
  try {
    // total_contacted is computed from lead statuses, not the stale campaigns
    // counter (which nothing increments): a lead counts as contacted once it
    // has been sent at least one email — 'sent' plus the statuses only
    // reachable from 'sent'. The alias intentionally shadows the c.* column
    // of the same name (node-postgres keeps the last duplicate field).
    const { rows } = await db.query(
      `SELECT c.*, COALESCE(contacted.n, 0)::int AS total_contacted
       FROM campaigns c
       LEFT JOIN (
         SELECT campaign_id, COUNT(*) AS n
         FROM leads
         WHERE status IN ('sent', 'replied', 'booked', 'unsubscribed')
         GROUP BY campaign_id
       ) contacted ON contacted.campaign_id = c.id
       ORDER BY c.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/process-runs — the most recent runs per campaign (default
// 3, ?limit=N up to 10) from the process_runs ledger, keyed by campaign id.
// Feeds the Campaigns page "Last run" display. MUST stay above /:id, which
// would otherwise capture "process-runs" as a campaign id.
router.get('/process-runs', async (req, res, next) => {
  try {
    res.json(await getLatestRunsPerCampaign(req.query.limit));
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/sending-schedule — the campaign's LIVE Instantly
// sending window (days, hours, timezone), read-only. Surfaces schedule
// mistakes (e.g. a US timezone on a UK campaign) without opening Instantly.
router.get('/:id/sending-schedule', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT instantly_campaign_id FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const instantlyId = rows[0].instantly_campaign_id || process.env.INSTANTLY_CAMPAIGN_ID;
    if (!instantlyId || !process.env.INSTANTLY_API_KEY) {
      return res.status(404).json({ error: 'No Instantly campaign configured' });
    }
    const schedule = await instantly.fetchCampaignSchedule(instantlyId);
    res.json({ instantly_campaign_id: instantlyId, ...schedule });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/cadence — this campaign's effective cadence (custom
// sequence/schedule/limit if set, else the computed defaults), plus the full
// Instantly timezone enum so the editor's dropdown only ever offers valid
// values. MUST stay above /:id.
router.get('/:id/cadence', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({
      ...cadence.resolveCadence(rows[0]),
      guardrails: {
        maxSteps: cadence.MAX_STEPS,
        minDaysBetweenSteps: cadence.MIN_DAYS_BETWEEN_STEPS,
        maxDailyLimit: cadence.MAX_DAILY_LIMIT,
      },
      timezones: instantly.INSTANTLY_TIMEZONES,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaigns/:id/cadence — validate and save a custom sequence +
// schedule + daily limit. Does NOT touch Instantly — that only ever happens
// via the explicit /cadence/sync action below. Returns 422 with the guardrail
// errors (and any non-blocking warnings) instead of saving a cadence that
// would just get rejected or misbehave on sync.
router.put('/:id/cadence', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { steps, schedule, dailyLimit } = req.body || {};
    const { errors, warnings } = cadence.validateCadence({ steps, schedule, dailyLimit });
    if (errors.length) {
      return res.status(422).json({ errors, warnings });
    }

    const updated = await cadence.saveCadence(req.params.id, { steps, schedule, dailyLimit });
    res.json({ ...cadence.resolveCadence(updated), warnings });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/cadence/diff — current (live Instantly) vs new
// (this campaign's resolved local cadence), for the "Save & Sync" confirmation
// dialog. Read-only — never syncs.
router.get('/:id/cadence/diff', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!rows[0].instantly_campaign_id) {
      return res.status(400).json({ error: 'Campaign has no linked Instantly campaign to diff against' });
    }
    res.json(await cadence.computeDiff(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/cadence/sync — push this campaign's resolved local
// cadence onto its Instantly campaign (one PATCH). The client is expected to
// have shown the operator the /cadence/diff result and gotten confirmation
// first — this route itself does not re-derive or require the diff, it just
// applies the sync when asked.
router.post('/:id/cadence/sync', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!rows[0].instantly_campaign_id) {
      return res.status(400).json({ error: 'Campaign has no linked Instantly campaign to sync to' });
    }
    await cadence.syncCadence(rows[0]);
    res.json({ synced: true, campaign_id: Number(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/resume — resume a campaign Instantly has
// auto-paused or bounce-protected (status 2 / -2), via the same "activate"
// action used to start a brand-new campaign — Instantly has no separate
// resume endpoint. Lets the operator clear a bounce-protect pause from
// Safely SDR without logging into Instantly. Returns the live status right
// after so the Dashboard can reflect the change without waiting for the
// next needs-attention poll.
router.post('/:id/resume', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, instantly_campaign_id FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    if (!campaign.instantly_campaign_id) {
      return res.status(400).json({ error: 'Campaign has no linked Instantly campaign to resume' });
    }

    await instantly.activateCampaign(campaign.instantly_campaign_id);

    const live = await instantly.fetchCampaignCadence(campaign.instantly_campaign_id);
    res.json({
      resumed: true,
      instantlyStatus: live.status,
      instantlyStatusLabel: instantly.INSTANTLY_STATUS_LABELS[live.status] ?? `unknown (${live.status})`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/aimfox-summary — read-only LinkedIn flow summary +
// warmup limits for the campaign's linked Aimfox campaign. Aimfox's API has
// no endpoint to edit a flow, so this is display-only; the response includes
// a manageUrl straight into the Aimfox UI for anything that needs changing.
router.get('/:id/aimfox-summary', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT aimfox_campaign_id FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(await cadence.getAimfoxSummary(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id — get a single campaign
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaigns/:id — update a campaign's name, ICP targeting fields
// (industries, locations, titles, minimum fleet size), and auto-replenish
// settings (auto_replenish, replenish_threshold). Status and lead counts are
// managed elsewhere and left untouched.
router.put('/:id', async (req, res, next) => {
  try {
    const {
      name,
      icp_industries,
      icp_locations,
      icp_titles,
      icp_min_fleet_size,
      instantly_campaign_id,
      aimfox_campaign_id,
      auto_replenish,
      replenish_threshold,
      lead_source,
      fallback_source_enabled,
    } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: '`name` is required' });
    }
    if (lead_source !== undefined && !LEAD_SOURCES.includes(lead_source)) {
      return res
        .status(400)
        .json({ error: `\`lead_source\` must be one of ${LEAD_SOURCES.join(', ')}` });
    }
    if (auto_replenish !== undefined && typeof auto_replenish !== 'boolean') {
      return res.status(400).json({ error: '`auto_replenish` must be a boolean' });
    }
    if (fallback_source_enabled !== undefined && typeof fallback_source_enabled !== 'boolean') {
      return res.status(400).json({ error: '`fallback_source_enabled` must be a boolean' });
    }
    if (
      replenish_threshold !== undefined &&
      (!Number.isInteger(replenish_threshold) || replenish_threshold < 1)
    ) {
      return res.status(400).json({ error: '`replenish_threshold` must be a positive integer' });
    }

    // A changed ICP means the sourcing cursors point into the WRONG search —
    // compare against the current row, then restart Apollo pagination from
    // page 1, drop the Clay search id (a fresh search is created next run),
    // and clear both exhausted-at flags (migration 019) since a new ICP may
    // well have matches the old one didn't.
    const { rows: currentRows } = await db.query(
      'SELECT icp_industries, icp_locations, icp_titles, icp_min_fleet_size FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (currentRows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const current = currentRows[0];
    const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    const icpChanged =
      !sameList(icp_industries, current.icp_industries) ||
      !sameList(icp_locations, current.icp_locations) ||
      !sameList(icp_titles, current.icp_titles) ||
      (icp_min_fleet_size != null && icp_min_fleet_size !== current.icp_min_fleet_size);

    const { rows } = await db.query(
      `UPDATE campaigns
       SET name = $1,
           icp_industries = $2,
           icp_locations = $3,
           icp_titles = $4,
           icp_min_fleet_size = COALESCE($5, icp_min_fleet_size),
           instantly_campaign_id = $6,
           aimfox_campaign_id = CASE WHEN $7 THEN $8 ELSE aimfox_campaign_id END,
           auto_replenish = COALESCE($9, auto_replenish),
           replenish_threshold = COALESCE($10, replenish_threshold),
           apollo_page = CASE WHEN $11 THEN 1 ELSE apollo_page END,
           clay_search_id = CASE WHEN $11 THEN NULL ELSE clay_search_id END,
           lead_source = COALESCE($12, lead_source),
           fallback_source_enabled = COALESCE($13, fallback_source_enabled),
           apollo_exhausted_at = CASE WHEN $11 THEN NULL ELSE apollo_exhausted_at END,
           clay_exhausted_at = CASE WHEN $11 THEN NULL ELSE clay_exhausted_at END
       WHERE id = $14
       RETURNING *`,
      [
        name,
        icp_industries ?? null,
        icp_locations ?? null,
        icp_titles ?? null,
        icp_min_fleet_size ?? null,
        instantly_campaign_id || null,
        // Only touch aimfox_campaign_id when the field was actually sent —
        // clients that predate it (the current Edit modal) must not wipe it.
        aimfox_campaign_id !== undefined,
        aimfox_campaign_id || null,
        auto_replenish ?? null,
        replenish_threshold ?? null,
        icpChanged,
        lead_source ?? null,
        fallback_source_enabled ?? null,
        req.params.id,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Statuses the UI may set directly. 'completed' exists in the schema but is
// reserved for future automation, not manual toggling.
const SETTABLE_STATUSES = ['draft', 'active', 'paused'];

// PATCH /api/campaigns/:id/status — activate/pause a campaign. Only 'active'
// campaigns are picked up by the hourly jobs (leadReplenisher sourcing,
// leadProcessor scoring/drafting), so this is the master on/off switch for a
// campaign's automation.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!SETTABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `\`status\` must be one of ${SETTABLE_STATUSES.join(', ')}`,
      });
    }

    const { rows } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/find-leads — source leads from Apollo for this
// campaign. Walks pages from the campaign's apollo_page cursor until `target`
// leads are inserted (default 25, capped by maxPages) — see findLeadsForCampaign.
router.post('/:id/find-leads', async (req, res, next) => {
  try {
    const { target, maxPages } = req.body || {};
    if (target !== undefined && (!Number.isInteger(target) || target < 1)) {
      return res.status(400).json({ error: '`target` must be a positive integer' });
    }
    if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
      return res.status(400).json({ error: '`maxPages` must be a positive integer' });
    }
    const summary = await findLeadsForCampaign(req.params.id, { target, maxPages });
    res.json(summary);
  } catch (err) {
    // Surface a not-found campaign as a 404 rather than a generic 500.
    if (/not found/i.test(err.message)) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/campaigns/:id/apollo-search — run an ad-hoc Apollo People Search
// with operator-supplied criteria (titles, industries, locations, min company
// size) and return the matched candidates WITHOUT saving them. The Campaigns
// page previews these so the operator can pick which to import via /import-leads.
// Note: Apollo's search returns preview records — names may be masked and emails
// are locked until enrichment (see CLAUDE.md → Lead Sourcing).
router.post('/:id/apollo-search', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { titles, industries, locations, minCompanySize, perPage } = req.body || {};
    const icp = {
      titles: Array.isArray(titles) ? titles : [],
      industries: Array.isArray(industries) ? industries : [],
      locations: Array.isArray(locations) ? locations : [],
      minCompanySize: minCompanySize ?? null,
    };

    // This is a PREVIEW endpoint: surface candidates so the operator can pick
    // which to import. Do NOT enrich here. Enrichment (bulk_match) spends an
    // Apollo credit per contact on every ad-hoc search AND drops any candidate
    // without `has_email` or that bulk_match can't resolve — which surfaces as
    // "No matches found" even when Apollo did return people. Previews keep
    // masked names / locked emails by design; enrichment happens at import time.
    const leads = await apollo.findLeads(icp, {
      perPage: Number(perPage) || 100,
      enrich: false,
    });

    res.json({ found: leads.length, leads });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/import-leads — save a chosen set of leads (selected
// from an Apollo search preview) into this campaign. Each goes through the
// shared saveLeadIfNew (blacklist + dedupe + insert) so the rules match every
// other source, and the campaign's total_leads counter is bumped by however
// many were actually inserted.
router.post('/:id/import-leads', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { leads } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: '`leads` must be a non-empty array' });
    }

    // The search preview returns un-enriched leads (masked names / locked
    // emails). Now that the operator has chosen which to keep, resolve those
    // selections into real contacts via bulk_match before saving. This spends
    // Apollo credits — one per selected contact that has an email to reveal —
    // but only for the leads actually picked. Un-enrichable leads pass through
    // unchanged so nothing the operator selected is dropped.
    const enrichedLeads = await apollo.enrichLeads(leads);

    const summary = {
      received: leads.length,
      inserted: 0,
      duplicates: 0,
      blacklisted: 0,
      skipped: 0,
    };

    for (const lead of enrichedLeads) {
      const { status } = await saveLeadIfNew(id, lead);
      if (status === 'inserted') summary.inserted += 1;
      else if (status === 'duplicate') summary.duplicates += 1;
      else if (status === 'blacklisted') summary.blacklisted += 1;
      else summary.skipped += 1;
    }

    await incrementCampaignLeads(id, summary.inserted);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/launch-clay — kick off Clay lead sourcing for this
// campaign's ICP. FIRE-AND-FORGET: triggerLeadSourcing pushes the ICP into the
// Clay table's inbound webhook and returns Clay's acknowledgement immediately;
// Clay enriches asynchronously (minutes) and POSTs each result back to our
// /api/webhooks/clay callback, which inserts leads attributed to this campaign.
router.post('/:id/launch-clay', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    const campaign = rows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const icp = {
      industries: campaign.icp_industries ?? [],
      locations: campaign.icp_locations ?? [],
      titles: campaign.icp_titles ?? [],
      minCompanySize: campaign.icp_min_fleet_size ?? null,
    };

    const result = await clay.triggerLeadSourcing(icp, {
      extra: { campaign_id: campaign.id },
    });

    res.json({ launched: true, campaign_id: campaign.id, clay: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/upload-csv — import leads from an uploaded CSV file
// (multipart form field `file`). Runs the same importer as the CLI script:
// map columns → blacklist + dedupe + insert → backfill missing emails. Returns
// the import summary { total, inserted, updated, duplicates, blacklisted, skipped }.
router.post('/:id/upload-csv', uploadCsv, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded (expected form field `file`)' });
    }

    let summary;
    try {
      summary = await importLeadsFromCsv(req.file.buffer.toString('utf8'), Number(req.params.id));
    } catch (err) {
      // A malformed CSV is a client input problem, not a server fault.
      return res.status(400).json({ error: `Failed to import CSV: ${err.message}` });
    }

    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/process-leads — score + draft 'new' leads for this
// campaign. Runs in the BACKGROUND: responds 202 immediately, then processes at
// most MAX_LEADS_PER_REQUEST leads (batches of 10, 100ms gap between Anthropic
// calls). Poll GET /process-status for progress and completion.
router.post('/:id/process-leads', async (req, res, next) => {
  try {
    const id = req.params.id;

    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (processingCampaigns.has(id)) {
      return res.status(202).json({ status: 'already_processing', campaign_id: Number(id) });
    }

    processingCampaigns.add(id);
    // Fire-and-forget: do NOT await. Clear the in-flight flag when it settles.
    processCampaignLeads(id, { limit: MAX_LEADS_PER_REQUEST, batchSize: 10, delayMs: 100 })
      // Ledger the manual run so the Campaigns page "Last run" shows it and
      // it counts against the leadProcessor's daily budget.
      .then((result) => recordProcessRun('manual_process', id, result))
      .catch((err) => {
        console.error(`[process-leads] campaign ${id} failed:`, err.message);
      })
      .finally(() => {
        processingCampaigns.delete(id);
      });

    res.status(202).json({ status: 'processing_started', campaign_id: Number(id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/process-status — current new vs drafted lead counts for
// this campaign, plus whether a background process-leads run is still in flight.
// The Campaigns page polls this until `processing` is false.
router.get('/:id/process-status', async (req, res, next) => {
  try {
    const id = req.params.id;

    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'new')     AS new_count,
         COUNT(*) FILTER (WHERE status = 'drafted') AS drafted_count,
         COUNT(*) FILTER (WHERE status = 'sent')    AS sent_count
       FROM leads
       WHERE campaign_id = $1`,
      [id]
    );

    res.json({
      campaign_id: Number(id),
      processing: processingCampaigns.has(id),
      new: Number(rows[0].new_count),
      drafted: Number(rows[0].drafted_count),
      sent: Number(rows[0].sent_count),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaigns/:id/low-scores — delete this campaign's leads whose most
// recent score is below 50. Leads that were never scored are left alone (a NULL
// score is not "< 50"). FK cascades remove each deleted lead's scores, emails,
// and sequences. Runs in a transaction so the total_leads counter stays in sync.
router.delete('/:id/low-scores', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: campaignRows } = await client.query(
      'SELECT id FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (campaignRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: deleted } = await client.query(
      `DELETE FROM leads l
       WHERE l.campaign_id = $1
         AND (
           SELECT s.score
           FROM scores s
           WHERE s.lead_id = l.id
           ORDER BY s.created_at DESC
           LIMIT 1
         ) < 50
       RETURNING l.id`,
      [req.params.id]
    );

    if (deleted.length > 0) {
      await client.query(
        'UPDATE campaigns SET total_leads = GREATEST(0, total_leads - $1) WHERE id = $2',
        [deleted.length, req.params.id]
      );
    }

    await client.query('COMMIT');
    res.json({ deleted: deleted.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/campaigns/:id — delete a campaign and everything attached to it.
// The FK constraints handle the cascade: deleting the campaign removes its leads
// (ON DELETE CASCADE), which in turn removes their scores, emails, and sequences;
// events are detached (lead_id set NULL) per the schema.
router.delete('/:id', async (req, res, next) => {
  try {
    // RETURNING gives us the (now-deleted) campaign's instantly_campaign_id so we
    // can mirror the deletion in Instantly.
    const { rows } = await db.query(
      'DELETE FROM campaigns WHERE id = $1 RETURNING instantly_campaign_id',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Mirror the deletion in Instantly. Best-effort: a failure here must NOT
    // block the local delete (already committed) — log it and still return 204.
    const instantlyCampaignId = rows[0].instantly_campaign_id;
    if (instantlyCampaignId && process.env.INSTANTLY_API_KEY) {
      try {
        await instantly.deleteCampaign(instantlyCampaignId);
      } catch (err) {
        console.error(
          `[campaigns] Instantly campaign deletion failed for ${instantlyCampaignId}:`,
          err.message
        );
      }
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
