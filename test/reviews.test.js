// Spot reviews (migration-066): src/lib/reviews.js, POST /api/me/reviews/:id,
// the /spots page section, and the two rules the whole feature is shaped by.
//
//   1. Points pay for the review WE hold, and the Google link after it is
//      offered at EVERY rating and pays nothing. Google forbids incentives for
//      its reviews and forbids "review gating"; the penalty lands on the
//      vendor's listing. The source-text guards at the bottom exist because the
//      natural "improvement" to this feature is to break one of them.
//   2. A FIRST review needs presence: a visit at the spot in the last 24h, or
//      the phone within the radius. Edits need neither and pay nothing.
//
// Supabase is stubbed by patching globalThis.fetch (the same harness shape as
// test/notification-call-sites.test.js) and supabaseAdmin.rpc is swapped
// directly. The route is called through the router's own stack with
// requireConsent skipped, so req.profile is supplied the way it would set it.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { resetAllCaches } from '../src/lib/cache.js';
import {
  validGoogleReviewUrl,
  validReviewPoints,
  parseReviewInput,
  reviewAuthorName,
  metersBetween,
  checkOnsite,
  REVIEW_CONFIG,
} from '../src/lib/reviews.js';
import { spotPageHtml } from '../src/lib/spots-page.js';
import studentRouter, { mergeHistory } from '../src/routes/student.js';

const STUDENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VENDOR = 'fafafafa-bcbc-4ded-8efe-abababababab';
// Old Main, State College. A degree of latitude is ~111 km, so 0.0005° is ~55 m.
const SPOT = { lat: 40.7964, lng: -77.8627 };

/* ---------- the operator's settings ---------- */

