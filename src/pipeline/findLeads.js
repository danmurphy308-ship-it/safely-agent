const db = require('../config/db');
const apollo = require('../integrations/apollo');
const clay = require('../integrations/clay');
const { isBlacklisted } = require('../services/blacklist');
const { checkExistingCustomer } = require('../services/customerCheck');
const { verifyEmailWithRetry } = require('../services/emailVerification');

// Target-driven sourcing defaults: keep fetching pages until this many leads
// actually make it into the DB, bounded by a per-run page cap (each page's
// enrichment spends Apollo credits on every has_email preview it contains).
const DEFAULT_TARGET = 25;
const DEFAULT_MAX_PAGES = 4;

// Source-fallback chain (migration 019, opt-in via fallback_source_enabled):
// when the primary provider is exhausted, the secondary gets its own smaller
// page budget rather than the full maxPages allowance, so a fallback leg
// can't double a run's credit spend.
const FALLBACK_MAX_PAGES = 2;

const OTHER_PROVIDER = { apollo: 'clay', clay: 'apollo' };
const EXHAUSTED_COLUMN = { apollo: 'apollo_exhausted_at', clay: 'clay_exhausted_at' };

function providerConfigured(provider) {
  return provider === 'clay' ? clay.isPublicApiConfigured() : Boolean(process.env.APOLLO_API_KEY);
}

async function markExhausted(campaignId, provider) {
  await db.query(`UPDATE campaigns SET ${EXHAUSTED_COLUMN[provider]} = now() WHERE id = $1`, [
    campaignId,
  ]);
}

/**
 * Walk pages of ONE provider for a campaign, saving acceptable leads as it
 * goes, until `target` are inserted, `maxPages` is hit, or the provider comes
 * back empty (exhausted). Cursors (`apollo_page`/`clay_search_id`) are read
 * from and persisted onto the campaign row regardless of which provider is
 * currently walking — both columns exist on every campaign so either one can
 * serve as primary or fallback without a schema change.
 *
 * @param {number} campaignId
 * @param {('apollo'|'clay')} provider
 * @param {object} icp
 * @param {object} cursors - { page, claySearchId } — current cursor values.
 * @param {number} maxPages
 * @param {number} target
 * @param {number} perPage
 * @returns {Promise<{summary: object, cursors: object}>}
 */
async function walkProvider(campaignId, provider, icp, cursors, maxPages, target, perPage) {
  let { page, claySearchId } = cursors;

  const summary = {
    found: 0,
    blacklisted: 0,
    duplicates: 0,
    inserted: 0,
    pages: 0,
    exhausted: false,
    leads: [],
  };

  while (summary.pages < maxPages && summary.inserted < target) {
    let candidates;
    if (provider === 'clay') {
      candidates = await clay.findLeads(icp, { searchId: claySearchId, perPage });
      // Persist the search id as soon as Clay mints one — it IS the cursor,
      // so losing it would restart the walk from the beginning next run.
      if (candidates.searchId && candidates.searchId !== claySearchId) {
        claySearchId = candidates.searchId;
        await db.query('UPDATE campaigns SET clay_search_id = $1 WHERE id = $2', [
          claySearchId,
          campaignId,
        ]);
      }
    } else if (page * perPage > apollo.MAX_PAGINATION_OFFSET) {
      // Guard: don't even call Apollo once the cursor has drifted past its
      // pagination ceiling — it 422s rather than returning an empty page (see
      // the catch below), and there's no point spending the request to find
      // that out again once we already know.
      console.warn(
        `[findLeads] campaign ${campaignId}: apollo page ${page} (offset ${page * perPage}) is ` +
          `past Apollo's ${apollo.MAX_PAGINATION_OFFSET} pagination ceiling — treating as exhausted`
      );
      candidates = [];
    } else {
      try {
        candidates = await apollo.findLeads(icp, { page, perPage });
      } catch (err) {
        if (!err.isPageThresholdError) throw err;
        // Apollo 422s past its offset ceiling instead of returning an empty
        // page — treat it exactly like one rather than letting it crash the
        // run (and, with fallback_source_enabled, skip straight past it).
        console.warn(
          `[findLeads] campaign ${campaignId}: apollo page ${page} hit its pagination ceiling ` +
            `(${err.message}) — treating as exhausted`
        );
        candidates = [];
      }
    }
    summary.pages += 1;

    // Empty page: the provider has no more people for this ICP right now.
    // Leave the cursor where it is so a later run (or an ICP tweak, which
    // resets it) retries from here rather than pointlessly walking further.
    if (candidates.length === 0) {
      summary.exhausted = true;
      break;
    }

    summary.found += candidates.length;
    // The page's enrichment credits are already spent — save everything
    // usable from it even once the target is reached.
    for (const lead of candidates) {
      const { status, lead: inserted } = await saveLeadIfNew(campaignId, lead);
      if (status === 'blacklisted') summary.blacklisted += 1;
      else if (status === 'duplicate') summary.duplicates += 1;
      else if (status === 'inserted') {
        summary.inserted += 1;
        summary.leads.push(inserted);
      }
    }

    if (provider === 'clay') {
      // Clay's iterator advanced server-side; nothing further to persist.
      // has_more:false means the search is drained — a fresh run needs a new
      // search, which happens automatically once the ICP changes (cursor
      // reset) or can be forced by clearing clay_search_id.
      if (!candidates.hasMore) {
        summary.exhausted = true;
        break;
      }
    } else {
      // Persist the cursor page-by-page so a crashed/interrupted run never
      // re-fetches pages it already consumed.
      page += 1;
      await db.query('UPDATE campaigns SET apollo_page = $1 WHERE id = $2', [page, campaignId]);
    }
  }

  return { summary, cursors: { page, claySearchId } };
}

