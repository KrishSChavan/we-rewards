// The API is JSON-only. These lock in that contract: any request carrying a
// non-JSON body — especially XML, the XXE vector — is refused with 415 before it
// reaches a parser, while bodyless and genuine-JSON requests pass through.
//
// Runs in the default suite (no DB): the gate decides purely on headers, before
// any auth/DB middleware, so the app-level check needs no Supabase project.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireJson } from '../src/middleware/require-json.js';
import { app } from '../server.js';

// Minimal Express-ish response double: records the status + JSON body.
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function run(headers) {
  const req = { method: 'POST', headers };
  const res = fakeRes();
  let nexted = false;
  requireJson(req, res, () => { nexted = true; });
  return { res, nexted };
}

describe('requireJson content-type gate (unit)', () => {
  test('an XML body is rejected with 415', () => {
    const { res, nexted } = run({ 'content-type': 'application/xml', 'content-length': '120' });
    assert.equal(nexted, false, 'must not proceed to a handler');
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.error, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('text/xml is rejected with 415', () => {
    const { res, nexted } = run({ 'content-type': 'text/xml', 'content-length': '80' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 415);
  });

  test('a chunked XML body (no content-length) is still rejected', () => {
    const { res, nexted } = run({ 'content-type': 'application/xml', 'transfer-encoding': 'chunked' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 415);
  });

  test('a body with no content-type at all is rejected', () => {
    const { res, nexted } = run({ 'content-length': '50' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 415);
  });

  test('form and multipart bodies are rejected too', () => {
    for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      const { res, nexted } = run({ 'content-type': ct, 'content-length': '30' });
      assert.equal(nexted, false, `${ct} must not proceed`);
      assert.equal(res.statusCode, 415, `${ct} must be 415`);
    }
  });

  test('application/json is allowed through', () => {
    const { res, nexted } = run({ 'content-type': 'application/json', 'content-length': '15' });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, null, 'no response written when allowed');
  });

  test('application/json with a charset parameter is allowed', () => {
    const { nexted } = run({ 'content-type': 'application/json; charset=utf-8', 'content-length': '15' });
    assert.equal(nexted, true);
  });

  test('a +json vendor media type is allowed', () => {
    const { nexted } = run({ 'content-type': 'application/vnd.api+json', 'content-length': '15' });
    assert.equal(nexted, true);
  });

  test('a bodyless request (no length, no transfer-encoding) passes untouched', () => {
    const { res, nexted } = run({ 'content-type': 'application/xml' });
    assert.equal(nexted, true, 'no body ⇒ nothing to police');
    assert.equal(res.statusCode, null);
  });

  test('an empty body (content-length: 0) passes untouched', () => {
    const { nexted } = run({ 'content-length': '0' });
    assert.equal(nexted, true);
  });
});

describe('content-type gate (app end-to-end)', () => {
  test('a classic XXE payload to a real endpoint gets 415 before auth', async () => {
    const listener = app.listen(0);
    try {
      const port = listener.address().port;
      const xxe =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<foo>&xxe;</foo>';
      // No Authorization header: if the gate works, we never reach requireVendor.
      const res = await fetch(`http://127.0.0.1:${port}/api/vendor/award`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xxe,
      });
      assert.equal(res.status, 415, 'XML body must be refused with 415');
      const body = await res.json();
      assert.equal(body.error, 'UNSUPPORTED_MEDIA_TYPE');
    } finally {
      listener.close();
    }
  });

  test('the unauthenticated /api/client-error endpoint also refuses XML with 415', async () => {
    const listener = app.listen(0);
    try {
      const port = listener.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/client-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: '<x/>',
      });
      assert.equal(res.status, 415);
    } finally {
      listener.close();
    }
  });
});
