// Unit tests for the trackable-QR primitives (src/lib/tracked-qr.js) — the
// halves that decide things before any query runs.
//
// Three of these guard something that fails silently in production if it
// breaks. The code alphabet is what someone reads off a banner when the print
// didn't scan, so a lookalike glyph creeping in costs a real scan. The cookie
// parser is the only thing standing between a hand-crafted Cookie header and a
// row in the scans table. And the bot filter decides which requests become
// numbers an operator will later quote at somebody.
//
// The payout itself is asserted in SQL (test/sql/behavior-050.sql), against the
// real grant_community_points rail rather than a mock of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintCode, normalizeCode, CODE_ALPHABET, CODE_LENGTH,
  readVisitorCookie, visitorCookieOptions, TRACKED_QR_COOKIE,
  isLikelyBot,
} from '../src/lib/tracked-qr.js';
import { csvCell } from '../src/routes/admin.js';

/* ---------- the code in the URL ---------- */

test('a minted code is the advertised length and alphabet', () => {
  for (let i = 0; i < 500; i += 1) {
    const c = mintCode();
    assert.equal(c.length, CODE_LENGTH);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
  }
});

test('the alphabet contains no glyph that can be misread aloud or in print', () => {
  // The one time a human touches this string is reading it off a banner whose
  // QR would not scan. 0/O, 1/l/I are the pairs that cost a real scan.
  for (const bad of ['0', 'o', '1', 'l', 'i', 'O', 'L', 'I']) {
    assert.ok(!CODE_ALPHABET.includes(bad), `${bad} should not be in the alphabet`);
  }
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length, 'no duplicate symbols');
});

test('minted codes do not repeat in bulk', () => {
  // Not a proof of uniqueness — the UNIQUE column and the retry loop in
  // createTrackedQr are that. This catches a broken RNG returning a constant.
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(mintCode());
  assert.equal(seen.size, 5000);
});

test('a code is forgiven case and surrounding space, and nothing else', () => {
  const c = mintCode();
  assert.equal(normalizeCode(c), c);
  assert.equal(normalizeCode(`  ${c.toUpperCase()}  `), c, 'a phone keyboard capitalises the first letter');
});

