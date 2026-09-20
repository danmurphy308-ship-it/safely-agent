const express = require('express');
const db = require('../config/db');
const anthropic = require('../config/anthropic');
const instantly = require('../integrations/instantly');

const router = express.Router();

// The user explicitly asked for this model for the chat assistant.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
// Bound the tool-use loop so a misbehaving turn can't call tools forever.
const MAX_TOOL_ROUNDS = 6;

// Stable system prompt (kept byte-for-byte identical for prompt caching).
const SYSTEM_PROMPT = `You are the assistant for Safely's AI SDR app — an outbound sales tool that finds leads, scores them against Safely's ICP, drafts cold emails, and sends them via Instantly to book meetings for Safely (a fleet safety product).

You help the operator understand and run their pipeline. Use the provided tools to answer questions with real data rather than guessing — call get_campaigns, get_leads_summary, and get_dashboard_stats to look things up, and create_campaign to create a new campaign when asked. You may call multiple tools before answering.

Guidelines:
- Be conversational and concise. Lead with the answer, then any supporting detail.
- Base factual claims on tool results; if a tool returns nothing, say so plainly.
- Before creating a campaign, confirm the name (and any targeting details) with the user unless they've clearly already asked you to create it.
- Format numbers readably. Don't invent campaigns, leads, or stats that the tools didn't return.`;

// Tool definitions exposed to Claude.
const TOOLS = [
  {
    name: 'get_campaigns',
    description:
      'List all outreach campaigns with their status and pipeline counts (total leads, contacted, replied, meetings). Use for any question about campaigns.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_leads_summary',
    description:
      'Summarise leads in the pipeline: total count and a breakdown by lifecycle status (new, scored, drafted, sent, replied, booked, etc.). Optionally scope to one campaign.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: {
          type: 'integer',
          description: 'Optional campaign id to scope the summary to a single campaign.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_dashboard_stats',
    description:
      'Top-line outreach performance: emails sent, open rate, replies and reply rate (from Instantly), plus meetings booked and total/active campaign counts. Use for "how are we doing" questions.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_campaign',
    description:
      'Create a new outreach campaign. Requires a name; ICP targeting (industries, locations, job titles, minimum fleet size) is optional. Creates the campaign locally and, if Instantly is configured, a matching Instantly campaign.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Campaign name.' },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target industries.',
        },
        locations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target locations, e.g. ["United Kingdom", "United States"].',
        },
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target job titles, e.g. ["Fleet Manager", "Operations Director"].',
        },
        min_fleet_size: { type: 'integer', description: 'Minimum fleet size.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────────────

async function getCampaigns() {
  const { rows } = await db.query(
    `SELECT id, name, status, total_leads, total_contacted, total_replied,
            total_meetings, instantly_campaign_id, created_at
     FROM campaigns
     ORDER BY created_at DESC`
  );
  return { count: rows.length, campaigns: rows };
}

async function getLeadsSummary(input) {
  const campaignId = input?.campaign_id;
  const params = [];
  let where = '';
  if (campaignId != null) {
    params.push(campaignId);
    where = 'WHERE campaign_id = $1';
  }
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM leads ${where} GROUP BY status ORDER BY status`,
    params
  );
  const byStatus = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = r.count;
    total += r.count;
  }
  return { campaign_id: campaignId ?? null, total, by_status: byStatus };
}

async function getDashboardStats() {
  const { rows: campaignRows } = await db.query(
    `SELECT
       COUNT(*)::int AS total_campaigns,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
       COALESCE(SUM(total_leads), 0)::int AS total_leads
     FROM campaigns`
  );
  const { rows: bookedRows } = await db.query(
    "SELECT COUNT(*)::int AS meetings_booked FROM leads WHERE status = 'booked'"
  );

  const stats = {
    total_campaigns: campaignRows[0].total_campaigns,
    active_campaigns: campaignRows[0].active_campaigns,
    total_leads: campaignRows[0].total_leads,
    meetings_booked: bookedRows[0].meetings_booked,
  };

  // Instantly analytics is best-effort — a failure here shouldn't break the tool.
  try {
    const instantlyStats = await instantly.fetchCampaignStats();
    Object.assign(stats, {
      emails_sent: instantlyStats.total_sent,
      open_rate: instantlyStats.open_rate,
      reply_count: instantlyStats.reply_count,
      reply_rate: instantlyStats.reply_rate,
    });
  } catch (err) {
    stats.instantly_error = err.message;
  }

  return stats;
}

async function createCampaign(input) {
  const name = input?.name;
  if (!name || typeof name !== 'string') {
    return { error: '`name` is required to create a campaign' };
  }

  const { rows } = await db.query(
    `INSERT INTO campaigns (name, icp_industries, icp_locations, icp_titles, icp_min_fleet_size)
     VALUES ($1, $2, $3, $4, COALESCE($5, 100))
     RETURNING id, name, status, icp_industries, icp_locations, icp_titles, icp_min_fleet_size`,
    [
      name,
      Array.isArray(input.industries) ? input.industries : null,
      Array.isArray(input.locations) ? input.locations : null,
      Array.isArray(input.titles) ? input.titles : null,
      input.min_fleet_size ?? null,
    ]
  );
  const created = rows[0];

  // Best-effort: mirror in Instantly when configured (same as the REST route).
  if (process.env.INSTANTLY_API_KEY) {
    try {
      const { id: instantlyId } = await instantly.createCampaign(created.name, {
        locations: created.icp_locations || [],
      });
      if (instantlyId) {
        await db.query('UPDATE campaigns SET instantly_campaign_id = $1 WHERE id = $2', [
          instantlyId,
          created.id,
        ]);
        created.instantly_campaign_id = instantlyId;
      }
    } catch (err) {
      console.error(
        `[chat] Instantly campaign creation failed for "${created.name}":`,
        err.message
      );
    }
  }

  return { created };
}

const TOOL_IMPLS = {
  get_campaigns: getCampaigns,
  get_leads_summary: getLeadsSummary,
  get_dashboard_stats: getDashboardStats,
  create_campaign: createCampaign,
};

async function runTool(name, input) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `unknown tool: ${name}` };
  return impl(input || {});
}

// ── Route ───────────────────────────────────────────────────────────────────

// POST /api/chat — body: { messages: [{ role: 'user'|'assistant', content: string }] }.
// Runs Claude with tool use and returns { reply: string } (the final assistant text).
router.post('/', async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '`messages` must be a non-empty array' });
    }

    // Keep only well-formed string-content user/assistant turns…
    const convo = messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim()
      )
      .map((m) => ({ role: m.role, content: m.content }));

    // …then drop any leading assistant turns (e.g. a UI greeting): the API
    // requires the conversation to start with a user message.
    while (convo.length && convo[0].role === 'assistant') convo.shift();

    if (convo.length === 0 || convo[convo.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'the last message must be from the user' });
    }

    let response;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: convo,
      });

      if (response.stop_reason !== 'tool_use') break;

      // Echo the assistant turn (with its tool_use blocks) back into the convo.
      convo.push({ role: 'assistant', content: response.content });

      // Execute every requested tool and return all results in one user turn.
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await runTool(block.name, block.input);
        } catch (err) {
          result = { error: err.message };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      convo.push({ role: 'user', content: toolResults });
    }

    const reply = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    res.json({ reply: reply || "Sorry, I couldn't put together a response." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
