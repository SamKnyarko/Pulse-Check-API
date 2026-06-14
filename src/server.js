'use strict';

const express = require('express');
const MonitorStore = require('./monitorStore');
const { fireAlert } = require('./alerts');

/**
 * server.js
 * ---------
 * The HTTP layer. It is deliberately "thin": it parses/validates requests,
 * calls the MonitorStore, and shapes the JSON response. All the real logic
 * lives in monitorStore.js. This separation makes the system easy to test
 * and easy to reason about.
 *
 * We export a factory `createApp()` so that:
 *   - tests can spin up an app with their own store, and
 *   - the file can be imported without immediately opening a network port.
 * The server only starts listening when this file is run directly
 * (the `require.main === module` guard at the bottom).
 */

const PORT = process.env.PORT || 3000;

/**
 * Convert an internal monitor object into the public JSON shape we return to
 * clients. We deliberately hide internal fields (like the raw timer handle)
 * and compute a friendly, live `remainingSeconds` countdown.
 */
function serialize(monitor) {
  let remainingSeconds = null;
  if (monitor.status === 'active' && monitor.expiresAt) {
    // How long until this monitor would fire, right now.
    remainingSeconds = Math.max(
      0,
      Math.round((monitor.expiresAt - Date.now()) / 1000)
    );
  }

  return {
    id: monitor.id,
    status: monitor.status,
    timeoutSeconds: monitor.timeoutSeconds,
    alertEmail: monitor.alertEmail,
    remainingSeconds,
    createdAt: new Date(monitor.createdAt).toISOString(),
    lastHeartbeat: monitor.lastHeartbeat
      ? new Date(monitor.lastHeartbeat).toISOString()
      : null,
    expiresAt: monitor.expiresAt
      ? new Date(monitor.expiresAt).toISOString()
      : null,
  };
}

/**
 * Build and configure the Express application.
 * @returns {{ app: import('express').Express, store: MonitorStore }}
 */
function createApp() {
  const app = express();
  app.use(express.json()); // parse JSON request bodies into req.body

  // Inject the alert delivery function into the store. The store calls this
  // whenever a countdown hits zero.
  const store = new MonitorStore(fireAlert);

  // ---- Health check ---------------------------------------------------------
  // A tiny endpoint so an orchestrator (or the reviewer) can confirm the
  // service is up. Cheap insurance and standard practice for any backend.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', monitors: store.list().length });
  });

  // ---- User Story 1: Register a monitor -------------------------------------
  app.post('/monitors', (req, res) => {
    const { id, timeout, alert_email: alertEmail } = req.body || {};

    // Validate input up front and fail fast with a clear 400 message.
    if (typeof id !== 'string' || id.trim() === '') {
      return res.status(400).json({ error: '`id` is required and must be a non-empty string' });
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return res.status(400).json({ error: '`timeout` is required and must be a positive number of seconds' });
    }
    if (alertEmail !== undefined && typeof alertEmail !== 'string') {
      return res.status(400).json({ error: '`alert_email` must be a string when provided' });
    }

    try {
      const monitor = store.register(id.trim(), timeout, alertEmail);
      return res.status(201).json({
        message: `Monitor "${monitor.id}" created. Countdown started for ${timeout}s.`,
        monitor: serialize(monitor),
      });
    } catch (err) {
      if (err.code === 'CONFLICT') {
        // Re-registering an existing id is a conflict; use heartbeat to reset.
        return res.status(409).json({ error: err.message });
      }
      throw err; // unexpected -> bubble up to the error handler
    }
  });

  // ---- User Story 2 + Bonus: Heartbeat (reset / un-pause) -------------------
  app.post('/monitors/:id/heartbeat', (req, res) => {
    const monitor = store.heartbeat(req.params.id);
    if (!monitor) {
      return res.status(404).json({ error: `Monitor "${req.params.id}" not found` });
    }
    return res.status(200).json({
      message: `Heartbeat received. Countdown reset to ${monitor.timeoutSeconds}s.`,
      monitor: serialize(monitor),
    });
  });

  // ---- Bonus User Story: Pause ("Snooze") -----------------------------------
  app.post('/monitors/:id/pause', (req, res) => {
    const monitor = store.pause(req.params.id);
    if (!monitor) {
      return res.status(404).json({ error: `Monitor "${req.params.id}" not found` });
    }
    return res.status(200).json({
      message: `Monitor "${monitor.id}" paused. Send a heartbeat to resume.`,
      monitor: serialize(monitor),
    });
  });

  // ---- Developer's Choice: Observability (list + detail) --------------------
  // A monitoring system you cannot query is useless. These read endpoints let a
  // support engineer see, at a glance, which devices are active, paused, or
  // down, and how much time each active monitor has left.
  app.get('/monitors', (_req, res) => {
    res.json({
      count: store.list().length,
      monitors: store.list().map(serialize),
    });
  });

  app.get('/monitors/:id', (req, res) => {
    const monitor = store.get(req.params.id);
    if (!monitor) {
      return res.status(404).json({ error: `Monitor "${req.params.id}" not found` });
    }
    res.json({ monitor: serialize(monitor) });
  });

  // ---- Convenience: delete a monitor ----------------------------------------
  app.delete('/monitors/:id', (req, res) => {
    const deleted = store.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: `Monitor "${req.params.id}" not found` });
    }
    res.status(204).send(); // 204 No Content: success, nothing to return
  });

  // ---- Fallbacks ------------------------------------------------------------
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

  // Centralised error handler (Express identifies it by its 4 arguments).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, store };
}

// Only start the HTTP server when this file is executed directly
// (e.g. `npm start`), not when it is imported by a test.
if (require.main === module) {
  const { app } = createApp();
  app.listen(PORT, () => {
    console.log(`Pulse-Check-API listening on http://localhost:${PORT}`);
  });
}

module.exports = { createApp, serialize };