/**
 * Find leads for a campaign and save the new ones, fetching as many provider
 * pages as it takes (up to `maxPages`) to INSERT `target` acceptable leads —
 * not merely to fetch them. Most of a page is typically lost to missing
 * emails, blacklist/HubSpot hits, and duplicates, so a single fixed-size fetch
 * under-delivers badly.
 *
 * The PRIMARY provider comes from the campaign's `lead_source` ('apollo' |
 * 'clay'):
 *
 * - Apollo pages by number: the campaign's `apollo_page` cursor picks up where
 *   the last run stopped and is persisted after every fetched page, so repeat
 *   runs (manual or the auto-replenisher) see fresh people instead of
 *   re-buying page 1.
 * - Clay pages via a stateful server-side search iterator: the campaign's
 *   `clay_search_id` is the cursor. It's created on first use, persisted, and
 *   every fetch advances it on Clay's side (a crashed run can skip, never
 *   repeat, records). `has_more: false` marks the ICP exhausted.
 *
 * Both cursors reset when the ICP targeting changes (PUT /api/campaigns/:id).
 *
 * SOURCE-FALLBACK CHAIN (migration 019, opt-in via `fallback_source_enabled`):
 * when the primary provider is exhausted — either just now, or already marked
 * exhausted by a previous run (skipped here to avoid a wasted, near-certainly-
 * empty call) — and the target isn't yet met, the OTHER provider gets a
 * bounded follow-up walk (`FALLBACK_MAX_PAGES`, further capped by whatever's
 * left of `maxPages`) using the same ICP and its own cursor. Both
 * `apollo_exhausted_at`/`clay_exhausted_at` are stamped the moment their
 * provider comes back empty, and — v1 — only cleared by an ICP edit, same
 * trigger as the cursor reset above; a time-based re-check is a future
 * enhancement, not built here.
 *
 * @param {number} campaignId
 * @param {object} [options]
 * @param {number} [options.target=25]   - Stop once this many leads are inserted.
 * @param {number} [options.maxPages=4]  - Max provider pages fetched this run.
 * @param {number} [options.perPage]     - Records per page; defaults to 2x target
 *   (clamped 10..100) so credit spend scales with what's actually needed.
 * @returns {Promise<{found:number, blacklisted:number, duplicates:number,
 *   inserted:number, pages:number, exhausted:boolean, leads:object[],
 *   primaryProvider:string, fallbackProvider:(string|null),
 *   fallbackUsed:boolean}>}
 */
