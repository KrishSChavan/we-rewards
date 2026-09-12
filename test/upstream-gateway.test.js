// End to end: what a client and the operator's error log get when SUPABASE'S
// GATEWAY fails, rather than Postgres.
//
// This is the 2026-09-12 earn-code 500 (log 0834ce36) wired all the way up. The
// gateway answered a PostgREST call with 504 and the plain-text body "Gateway
// Timeout"; postgrest-js cannot parse that as JSON, so the route threw
// { message: 'Gateway Timeout' } — a plain object with no code and no stack — the
// central handler matched it against nothing, and a student was told
// "Something went wrong" while the operator got a push about a server fault in
// code that was working perfectly.
//
// THE ROUTE UNDER TEST IS NOT /api/me/earn-code. That one needs a real Supabase
// JWT. POST /api/apply is unauthenticated, ends in `if (error) throw error` over
// a plain table insert, and therefore exercises the identical path through the
// central handler — which is the part of the chain that was wrong for EVERY
// route, not just the earn-code one.
//
// No database: the stub below answers only requests bound for Supabase, so the
// test's own requests to the app still go out over the real fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';

const SUPABASE_HOST = new URL(process.env.SUPABASE_URL).host;
const realFetch = globalThis.fetch;

/**
 * Every Supabase call answers `status` with `body`; everything else is real.
 *
 * Returns the call log, each entry carrying the request body as well as the path
 * — the error_logs INSERT is itself a Supabase call, so the row the operator
 * would have read in /admin arrives here and can be asserted on directly.
 */
function stubSupabase(status, body, contentType = 'text/plain') {
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input ?? '');
    if (!url.includes(SUPABASE_HOST)) return realFetch(input, init);
    seen.push({
      call: `${init?.method ?? 'GET'} ${new URL(url).pathname}`,
      sent: (() => {
        try { return JSON.parse(init?.body ?? 'null'); } catch { return init?.body ?? null; }
      })(),
    });
    return new Response(body, { status, headers: { 'content-type': contentType } });
  };
  return seen;
}

/** The error_logs row this request would have written, or undefined. */
const loggedRow = (seen) => seen.find((c) => c.call.includes('/rest/v1/error_logs'))?.sent;

const APPLICATION = {
  businessName: 'Joe’s Pizza',
  contactName: 'Joe',
  phone: '814 555 0100',
  email: 'gateway-test@example.com',
  password: 'a-good-password',
  rewards: [{ title: 'Free small coffee', spend: 25, emoji: '☕' }],
};

let port = 0;
let listener = null;

before(async () => {
  listener = await new Promise((resolve, reject) => {
    const l = app.listen(0);
    l.once('listening', () => resolve(l));
    l.once('error', reject);
  });
  port = listener.address().port;
});

after(async () => {
  globalThis.fetch = realFetch;
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
});

/**
 * POST /api/apply from a FRESH CLIENT IP each time.
 *
 * applyLimiter allows 5 per IP per 15 minutes, and this file makes more calls
 * than that — without this every test after the fifth gets a 429 and the file
 * reads as a pile of unrelated failures. The app runs with `trust proxy` = 1
 * (it is behind a PaaS router in production), so X-Forwarded-For is what
 * express-rate-limit keys on, exactly as it is for real traffic.
 */
let clientIp = 0;
const apply = (body = APPLICATION) => realFetch(`http://127.0.0.1:${port}/api/apply`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Forwarded-For': `203.0.113.${(clientIp += 1) % 250}`,
  },
  body: JSON.stringify(body),
});

test('A GATEWAY 504 IS ANSWERED 503, NOT 500', async () => {
  stubSupabase(504, 'Gateway Timeout');
  const res = await apply();
  assert.equal(res.status, 503, 'somebody else being down is not this server failing');
  const body = await res.json();
  assert.equal(body.error, 'UPSTREAM_UNAVAILABLE');
  assert.match(body.message, /try that again in a moment/i);
  assert.doesNotMatch(body.message, /something went wrong/i);
});

test('the message logged names the upstream, the status AND the failing call', async () => {
  // What the operator used to get was the two words "Gateway Timeout". The whole
  // point of normalising is that the log row now says which call it was — so the
  // same push that used to start a bug hunt ends one.
  const seen = stubSupabase(504, 'Gateway Timeout');
  await apply();

  assert.ok(seen.some((c) => c.call === 'POST /rest/v1/vendor_applications'),
    'the route never reached its insert');

  const row = loggedRow(seen);
  assert.ok(row, `the failure was never logged — calls: ${seen.map((c) => c.call).join(', ')}`);
  assert.notEqual(row.message, 'Gateway Timeout', 'this is the bare message the fix exists to replace');
  assert.match(row.message, /Database gateway error \(HTTP 504\)/);
  assert.match(row.message, /\/rest\/v1\/vendor_applications/, 'names the call that failed');
  assert.equal(row.status, 503, 'logged as an upstream failure, not as a 500');
  assert.equal(row.path, '/api/apply', 'and still says which of OUR routes the caller hit');
});

