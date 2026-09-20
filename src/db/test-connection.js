// Quick connectivity check: connects using DATABASE_URL from .env and runs
// SELECT NOW() to confirm the database is reachable.
//
// Usage: node src/db/test-connection.js   (or: npm run db:test)

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    const { rows } = await client.query('SELECT NOW() AS now');
    console.log('✅ Connected. Server time:', rows[0].now);
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
