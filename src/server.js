'use strict';

const express = require('express');
const MonitorStore = require('./monitorStore');
const { fireAlert } = require('./alerts');



const PORT = process.env.PORT || 3000;


function serialize(monitor) {
  let remainingSeconds = null;
  if (monitor.status === 'active' && monitor.expiresAt) {
    
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


function createApp() {
  const app = express();
  app.use(express.json()); 
  const store = new MonitorStore(fireAlert);

  
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', monitors: store.list().length });
  });

  app.post('/monitors', (req, res) => {
    const { id, timeout, alert_email: alertEmail } = req.body || {};

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

        return res.status(409).json({ error: err.message });
      }
      throw err; 
    }
  });


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

  app.delete('/monitors/:id', (req, res) => {
    const deleted = store.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: `Monitor "${req.params.id}" not found` });
    }
    res.status(204).send(); 
  });


  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

 
  app.use((err, _req, res, _next) => {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, store };
}


if (require.main === module) {
  const { app } = createApp();
  app.listen(PORT, () => {
    console.log(`Pulse-Check-API listening on http://localhost:${PORT}`);
  });
}

module.exports = { createApp, serialize };
