// Unit tests for the transport retry wrapped around both Supabase clients
// (src/lib/supabase.js). No network: retryingFetch takes its fetch as an
// injectable third argument precisely so this can drive every failure shape.
//
// What makes these worth having is the NEGATIVE cases. The retry exists for one
// observed failure — Cloudflare answering 530 for a moment — and the ways it
// could go wrong are all worse than the bug it fixes: repeating a write would
// award points twice, and repeating a deterministic query error would just make
// a 500 arrive later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  retryingFetch,
  READ_ONLY_RPCS,
  IDEMPOTENT_WRITE_RPCS,
  UPSTREAM_GATEWAY,
} from '../src/lib/supabase.js';

/** A fake fetch that plays the given script, one entry per call. */
function scripted(...steps) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    const step = steps[calls.length - 1];
    if (step instanceof Error) throw step;
    return { status: step, body: `response-${calls.length}` };
  };
  fn.calls = calls;
  return fn;
}

const get = (extra) => ({ method: 'GET', ...extra });

test('a request that succeeds is passed straight through, once', async () => {
  const f = scripted(200);
  const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
});

test('a GET that fails at the transport is retried once and can succeed', async () => {
  // The DNS/connection-level shape: fetch itself throws, so the request
  // provably never reached Postgres.
  const f = scripted(new TypeError('fetch failed'), 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('a GET failing at the transport twice propagates the SECOND error', async () => {
  const first = new TypeError('fetch failed');
  const second = new TypeError('still failing');
  const f = scripted(first, second);
  await assert.rejects(
    () => retryingFetch('https://x/rest/v1/vendors', get(), f),
    (e) => e === second,
  );
  assert.equal(f.calls.length, 2);
});

test('Cloudflare 530 (the 1018 that caused this) is retried', async () => {
  const f = scripted(530, 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('every gateway status that means "origin never reached" is retried', async () => {
  for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
    const f = scripted(status, 200);
    const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
    assert.equal(res.status, 200, `status ${status} should have been retried`);
    assert.equal(f.calls.length, 2, `status ${status} should have been retried`);
  }
});

test('a still-failing gateway hands back the retry\'s response, not the first', async () => {
  const f = scripted(530, 502);
  const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
  assert.equal(res.status, 502);
  assert.equal(res.body, 'response-2');
});

test('HTTP 500 is NOT retried — a PostgREST failure is deterministic', async () => {
  // A missing column or a violated constraint fails identically a beat later;
  // retrying only delays the error the caller has to surface.
  const f = scripted(500, 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
  assert.equal(res.status, 500);
  assert.equal(f.calls.length, 1);
});

test('4xx is NOT retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 416, 429]) {
    const f = scripted(status, 200);
    const res = await retryingFetch('https://x/rest/v1/vendors', get(), f);
    assert.equal(res.status, status);
    assert.equal(f.calls.length, 1, `status ${status} must not be retried`);
  }
});

test('a POST is NEVER retried, at the transport or on a gateway error', async () => {
  // The one that matters: a write that reached Postgres but lost its response
  // is indistinguishable from one that never arrived, so a retry double-awards.
  const boom = new TypeError('fetch failed');
  const thrown = scripted(boom, 200);
  await assert.rejects(
    () => retryingFetch('https://x/rest/v1/transactions', { method: 'POST' }, thrown),
    (e) => e === boom,
  );
  assert.equal(thrown.calls.length, 1);

  const gateway = scripted(530, 200);
  const res = await retryingFetch('https://x/rest/v1/transactions', { method: 'POST' }, gateway);
  assert.equal(res.status, 530);
  assert.equal(gateway.calls.length, 1);
});

test('PATCH, PUT, DELETE and an unlisted POST are all left alone too', async () => {
  // RPC POSTs used to be in this list unconditionally. They are now judged by
  // NAME (see the idempotent-RPC section below); everything that is not an RPC
  // call on the allowlist is still excluded on its verb alone.
  for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
    const f = scripted(530, 200);
    const res = await retryingFetch('https://x/rest/v1/thing', { method }, f);
    assert.equal(res.status, 530, `${method} must not be retried`);
    assert.equal(f.calls.length, 1, `${method} must not be retried`);
  }
});

test('HEAD is retried (PostgREST uses it for count-only reads)', async () => {
  const f = scripted(530, 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', { method: 'HEAD' }, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('a missing method defaults to GET rather than being treated as unsafe', async () => {
  const f = scripted(530, 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', {}, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('a Request object carries its own method', async () => {
  const f = scripted(530, 200);
  const res = await retryingFetch({ method: 'POST', url: 'https://x' }, undefined, f);
  assert.equal(res.status, 530, 'a POST Request must not be retried');
  assert.equal(f.calls.length, 1);
});

test('an aborted caller is not retried — they have already given up', async () => {
  const ac = new AbortController();
  ac.abort();

  const gateway = scripted(530, 200);
  const res = await retryingFetch('https://x/rest/v1/vendors', get({ signal: ac.signal }), gateway);
  assert.equal(res.status, 530);
  assert.equal(gateway.calls.length, 1);

  const boom = new Error('aborted');
  const thrown = scripted(boom, 200);
  await assert.rejects(
    () => retryingFetch('https://x/rest/v1/vendors', get({ signal: ac.signal }), thrown),
    (e) => e === boom,
  );
  assert.equal(thrown.calls.length, 1);
});

test('the retry re-sends the identical input and init', async () => {
  const f = scripted(530, 200);
  const init = get({ headers: { apikey: 'k' } });
  await retryingFetch('https://x/rest/v1/vendors?select=id', init, f);
  assert.equal(f.calls[0].input, f.calls[1].input);
  assert.equal(f.calls[0].init, f.calls[1].init);
});

/* ============================================================
 * The idempotent-RPC exception (the 2026-09-12 earn-code 500).
 *
 * PostgREST mounts every RPC as a POST, so the blanket "no writes" rule above
 * also excluded every READ that happens to be an RPC — and create_earn_code,
 * which writes but cannot double-write. These are the tests that keep that
 * exception narrow: the thing it must never do is retry an award.
 * ============================================================ */

const rpc = (name) => `https://x/rest/v1/rpc/${name}`;

test('the RPC that caused this (create_earn_code) IS retried on a gateway error', async () => {
  const f = scripted(504, 200);
  const res = await retryingFetch(rpc('create_earn_code'), { method: 'POST' }, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('create_earn_code is retried when fetch itself throws, too', async () => {
  const f = scripted(new TypeError('fetch failed'), 200);
  const res = await retryingFetch(rpc('create_earn_code'), { method: 'POST' }, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('every read-only RPC is retried — they cannot write, so a repeat is a re-read', async () => {
  for (const name of READ_ONLY_RPCS) {
    const f = scripted(504, 200);
    const res = await retryingFetch(rpc(name), { method: 'POST' }, f);
    assert.equal(res.status, 200, `${name} should have been retried`);
    assert.equal(f.calls.length, 2, `${name} should have been retried`);
  }
});

test('AN RPC THAT MOVES POINTS IS STILL NEVER RETRIED', async () => {
  // The whole reason the allowlist is a list and not a rule. award_points,
  // claim_receipt, punch_in, redeem_by_code and transfer_community_points each
  // move real value; a second run is a second award or a second spend.
  for (const name of ['award_points', 'claim_receipt', 'punch_in', 'redeem_by_code',
    'transfer_community_points', 'reverse_transaction', 'grant_community_points']) {
    const f = scripted(504, 200);
    const res = await retryingFetch(rpc(name), { method: 'POST' }, f);
    assert.equal(res.status, 504, `${name} must not be retried`);
    assert.equal(f.calls.length, 1, `${name} must not be retried`);
  }
});

test('an unknown RPC is not retried — the allowlist is opt-in, not opt-out', async () => {
  const f = scripted(504, 200);
  const res = await retryingFetch(rpc('some_rpc_added_next_year'), { method: 'POST' }, f);
  assert.equal(res.status, 504);
  assert.equal(f.calls.length, 1);
});

test('a table write whose URL merely CONTAINS an allowlisted name is not retried', async () => {
  // The allowlist is matched against the RPC path, not against the URL. A POST to
  // /rest/v1/earn_codes is an insert into the table, and sharing a substring with
  // create_earn_code must not buy it a retry.
  for (const url of ['https://x/rest/v1/earn_codes', 'https://x/rest/v1/rpc/create_earn_code_v2',
    'https://x/rest/v1/transactions?on_conflict=create_earn_code']) {
    const f = scripted(504, 200);
    const res = await retryingFetch(url, { method: 'POST' }, f);
    assert.equal(f.calls.length, 1, `${url} must not be retried`);
    assert.equal(res.status, 504);
  }
});

test('an allowlisted RPC with a query string is still recognised', async () => {
  const f = scripted(504, 200);
  const res = await retryingFetch(`${rpc('create_earn_code')}?select=code`, { method: 'POST' }, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
});

test('an aborted caller is not retried even for an allowlisted RPC', async () => {
  const ac = new AbortController();
  ac.abort();
  const f = scripted(504, 200);
  const res = await retryingFetch(rpc('create_earn_code'), { method: 'POST', signal: ac.signal }, f);
  assert.equal(res.status, 504);
  assert.equal(f.calls.length, 1);
});

/* ============================================================
 * The proof behind READ_ONLY_RPCS, re-checked against the SQL.
 *
 * The list is only safe because Postgres REFUSES to execute a write inside a
 * non-volatile function. That proof lives in the migrations, not here, so this
 * reads them: the day somebody redefines one of these as volatile (which is the
 * default — it happens by simply omitting the word) this test fails instead of
 * the app quietly retrying a write.
 * ============================================================ */

test('every READ_ONLY_RPC is still declared stable/immutable in its latest migration', async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const name of READ_ONLY_RPCS) {
    // The LAST migration that defines it wins — that is the definition the
    // database is running.
    // Scanned as plain strings rather than a built-up RegExp: the pattern would
    // need four escaping levels to survive (tool → shell → file → template
    // literal), and a silently mangled one here passes by finding nothing.
    let latest = null;
    let body = null;
    for (const f of files) {
      const sql = await readFile(new URL(f, dir), 'utf8');
      const lower = sql.toLowerCase();
      const needle = `function public.${name}`;
      // The DEFINITION, not the grant/revoke/comment lines that name the same
      // function further down the file — those sit after the volatility marker
      // and would make every entry here look un-declared.
      let at = -1;
      for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
        const isDefinition = /create\s+(or\s+replace\s+)?$/.test(lower.slice(Math.max(0, i - 30), i));
        if (isDefinition && /^\s*\(/.test(lower.slice(i + needle.length))) at = i;
      }
      if (at === -1) continue;
      // The declaration is everything between the signature and the body.
      const end = sql.indexOf('$$', at);
      latest = f;
      body = sql.slice(at, end === -1 ? sql.length : end);
    }
    assert.ok(latest, `${name} is in READ_ONLY_RPCS but no migration defines it`);
    assert.match(
      body,
      /\b(stable|immutable)\b/i,
      `${name} is retried as a read-only RPC but ${latest} no longer declares it stable — `
      + 'either restore the declaration or take it out of READ_ONLY_RPCS in src/lib/supabase.js',
    );
  }
});

test('create_earn_code still takes the advisory lock the retry depends on', async () => {
  // IDEMPOTENT_WRITE_RPCS holds exactly one name, and its safety under a
  // CONCURRENT second run is pg_advisory_xact_lock in migration-056. Without
  // that line two attempts can both mint, so this asserts the line is still
  // there — the same role the test above plays for the read-only list.
  assert.deepEqual([...IDEMPOTENT_WRITE_RPCS], ['create_earn_code'],
    'a new idempotent write RPC needs its own proof here');

  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let body = null;
  for (const f of files) {
    const sql = await readFile(new URL(f, dir), 'utf8');
    const m = /create or replace function public\.create_earn_code[\s\S]*?\$\$([\s\S]*?)\$\$;/i.exec(sql);
    if (m) body = m[1];
  }
  assert.ok(body, 'no migration defines create_earn_code');
  assert.match(body, /pg_advisory_xact_lock/,
    'create_earn_code is retried as idempotent, but its latest definition no longer '
    + 'serialises per student — a retry can now mint a second live code');
});

/* ============================================================
 * Normalising a gateway failure into the PostgREST error shape.
 *
 * This is the half of the fix that covers the calls that are NOT retryable. The
 * earn-code 500 was logged as the two words "Gateway Timeout" — the gateway's
 * response body, with no hint of which upstream, which call, or that the request
 * never reached Postgres at all. These use real Response objects because reading
 * and rebuilding the body is the whole behaviour under test.
 * ============================================================ */

const respond = (body, status, type = 'text/plain') =>
  async () => new Response(body, { status, headers: { 'content-type': type } });

test('a gateway 504 with a text body becomes an UPSTREAM_GATEWAY error', async () => {
  // Byte-for-byte the body that produced log 0834ce36 on 2026-09-12.
  const res = await retryingFetch(rpc('award_points'), { method: 'POST' }, respond('Gateway Timeout', 504));
  assert.equal(res.status, 504, 'the status is preserved — it is the honest one');
  const body = await res.json();
  assert.equal(body.code, UPSTREAM_GATEWAY);
  assert.match(body.message, /Database gateway error \(HTTP 504\)/);
  assert.match(body.message, /POST \/rest\/v1\/rpc\/award_points/, 'names the call that failed');
  assert.equal(body.details, 'Gateway Timeout', 'the original body is kept, not thrown away');
  assert.match(body.hint, /Not retried/);
});

test('a retried-and-still-failing call says so, so an outage reads as an outage', async () => {
  const f = scripted(504, 504);
  // scripted() returns plain objects; wrap it in real Responses for this one.
  const doFetch = async (...a) => new Response('Gateway Timeout', { status: (await f(...a)).status });
  const res = await retryingFetch(rpc('create_earn_code'), { method: 'POST' }, doFetch);
  const body = await res.json();
  assert.match(body.hint, /Retried once and it failed again/);
});

test('an HTML error page is normalised too, and capped', async () => {
  const page = `<!DOCTYPE html><html><body>${'x'.repeat(9000)}</body></html>`;
  const res = await retryingFetch('https://x/rest/v1/vendors', { method: 'GET' }, respond(page, 530, 'text/html'));
  const body = await res.json();
  assert.equal(body.code, UPSTREAM_GATEWAY);
  assert.ok(body.details.length <= 500, `details was ${body.details.length} characters`);
});

test('A REAL POSTGREST ERROR IS LEFT ALONE, code and all', async () => {
  // PostgREST answers 503 itself when it cannot get a connection (PGRST001), and
  // that is a real error with a real code. Overwriting it would replace a
  // diagnosable failure with "the gateway is down".
  const pgrst = JSON.stringify({ code: 'PGRST001', message: 'Database client error', details: null, hint: null });
  const res = await retryingFetch('https://x/rest/v1/vendors', { method: 'POST' },
    respond(pgrst, 503, 'application/json'));
  const body = await res.json();
  assert.equal(body.code, 'PGRST001');
  assert.equal(body.message, 'Database client error');
});

test('a statement timeout keeps its 57014, which is NOT an upstream failure', async () => {
  const timeout = JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' });
  const res = await retryingFetch(rpc('create_earn_code'), { method: 'POST' },
    respond(timeout, 504, 'application/json'));
  const body = await res.json();
  assert.equal(body.code, '57014', 'Postgres cancelled the query; the gateway did not give up');
});

test('a successful response is passed through untouched, body unread', async () => {
  const res = await retryingFetch('https://x/rest/v1/vendors', { method: 'GET' },
    respond('[{"id":"v-1"}]', 200, 'application/json'));
  assert.equal(res.status, 200);
  assert.equal(res.bodyUsed, false, 'a 200 body must not be consumed on the way past');
  assert.deepEqual(await res.json(), [{ id: 'v-1' }]);
});

test('a 500 from PostgREST is not dressed up as a gateway failure', async () => {
  const res = await retryingFetch('https://x/rest/v1/vendors', { method: 'GET' },
    respond('boom', 500));
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'boom', '500 is not in the gateway range — left exactly as it came');
});

test('THE QUERY STRING IS NEVER COPIED INTO THE MESSAGE', async () => {
  // PostgREST filters live in the query string, and a live earn code can be one
  // of them. error_logs.message gets none of the redaction requestContext
  // applies to context, and the log is exported into bug reports, so a leak here
  // is permanent.
  const url = 'https://x/rest/v1/earn_codes?code=eq.482913&select=user_id';
  const res = await retryingFetch(url, { method: 'GET' }, respond('Gateway Timeout', 504));
  const body = await res.json();
  assert.doesNotMatch(body.message, /482913/, 'a live code reached the log message');
  assert.doesNotMatch(body.message, /\?/);
  assert.match(body.message, /GET \/rest\/v1\/earn_codes$/);
});

test('an injected fetch that is not a whole Response still works', async () => {
  // The test seam above hands back { status, body } objects. Normalising must not
  // assume more of the injected fetch than retryingFetch itself needs.
  const f = scripted(504);
  const res = await retryingFetch(rpc('award_points'), { method: 'POST' }, f);
  assert.equal(res.status, 504);
  assert.equal(res.body, 'response-1');
});