test('every gateway status in the range behaves the same way', async () => {
  for (const status of [502, 503, 504, 520, 521, 522, 530]) {
    stubSupabase(status, 'Bad Gateway');
    const res = await apply();
    assert.equal(res.status, 503, `HTTP ${status} from the gateway should answer 503`);
    assert.equal((await res.json()).error, 'UPSTREAM_UNAVAILABLE');
  }
});

test('A REAL POSTGREST FAILURE IS STILL A 500 — this must not hide our own bugs', async () => {
  // The risk in the branch above is that it swallows real breakage. A PostgREST
  // 500 (a bad column, a violated constraint, a missing migration) is a bug in
  // this repo and has to keep reading as one.
  stubSupabase(500, JSON.stringify({
    code: '42703', message: 'column vendor_applications.rewards does not exist',
  }), 'application/json');
  const res = await apply();
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'SERVER_ERROR');
});

test('a JSON error carried on a GATEWAY status keeps its own code', async () => {
  // PostgREST answers 503 itself when it cannot get a database connection, and
  // PGRST001 is a different diagnosis from "the gateway never reached Postgres" —
  // it can be a connection-pool size we chose. So the status being in the gateway
  // range is NOT sufficient: an error that came back as JSON carries its own
  // code, keeps it, and stays a 500 that an operator will investigate.
  stubSupabase(503, JSON.stringify({ code: 'PGRST001', message: 'Database client error' }), 'application/json');
  const res = await apply();
  assert.equal(res.status, 500, 'an error with its own PostgREST code is not an upstream gateway failure');
  assert.equal((await res.json()).error, 'SERVER_ERROR');
});

test('a 4xx from the table is still handled by the route, not the gateway branch', async () => {
  // The duplicate-application path: 23505 must keep answering 409.
  stubSupabase(409, JSON.stringify({ code: '23505', message: 'duplicate key value' }), 'application/json');
  const res = await apply();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'DUPLICATE_APPLICATION');
});

test('a bad application is still a 400 and never reaches Supabase at all', async () => {
  const seen = stubSupabase(504, 'Gateway Timeout');
  const res = await apply({ ...APPLICATION, email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0, 'validation runs before any database call');
});

/* ============================================================
 * WHICH VENDOR, end to end.
 *
 * Two halves, both of which used to come out anonymous:
 *   • a CLIENT crash posts the spot it was looking at (public/student/app.js,
 *     public/vendor/terminal.js, public/scan/scan.js) and the server stores that
 *     context verbatim;
 *   • a SERVER failure is attributed by requestContext from whatever the request
 *     carried (src/lib/errors.js — unit-tested in test/error-context.test.js).
 * ============================================================ */

test('a client crash carries its vendor all the way into the error log row', async () => {
  const seen = stubSupabase(201, JSON.stringify([{ id: 'log-1' }]), 'application/json');
  const res = await realFetch(`http://127.0.0.1:${port}/api/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.251' },
    body: JSON.stringify({
      source: 'student',
      message: "Cannot read properties of null (reading 'textContent')",
      url: '/student/',
      // What crashContext() now sends when a student is on a spot screen.
      context: { tab: 'spot', vendor: 'Yallah Taco', vendorId: 'v-7', online: true },
    }),
  });
  assert.equal(res.status, 204);

  const row = loggedRow(seen);
  assert.ok(row, 'the crash was not logged');
  assert.equal(row.context.vendor, 'Yallah Taco');
  assert.equal(row.context.vendorId, 'v-7', 'the id survives too — a chain shares one name');
  assert.equal(row.source, 'student');
});

test('a server failure records the request that caused it, for the same row', async () => {
  // requestContext is what fills this in; here it is only being shown to be
  // WIRED to the central handler, which is the part a unit test cannot see.
  const seen = stubSupabase(504, 'Gateway Timeout');
  await apply();
  const row = loggedRow(seen);
  assert.equal(row.context.body.businessName, 'Joe’s Pizza');
  assert.equal(row.context.body.password, '[redacted]', 'still redacted on the way in');
});
