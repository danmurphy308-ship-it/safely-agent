const db = require('../config/db');

// Simple internal session auth: an httpOnly, signed cookie holding
// { userId, exp } as JSON — no server-side session store, no roles, no
// self-registration. cookie-parser signs/verifies it (SESSION_SECRET) and
// auto (de)serialises the JSON via its 'j:' prefix convention, so the
// payload arrives at req.signedCookies[COOKIE_NAME] as a plain object.

const COOKIE_NAME = 'session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_OPTIONS = {
  httpOnly: true,
  signed: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: THIRTY_DAYS_MS,
};

/**
 * Set the session cookie for a logged-in user.
 *
 * @param {import('express').Response} res
 * @param {{id:number}} user
 */
function setSessionCookie(res, user) {
  res.cookie(COOKIE_NAME, { userId: user.id, exp: Date.now() + THIRTY_DAYS_MS }, COOKIE_OPTIONS);
}

/**
 * Clear the session cookie (logout).
 *
 * @param {import('express').Response} res
 */
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Paths under /api that must stay reachable without a session: Instantly,
// Aimfox, and Clay all post to /api/webhooks/* on their own schedule and have
// no way to carry our session cookie; /api/health backs the keep-alive
// self-ping and uptime monitors; /api/auth/login is how a session is
// obtained in the first place. Everything NOT under /api (the SPA shell,
// static assets) is left untouched here — the React app gates itself
// client-side (see client/src/auth.jsx), redirecting to /login when
// GET /api/auth/me comes back 401.
function isExemptApiPath(path) {
  return path === '/api/health' || path === '/api/auth/login' || path.startsWith('/api/webhooks/');
}

/**
 * Require a valid session for every /api/* route except the exemptions
 * above. Non-/api requests (the SPA shell, static assets) pass through
 * untouched. On success, attaches `req.user` ({id, email, name}).
 */
async function requireAuth(req, res, next) {
  if (!req.path.startsWith('/api/') || isExemptApiPath(req.path)) {
    return next();
  }

  const session = req.signedCookies?.[COOKIE_NAME];
  if (!session || typeof session !== 'object' || !session.userId || !session.exp) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (Date.now() > session.exp) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await db.query('SELECT id, email, name FROM users WHERE id = $1', [
      session.userId,
    ]);
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, setSessionCookie, clearSessionCookie, COOKIE_NAME };
