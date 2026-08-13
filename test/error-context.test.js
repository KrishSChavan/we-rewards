// Unit tests for requestContext (src/lib/errors.js) — the blob attached to every
// logged 500 so the /admin error log can say what the request was FOR, not just
// which path threw.
//
// The reason this has tests at all is the redaction rule. error_logs is read in
// the dashboard, exported into bug reports, and never re-audited afterwards, so
// a value that lands there is there for good. Anything credential-shaped must be
// replaced by a marker on the way in, not filtered on the way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../src/lib/errors.js';

const req = (over = {}) => ({ headers: {}, query: {}, body: {}, ...over });

test('a bare request with nothing to say produces null, not an empty object', () => {
  assert.equal(requestContext(req()), null);
  assert.equal(requestContext(null), null);
});

test('query and body fields are recorded so the failure can be reproduced', () => {
  const ctx = requestContext(req({
    query: { audience: 'top', from: '1' },
    body: { exactAmount: 12.5 },
  }));
  assert.deepEqual(ctx.query, { audience: 'top', from: '1' });
  assert.deepEqual(ctx.body, { exactAmount: '12.5' });
});

test('credentials and single-use secrets are redacted, never logged', () => {
  const ctx = requestContext(req({
    body: {
      password: 'hunter2', pin: '1234', code: '482913', token: 'ey.jwt',
      apiKey: 'sk-live', logo: 'data:image/png;base64,AAAA', image: 'data:image/jpeg;base64,BBBB',
    },
  }));
  for (const [k, v] of Object.entries(ctx.body)) {
    assert.equal(v, '[redacted]', `${k} should have been redacted, got ${JSON.stringify(v)}`);
  }
});

test('a redemption token in the query string is redacted as well', () => {
  const ctx = requestContext(req({ query: { t: 'x', token: 'secret-value' } }));
  assert.equal(ctx.query.token, '[redacted]');
  assert.equal(ctx.query.t, 'x');
});

test('structured values become type markers rather than serialised payloads', () => {
  const ctx = requestContext(req({ body: { tiers: [1, 2, 3], keys: { a: 1 }, note: null } }));
  assert.equal(ctx.body.tiers, '[array · 3]');
  assert.equal(ctx.body.keys, '[redacted]', 'a field named "keys" is a push subscription secret');
  assert.equal(ctx.body.note, null);
});

test('a long value is truncated so one request cannot bloat the table', () => {
  const ctx = requestContext(req({ body: { title: 'x'.repeat(5000) } }));
  assert.ok(ctx.body.title.length <= 201, `got ${ctx.body.title.length} characters`);
  assert.ok(ctx.body.title.endsWith('…'));
});

test('a body with more fields than the cap is summarised, not dropped', () => {
  const body = {};
  for (let i = 0; i < 40; i++) body[`f${i}`] = i;
  const ctx = requestContext(req({ body }));
  assert.equal(Object.keys(ctx.body).length, 26, '25 fields plus the "more fields" note');
  assert.match(ctx.body['…'], /15 more fields/);
});

test('who and where ride along: the signed-in user, the vendor, and the page', () => {
  const ctx = requestContext(req({
    user: { id: 'u-1', email: 'staff@example.com' },
    vendor: { id: 'v-1', name: 'Local Eats' },
    headers: { referer: 'https://we-rewards.com/terminal' },
  }));
  assert.equal(ctx.actorEmail, 'staff@example.com');
  assert.equal(ctx.actorId, 'u-1');
  assert.equal(ctx.vendor, 'Local Eats');
  assert.equal(ctx.vendorId, 'v-1');
  assert.equal(ctx.referer, 'https://we-rewards.com/terminal');
});

test('an array body (not an object) is ignored rather than indexed field by field', () => {
  assert.equal(requestContext(req({ body: [1, 2, 3] })), null);
});
