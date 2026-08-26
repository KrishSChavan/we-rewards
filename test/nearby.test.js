// The server half of nearby spot alerts (src/lib/nearby.js).
//
// Thin on purpose — every rule that decides whether a student may be
// interrupted lives in claim_nearby_notification, under a row lock, and is
// asserted against a real Postgres in test/sql/behavior-051.sql. The proximity
// maths lives on the phone and is asserted in test/nearby-client.test.js.
//
// What is left here is the seam between the two, and it carries two properties
// that are easy to break and impossible to notice in production:
//
//   1. THE FAILURE DIRECTION. This module is called from a request path to
//      decide whether to interrupt someone in the street. Every way it can go
//      wrong — no migration, a dead database, a thrown client — must come back
//      "no", quietly. A throw here would 500 a claim; a truthy default would
//      notify a student the database never approved.
//
//   2. THE SHARED BUDGET, at the JS boundary. migration-051's caps only mean
//      anything if the values actually forwarded are CAMPAIGN_CONFIG's. A copy
//      of the numbers that drifted would give this feature its own quota
//      silently — the exact thing the migration was written to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimNearby, NEARBY_CONFIG } from '../src/lib/nearby.js';
import { CAMPAIGN_CONFIG } from '../src/lib/campaigns.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/** Swap supabaseAdmin.rpc for the duration of one call and capture its args. */
async function withRpc(impl, fn) {
  const original = supabaseAdmin.rpc;
  const seen = [];
  supabaseAdmin.rpc = async (name, params) => { seen.push({ name, params }); return impl(name, params); };
  try { return { result: await fn(), seen }; }
  finally { supabaseAdmin.rpc = original; }
}

/* ---------- the knobs the client is handed ---------- */

test('the radius and dwell have sane defaults', () => {
  assert.equal(NEARBY_CONFIG.radiusMeters, 150);
  assert.equal(NEARBY_CONFIG.dwellSeconds, 30);
});

test('nothing about the throttle is exposed to the browser', () => {
  // A client that believed it knew the caps would be tempted to decide for
  // itself and skip the claim — at which point the shared budget stops being
  // shared. These are enforced in SQL and must stay invisible here.
  for (const leak of ['dailyCap', 'weeklyCap', 'cooldownMinutes', 'quietStart', 'quietEnd']) {
    assert.ok(!(leak in NEARBY_CONFIG), `${leak} must not be served to the client`);
  }
});

/* ---------- the failure direction ---------- */

test('a missing user or vendor never reaches the database', async () => {
  const { result, seen } = await withRpc(
    () => ({ data: true, error: null }),
    async () => [
      await claimNearby(null, 'v'),
      await claimNearby('u', null),
      await claimNearby(undefined, undefined),
      await claimNearby('', ''),
    ],
  );
  assert.deepEqual(result, [false, false, false, false]);
  assert.equal(seen.length, 0, 'a half-formed claim was still sent to the database');
});

test('a missing migration is a quiet no, not a crash', async () => {
  // What an unapplied migration-051 actually looks like: PostgREST cannot find
  // the function. The feature has to be silently off, not 500 every claim.
  const { result } = await withRpc(
    () => ({ data: null, error: { message: 'Could not find the function public.claim_nearby_notification' } }),
    () => claimNearby('u', 'v'),
  );
  assert.equal(result, false);
});

test('a thrown client is a quiet no too', async () => {
  const { result } = await withRpc(
    () => { throw new Error('socket hang up'); },
    () => claimNearby('u', 'v'),
  );
  assert.equal(result, false);
});

test('only a literal true is treated as permission', async () => {
  // The RPC returns a boolean. Anything else — null from an error path, a
  // stringified body, an empty array — means we did not get an answer, and
  // "did not get an answer" must never become "go ahead and interrupt them".
  for (const data of [null, undefined, 'true', 1, {}, [], [true], 'f', false]) {
    const { result } = await withRpc(() => ({ data, error: null }), () => claimNearby('u', 'v'));
    assert.equal(result, false, `${JSON.stringify(data)} was treated as permission`);
  }
  const { result } = await withRpc(() => ({ data: true, error: null }), () => claimNearby('u', 'v'));
  assert.equal(result, true);
});

/* ---------- the shared budget ---------- */

test('the caps forwarded are the campaign worker’s own, not a second copy', async () => {
  const { seen } = await withRpc(() => ({ data: true, error: null }), () => claimNearby('u-1', 'v-1'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'claim_nearby_notification');
  const p = seen[0].params;
  assert.equal(p.p_user_id, 'u-1');
  assert.equal(p.p_vendor_id, 'v-1');
  assert.equal(p.p_cooldown_minutes, CAMPAIGN_CONFIG.cooldownMinutes);
  assert.equal(p.p_daily_cap, CAMPAIGN_CONFIG.dailyCap);
  assert.equal(p.p_weekly_cap, CAMPAIGN_CONFIG.weeklyCap);
  assert.equal(p.p_quiet_start, CAMPAIGN_CONFIG.quietStart);
  assert.equal(p.p_quiet_end, CAMPAIGN_CONFIG.quietEnd);
  assert.equal(p.p_timezone, CAMPAIGN_CONFIG.timezone);
});

test('no coordinates are sent, only the spot', async () => {
  // The Privacy Policy (§2.9) says the server learns which spot you were next
  // to and never where you are. This is that promise, as an assertion.
  const { seen } = await withRpc(() => ({ data: true, error: null }), () => claimNearby('u', 'v'));
  const keys = Object.keys(seen[0].params).join(' ');
  for (const bad of ['lat', 'lon', 'lng', 'coord', 'accuracy', 'position']) {
    assert.ok(!keys.includes(bad), `the claim carries "${bad}" — coordinates must never leave the phone`);
  }
});
