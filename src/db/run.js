// Applies one or more .sql files to the database via psql.
//
// Loads connection settings from .env (dotenv), then shells out to psql.
// If DATABASE_URL is set it is passed directly; otherwise psql falls back to
// the standard PG* environment variables (PGHOST, PGPORT, PGUSER, ...).
//
// Usage: node src/db/run.js <file.sql> [<file2.sql> ...]

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { spawnSync } = require('child_process');

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node src/db/run.js <file.sql> [<file2.sql> ...]');
  process.exit(1);
}

// Connection target: explicit DATABASE_URL, else rely on PG* env vars.
const connArgs = process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [];

for (const file of files) {
  const abs = path.resolve(__dirname, '..', '..', file);
  console.log(`Applying ${file} ...`);

  const result = spawnSync(
    'psql',
    [...connArgs, '-v', 'ON_ERROR_STOP=1', '-f', abs],
    { stdio: 'inherit', env: process.env }
  );

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('psql not found on PATH. Install the PostgreSQL client tools.');
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`psql exited with code ${result.status} while applying ${file}`);
    process.exit(result.status || 1);
  }
}

console.log('Done.');