async function findLeadsForCampaign(campaignId, options = {}) {
  if (campaignId == null) {
    throw new Error('findLeadsForCampaign: `campaignId` is required');
  }

  const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  const campaign = rows[0];
  if (!campaign) {
    throw new Error(`findLeadsForCampaign: campaign ${campaignId} not found`);
  }

  const icp = {
    industries: campaign.icp_industries ?? [],
    locations: campaign.icp_locations ?? [],
    titles: campaign.icp_titles ?? [],
    minCompanySize: campaign.icp_min_fleet_size ?? null,
  };

  const target = Math.max(1, Number(options.target) || DEFAULT_TARGET);
  const maxPages = Math.max(1, Number(options.maxPages) || DEFAULT_MAX_PAGES);
  const perPage = Number(options.perPage) || Math.min(100, Math.max(10, target * 2));

  const primary = campaign.lead_source === 'clay' ? 'clay' : 'apollo';
  const secondary = OTHER_PROVIDER[primary];
  let cursors = {
    page: Math.max(1, campaign.apollo_page ?? 1),
    claySearchId: campaign.clay_search_id || null,
  };

  const summary = {
    found: 0,
    blacklisted: 0,
    duplicates: 0,
    inserted: 0,
    pages: 0,
    exhausted: false,
    leads: [],
    primaryProvider: primary,
    fallbackProvider: null,
    fallbackUsed: false,
  };

  const primaryAlreadyExhausted = Boolean(campaign[EXHAUSTED_COLUMN[primary]]);
  let primaryExhausted = primaryAlreadyExhausted;

  if (primaryAlreadyExhausted) {
    summary.exhausted = true;
    console.log(
      `[findLeads] campaign ${campaignId}: ${primary} already marked exhausted for this ICP — ` +
        'skipping straight to fallback check'
    );
  } else {
    const primaryRun = await walkProvider(campaignId, primary, icp, cursors, maxPages, target, perPage);
    cursors = primaryRun.cursors;
    Object.assign(summary, {
      found: primaryRun.summary.found,
      blacklisted: primaryRun.summary.blacklisted,
      duplicates: primaryRun.summary.duplicates,
      inserted: primaryRun.summary.inserted,
      pages: primaryRun.summary.pages,
      exhausted: primaryRun.summary.exhausted,
      leads: primaryRun.summary.leads,
    });
    primaryExhausted = primaryRun.summary.exhausted;
    if (primaryExhausted) await markExhausted(campaignId, primary);
  }

  const remainingTarget = target - summary.inserted;
  const remainingPageBudget = maxPages - summary.pages;
  const secondaryAlreadyExhausted = Boolean(campaign[EXHAUSTED_COLUMN[secondary]]);

  const fallbackEligible =
    primaryExhausted &&
    campaign.fallback_source_enabled &&
    remainingTarget > 0 &&
    remainingPageBudget > 0 &&
    !secondaryAlreadyExhausted &&
    providerConfigured(secondary);

  if (fallbackEligible) {
    const fallbackMaxPages = Math.min(remainingPageBudget, FALLBACK_MAX_PAGES);
    console.log(
      `[findLeads] campaign ${campaignId}: ${primary} exhausted, fallback_source_enabled — ` +
        `trying ${secondary} for up to ${fallbackMaxPages} page(s)`
    );
    const fallbackRun = await walkProvider(
      campaignId,
      secondary,
      icp,
      cursors,
      fallbackMaxPages,
      remainingTarget,
      perPage
    );
    summary.found += fallbackRun.summary.found;
    summary.blacklisted += fallbackRun.summary.blacklisted;
    summary.duplicates += fallbackRun.summary.duplicates;
    summary.inserted += fallbackRun.summary.inserted;
    summary.pages += fallbackRun.summary.pages;
    summary.leads = summary.leads.concat(fallbackRun.summary.leads);
    summary.fallbackProvider = secondary;
    summary.fallbackUsed = true;
    // The fallback leg is the last one attempted this run — its exhaustion
    // (or lack of it) is the more useful "is there really nothing left"
    // signal than the primary's, which we already know ran dry.
    summary.exhausted = fallbackRun.summary.exhausted;
    if (fallbackRun.summary.exhausted) await markExhausted(campaignId, secondary);
    console.log(
      `[findLeads] campaign ${campaignId}: fallback (${secondary}) found ${fallbackRun.summary.found}, ` +
        `inserted ${fallbackRun.summary.inserted}${fallbackRun.summary.exhausted ? ' — also exhausted' : ''}`
    );
  } else if (primaryExhausted && campaign.fallback_source_enabled) {
    const why = !providerConfigured(secondary)
      ? `${secondary} is not configured`
      : secondaryAlreadyExhausted
        ? `${secondary} is also marked exhausted`
        : remainingPageBudget <= 0
          ? 'no page budget left this run'
          : 'target already met';
    console.log(`[findLeads] campaign ${campaignId}: ${primary} exhausted, fallback unavailable (${why})`);
  }

  // Keep the campaign's lead counter in sync with what we just inserted.
  await incrementCampaignLeads(campaignId, summary.inserted);

  return summary;
}

/**
 * Save a single lead for a campaign if it isn't blacklisted, a duplicate, or
 * missing a company name. Shared by the Apollo pipeline, both Clay paths
 * (Public API search and the legacy webhook), and CSV import, so the
 * blacklist + dedupe rules — and now email verification — stay identical
 * across every source.
 *
 * @param {number|null} campaignId
 * @param {object} lead - A lead already shaped for the `leads` table.
 * @returns {Promise<{status:('inserted'|'blacklisted'|'duplicate'|'skipped'), lead?:object}>}
 */
