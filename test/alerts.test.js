import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { errorAlertPayload } from '../src/lib/alerts.js';

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
