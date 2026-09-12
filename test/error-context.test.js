// Unit tests for requestContext (src/lib/errors.js) — the blob attached to every
// logged 500 so the /admin error log can say what the request was FOR, not just
// which path threw.
//
// The reason this has tests at all is the redaction rule. error_logs is read in
// the dashboard, exported into bug reports, and never re-audited afterwards, so
// a value that lands there is there for good. Anything credential-shaped must be
// replaced by a marker on the way in, not filtered on the way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext, vendorFromRequest } from '../src/lib/errors.js';

const req = (over = {}) => ({ headers: {}, query: {}, body: {}, ...over });

test('a bare request with nothing to say produces null, not an empty object', () => {
  assert.equal(requestContext(req()), null);
  assert.equal(requestContext(null), null);
});

test('query and body fields are recorded so the failure can be reproduced', () => {
  const ctx = requestContext(req({
    query: { audience: 'top', from: '1' },
    body: { exactAmount: 12.5 },
  }));
  assert.deepEqual(ctx.query, { audience: 'top', from: '1' });
  assert.deepEqual(ctx.body, { exactAmount: '12.5' });
});

test('credentials and single-use secrets are redacted, never logged', () => {
  const ctx = requestContext(req({
    body: {
      password: 'hunter2', pin: '1234', code: '482913', token: 'ey.jwt',
      apiKey: 'sk-live', logo: 'data:image/png;base64,AAAA', image: 'data:image/jpeg;base64,BBBB',
    },
  }));
  for (const [k, v] of Object.entries(ctx.body)) {
    assert.equal(v, '[redacted]', `${k} should have been redacted, got ${JSON.stringify(v)}`);
  }
});

test('a redemption token in the query string is redacted as well', () => {
  const ctx = requestContext(req({ query: { t: 'x', token: 'secret-value' } }));
  assert.equal(ctx.query.token, '[redacted]');
  assert.equal(ctx.query.t, 'x');
});

test('structured values become type markers rather than serialised payloads', () => {
  const ctx = requestContext(req({ body: { tiers: [1, 2, 3], keys: { a: 1 }, note: null } }));
  assert.equal(ctx.body.tiers, '[array · 3]');
  assert.equal(ctx.body.keys, '[redacted]', 'a field named "keys" is a push subscription secret');
  assert.equal(ctx.body.note, null);
});

test('a long value is truncated so one request cannot bloat the table', () => {
  const ctx = requestContext(req({ body: { title: 'x'.repeat(5000) } }));
  assert.ok(ctx.body.title.length <= 201, `got ${ctx.body.title.length} characters`);
  assert.ok(ctx.body.title.endsWith('…'));
});

test('a body with more fields than the cap is summarised, not dropped', () => {
  const body = {};
  for (let i = 0; i < 40; i++) body[`f${i}`] = i;
  const ctx = requestContext(req({ body }));
  assert.equal(Object.keys(ctx.body).length, 26, '25 fields plus the "more fields" note');
  assert.match(ctx.body['…'], /15 more fields/);
});

test('who and where ride along: the signed-in user, the vendor, and the page', () => {
  const ctx = requestContext(req({
    user: { id: 'u-1', email: 'staff@example.com' },
    vendor: { id: 'v-1', name: 'Local Eats' },
    headers: { referer: 'https://we-rewards.com/terminal' },
  }));
  assert.equal(ctx.actorEmail, 'staff@example.com');
  assert.equal(ctx.actorId, 'u-1');
  assert.equal(ctx.vendor, 'Local Eats');
  assert.equal(ctx.vendorId, 'v-1');
  assert.equal(ctx.referer, 'https://we-rewards.com/terminal');
});

test('an array body (not an object) is ignored rather than indexed field by field', () => {
  assert.equal(requestContext(req({ body: [1, 2, 3] })), null);
});

/* ============================================================
 * WHICH VENDOR. "Which spot was this?" is the first question asked about almost
 * every failure, and the answer was in the request unread: only req.vendor (the
 * terminal's own row) was ever recorded, so a student redeeming at a counter, an
 * operator editing a spot and a public /spots page all logged an anonymous uuid
 * at best.
 *
 * `lookup` is injected here. In the app it is the in-memory vendor catalogue
 * (src/lib/cache.js → lookupVendor), and these tests are about which candidates
 * requestContext FINDS and which it is willing to believe, not about the cache.
 * ============================================================ */

const CATALOGUE = {
  '11111111-1111-1111-1111-111111111111': { id: '11111111-1111-1111-1111-111111111111', name: 'Yallah Taco' },
  'yallah-taco': { id: '11111111-1111-1111-1111-111111111111', name: 'Yallah Taco' },
};
const lookup = (k) => CATALOGUE[String(k).toLowerCase()] ?? null;

test('an authenticated vendor is named from req.vendor, as before', () => {
  const v = vendorFromRequest(req({ vendor: { id: 'v-1', name: 'Local Eats' } }), lookup);
  assert.equal(v.name, 'Local Eats');
  assert.equal(v.id, 'v-1');
});

test('req.vendor wins over everything else — it is the resolved row', () => {
  // A deactivated vendor is NOT in the catalogue, so this is also the path that
  // keeps the operator's own terminal session named while a spot is switched off.
  const v = vendorFromRequest(req({
    vendor: { id: 'v-1', name: 'Switched Off Spot' },
    body: { vendorId: '11111111-1111-1111-1111-111111111111' },
  }), lookup);
  assert.equal(v.name, 'Switched Off Spot');
});