test('anything that is not a code is refused rather than queried', () => {
  const bad = [
    '', '   ', 'abc', 'a'.repeat(9), '0'.repeat(8), 'aaaaaaa1',
    'aaaa aaa', 'aaaaaa!!', null, undefined, 12345678, {}, [],
    "' or 1=1 --", '../../etc', 'aaaaaaa\n',
  ];
  for (const raw of bad) {
    assert.equal(normalizeCode(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

/* ---------- the visitor cookie ---------- */

const cookieReq = (raw) => ({ headers: raw == null ? {} : { cookie: raw } });
const NONCE = 'a'.repeat(32);

test('our cookie is found among the others the browser sends', () => {
  const code = mintCode();
  const got = readVisitorCookie(cookieReq(`sb-access=xyz; ${TRACKED_QR_COOKIE}=${NONCE}.${code}; other=1`));
  assert.equal(got.code, code);
  assert.equal(got.nonce, NONCE);
  assert.equal(got.hash.length, 64, 'a SHA-256 hex digest');
});

test('the same nonce always hashes the same way, and a different one does not', () => {
  const code = mintCode();
  const a = readVisitorCookie(cookieReq(`${TRACKED_QR_COOKIE}=${NONCE}.${code}`));
  const b = readVisitorCookie(cookieReq(`${TRACKED_QR_COOKIE}=${NONCE}.${code}`));
  const c = readVisitorCookie(cookieReq(`${TRACKED_QR_COOKIE}=${'b'.repeat(32)}.${code}`));
  // This is what makes the unique-visitor count mean anything: one phone
  // scanning twice has to land on one hash, and two phones must not collide.
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});

test('the raw nonce is never what gets stored', () => {
  const got = readVisitorCookie(cookieReq(`${TRACKED_QR_COOKIE}=${NONCE}.${mintCode()}`));
  assert.notEqual(got.hash, got.nonce, 'the hash must not be the nonce itself');
  assert.ok(!got.hash.includes(NONCE));
});

test('a malformed or absent cookie yields null, never a partial read', () => {
  const bad = [
    null,
    '',
    'other=1',
    `${TRACKED_QR_COOKIE}=`,
    `${TRACKED_QR_COOKIE}=nope`,
    `${TRACKED_QR_COOKIE}=${NONCE}`,                       // no code half
    `${TRACKED_QR_COOKIE}=${NONCE}.`,                      // empty code
    `${TRACKED_QR_COOKIE}=${NONCE}.TOOLONGCODE`,
    `${TRACKED_QR_COOKIE}=${'z'.repeat(32)}.aaaaaaaa`,     // nonce not hex
    `${TRACKED_QR_COOKIE}=${NONCE}.aaaaaaa!`,              // code not in alphabet
  ];
  for (const raw of bad) {
    assert.equal(readVisitorCookie(cookieReq(raw)), null, `should reject ${JSON.stringify(raw)}`);
  }
});

test('the cookie is set with the options attribution depends on', () => {
  const o = visitorCookieOptions();
  // httpOnly: page JS must not be able to read or plant it.
  assert.equal(o.httpOnly, true);
  // ⚠ Lax, not Strict. The visitor scans, then signs in with Google, and comes
  // back on a top-level cross-site redirect. Strict drops the cookie on exactly
  // that hop, which is the one hop the whole feature depends on.
  assert.equal(o.sameSite, 'lax');
  // Path must be '/', and the clearCookie in accept-terms must match it.
  assert.equal(o.path, '/');
  assert.equal(o.maxAge, 30 * 24 * 60 * 60 * 1000);
  assert.equal(o.secure, process.env.NODE_ENV === 'production');
});

/* ---------- link previews are not people ---------- */

test('a real phone scanning a poster is counted', () => {
  // The expensive failure direction: a missed crawler costs one phantom scan,
  // but misjudging a real user-agent silently drops a student's scan and there
  // is no way to notice it happened.
  const real = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (iPad; CPU OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/604.1',
  ];
  for (const ua of real) assert.equal(isLikelyBot(ua), false, `should count: ${ua.slice(0, 40)}…`);
});

test('the crawlers that fetch a pasted poster link are not counted', () => {
  // Every one of these fires when the URL is pasted into a chat. Counting them
  // would inflate exactly the banners that got shared the most.
  const bots = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'curl/8.4.0',
    'Wget/1.21.3',
    'python-requests/2.31.0',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/122.0.0.0 Safari/537.36',
  ];
  for (const ua of bots) assert.equal(isLikelyBot(ua), true, `should skip: ${ua.slice(0, 40)}…`);
});

test('a missing user-agent is treated as a person, not a bot', () => {
  // A scan with no UA is far more likely to be a stripped-down mobile browser
  // than a crawler, and the cost of guessing wrong falls on a real student.
  for (const ua of ['', null, undefined]) assert.equal(isLikelyBot(ua), false);
});

/* ---------- CSV ---------- */

test('a cell that would parse wrong is quoted', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('HUB, east'), '"HUB, east"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0', 'a zero count is a number, not a blank');
});

test('a cell that a spreadsheet would EXECUTE is defused', () => {
  // Excel and Sheets evaluate a cell starting with = + - or @ as a formula. The
  // operator types the banner names, which makes this a foot-gun rather than an
  // attack — but the user-agent column arrives from the open internet.
  for (const raw of ['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://x")']) {
    assert.ok(csvCell(raw).startsWith("'") || csvCell(raw).startsWith('"\''),
      `${raw} should be defused, got ${csvCell(raw)}`);
  }
  // And the defusing must not corrupt an ordinary negative-looking name.
  assert.equal(csvCell('HUB-east'), 'HUB-east');
});

/* ---------- GET /r/:code, the paths that never reach the database ----------

   These exist because the bug they cover was INVISIBLE to unit tests: Express
   decodes :code inside Layer.match, before the handler body runs, so a
   malformed percent-escape threw past the route's own try/catch and came back
   as a 500 with an error_logs row — on an unauthenticated endpoint that a
   crawler can hit 600 times a quarter-hour. Worse, the decode error embeds the
   raw param and server.js matches known error codes by SUBSTRING, so
   /r/%zzREWARD_NOT_FOUND answered 404 REWARD_NOT_FOUND.

   Every case below is rejected before any query is attempted, so this needs no
   database — which is the whole reason it can live in the always-on suite. */
import express from 'express';
import http from 'node:http';
import trackedQrRoutes from '../src/routes/tracked-qr.js';

function withServer(fn) {
  const app = express();
  app.use('/r', trackedQrRoutes);
  // Stands in for server.js's central error handler, so a leak past the
  // router's guard shows up here as a 500 exactly as it would in production.
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'SERVER_ERROR' }));
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
      try { resolve(await fn(`http://127.0.0.1:${server.address().port}`)); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

/**
 * ⚠ NOT fetch(). undici percent-ENCODES a raw '%' in the path to '%25' before
 * it goes out, so fetch('/r/%') arrives as '/r/%25', decodes cleanly to '%',
 * and is rejected by normalizeCode in the handler — the decode failure this
 * whole block exists to cover never happens. That made the first version of
 * these tests pass with the guard deliberately disabled, which is to say it
 * made them worthless. http.request sends the path byte-for-byte, the way a
 * scanner or a chat client that mangled the link would.
 */
function get(base, path) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('an undecodable code redirects home instead of 500ing', async () => {
  await withServer(async (base) => {
    for (const path of ['/r/%', '/r/%zz', '/r/a%E0%A4%A', '/r/%2']) {
      const res = await get(base, path);
      assert.equal(res.status, 302, `${path} should redirect, not error`);
      assert.equal(res.headers.get('location'), '/', `${path} should land on the app`);
      // The failure paths must be uncacheable too, or Cloudflare pins them.
      assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${path} must not be cacheable`);
    }
  });
});

test('a caller cannot steer the central error handler through the code', async () => {
  // server.js maps known error codes by substring against the message, and the
  // decode error quotes the param back. If this ever 404s REWARD_NOT_FOUND
  // again, the guard has stopped catching decode failures.
  await withServer(async (base) => {
    for (const probe of ['REWARD_NOT_FOUND', 'GRANT_ALREADY_PAID', 'NOT_ADMIN']) {
      const res = await get(base, `/r/%zz${probe}`);
      assert.equal(res.status, 302, `${probe} must not be reachable through a bad escape`);
      assert.equal(res.headers.get('location'), '/');
    }
  });
});

test('a well-formed but impossible code is refused before any query', async () => {
  // Wrong length, or a glyph the alphabet deliberately excludes. normalizeCode
  // rejects these in the handler, so no database is touched and the visitor
  // still lands somewhere useful — the QR is printed on a wall.
  await withServer(async (base) => {
    for (const path of ['/r/abc', '/r/aaaaaaaaa', '/r/00000000', '/r/AAAA1111']) {
      const res = await get(base, path);
      assert.equal(res.status, 302, `${path} should redirect`);
      assert.equal(res.headers.get('location'), '/');
    }
  });
});