describe('validGoogleReviewUrl', () => {
  test('accepts the links Google actually hands out', () => {
    for (const url of [
      'https://g.page/r/CabcDEF123/review',
      'https://search.google.com/local/writereview?placeid=ChIJabc123',
      'https://maps.app.goo.gl/AbCdEf123',
      'https://www.google.com/maps/place/Joe%27s',
      'https://g.co/kgs/abc123',
    ]) {
      const r = validGoogleReviewUrl(url);
      assert.equal(r.error, undefined, url);
      assert.match(r.value, /^https:\/\//);
    }
  });

  test('empty clears it', () => {
    assert.deepEqual(validGoogleReviewUrl(''), { value: null });
    assert.deepEqual(validGoogleReviewUrl('   '), { value: null });
    assert.deepEqual(validGoogleReviewUrl(null), { value: null });
  });

  test('refuses anything that is not an https Google link', () => {
    for (const url of [
      'http://g.page/r/abc/review',                 // not https
      'https://google.com.evil.example/review',     // lookalike host
      'https://evilgoogle.com/review',              // suffix without the dot
      'https://yelp.com/biz/joes',
      'javascript:alert(1)',
      'g.page/r/abc/review',                        // no scheme
      'https://user:pw@search.google.com/local/writereview?placeid=x',
      `https://g.page/${'a'.repeat(600)}`,
    ]) {
      assert.ok(validGoogleReviewUrl(url).error, url);
    }
  });
});

describe('validReviewPoints', () => {
  test('blank and zero switch review points off', () => {
    assert.deepEqual(validReviewPoints(''), { value: 0 });
    assert.deepEqual(validReviewPoints(null), { value: 0 });
    assert.deepEqual(validReviewPoints(0), { value: 0 });
  });
  test('whole numbers 0..500 only', () => {
    assert.deepEqual(validReviewPoints(50), { value: 50 });
    assert.deepEqual(validReviewPoints('500'), { value: 500 });
    for (const bad of [-1, 501, 1.5, 'lots', NaN]) assert.ok(validReviewPoints(bad).error, String(bad));
  });
});

/* ---------- what a student sends ---------- */

describe('parseReviewInput', () => {
  test('a rating is required and is 1-5', () => {
    for (const rating of [undefined, 0, 6, 2.5, 'five']) {
      assert.equal(parseReviewInput({ rating }).code, 'REVIEW_RATING_INVALID', String(rating));
    }
    assert.equal(parseReviewInput({ rating: 4 }).rating, 4);
    assert.equal(parseReviewInput({ rating: '3' }).rating, 3);
  });

  test('text is optional, trimmed, and capped at 500 characters', () => {
    assert.equal(parseReviewInput({ rating: 5 }).body, null);
    assert.equal(parseReviewInput({ rating: 5, body: '   ' }).body, null);
    assert.equal(parseReviewInput({ rating: 5, body: '  Great\r\n\r\n\r\n\r\nfries \u0007 ' }).body, 'Great\n\nfries');
    assert.equal(parseReviewInput({ rating: 5, body: 'x'.repeat(500) }).body.length, 500);
    assert.equal(parseReviewInput({ rating: 5, body: 'x'.repeat(501) }).code, 'REVIEW_TOO_LONG');
    assert.equal(parseReviewInput({ rating: 5, body: 42 }).code, 'BAD_REQUEST');
  });

  test('anonymous only when it is literally true', () => {
    assert.equal(parseReviewInput({ rating: 5, anonymous: true }).anonymous, true);
    assert.equal(parseReviewInput({ rating: 5, anonymous: 'yes' }).anonymous, false);
  });

  test('a malformed location is no location, not an error', () => {
    assert.equal(parseReviewInput({ rating: 5, location: { lat: 'x', lng: 1 } }).location, null);
    assert.equal(parseReviewInput({ rating: 5, location: { lat: 95, lng: 1 } }).location, null);
    assert.deepEqual(
      parseReviewInput({ rating: 5, location: { lat: 1, lng: 2, accuracy: 12 } }).location,
      { lat: 1, lng: 2, accuracy: 12 },
    );
  });
});

describe('reviewAuthorName', () => {
  test('"First L." from a full name', () => {
    assert.equal(reviewAuthorName({ name: 'Krish Chavan', email: 'kc@psu.edu' }), 'Krish C.');
    assert.equal(reviewAuthorName({ name: 'josé  álvarez', email: 'x@y.z' }), 'José Á.');
    assert.equal(reviewAuthorName({ name: 'Mary Ann van der Berg', email: 'x@y.z' }), 'Mary B.');
  });

  test('never publishes the email fallback accept-terms writes', () => {
    // No name from the provider → accept-terms writes the email's local part.
    assert.equal(reviewAuthorName({ name: 'krish.chavan', email: 'krish.chavan@gmail.com' }), null);
    assert.equal(reviewAuthorName({ name: 'jsmith42', email: 'jsmith42@psu.edu' }), null);
    assert.equal(reviewAuthorName({ name: 'abc123xyz', email: 'abc123xyz@privaterelay.appleid.com' }), null);
  });

  test('nothing email-shaped or handle-shaped is ever a name', () => {
    assert.equal(reviewAuthorName({ name: 'krish@gmail.com', email: 'krish@gmail.com' }), null);
    assert.equal(reviewAuthorName({ name: 'krish.chavan@gmail.com', email: null }), null);
    assert.equal(reviewAuthorName({ name: 'jsmith42', email: null }), null);
    assert.equal(reviewAuthorName({ name: 'Krish Chavan 2', email: 'kc@psu.edu' }), null);
  });

  test('a one-word name that is not the email is fine', () => {
    assert.equal(reviewAuthorName({ name: 'Krish', email: 'kc@psu.edu' }), 'Krish');
  });

  test('nothing to sign with is anonymous', () => {
    assert.equal(reviewAuthorName({ name: '', email: 'a@b.c' }), null);
    assert.equal(reviewAuthorName({ name: '1234 !!', email: 'a@b.c' }), null);
    assert.equal(reviewAuthorName({}), null);
  });
});

/* ---------- presence ---------- */

describe('checkOnsite', () => {
  const spot = { latitude: SPOT.lat, longitude: SPOT.lng };

  test('metersBetween is in metres', () => {
    const oneDegree = metersBetween(40, -77, 41, -77);
    assert.ok(oneDegree > 110_000 && oneDegree < 112_000, String(oneDegree));
    assert.equal(metersBetween(SPOT.lat, SPOT.lng, SPOT.lat, SPOT.lng), 0);
  });

  test('at the door passes', () => {
    const r = checkOnsite(spot, { lat: SPOT.lat + 0.0005, lng: SPOT.lng, accuracy: 20 });
    assert.equal(r.ok, true);
  });

  test('a fix just outside the radius passes on its own accuracy, up to the slack', () => {
    // ~170 m away: outside 150, inside 150 + min(40, 50).
    const near = { lat: SPOT.lat + 170 / 111_000, lng: SPOT.lng };
    assert.equal(checkOnsite(spot, { ...near, accuracy: 40 }).ok, true);
    assert.equal(checkOnsite(spot, { ...near, accuracy: 5 }).code, 'REVIEW_TOO_FAR');
  });

  test('down the street is too far', () => {
    const r = checkOnsite(spot, { lat: SPOT.lat + 0.01, lng: SPOT.lng, accuracy: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REVIEW_TOO_FAR');
    assert.equal(r.status, 403);
  });

  test('a vague fix is refused rather than trusted', () => {
    const r = checkOnsite(spot, { lat: SPOT.lat, lng: SPOT.lng, accuracy: REVIEW_CONFIG.maxAccuracyMeters + 1 });
    assert.equal(r.code, 'REVIEW_LOCATION_IMPRECISE');
  });

  test('no location, and a spot with no coordinates, each say what to do', () => {
    assert.equal(checkOnsite(spot, null).code, 'REVIEW_NEEDS_LOCATION');
    assert.equal(checkOnsite({ latitude: null, longitude: null }, { lat: 1, lng: 1 }).code, 'REVIEW_SPOT_NOT_MAPPED');
  });
});

/* ---------- POST /api/me/reviews/:vendorId ---------- */

const catalogueRow = {
  id: VENDOR, name: 'Joe’s', slug: 'joes', address: '1 College Ave',
  latitude: SPOT.lat, longitude: SPOT.lng, has_logo: false,
  accepts_community_points: true, punch_enabled: false, points_per_dollar: 10,
  cuisine: [], price_level: null, created_at: '2026-01-01T00:00:00Z',
  pool_id: null, point_pools: null, rewards: [],
};

/**
 * Answer Supabase from a small world description:
 *   { existing, recentTx, recentPunch, reviewsTable: 'ok' | 'missing' }
 */
function worldHandler(world) {
  return (call) => {
    const u = call.url;
    const json = (rows, status = 200) => ({ status, body: JSON.stringify(rows) });
    if (/\/rest\/v1\/vendor_reviews\b/.test(u)) {
      if (world.reviewsTable === 'missing') {
        return { status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.vendor_reviews' }) };
      }
      return json(world.existing ? [{ id: 'r1' }] : []);
    }
    if (/\/rest\/v1\/vendor_review_stats\b/.test(u)) return json([]);
    if (/\/rest\/v1\/vendors\b/.test(u) && u.includes('review_points')) {
      return json([{ id: VENDOR, review_points: 50, google_review_url: 'https://g.page/r/abc/review' }]);
    }
    if (/\/rest\/v1\/vendors\b/.test(u)) return json([catalogueRow]);
    if (/\/rest\/v1\/transactions\b/.test(u)) return json(world.recentTx ? [{ id: 't1' }] : []);
    if (/\/rest\/v1\/punches\b/.test(u)) return json(world.recentPunch ? [{ id: 'p1' }] : []);
    if (/\/rest\/v1\/vendor_staff\b/.test(u)) return json(world.staff ? [{ vendor_id: VENDOR }] : []);
    return json([]);
  };
}

async function withWorld(world, fn) {
  const realFetch = globalThis.fetch;
  const realRpc = supabaseAdmin.rpc;
  const calls = [];
  const rpcs = [];
  const handler = worldHandler(world);
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: decodeURIComponent(String(input?.url ?? input)), method: String(init.method ?? 'GET').toUpperCase() };
    calls.push(call);
    const out = handler(call);
    return new Response(out.body, { status: out.status, headers: { 'Content-Type': 'application/json' } });
  };
  supabaseAdmin.rpc = async (name, params) => {
    rpcs.push({ name, params });
    return world.rpc
      ? world.rpc(name, params)
      : { data: [{ review_id: 'r1', created: true, points_awarded: 50, new_balance: 150 }], error: null };
  };
  try {
    return await fn({ calls, rpcs });
  } finally {
    globalThis.fetch = realFetch;
    supabaseAdmin.rpc = realRpc;
  }
}

function postReview(body, { profile = { name: 'Krish Chavan', email: 'kc@psu.edu' } } = {}) {
  const layer = studentRouter.stack.find((l) => l.route?.path === '/reviews/:vendorId' && l.route.methods.post);
  assert.ok(layer, 'POST /reviews/:vendorId is registered');
  const handle = layer.route.stack.at(-1).handle;   // skips requireConsent
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      setHeader() {},
    };
    handle({ user: { id: STUDENT }, profile, params: { vendorId: VENDOR }, body }, res, (err) => (err ? reject(err) : resolve({ status: 'next' })));
  });
}

