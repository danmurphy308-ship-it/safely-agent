const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { requireAuth } = require('./src/middleware/auth');
const healthRouter = require('./src/routes/health');
const authRouter = require('./src/routes/auth');
const campaignsRouter = require('./src/routes/campaigns');
const leadsRouter = require('./src/routes/leads');
const callListRouter = require('./src/routes/callList');
const emailsRouter = require('./src/routes/emails');
const repliesRouter = require('./src/routes/replies');
const instantlyRouter = require('./src/routes/instantly');
const aimfoxRouter = require('./src/routes/aimfox');
const funnelRouter = require('./src/routes/funnel');
const dashboardRouter = require('./src/routes/dashboard');
const statusRouter = require('./src/routes/status');
const settingsRouter = require('./src/routes/settings');
const webhooksRouter = require('./src/routes/webhooks');
const chatRouter = require('./src/routes/chat');
const { startSequenceRunner, runDueSequences } = require('./src/jobs/sequenceRunner');
const { startLeadProcessor, runNewLeads } = require('./src/jobs/leadProcessor');
const { startLeadReplenisher, replenishCampaigns } = require('./src/jobs/leadReplenisher');
const { startHeygenPoller, runHeygenPoll } = require('./src/jobs/heygenPoller');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET));

// Session auth for every /api/* route except /api/health, /api/webhooks/*,
// and /api/auth/login (see src/middleware/auth.js). Non-/api requests (the
// SPA shell, static assets) pass through untouched.
app.use(requireAuth);

// Routes
app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/call-list', callListRouter);
app.use('/api/emails', emailsRouter);
app.use('/api/replies', repliesRouter);
app.use('/api/instantly', instantlyRouter);
app.use('/api/aimfox', aimfoxRouter);
app.use('/api/funnel', funnelRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/status', statusRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/chat', chatRouter);

// Lightweight health check used by uptime monitors and the keep-alive self-ping.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// In production, serve the built React app (client/dist) and let client-side
// routing handle non-API paths. In dev, Vite serves the frontend separately.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, 'client', 'dist');
  app.use(express.static(clientDist));

  // SPA fallback: any non-API GET route returns index.html so React Router can
  // resolve it. API/health misses fall through to the JSON 404 handler below.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path === '/health') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({ name: 'safely-agent', status: 'ok' });
  });
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Keep the Fly machine warm so the hourly leadProcessor and sequenceRunner
// jobs run reliably. Fly auto-stops a machine when its proxy sees no incoming
// traffic, so the ping MUST go through the public hostname (FLY_APP_NAME) — a
// localhost ping bypasses the proxy and would not reset the idle timer.
// NOTE: this only prevents an already-running machine from stopping; it cannot
// restart a machine that has already stopped. For a hard guarantee, set
// min_machines_running = 1 (and auto_stop_machines = 'off') in fly.toml.
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;

function startKeepAlive() {
  const url =
    process.env.KEEPALIVE_URL ||
    (process.env.FLY_APP_NAME
      ? `https://${process.env.FLY_APP_NAME}.fly.dev/api/health`
      : null);

  if (!url) {
    console.log('[keepAlive] FLY_APP_NAME/KEEPALIVE_URL not set — self-ping disabled');
    return;
  }

  setInterval(async () => {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        console.warn(`[keepAlive] ping ${url} returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[keepAlive] ping failed: ${err.message}`);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  console.log(`[keepAlive] self-ping every 4m → ${url}`);
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);

  // Keep the machine warm for the hourly background jobs.
  startKeepAlive();
  // Send due sequence follow-ups every hour, plus once now to catch up on any
  // that came due while we were down/deploying.
  startSequenceRunner();
  runDueSequences().catch((err) =>
    console.error('[sequenceRunner] initial run failed:', err.message)
  );

  // Score & draft new leads every hour, plus once now to catch up on any that
  // arrived while we were down/deploying.
  startLeadProcessor();
  runNewLeads().catch((err) =>
    console.error('[leadProcessor] initial run failed:', err.message)
  );

  // Top up low campaign pipelines from Apollo every hour, plus once now.
  // Opt-in per campaign (auto_replenish) with a 24h per-campaign cooldown.
  startLeadReplenisher();
  replenishCampaigns().catch((err) =>
    console.error('[leadReplenisher] initial run failed:', err.message)
  );

  // Poll HeyGen for pending personalized videos (leads scoring 85+) every 2
  // minutes — much shorter than the hourly jobs, since sendSequenceEmail's
  // 15-minute hold needs finer-grained checking. No-op when HEYGEN_API_KEY is
  // unset (runHeygenPoll just finds nothing to poll).
  startHeygenPoller();
  runHeygenPoll().catch((err) => console.error('[heygenPoller] initial run failed:', err.message));
});

module.exports = app;
