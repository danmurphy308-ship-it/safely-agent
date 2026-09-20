const { Pool } = require('pg');

// Uses DATABASE_URL if provided, otherwise falls back to the standard
// PG* environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
