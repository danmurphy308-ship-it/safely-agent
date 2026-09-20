const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { setSessionCookie, clearSessionCookie } = require('../middleware/auth');

const router = express.Router();

// Fixed hash to compare against when the email doesn't match any user, so a
// login attempt for a non-existent address takes roughly the same time as a
// wrong-password attempt (avoids a timing side-channel revealing which
// @transpoco.com addresses are registered).
const DUMMY_HASH = '$2b$10$zcX2L3VaSk/nuZrM/yFgoOqpDx.NOpbHZ7duGcbu0CacnfoC6WLGq';

// POST /api/auth/login — the one exempt /api/auth route (see requireAuth's
// isExemptApiPath); everyone else on this router runs behind the session gate.
router.post('/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await db.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0] || null;

    const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    setSessionCookie(res, user);
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — behind requireAuth like the rest of this router;
// clearing the cookie is idempotent either way.
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — requireAuth already resolved req.user (or this route
// would never be reached, having 401'd first); this is also what the client
// polls on load to decide whether to render the app or redirect to /login.
router.get('/me', (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
});

module.exports = router;
