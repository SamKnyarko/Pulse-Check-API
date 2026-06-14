'use strict';

/**
 * Tests for the MonitorStore (the core timing logic).
 * Run with: npm test   (uses Node's built-in test runner, no extra deps)
 *
 * We test the store directly rather than over HTTP because the store is where
 * the interesting behaviour lives. We use very short timeouts (fractions of a
 * second) so the suite runs quickly.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const MonitorStore = require('../src/monitorStore');

// Small helper: pause execution for `ms` milliseconds.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('register creates an active monitor', () => {
  const store = new MonitorStore();
  const m = store.register('dev-1', 60, 'a@b.com');
  assert.strictEqual(m.status, 'active');
  assert.strictEqual(m.id, 'dev-1');
  store.shutdown();
});

test('registering a duplicate id throws a CONFLICT error', () => {
  const store = new MonitorStore();
  store.register('dev-1', 60);
  assert.throws(() => store.register('dev-1', 60), /already exists/);
  store.shutdown();
});

test('heartbeat on an unknown id returns null', () => {
  const store = new MonitorStore();
  assert.strictEqual(store.heartbeat('ghost'), null);
  store.shutdown();
});

test('a monitor goes down and fires an alert if no heartbeat arrives', async () => {
  let fired = null;
  const store = new MonitorStore((monitor) => { fired = monitor; });

  store.register('dev-1', 0.1); // 100ms timeout
  await sleep(160);             // wait past expiry

  assert.strictEqual(fired?.id, 'dev-1');
  assert.strictEqual(store.get('dev-1').status, 'down');
  store.shutdown();
});

test('a heartbeat resets the countdown and prevents the alert', async () => {
  let fired = false;
  const store = new MonitorStore(() => { fired = true; });

  store.register('dev-1', 0.2); // 200ms timeout
  await sleep(120);
  store.heartbeat('dev-1');     // reset before it expires
  await sleep(120);             // 240ms total, but only 120ms since reset

  assert.strictEqual(fired, false);
  assert.strictEqual(store.get('dev-1').status, 'active');
  store.shutdown();
});

test('pause stops the countdown so no alert fires', async () => {
  let fired = false;
  const store = new MonitorStore(() => { fired = true; });

  store.register('dev-1', 0.1);
  store.pause('dev-1');
  await sleep(160);

  assert.strictEqual(fired, false);
  assert.strictEqual(store.get('dev-1').status, 'paused');
  store.shutdown();
});

test('heartbeat un-pauses a paused monitor', () => {
  const store = new MonitorStore();
  store.register('dev-1', 60);
  store.pause('dev-1');
  assert.strictEqual(store.get('dev-1').status, 'paused');

  store.heartbeat('dev-1');
  assert.strictEqual(store.get('dev-1').status, 'active');
  store.shutdown();
});

test('a heartbeat revives a monitor that already went down', async () => {
  const store = new MonitorStore();
  store.register('dev-1', 0.1);
  await sleep(160);
  assert.strictEqual(store.get('dev-1').status, 'down');

  store.heartbeat('dev-1'); // device came back online
  assert.strictEqual(store.get('dev-1').status, 'active');
  store.shutdown();
});

test('remove deletes a monitor', () => {
  const store = new MonitorStore();
  store.register('dev-1', 60);
  assert.strictEqual(store.remove('dev-1'), true);
  assert.strictEqual(store.get('dev-1'), undefined);
  assert.strictEqual(store.remove('dev-1'), false); // already gone
  store.shutdown();
});
