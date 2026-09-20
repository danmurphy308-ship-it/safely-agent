// Manual test: verify ONE email address via Instantly's email-verification
// API and exit.
//
// Per the project Safety Rules, this makes ONE verification call per run
// (plus up to 3 status polls if Instantly answers 'pending'). Requires
// INSTANTLY_API_KEY in .env. Run with:
//   node src/scripts/testVerifyEmail.js [email]

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { verifyEmail } = require('../integrations/instantly');

const email = process.argv[2] || 'dan.murphy@transpoco.com';

async function main() {
  if (!process.env.INSTANTLY_API_KEY) {
    console.error('INSTANTLY_API_KEY is not set in .env — cannot call Instantly.');
    process.exit(1);
  }

  console.log(`Verifying ${email} via Instantly (single call)\n`);

  // One verification only — do not loop here.
  const status = await verifyEmail(email);
  console.log(`verification_status: ${status}`);
  if (status === 'invalid') {
    console.log('\n→ this lead would be deprioritised before scoring and blocked at send.');
  } else {
    console.log('\n→ this lead would be allowed through.');
  }
}

main().catch((err) => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