describe('POST /api/me/reviews/:vendorId', () => {
  beforeEach(() => resetAllCaches());

  test('a first review with no recent visit and no location is refused, and pays nothing', async () => {
    await withWorld({}, async ({ rpcs }) => {
      const r = await postReview({ rating: 5 });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'REVIEW_NEEDS_LOCATION');
      assert.equal(rpcs.length, 0);
    });
  });

  test('a first review from down the street is refused', async () => {
    await withWorld({}, async ({ rpcs }) => {
      const r = await postReview({ rating: 1, location: { lat: SPOT.lat + 0.01, lng: SPOT.lng, accuracy: 10 } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'REVIEW_TOO_FAR');
      assert.equal(rpcs.length, 0);
    });
  });

  test('a first review at the spot is written as onsite and pays', async () => {
    await withWorld({}, async ({ rpcs }) => {
      const r = await postReview({ rating: 4, body: 'Good', location: { lat: SPOT.lat, lng: SPOT.lng, accuracy: 15 } });
      assert.equal(r.status, 200);
      assert.equal(rpcs.length, 1);
      assert.equal(rpcs[0].name, 'submit_review');
      assert.equal(rpcs[0].params.p_source, 'onsite');
      assert.equal(rpcs[0].params.p_author_name, 'Krish C.');
      assert.equal(rpcs[0].params.p_body, 'Good');
      assert.equal(r.body.pointsAwarded, 50);
      // No coordinates go to the database, ever.
      assert.ok(!JSON.stringify(rpcs[0].params).includes(String(SPOT.lat)));
    });
  });

  test('a recent visit stands in for location', async () => {
    await withWorld({ recentTx: true }, async ({ rpcs }) => {
      const r = await postReview({ rating: 3 });
      assert.equal(r.status, 200);
      assert.equal(rpcs[0].params.p_source, 'visit');
    });
    await withWorld({ recentPunch: true }, async ({ rpcs }) => {
      const r = await postReview({ rating: 3 });
      assert.equal(r.status, 200);
      assert.equal(rpcs[0].params.p_source, 'visit');
    });
  });

  test('an edit needs no presence at all', async () => {
    await withWorld({ existing: true, rpc: () => ({ data: [{ review_id: 'r1', created: false, points_awarded: 0, new_balance: null }], error: null }) }, async ({ rpcs, calls }) => {
      const r = await postReview({ rating: 2 });
      assert.equal(r.status, 200);
      assert.equal(rpcs.length, 1);
      assert.equal(r.body.created, false);
      assert.equal(r.body.pointsAwarded, 0);
      assert.ok(!calls.some((c) => /\/rest\/v1\/(transactions|punches)\b/.test(c.url)), 'no visit lookup for an edit');
    });
  });

  test('anonymous posts without a name', async () => {
    await withWorld({ recentTx: true }, async ({ rpcs }) => {
      await postReview({ rating: 5, anonymous: true });
      assert.equal(rpcs[0].params.p_author_name, null);
    });
  });

  test('the Google link comes back at a one-star rating exactly as at five', async () => {
    for (const rating of [1, 5]) {
      resetAllCaches();
      await withWorld({ recentTx: true }, async () => {
        const r = await postReview({ rating });
        assert.equal(r.body.googleReviewUrl, 'https://g.page/r/abc/review', `rating ${rating}`);
      });
    }
  });

  test('staff cannot review the spot they run, even right after a sale', async () => {
    await withWorld({ staff: true, recentTx: true }, async ({ rpcs }) => {
      const r = await postReview({ rating: 5 });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'REVIEW_OWN_SPOT');
      assert.equal(rpcs.length, 0);
    });
  });

  test('a bad rating is refused before anything is read', async () => {
    await withWorld({}, async ({ calls, rpcs }) => {
      const r = await postReview({ rating: 9 });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'REVIEW_RATING_INVALID');
      assert.equal(calls.length, 0);
      assert.equal(rpcs.length, 0);
    });
  });

  test('a database without migration-066 answers 503, not 500', async () => {
    await withWorld({ reviewsTable: 'missing' }, async ({ rpcs }) => {
      const r = await postReview({ rating: 5 });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'REVIEWS_UNAVAILABLE');
      assert.equal(rpcs.length, 0);
    });
  });
});