async function saveLeadIfNew(campaignId, lead) {
  // leads.company_name is NOT NULL — nothing to insert without it.
  if (!lead || !lead.company_name) return { status: 'skipped' };

  if (await isBlacklisted(lead.contact_email, lead.company_domain, lead.contact_linkedin)) {
    return { status: 'blacklisted' };
  }
  // Never save existing Safely/Transpoco relationships (Critical Rule). A hit
  // is persisted to the blacklist by checkExistingCustomer, so it reports as
  // 'blacklisted'. Fail OPEN on a HubSpot API error — sourcing must not stall
  // on a HubSpot outage; the send-time gate in sendSequenceEmail fails closed.
  try {
    const { existing } = await checkExistingCustomer(lead);
    if (existing) return { status: 'blacklisted' };
  } catch (err) {
    console.error('[findLeads] HubSpot customer check failed (saving anyway):', err.message);
  }
  if (await isDuplicate(lead)) {
    return { status: 'duplicate' };
  }

  const inserted = await insertLead(campaignId, lead);
  await verifyInsertedLeadEmail(inserted);
  return { status: 'inserted', lead: inserted };
}

// Verify a just-inserted lead's email at IMPORT TIME, not deferred until it's
// next processed — closes the gap that let a large pre-verification-era
// backlog accumulate (leads sourced/imported long before anything ever
// checked their address, some sitting unprocessed for weeks). Only stamps
// email_verification/email_verified_at here; it does NOT deprioritise an
// invalid address or tag it linkedin-only — that decision logic stays in
// processLead (pipeline.js), which will find the value already cached the
// moment it runs and act on it immediately, however long that takes. No-op
// when there's no email to check or INSTANTLY_API_KEY isn't configured,
// matching every other optional integration in this codebase.
async function verifyInsertedLeadEmail(lead) {
  if (!lead?.contact_email || !process.env.INSTANTLY_API_KEY) return;

  const result = await verifyEmailWithRetry(lead.contact_email, { leadId: lead.id });
  if (result === null) return; // fails open — stays NULL, re-checked by processLead later

  const { rows } = await db.query(
    `UPDATE leads SET email_verification = $2, email_verified_at = now()
     WHERE id = $1
     RETURNING email_verification, email_verified_at`,
    [lead.id, result]
  );
  lead.email_verification = rows[0].email_verification;
  lead.email_verified_at = rows[0].email_verified_at;
}

// Bump a campaign's total_leads counter by `count` (no-op for count<=0 or no campaign).
async function incrementCampaignLeads(campaignId, count) {
  if (campaignId == null || !count || count <= 0) return;
  await db.query('UPDATE campaigns SET total_leads = total_leads + $1 WHERE id = $2', [
    count,
    campaignId,
  ]);
}

// A lead is a duplicate if an existing row matches on company + contact name
// (the primary key we always have from Apollo, since emails are often locked),
// or shares its email or LinkedIn URL when those are present.
async function isDuplicate(lead) {
  const conditions = [];
  const params = [];

  // Primary check — same person at the same company, regardless of email/LinkedIn.
  if (lead.company_name && lead.contact_name) {
    params.push(lead.company_name, lead.contact_name);
    conditions.push(
      `(company_name = $${params.length - 1} AND contact_name = $${params.length})`
    );
  }
  if (lead.contact_email) {
    params.push(lead.contact_email);
    conditions.push(`contact_email = $${params.length}`);
  }
  if (lead.contact_linkedin) {
    params.push(lead.contact_linkedin);
    conditions.push(`contact_linkedin = $${params.length}`);
  }

  // No identifying fields at all — can't reliably dedupe, treat as new.
  if (conditions.length === 0) return false;

  const { rowCount } = await db.query(
    `SELECT 1 FROM leads WHERE ${conditions.join(' OR ')} LIMIT 1`,
    params
  );
  return rowCount > 0;
}

async function insertLead(campaignId, lead) {
  const { rows } = await db.query(
    `INSERT INTO leads
       (campaign_id, company_name, contact_name, contact_email, contact_title,
        contact_linkedin, company_url, company_domain, industry, fleet_size,
        country, employee_count, raw_enrichment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      campaignId,
      lead.company_name,
      lead.contact_name,
      lead.contact_email,
      lead.contact_title,
      lead.contact_linkedin,
      lead.company_url,
      lead.company_domain,
      lead.industry,
      lead.fleet_size,
      lead.country,
      lead.employee_count,
      lead.raw_enrichment ?? null,
    ]
  );
  return rows[0];
}

module.exports = {
  findLeadsForCampaign,
  saveLeadIfNew,
  incrementCampaignLeads,
  // Exported for the dashboard's exhausted-source health check
  // (src/services/campaignHealth.js) so "is the fallback usable" is computed
  // identically to how findLeadsForCampaign itself decides it.
  OTHER_PROVIDER,
  providerConfigured,
};
