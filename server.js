/**
 * server.js — Lead Router
 *
 * Routes:
 *   POST /route-lead              → public: assign a lead to an advisor
 *   GET  /advisors                → admin: list all advisors
 *   POST /advisors                → admin: create advisor
 *   POST /advisors/update         → admin: update advisor fields
 *   POST /advisors/set-counts     → admin: set appointment counts
 *   POST /advisors/toggle-active  → admin: pause / unpause
 *   DELETE /advisors/:id          → admin: delete advisor
 *   GET  /admin                   → admin dashboard UI
 *   GET  /health                  → liveness check
 *
 * All /advisors routes require the X-Admin-Key header.
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const app      = express();
const adminAuth                  = require('./src/middleware/adminAuth');
const { legacyRoutingEnabled }   = require('./src/legacyRouting');
const { syncMetaAdsToAirtable }  = require('./src/jobs/metaSync');
const { syncMetaSpendToAirtable } = require('./src/jobs/metaSpendSync');
const { syncWeeklyMetrics }       = require('./src/jobs/metricsSync');
const { createInFlightTracker, createGracefulShutdown } = require('./src/gracefulShutdown');
const { createZoomRouter }        = require('./src/routes/zoom');

const transcriptTracker = createInFlightTracker();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ────────────────────────────────────────────────────────────
// /route-lead is called from external pages (GHL) so it needs CORS open.
// /advisors is admin-only and stays locked down by the X-Admin-Key header.
app.use('/route-lead',    cors(), require('./src/routes/leads'));
app.use('/advisors',     require('./src/routes/advisors'));
app.use('/zoom-webhook', createZoomRouter({ transcriptTracker }));
app.use('/fallback-use', require('./src/routes/fallbackMarker').createFallbackMarkerRouter());

// ── Admin UI — clean URL ───────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// ── Meta Ads sync — POST /admin/sync-meta-ads ─────────────────────────────
// Trigger manually, or point a cron service at this endpoint hourly.
// Requires X-Admin-Key header.
app.post('/admin/sync-meta-ads', adminAuth, async (req, res) => {
  try {
    const result = await syncMetaAdsToAirtable();
    res.json(result);
  } catch (err) {
    console.error('[meta-sync] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Meta spend sync — POST /admin/sync-meta-spend ────────────────────────
// Run on Tuesday around 2PM to populate Spend fields on current week's rows.
// Also triggers weekly metrics calculation after spend is written.
// Requires X-Admin-Key header.
app.post('/admin/sync-meta-spend', adminAuth, async (req, res) => {
  try {
    const spendResult   = await syncMetaSpendToAirtable();
    const metricsResult = await syncWeeklyMetrics();
    res.json({ spend: spendResult, metrics: metricsResult });
  } catch (err) {
    console.error('[spend-sync] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Weekly metrics sync — POST /admin/sync-metrics ───────────────────────
// Recalculates and upserts the current cycle's row in Weekly Metrics.
// Can be run any time to refresh metrics without re-running spend sync.
// Requires X-Admin-Key header.
app.post('/admin/sync-metrics', adminAuth, async (req, res) => {
  try {
    const result = await syncWeeklyMetrics();
    res.json(result);
  } catch (err) {
    console.error('[metrics-sync] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  legacyRoutingEnabled: legacyRoutingEnabled(),
  renderGitCommit: process.env.RENDER_GIT_COMMIT || null,
  inFlightTranscriptWork: transcriptTracker.getCount(),
}));

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Lead router  →  http://localhost:${PORT}`);
  console.log(`Admin UI     →  http://localhost:${PORT}/admin`);
  console.log(`GHL embed    →  http://localhost:${PORT}/ghl-embed.js`);
});

const shutdown = createGracefulShutdown({
  server,
  tracker: transcriptTracker,
  // Render sends SIGTERM and allows 30 seconds before killing the process.
  timeoutMs: 25_000,
});
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