/* ---------- the public /spots page ---------- */

describe('spotPageHtml reviews section', () => {
  const spot = {
    id: VENDOR, name: 'Joe’s', slug: 'joes', address: '1 College Ave',
    latitude: SPOT.lat, longitude: SPOT.lng, hasLogo: false, cuisine: [], priceLevel: null,
    punchEnabled: false, rewards: [{ title: 'Free fries', cost_in_points: 100, cost_in_visits: null, emoji: '🍟' }],
  };

  test('shows the average, the reviews and the points disclosure', () => {
    const html = spotPageHtml(spot, {
      avg: 4.5, count: 2,
      reviews: [
        { id: 'a', rating: 5, body: 'Great <b>fries</b>', authorName: 'Krish C.', createdAt: '2026-10-01', edited: false },
        { id: 'b', rating: 4, body: null, authorName: null, createdAt: '2026-10-02', edited: true },
      ],
    });
    assert.match(html, /4\.5 out of 5, from 2 student reviews/);
    assert.match(html, /points for their first review of a spot, whatever rating they give/);
    assert.match(html, /Krish C\./);
    assert.match(html, /WeRewards member, edited/);
    assert.ok(!html.includes('<b>fries</b>'), 'review text is escaped');
  });

  test('emits no review structured data (self-serving and incentivised)', () => {
    const html = spotPageHtml(spot, { avg: 5, count: 1, reviews: [{ id: 'a', rating: 5, body: 'x', authorName: null, createdAt: '2026-10-01', edited: false }] });
    assert.ok(!/AggregateRating|"Review"|reviewRating/.test(html));
  });

  test('no section at all when reviews are not available', () => {
    assert.ok(!spotPageHtml(spot, null).includes('What students say'));
    assert.ok(!spotPageHtml(spot).includes('What students say'));
  });
});