test('A STUDENT REDEEMING IS ATTRIBUTED FROM THE BODY, WITH A NAME', () => {
  // POST /api/me/redeem-code carries vendorId in the body and has no req.vendor.
  // Before this, the log row said nothing but a bare uuid inside the body blob.
  const ctx = requestContext(req({
    user: { id: 'u-1', email: 'smg7590@psu.edu' },
    body: { vendorId: '11111111-1111-1111-1111-111111111111', rewardId: 'r-1', paidWith: 'points' },
  }), lookup);
  assert.equal(ctx.vendor, 'Yallah Taco');
  assert.equal(ctx.vendorId, '11111111-1111-1111-1111-111111111111');
});

test('a vendor id in the QUERY STRING is found too', () => {
  const v = vendorFromRequest(req({ query: { vendorId: '11111111-1111-1111-1111-111111111111' } }), lookup);
  assert.equal(v.name, 'Yallah Taco');
});

test('snake_case and spotId spellings are both recognised', () => {
  for (const key of ['vendor_id', 'spotId', 'spot_id']) {
    const v = vendorFromRequest(req({ body: { [key]: '11111111-1111-1111-1111-111111111111' } }), lookup);
    assert.equal(v?.name, 'Yallah Taco', `${key} was not recognised`);
  }
});

test('THE URL IS READ, because req.params is gone by the time an error lands', () => {
  // Express restores req.params as each router unwinds, so the central error
  // handler sees {} — measured. originalUrl is what survives.
  const v = vendorFromRequest(req({
    params: {},
    originalUrl: '/api/vendor-logo/11111111-1111-1111-1111-111111111111',
  }), lookup);
  assert.equal(v.name, 'Yallah Taco');
});

test('a public /spots page is attributed by slug', () => {
  const v = vendorFromRequest(req({ originalUrl: '/spots/yallah-taco' }), lookup);
  assert.equal(v.name, 'Yallah Taco');
  assert.equal(v.id, '11111111-1111-1111-1111-111111111111');
});

test('an operator editing a spot is attributed from the admin path', () => {
  const v = vendorFromRequest(req({
    originalUrl: '/api/admin/vendors/11111111-1111-1111-1111-111111111111/rewards',
  }), lookup);
  assert.equal(v.name, 'Yallah Taco');
});

test('a query string on the path is not mistaken for a path segment', () => {
  const v = vendorFromRequest(req({ originalUrl: '/spots/yallah-taco?from=email' }), lookup);
  assert.equal(v.name, 'Yallah Taco');
});

test('AN UNKNOWN UUID IN A PATH IS NOT LABELLED A VENDOR', () => {
  // A reward id, a transaction id and a user id are all indistinguishable from a
  // vendor id. Claiming the wrong spot is worse than claiming none, so a bare
  // uuid counts only when the catalogue confirms it.
  assert.equal(vendorFromRequest(req({ originalUrl: '/api/me/history/99999999-9999-9999-9999-999999999999' }), lookup), null);
});

test('...but a uuid the catalogue DOES know is picked up wherever it sits', () => {
  // Costs nothing and covers routes added later with no wiring.
  const v = vendorFromRequest(req({
    originalUrl: '/api/some/route/added/later/11111111-1111-1111-1111-111111111111/thing',
  }), lookup);
  assert.equal(v.name, 'Yallah Taco');
});

test('an unresolvable id the request NAMED is still logged, unnamed', () => {
  // The catalogue holds active vendors only, and it may simply be cold. An id the
  // operator can paste into the Spots tab beats no vendor at all.
  const v = vendorFromRequest(req({ body: { vendorId: '22222222-2222-2222-2222-222222222222' } }), lookup);
  assert.equal(v.name, null);
  assert.equal(v.id, '22222222-2222-2222-2222-222222222222');
});

test('an unresolvable SLUG is reported as a slug, not as an id', () => {
  const ctx = requestContext(req({ originalUrl: '/spots/a-spot-that-was-deleted' }), lookup);
  assert.equal(ctx.vendorSlug, 'a-spot-that-was-deleted');
  assert.equal(ctx.vendorId, undefined);
});

test('a mangled percent-escape in the path is not a vendor', () => {
  // GET /spots/% reaches the error handler as a URIError; decodeURIComponent
  // would throw a SECOND time inside the logger and lose the row entirely.
  assert.doesNotThrow(() => vendorFromRequest(req({ originalUrl: '/spots/%' }), lookup));
  assert.equal(vendorFromRequest(req({ originalUrl: '/spots/%zz' }), lookup).slug, '%zz');
});

test('a request with no vendor anywhere says so, rather than guessing', () => {
  assert.equal(vendorFromRequest(req({ originalUrl: '/api/me/earn-code' }), lookup), null);
  assert.equal(vendorFromRequest(null, lookup), null);
  assert.equal(requestContext(req({ originalUrl: '/api/me/earn-code' }))?.vendor, undefined);
});

test('the real lookup is used by default and never throws on a cold cache', () => {
  // requestContext must work with no catalogue loaded at all — which is exactly
  // the state a process is in when its first request is the one that fails.
  const ctx = requestContext(req({
    body: { vendorId: '11111111-1111-1111-1111-111111111111' },
    user: { id: 'u-1', email: 'a@b.c' },
  }));
  assert.equal(ctx.vendorId, '11111111-1111-1111-1111-111111111111');
  assert.equal(ctx.vendor, undefined, 'no name is available with nothing cached');
});
