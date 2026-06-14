'use strict';


class MonitorStore {
  
  constructor(onAlert) {
    this.monitors = new Map();
    this.onAlert = onAlert || (() => {});
  }

 
  register(id, timeout, alertEmail) {
    if (this.monitors.has(id)) {
      const err = new Error(`Monitor "${id}" already exists`);
      err.code = 'CONFLICT';
      throw err;
    }

    const now = Date.now();
    const monitor = {
      id,
      timeoutSeconds: timeout,
      alertEmail: alertEmail || null,
      status: 'active',
      createdAt: now,
      lastHeartbeat: null,   // no ping yet; registration starts the clock
      expiresAt: null,       // filled in by _startTimer
      _timer: null,          // private: the setTimeout handle (underscore = internal)
    };

    this.monitors.set(id, monitor);
    this._startTimer(monitor);
    return monitor;
  }

  
  heartbeat(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    monitor.lastHeartbeat = Date.now();
    monitor.status = 'active';   // covers active -> active, paused -> active, down -> active
    this._startTimer(monitor);   // cancels any existing timer, then starts fresh
    return monitor;
  }

 
  pause(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    this._clearTimer(monitor);
    monitor.status = 'paused';
    monitor.expiresAt = null;    
    return monitor;
  }


  get(id) {
    return this.monitors.get(id);
  }

  /** Return every monitor as a plain array (used by the list endpoint). */
  list() {
    return [...this.monitors.values()];
  }

  
  remove(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return false;
    this._clearTimer(monitor);
    return this.monitors.delete(id);
  }

  
  shutdown() {
    for (const monitor of this.monitors.values()) {
      this._clearTimer(monitor);
    }
  }

 
  _startTimer(monitor) {
    this._clearTimer(monitor);
    monitor.expiresAt = Date.now() + monitor.timeoutSeconds * 1000;
    monitor._timer = setTimeout(
      () => this._expire(monitor),
      monitor.timeoutSeconds * 1000
    );
  }

  /** Cancel a monitor's pending timer if one is scheduled. */
  _clearTimer(monitor) {
    if (monitor._timer) {
      clearTimeout(monitor._timer);
      monitor._timer = null;
    }
  }

  
  _expire(monitor) {
    monitor.status = 'down';
    monitor._timer = null;
    monitor.expiresAt = null;
    this.onAlert(monitor);
  }
}

module.exports = MonitorStore;