/* ---------- the two rules, as source-text guards ---------- */

describe('the Google rule', () => {
  const app = readFileSync(new URL('../public/student/app.js', import.meta.url), 'utf8');
  const fnBody = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const next = src.indexOf('\nfunction ', start + 10);
    const nextAsync = src.indexOf('\nasync function ', start + 10);
    const end = Math.min(...[next, nextAsync].filter((i) => i > 0));
    return src.slice(start, end);
  };

  test('the Google button never depends on the rating (no review gating)', () => {
    const done = fnBody(app, 'showReviewDone');
    assert.ok(done.includes('googleReviewUrl'));
    assert.ok(!/rating/i.test(done.replace(/\/\/.*$/gm, '')), 'showReviewDone must not read the rating');
  });

  test('nothing about opening Google pays or claims points', () => {
    const open = fnBody(app, 'openGoogleReview').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/authFetch|\/api\//.test(open), 'openGoogleReview must not call the server');
  });

  test('the server hands the link back whatever the rating', () => {
    const src = readFileSync(new URL('../src/routes/student.js', import.meta.url), 'utf8');
    const start = src.indexOf("router.post('/reviews/:vendorId'");
    const end = src.indexOf('router.get(', start);
    const handler = src.slice(start, end);
    const line = handler.split('\n').find((l) => l.includes('googleReviewUrl:'));
    assert.ok(line, 'the response carries googleReviewUrl');
    assert.ok(!/rating/i.test(line), line);
  });
});

