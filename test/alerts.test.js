import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { errorAlertPayload, createRepeatGate } from '../src/lib/alerts.js';

describe('admin error push payloads', () => {
  test('labels every error source shown by the admin log', () => {
    const labels = {
      server: 'Server',
      student: 'Student app',
      vendor: 'Vendor app',
      admin: 'Admin app',
    };
    for (const [source, label] of Object.entries(labels)) {
      const payload = errorAlertPayload({ source, message: 'Boom' });
      assert.equal(payload.title, `WeRewards error: ${label}`);
      assert.equal(payload.body, 'Boom');
      assert.equal(payload.url, '/admin/');
    }
  });

  test('keeps the alert readable when an error or URL is enormous', () => {
    const payload = errorAlertPayload({
      source: 'server',
      message: 'x'.repeat(500),
      path: '/' + 'y'.repeat(500),
    });
    assert.match(payload.body, /^x{137}\.\.\./);
    assert.ok(payload.body.length <= 245, `body was ${payload.body.length} characters`);
  });

  test('has safe fallbacks for malformed reports', () => {
    assert.deepEqual(errorAlertPayload(), {
      title: 'WeRewards error: App',
      body: 'Unknown error',
      url: '/admin/',
    });
  });
});

describe('repeated errors push once an hour', () => {
  const HOUR = 60 * 60 * 1000;
  // Verbatim from the 2026-10-19 broadcast, which pushed this 420 times.
  const scanner = { source: 'student', message: 'Object Not Found Matching Id:2, MethodName:update, ParamCount:4' };

  test('the first occurrence pushes and the burst behind it does not', () => {
    const gate = createRepeatGate();
    const t0 = 1_000_000;
    assert.equal(gate(scanner, t0), true);
    for (let i = 1; i < 420; i++) assert.equal(gate(scanner, t0 + i * 150), false, `repeat ${i} pushed`);
  });

  test('a burst that is still going pushes again after the hour', () => {
    const gate = createRepeatGate();
    assert.equal(gate(scanner, 0), true);
    assert.equal(gate(scanner, HOUR - 1), false);
    assert.equal(gate(scanner, HOUR), true);
    // The window restarts from that second push, not from the first.
    assert.equal(gate(scanner, HOUR + HOUR - 1), false);
    assert.equal(gate(scanner, 2 * HOUR), true);
  });

  test('a different message, or the same one from another app, still pushes', () => {
    const gate = createRepeatGate();
    assert.equal(gate(scanner, 0), true);
    assert.equal(gate({ ...scanner, message: 'Object Not Found Matching Id:1, MethodName:update, ParamCount:4' }, 1), true);
    assert.equal(gate({ ...scanner, source: 'vendor' }, 2), true);
    assert.equal(gate({ source: 'server', message: 'TypeError: x is undefined' }, 3), true);
  });

  test('surrounding whitespace does not make a repeat look new', () => {
    const gate = createRepeatGate();
    assert.equal(gate({ source: 'server', message: 'Boom' }, 0), true);
    assert.equal(gate({ source: 'server', message: '  Boom\n' }, 1), false);
  });

  test('a malformed report is gated rather than thrown on', () => {
    const gate = createRepeatGate();
    assert.equal(gate(undefined, 0), true);
    assert.equal(gate({}, 1), false);
  });

  test('memory is capped, dropping the stalest message first', () => {
    const gate = createRepeatGate({ max: 3 });
    for (const m of ['a', 'b', 'c']) gate({ source: 'server', message: m }, 0);
    gate({ source: 'server', message: 'd' }, 1);              // evicts 'a'
    assert.equal(gate({ source: 'server', message: 'b' }, 2), false);
    assert.equal(gate({ source: 'server', message: 'a' }, 3), true);
  });
});
