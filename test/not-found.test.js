// The catch-all 404 (server.js, mounted below every route and above the error
// handler). Three things are worth locking in:
//
//   • a person who mistyped a URL gets the branded page, not Express's default
//     "Cannot GET /termnal";
//   • an API caller still gets JSON, because the client apps parse every /api
//     response body as JSON and show `message` verbatim;
//   • the catch-all did not shadow a real route. That is the failure mode that
//     would matter most and it is invisible in a page test, so the last case
//     hits a live endpoint.
//
// Runs in the default suite (no DB): nothing here touches Supabase.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';

// Boot the app on an ephemeral port for one request, then close it.
async function get(pathname, headers = {}) {
  const listener = app.listen(0);
  try {
    const port = listener.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    listener.close();
  }
}

describe('404 handling', () => {
  test('an unknown page returns the branded HTML page with status 404', async () => {
    const res = await get('/termnal');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.body, /This page doesn't exist/);
    // The way back matters more than the artwork: every public destination
    // must be linked, or the page is a dead end.
    for (const href of ['href="/"', 'href="/terminal"', 'href="/join"']) {
      assert.ok(res.body.includes(href), `must link ${href}`);
    }
    assert.ok(!res.body.includes('Cannot GET'), 'Express default must not leak through');
  });

  test('a 404 is never cached', async () => {
    // Cloudflare fronts the dyno and the student PWA caches same-origin GETs,
    // so a path that 404s today and ships tomorrow must not stay a miss.
    const res = await get('/nothing-here');
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  test('the page carries no script and no external asset reference', async () => {
    // It is served AT the unmatched path, so a relative href would resolve
    // against that path; and the CSP forbids inline script.
    const res = await get('/deep/path/that/does/not/exist');
    // Comments stripped first: the page's own header note explains why it
    // carries no <script>, and says so using the tag.
    const markup = res.body.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/<script/i.test(markup), 'no <script> (CSP forbids inline, and none is needed)');
    for (const ref of markup.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = ref[1];
      assert.ok(
        url.startsWith('/') || /^https?:\/\//.test(url),
        `asset reference must be absolute, got ${url}`
      );
    }
  });

  test('an unknown /api path returns JSON, not HTML', async () => {
    const res = await get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(JSON.parse(res.body).error, 'NOT_FOUND');
  });

  test('a caller that asks for JSON gets JSON even off /api', async () => {
    const res = await get('/nope', { Accept: 'application/json' });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, 'NOT_FOUND');
  });

  test('a missing subresource gets plain text, not a document', async () => {
    // Answering a <script src> with HTML hands the browser HTML to parse as JS.
    const res = await get('/missing-bundle.js');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.ok(!res.body.includes('<html'), 'must not be the HTML page');
  });

  test('a legal document outside the allowlist gets the same page', async () => {
    // /legal is allowlisted by filename; a miss there is still a person in a
    // browser, so it goes through the same handler.
    const res = await get('/legal/vendor-agreement');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.body, /This page doesn't exist/);
  });

  test('real routes are not shadowed by the catch-all', async () => {
    const health = await get('/api/health');
    assert.equal(health.status, 200, '/api/health must still answer');
    assert.equal(JSON.parse(health.body).ok, true);

    const shell = await get('/');
    assert.equal(shell.status, 200, 'the student shell must still be served at /');

    const asset = await get('/styles.css');
    assert.equal(asset.status, 200, 'static assets must still be served');
  });
});

/* ---------- a mangled percent-escape in the path ----------

   Express decodes a :param inside Layer.match, BEFORE the handler body runs, so
   a malformed escape throws past every route's own try/catch and lands in the
   central error handler in server.js. Two things went wrong there, and the
   second is why this block exists rather than just asserting a status:

     • the 500 branch answered 500 AND wrote an error_logs row — and /spots/:slug
       is public, indexed and carries no rate limiter, so it was one line of
       curl away from burying the operator's dashboard;
     • the decode error's message EMBEDS THE RAW PARAM, and the handler matches
       its `known` error map by SUBSTRING — so /spots/%zzCODE_INVALID came back
       401 CODE_INVALID. An anonymous caller could pick the status.

   src/routes/tracked-qr.js guards /r/<code> itself and test/tracked-qr.test.js
   pins that. This pins the app-wide fallback, whose correctness is ENTIRELY a
   matter of the branch sitting ABOVE the `known` scan — reorder it and both
   failures come back with the whole suite still green.

   No database: the throw happens during route matching, so no handler and no
   Supabase read is ever reached. That is what keeps this in the always-on suite. */
describe('a path that cannot be percent-decoded', () => {
  /**
   * ⚠ NOT fetch(). undici can percent-ENCODE a raw '%' in the path to '%25'
   * before it goes out, which decodes cleanly at the other end and never
   * triggers the failure this block is about — the same trap documented at
   * length in test/tracked-qr.test.js, where it made the first version of those
   * tests pass with the guard deliberately switched off. http.request sends the
   * path byte-for-byte, the way a mangled link or a misread QR actually would.
   */
  async function rawGet(pathname) {
    const http = await import('node:http');
    const listener = app.listen(0);
    await new Promise((resolve) => listener.once('listening', resolve));
    try {
      const port = listener.address().port;
      return await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: pathname, method: 'GET' },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    } finally {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  }

  test('an undecodable path is a 404, not a 500 that logs', async () => {
    for (const p of ['/spots/%', '/spots/a%E0%A4%A', '/spots/%2', '/api/vendor-logo/%']) {
      const res = await rawGet(p);
      assert.equal(res.status, 404, `${p} must be a clean 404, never a 500`);
    }
  });

  test('the raw param cannot pick the error code the server reports', async () => {
    // Each of these is a real key in server.js's `known` map, chosen because its
    // status is NOT 404 — so if the substring scan ever claims one of these
    // again, the status alone gives it away.
    const steerable = [
      ['CODE_INVALID', 401],
      ['RECEIPT_BUSY', 503],
      ['CAMPAIGN_QUOTA', 429],
      ['REVERSAL_EXPIRED', 403],
    ];
    for (const [code, hijackedStatus] of steerable) {
      const res = await rawGet(`/spots/%zz${code}`);
      assert.notEqual(res.status, hijackedStatus,
        `/spots/%zz${code} must not be answerable as ${code}`);
      assert.equal(res.status, 404, `/spots/%zz${code} should be a plain 404`);
      assert.ok(!res.body.includes(code),
        `the response body must not echo ${code} back to the caller`);
    }
  });

  test('an undecodable /api path still answers JSON, and is never cached', async () => {
    const res = await rawGet('/api/vendor-logo/%zzCODE_INVALID');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(res.body).error, 'NOT_FOUND');
    // Cloudflare and the student service worker both sit in front of this.
    assert.match(res.headers['cache-control'] ?? '', /no-store/);
  });
});
