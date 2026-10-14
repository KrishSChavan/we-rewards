// The NFC tag landing (src/routes/tap.js, src/lib/tap-page.js) and the iOS
// Universal Links file (server.js), end to end against the real app.
//
// WHAT IS WORTH LOCKING IN. A tag is programmed once and stuck to a counter,
// so the URL on it has to keep working whatever the server is going through:
//
//   • the page comes back 200 with the right destinations whether the ref is
//     known, unknown, malformed, undecodable or missing. A 404 or a 500 on a
//     tag is a dead counter;
//   • a catalogue blip must not take a counter tag down. This suite has NO
//     database (test/setup.js points SUPABASE_URL at an .invalid host, so the
//     catalogue read fails fast), which makes it the catalogue-down case by
//     construction: the slug has to go through to the app untouched;
//   • the apple-app-site-association file is fetched by Apple's CDN, which
//     refuses a redirect or a non-JSON type, and advertises ids that must
//     match the Xcode project;
//   • the page is uncacheable, noindex, and runs exactly one script.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';

import { app } from '../server.js';
import { createTapRouter } from '../src/routes/tap.js';
import { NFC_TAP_COOKIE, tapCookieOptions } from '../src/lib/nfc-taps.js';

/** One listener for the whole file, drained on the way out (test/seo.test.js says why). */
const server = (() => {
  let ready = null;
  return {
    async port() {
      if (!ready) {
        ready = new Promise((resolve, reject) => {
          const l = app.listen(0);
          l.once('listening', () => resolve(l));
          l.once('error', reject);
        });
      }
      return (await ready).address().port;
    },
    async close() {
      if (!ready) return;
      const l = await ready;
      ready = null;
      l.closeAllConnections();
      await new Promise((resolve) => l.close(resolve));
    },
  };
})();
after(() => server.close());

/** One request. `redirect: manual` so a bounce is reported as a bounce. */
async function get(pathname, init = {}) {
  const port = await server.port();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: 'manual', ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/**
 * NOT fetch(), for the percent-escape cases: undici re-encodes a raw '%' to
 * '%25' before the request goes out, so fetch('/t/%') never exercises the
 * decode failure at all (test/tracked-qr.test.js explains the same trap).
 * http.request sends the path byte for byte, like a tag written by hand would.
 */
async function rawGet(pathname) {
  const port = await server.port();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: { get: (h) => res.headers[h.toLowerCase()] ?? null } });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Run fn with these env vars set (null deletes one), restoring whatever was there before. */
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] == null) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

/** The attributes on <section id="tap">, raw, so an escaped &amp; stays visible. */
function tapSection(html) {
  const m = html.match(/<section class="tap" id="tap"([^>]*)>/);
  assert.ok(m, 'the tap section is missing from the page');
  const attrs = {};
  for (const [, k, v] of m[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)) attrs[k] = v;
  return attrs;
}

/** The href of the <a id="..."> link. */
function hrefOf(html, id) {
  return html.match(new RegExp(`<a id="${id}"[^>]*href="([^"]*)"`))?.[1];
}

/**
 * The one request in this file that touches the catalogue, fetched ONCE. With
 * no database the read fails only after the Supabase client's transport
 * retries have each waited out a DNS failure, which is several seconds on
 * Windows; two tests want the page, so they share it rather than pay twice.
 */
let irvings = null;
const getIrvings = () => (irvings ||= get('/t/irvings'));

/* ================= iOS Universal Links ================= */

describe('apple-app-site-association', () => {
  test('is served as plain JSON at the path Apple fetches, with no redirect and the real ids', async () => {
    // Pinned to the DEFAULTS, whatever the developer's own .env says.
    await withEnv({ APPLE_TEAM_ID: null, IOS_BUNDLE_ID: null }, async () => {
      const res = await get('/.well-known/apple-app-site-association');
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').startsWith('application/json'), `got ${res.headers.get('content-type')}`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
      assert.equal(res.headers.get('location'), null, 'Apple refuses a redirect here');
      const [detail] = JSON.parse(res.body).applinks.details;
      assert.deepEqual(detail.appIDs, ['UXXL68D688.com.werewards.app']);
      assert.ok(detail.components.some((c) => c['/'] === '/t'), 'the generic tag path must be claimed');
      assert.ok(detail.components.some((c) => c['/'] === '/t/*'), 'the vendor tag paths must be claimed');
    });
  });

  test('the team and bundle ids come from the environment, read per request', async () => {
    await withEnv({ APPLE_TEAM_ID: 'TEAM1234', IOS_BUNDLE_ID: 'com.example.x' }, async () => {
      const res = await get('/.well-known/apple-app-site-association');
      assert.deepEqual(JSON.parse(res.body).applinks.details[0].appIDs, ['TEAM1234.com.example.x']);
    });
  });
});

