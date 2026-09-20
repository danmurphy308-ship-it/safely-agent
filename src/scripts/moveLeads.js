// Move leads from one campaign to another by reassigning their campaign_id.
//
// Selects up to <limit> leads from the source campaign (lowest id first) and
// reassigns them to the target campaign in a single transaction. The campaign
// total_leads counters are adjusted to match so stats stay consistent.
//
// Usage:
//   node src/scripts/moveLeads.js <source_campaign_id> <target_campaign_id> <limit>
//   npm run move:leads -- <source_campaign_id> <target_campaign_id> <limit>
//
// Example:
//   node src/scripts/moveLeads.js 1 2 50   (move 50 leads from campaign 1 to 2)

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../config/db');

function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid ${name}: ${value ?? '(missing)'} (must be a positive integer)`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const [sourceArg, targetArg, limitArg] = process.argv.slice(2);

  if (sourceArg === undefined || targetArg === undefined || limitArg === undefined) {
    console.error(
      'Usage: node src/scripts/moveLeads.js <source_campaign_id> <target_campaign_id> <limit>'
    );
    process.exit(1);
  }

  const sourceId = parsePositiveInt(sourceArg, 'source_campaign_id');
  const targetId = parsePositiveInt(targetArg, 'target_campaign_id');
  const limit = parsePositiveInt(limitArg, 'limit');

  if (sourceId === targetId) {
    console.error('source_campaign_id and target_campaign_id must be different.');
    process.exit(1);
  }

  // Verify both campaigns exist up front for a clear error (instead of a raw
  // foreign-key violation on the UPDATE).
  const { rows: campaigns } = await db.query(
    'SELECT id FROM campaigns WHERE id = ANY($1)',
    [[sourceId, targetId]]
  );
  const found = new Set(campaigns.map((c) => c.id));
  if (!found.has(sourceId)) {
    console.error(`Source campaign ${sourceId} not found.`);
    process.exit(1);
  }
  if (!found.has(targetId)) {
    console.error(`Target campaign ${targetId} not found.`);
    process.exit(1);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Reassign the lowest-id leads from source → target. The subquery picks the
    // exact rows; LIMIT bounds how many move.
    const { rows: moved } = await client.query(
      `UPDATE leads
         SET campaign_id = $2
       WHERE id IN (
         SELECT id FROM leads
         WHERE campaign_id = $1
         ORDER BY id
         LIMIT $3
       )
       RETURNING id`,
      [sourceId, targetId, limit]
    );

    const count = moved.length;

    // Keep the campaigns' total_leads counters in sync with the move.
    if (count > 0) {
      await client.query(
        'UPDATE campaigns SET total_leads = GREATEST(total_leads - $1, 0) WHERE id = $2',
        [count, sourceId]
      );
      await client.query(
        'UPDATE campaigns SET total_leads = total_leads + $1 WHERE id = $2',
        [count, targetId]
      );
    }

    await client.query('COMMIT');

    if (count === 0) {
      console.log(`No leads found in campaign ${sourceId}. Nothing moved.`);
    } else {
      console.log(`Moved ${count} lead(s) from campaign ${sourceId} → ${targetId}.`);
      if (count < limit) {
        console.log(`(Requested ${limit}, but only ${count} were available.)`);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await db.pool.end();
}

main().catch(async (err) => {
  console.error('\nMove failed:', err.message);
  try {
    await db.pool.end();
  } catch (_) {
    // ignore pool shutdown errors during failure path
  }
  process.exit(1);
});
