// Unit tests for the requirePin gate (src/middleware/auth.js) that don't need a
// database: the "no PIN configured" and "PIN configured but no token presented"
// branches both decide before any query runs. The token-lookup path (valid /
// expired / idle) is exercised by the gated integration suite instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePin } from '../src/middleware/auth.js';

// Minimal Express-ish response double: records the status + JSON body.
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

test('a vendor with no PIN configured is not gated (calls next)', async () => {
  const req = { vendor: { id: 'v1', pin_hash: null }, user: { id: 'u1' }, headers: {} };
  const res = fakeRes();
  let nexted = false;
  await requirePin(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null, 'no response written when not gated');
});

test('a PIN-protected route with no X-Vendor-Pin header returns 401 PIN_REQUIRED', async () => {
  const req = { vendor: { id: 'v1', pin_hash: '$2a$hash' }, user: { id: 'u1' }, headers: {} };
  const res = fakeRes();
  let nexted = false;
  await requirePin(req, res, () => { nexted = true; });
  assert.equal(nexted, false, 'the request must not proceed');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'PIN_REQUIRED');
});
