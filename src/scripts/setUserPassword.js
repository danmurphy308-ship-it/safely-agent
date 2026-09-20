// Set (or change) a user's password. This is the ONLY way passwords get set —
// there is no self-registration and no reset-flow endpoint. Requires the
// email to already exist in `users` (seeded by migration 018); it never
// creates a new account.
//
// Run with:
//   npm run user:set-password -- <email> <new-password>
// or directly:
//   node src/scripts/setUserPassword.js <email> <new-password>
//
// Note: the password is passed as a plain argv argument, so it lands in your
// shell history like every other script in src/scripts/ takes its arguments —
// fine for the 4 known @transpoco.com accounts this is meant for, but don't
// reuse this pattern for anything more sensitive.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const bcrypt = require('bcryptjs');
const db = require('../config/db');

const BCRYPT_ROUNDS = 10;

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const password = process.argv[3] || '';

  if (!email || !password) {
    console.error('Usage: node src/scripts/setUserPassword.js <email> <new-password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length === 0) {
    console.error(`No user with email ${email} — this script only updates existing accounts.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, hash]);

  console.log(`Password updated for ${email}.`);
}

main()
  .catch((err) => {
    console.error('setUserPassword failed:', err.message);
    process.exit(1);
  })
  .finally(() => db.pool.end());
