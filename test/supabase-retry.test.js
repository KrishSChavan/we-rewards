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
import { retryingFetch } from '../src/lib/supabase.js';

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

test('PATCH, PUT, DELETE and RPC POSTs are all left alone too', async () => {
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