/* ================= the tag landing ================= */

describe('GET /t', () => {
  test('a generic tag renders the install page pointing at the app root', async () => {
    const res = await get('/t');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.ok(res.body.includes('<meta name="robots" content="noindex'));
    const tap = tapSection(res.body);
    assert.equal(tap['data-dest'], '/');
    assert.equal(tap['data-install'], '/?install=1');
    assert.ok(res.body.includes('Get the app'));
    assert.ok(res.body.includes('Continue on the web'));
    assert.equal(hrefOf(res.body, 'tap-web'), '/');
    assert.equal(hrefOf(res.body, 'tap-app'), '/?install=1');
  });

  test('exactly one script runs on the page, and it is /tap.js', async () => {
    // The CSP note in page-shell.js promises these pages run no inline script.
    // ?v= is the content hash server.js stamps on local scripts; the mirror is
    // built at import, so a missing stamp means the stamp itself is broken.
    const { body } = await get('/t');
    const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(scripts.length, 1, `expected one <script>, found: ${scripts.join(' ')}`);
    assert.match(scripts[0], /^<script src="\/tap\.js\?v=[0-9a-f]{8}">$/, 'the stamp is not optional');
    assert.ok(!body.includes('application/ld+json'), 'no structured data on a noindex page');
  });

  test('a slug goes through to the app untouched while the catalogue is down', async () => {
    // No database here, so the lookup fails and the app has to resolve the
    // slug itself. The install link carries the same destination plus
    // install=1, and the joining & must be attribute-escaped.
    const res = await getIrvings();
    assert.equal(res.status, 200);
    const tap = tapSection(res.body);
    assert.equal(tap['data-dest'], '/?spot=irvings');
    assert.equal(tap['data-install'], '/?spot=irvings&amp;install=1');
    assert.equal(hrefOf(res.body, 'tap-web'), '/?spot=irvings');
    assert.equal(hrefOf(res.body, 'tap-app'), '/?spot=irvings&amp;install=1');
  });

  test('an undecodable ref bounces home instead of 500ing', async () => {
    // The second probe is the substring attack on the central handler: a
    // decode error quotes the raw param back, and server.js matches known
    // error codes by substring, so a leak past the guard would answer 404
    // REWARD_NOT_FOUND. Neither may ever be a 500.
    for (const p of ['/t/%', '/t/%zzREWARD_NOT_FOUND']) {
      const res = await rawGet(p);
      assert.equal(res.status, 302, `${p} should redirect, not error`);
      assert.equal(res.headers.get('location'), '/', `${p} should land on the app`);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${p} must not be cacheable`);
    }
  });

  test('a ref that is neither a slug nor an id renders the generic page', async () => {
    const res = await get('/t/not%20a%20slug!');
    assert.equal(res.status, 200);
    assert.equal(tapSection(res.body)['data-dest'], '/');
  });

  test('the App Store listing rides along only once it is configured', async () => {
    await withEnv({ IOS_APP_STORE_URL: 'https://apps.apple.com/app/id123' }, async () => {
      assert.equal(tapSection((await get('/t')).body)['data-store'], 'https://apps.apple.com/app/id123');
    });
    await withEnv({ IOS_APP_STORE_URL: null }, async () => {
      assert.equal(tapSection((await get('/t')).body)['data-store'], '');
    });
  });

  test('a trailing slash is the generic page too', async () => {
    const res = await get('/t/');
    assert.equal(res.status, 200);
    assert.equal(tapSection(res.body)['data-dest'], '/');
  });

  test('nothing a visitor reads contains an em dash', async () => {
    for (const [p, res] of [['/t', await get('/t')], ['/t/irvings', await getIrvings()]]) {
      assert.ok(!res.body.includes('—'), `${p} carries an em dash`);
    }
  });
});

/* ================= the visitor cookie (migration-065) ================= */

/**
 * The one cookie a tap sets. It steers nothing (the page shows on every tap);
 * its hash is what lets the operator's counts tell a returning phone from a
 * new one. What is locked in here is its SCOPE: Path=/t, so it never rides on
 * an API call or reaches /terminal, and HttpOnly, so page script can neither
 * read nor plant it.
 */
describe('GET /t sets the visitor cookie', () => {
  test('a tap sets a 32-hex nonce, scoped to /t, HttpOnly, Lax, for 30 days', async () => {
    const res = await get('/t');
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, new RegExp(`^${NFC_TAP_COOKIE}=[0-9a-f]{32};`), 'the value is the nonce and nothing else');
    assert.match(cookie, /; Max-Age=2592000(;|$)/, '30 days');
    assert.match(cookie, /; Path=\/t(;|$)/, 'never rides on anything but a tap');
    assert.match(cookie, /; HttpOnly(;|$)/);
    assert.match(cookie, /; SameSite=Lax(;|$)/);
    assert.equal(/; Secure(;|$)/.test(cookie), process.env.NODE_ENV === 'production');
  });

  test('the options every write must use agree with the header', () => {
    const o = tapCookieOptions();
    assert.equal(o.httpOnly, true);
    assert.equal(o.sameSite, 'lax');
    assert.equal(o.path, '/t');
    assert.equal(o.maxAge, 30 * 24 * 60 * 60 * 1000);
    assert.equal(o.secure, process.env.NODE_ENV === 'production');
  });

  test('a phone that already carries the cookie keeps its nonce: no Set-Cookie at all', async () => {
    // A fresh nonce per tap would make uniques equal taps.
    const res = await get('/t', { headers: { cookie: `${NFC_TAP_COOKIE}=${'a'.repeat(32)}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('a malformed cookie is replaced rather than trusted', async () => {
    const res = await get('/t', { headers: { cookie: `${NFC_TAP_COOKIE}=not-a-nonce; other=1` } });
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^${NFC_TAP_COOKIE}=[0-9a-f]{32};`));
  });

  test('a link-preview crawler gets the page but no cookie', async () => {
    // A crawler re-fetching a pasted link must not become a "returning visitor".
    const res = await get('/t', { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

/* ================= the router against a catalogue that answers ================= */

/**
 * The full-app tests above can only see the catalogue-down branch (no database
 * in this suite), so the router is mounted on its own here with the lookup
 * injected, which is what createTapRouter's `resolve` option is for.
 */
function withRouter(opts, fn) {
  const bare = express();
  bare.use('/t', createTapRouter(opts));
  return new Promise((resolve, reject) => {
    const l = http.createServer(bare).listen(0, '127.0.0.1', async () => {
      try { resolve(await fn(`http://127.0.0.1:${l.address().port}`)); }
      catch (e) { reject(e); }
      finally { l.closeAllConnections(); l.close(); }
    });
  });
}

const IRVINGS = { id: 'u-1', name: "Irving's", slug: 'irvings' };

describe('GET /t/<ref> with a catalogue that answers', () => {
  test('a known slug resolves to the vendor id and names the spot, escaped', async () => {
    await withRouter({ resolve: async (ref) => (ref === 'irvings' ? IRVINGS : null) }, async (base) => {
      const res = await fetch(`${base}/t/Irvings`);
      const body = await res.text();
      assert.equal(res.status, 200);
      assert.equal(tapSection(body)['data-dest'], '/?spot=u-1');
      assert.equal(tapSection(body)['data-install'], '/?spot=u-1&amp;install=1');
      assert.ok(body.includes('<title>Irving&#39;s on WeRewards</title>'), 'the vendor name is escaped into the title');
      assert.ok(body.includes('<h1>Irving&#39;s</h1>'));
      assert.ok(body.includes('href="https://we-rewards.com/t/irvings"'), 'canonical names the slug');
    });
  });

  test('an unknown slug against a healthy catalogue is the generic page', async () => {
    await withRouter({ resolve: async () => null }, async (base) => {
      const body = await (await fetch(`${base}/t/nowhere`)).text();
      assert.equal(tapSection(body)['data-dest'], '/');
    });
  });

  test('a lookup that throws passes the ref through to the app', async () => {
    await withRouter({ resolve: async () => { throw new Error('ECONNREFUSED'); } }, async (base) => {
      const body = await (await fetch(`${base}/t/irvings`)).text();
      assert.equal(tapSection(body)['data-dest'], '/?spot=irvings');
    });
  });

  test('a lookup that hangs is cut off, and the ref passes through', async () => {
    await withRouter({ resolve: () => new Promise(() => {}), timeoutMs: 50 }, async (base) => {
      const started = Date.now();
      const body = await (await fetch(`${base}/t/irvings`)).text();
      assert.ok(Date.now() - started < 2000, 'a tap must never wait on the catalogue');
      assert.equal(tapSection(body)['data-dest'], '/?spot=irvings');
    });
  });
});

/* ================= what a tap records (migration-065) ================= */

/**
 * The row src/lib/nfc-taps.js would write, read through createTapRouter's
 * `record` seam instead of a database. The real recorder is exercised by
 * nothing here (no database), so what these hold is the CONTRACT between the
 * route and it: what is counted, against what, and hashed how.
 */
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function recorder() {
  const taps = [];
  return { taps, record: async (t) => { taps.push(t); } };
}

describe('GET /t/<ref> records the tap', () => {
  test('a known slug is counted against the vendor id, with the cookie nonce hashed', async () => {
    const r = recorder();
    await withRouter({ resolve: async (ref) => (ref === 'irvings' ? IRVINGS : null), record: r.record }, async (base) => {
      const res = await fetch(`${base}/t/Irvings`, { headers: { 'user-agent': PHONE } });
      assert.equal(res.status, 200);
      const nonce = (res.headers.get('set-cookie') ?? '').match(new RegExp(`^${NFC_TAP_COOKIE}=([0-9a-f]{32});`))?.[1];
      assert.ok(nonce, 'the cookie was set');

      assert.equal(r.taps.length, 1);
      const [tap] = r.taps;
      assert.equal(tap.ref, 'irvings', 'the ref as the tag carried it, normalised');
      assert.equal(tap.vendorId, 'u-1', 'keyed by the vendor id, so a slug rename keeps the history');
      assert.equal(tap.known, true);
      assert.equal(tap.source, 'web');
      assert.equal(tap.userAgent, PHONE);
      // The hash of the nonce, never the nonce: the table must name nobody.
      assert.equal(tap.visitorHash, sha256(nonce));
      assert.notEqual(tap.visitorHash, nonce);
    });
  });

  test('the same phone tapping twice is one visitor', async () => {
    const r = recorder();
    await withRouter({ resolve: async () => null, record: r.record }, async (base) => {
      const first = await fetch(`${base}/t/nowhere`);
      const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
      assert.match(cookie, new RegExp(`^${NFC_TAP_COOKIE}=`));
      await fetch(`${base}/t/nowhere`, { headers: { cookie } });
      assert.equal(r.taps.length, 2);
      assert.equal(r.taps[0].visitorHash, r.taps[1].visitorHash);
    });
  });

  test('an unknown ref is still a tap, against the ref alone; the bare tag is "generic"', async () => {
    // A tag written with a stale or mistyped slug is exactly what the
    // operator's Unmatched list exists to show, so it must land a row.
    const r = recorder();
    await withRouter({ resolve: async () => null, record: r.record }, async (base) => {
      await fetch(`${base}/t/stale-slug`);
      await fetch(`${base}/t`);
      await fetch(`${base}/t/not%20a%20slug!`);
      assert.deepEqual(
        r.taps.map((t) => [t.ref, t.vendorId, t.known]),
        [['stale-slug', null, false], ['generic', null, false], ['generic', null, false]],
      );
    });
  });

  test('a lookup that fails still counts the tap, as unknown', async () => {
    const r = recorder();
    await withRouter({ resolve: async () => { throw new Error('ECONNREFUSED'); }, record: r.record }, async (base) => {
      await fetch(`${base}/t/irvings`);
      assert.deepEqual(r.taps.map((t) => [t.ref, t.vendorId, t.known]), [['irvings', null, false]]);
    });
  });

  test('a crawler is neither counted nor given a cookie', async () => {
    const r = recorder();
    await withRouter({ resolve: async () => IRVINGS, record: r.record }, async (base) => {
      const res = await fetch(`${base}/t/irvings`, { headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(r.taps.length, 0);
    });
  });

  test('a recorder that throws or rejects cannot fail the tap, or the process', async () => {
    // A rejection nobody listens for takes Node down. The route must own it.
    for (const record of [async () => { throw new Error('boom'); }, () => { throw new Error('sync boom'); }]) {
      await withRouter({ resolve: async () => IRVINGS, record }, async (base) => {
        const res = await fetch(`${base}/t/irvings`);
        assert.equal(res.status, 200);
        assert.equal(tapSection(await res.text())['data-dest'], '/?spot=u-1');
      });
    }
    // Give the deferred write a turn to reject, so a crash would land inside this test.
    await new Promise((r) => setTimeout(r, 20));
  });
});
