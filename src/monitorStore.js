'use strict';

/**
 * MonitorStore
 * -------------
 * This is the "brain" of the Dead Man's Switch. It owns:
 *   1. The state of every monitor (kept in an in-memory Map).
 *   2. The countdown timer for each monitor (a Node.js setTimeout handle).
 *
 * Design idea (the most important thing to understand):
 *   A "Dead Man's Switch" fires an action when nothing happens. We model
 *   "nothing happening" with a timer. Every heartbeat cancels the pending
 *   timer and schedules a fresh one. If a heartbeat never arrives, the timer
 *   is never cancelled, so it fires -> the alert goes off.
 *
 * Why a Map instead of an array?
 *   We always look monitors up by their unique `id`. A Map gives O(1)
 *   average-time get/set/delete by key, whereas an array would be O(n).
 *
 * Why store the timer handle on the monitor object?
 *   To reset a countdown we must cancel the *specific* pending timer first
 *   (clearTimeout needs the handle returned by setTimeout). We keep that
 *   handle on the monitor so each monitor can manage its own timer.
 *
 * A monitor moves through three states:
 *   active  -> the timer is running; a heartbeat is expected before it expires
 *   paused  -> the timer is stopped on purpose; no alert can fire (Snooze)
 *   down    -> the timer expired without a heartbeat; an alert was fired
 */
class MonitorStore {
  /**
   * @param {(monitor: object) => void} onAlert
   *   A callback invoked when a monitor's countdown reaches zero.
   *   We inject it from the outside (dependency injection) so the store
   *   does not need to know *how* alerts are delivered (console, email,
   *   webhook). This keeps the store focused only on timing/state and makes
   *   it trivial to unit-test with a fake callback.
   */
  constructor(onAlert) {
    this.monitors = new Map();
    this.onAlert = onAlert || (() => {});
  }

  /**
   * Register a brand-new monitor and immediately start its countdown.
   * Throws a typed error if the id already exists so the HTTP layer can
   * translate it into a 409 Conflict.
   *
   * @param {string} id          unique device id, e.g. "device-123"
   * @param {number} timeout     countdown length in seconds
   * @param {string} [alertEmail] who to notify when it goes down
   * @returns {object} the created monitor
   */
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

  /**
   * Heartbeat = "I'm alive". Resets the countdown to the full timeout.
   * Also un-pauses a paused monitor and revives a monitor that already
   * went down (the device has clearly come back online).
   *
   * @param {string} id
   * @returns {object|null} the monitor, or null if the id is unknown
   */
  heartbeat(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    monitor.lastHeartbeat = Date.now();
    monitor.status = 'active';   // covers active -> active, paused -> active, down -> active
    this._startTimer(monitor);   // cancels any existing timer, then starts fresh
    return monitor;
  }

  /**
   * Pause (the "Snooze" button). Stops the countdown so no alert can fire
   * while a technician works on the device. The monitor is remembered; it
   * resumes when the next heartbeat arrives.
   *
   * @param {string} id
   * @returns {object|null} the monitor, or null if the id is unknown
   */
  pause(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    this._clearTimer(monitor);
    monitor.status = 'paused';
    monitor.expiresAt = null;    // there is no live countdown while paused
    return monitor;
  }

  /** Look up a single monitor (or undefined). */
  get(id) {
    return this.monitors.get(id);
  }

  /** Return every monitor as a plain array (used by the list endpoint). */
  list() {
    return [...this.monitors.values()];
  }

  /**
   * Permanently delete a monitor and stop its timer.
   * @returns {boolean} true if something was deleted
   */
  remove(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return false;
    this._clearTimer(monitor);
    return this.monitors.delete(id);
  }

  /**
   * Stop the entire store (clears every pending timer).
   * Important for a clean shutdown and for tests: a leftover setTimeout
   * keeps the Node process alive.
   */
  shutdown() {
    for (const monitor of this.monitors.values()) {
      this._clearTimer(monitor);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers (underscore-prefixed by convention)
  // ---------------------------------------------------------------------------

  /**
   * Start (or restart) a monitor's countdown.
   * Always clears the old timer first so we never leak overlapping timers.
   */
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

  /**
   * Fired by setTimeout when no heartbeat arrived in time.
   * Flips the monitor to "down" and delegates the actual notification to the
   * injected onAlert callback.
   */
  _expire(monitor) {
    monitor.status = 'down';
    monitor._timer = null;
    monitor.expiresAt = null;
    this.onAlert(monitor);
  }
}

module.exports = MonitorStore;
