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