describe('migration-066', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261017120000_migration-066.sql', import.meta.url), 'utf8');

  test('one review per student per location is a unique index, not a hope', () => {
    assert.match(sql, /create unique index if not exists idx_vendor_reviews_once\s+on public\.vendor_reviews \(user_id, vendor_id\)/);
  });

  test('submit_review announces itself to the points write guard first', () => {
    const body = sql.slice(sql.indexOf('create or replace function public.submit_review'));
    const guard = body.indexOf("set_config('app.points_write', 'server', true)");
    assert.ok(guard > 0);
    assert.ok(guard < body.indexOf('insert into point_balances'));
    assert.ok(guard < body.indexOf('insert into pool_balances'));
  });

  test('server-only: no anon or authenticated access to the table, view or function', () => {
    assert.match(sql, /revoke all on table public\.vendor_reviews from anon, authenticated;/);
    assert.match(sql, /revoke all privileges on public\.vendor_review_stats from anon, authenticated;/);
    assert.match(sql, /revoke execute on function public\.submit_review\(uuid, uuid, integer, text, text, text\) from public, anon, authenticated;/);
  });

  test('the hide reasons have no sentiment option', () => {
    assert.ok(!/'negative'|'low_rating'|'unfair'/.test(sql));
  });
});

describe('history', () => {
  test('a paid review is a row of its own, so the balance never jumps unexplained', () => {
    const { items, truncated } = mergeHistory(
      [{ id: 't1', type: 'earn', points: 100, created_at: '2026-10-01T10:00:00Z' }],
      [],
      { reviews: [{ id: 'r1', vendor_id: VENDOR, points_awarded: 50, created_at: '2026-10-02T10:00:00Z', vendors: { name: 'Joe’s' } }] },
    );
    assert.equal(items[0].type, 'review');
    assert.equal(items[0].points, 50);
    assert.equal(items[0].vendors.name, 'Joe’s');
    assert.equal(items[1].id, 't1');
    assert.equal(truncated, false);
  });

  test('without the reviews option nothing changes', () => {
    const { items } = mergeHistory([{ id: 't1', type: 'earn', points: 1, created_at: '2026-10-01T10:00:00Z' }], []);
    assert.deepEqual(items.map((i) => i.id), ['t1']);
  });
});

describe('the Post button says why it cannot be pressed', () => {
  // Reported from staging: stars filled, Post dimmed, nothing explained why
  // (Test Cafe has no address, so no map position, and there was no visit).
  const app = readFileSync(new URL('../public/student/app.js', import.meta.url), 'utf8');
  const grab = (name) => {
    const start = app.indexOf(`function ${name}(`);
    const end = app.indexOf('\n}\n', start) + 3;
    return app.slice(start, end);
  };
  const run = (state, rating, busy = false) => {
    const btn = { disabled: null, textContent: 'Post review' };
    // eslint-disable-next-line no-new-func
    new Function('btn', 'state', 'rating', 'busy', `
      const $ = () => btn;
      let reviewState = state, reviewRating = rating, reviewBusy = busy;
      ${grab('reviewBlock')}
      ${grab('syncReviewSubmit')}
      syncReviewSubmit();
    `)(btn, state, rating, busy);
    return btn;
  };

  test('an unmapped spot with no recent visit', () => {
    const b = run({ mapped: false, recentVisit: false, mine: null }, 5);
    assert.equal(b.disabled, true);
    assert.equal(b.textContent, 'Review after your next visit');
  });
  test('staff of the spot', () => {
    const b = run({ ownSpot: true, mapped: true, recentVisit: true }, 5);
    assert.equal(b.disabled, true);
    assert.equal(b.textContent, 'You run this spot');
  });
  test('no stars yet', () => {
    const b = run({ mapped: true, recentVisit: false }, 0);
    assert.equal(b.disabled, true);
    assert.equal(b.textContent, 'Tap a star to rate');
  });
  test('ready to post, or to save an edit', () => {
    assert.deepEqual(run({ mapped: true, recentVisit: false }, 4), { disabled: false, textContent: 'Post review' });
    assert.deepEqual(run({ mapped: false, recentVisit: false, mine: { rating: 2 } }, 4), { disabled: false, textContent: 'Save changes' });
  });
  test('mid-post the label is left to submitReview', () => {
    const b = run({ mapped: true, recentVisit: true }, 4, true);
    assert.equal(b.disabled, true);
    assert.equal(b.textContent, 'Post review');
  });
});
