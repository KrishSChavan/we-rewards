// The /admin NFC tag API (src/routes/admin.js, migration-065): the per-spot
// roll-up behind the "NFC tags" card, one spot's traffic series, and the raw
// tap export.
//
// Driven the way test/admin-notifications.test.js drives its routes: the
// exported sub-router is mounted on a bare express app (no requireAdmin, which
// in production is the gate it sits behind), and Supabase is answered by
// patching globalThis.fetch. supabaseAdmin resolves fetch per request
// (retryingFetch's `doFetch = fetch` default), so one patch sees every
// PostgREST read and RPC the routes make, with no module mocking and no
// database. The harness is a COPY of that file's, not an import: it is not
// exported there, and two suites sharing one fetch patch would fight over
// the handlers.
//
// What these hold:
//
//   • every spot is on the card, tapped or not, open ones first, so the
//     operator can copy a tag URL for a counter that has no tag yet;
//   • a database without migration-065 answers 200 + `unavailable` on all
//     three reads, never a 500, and the export's version of that is an empty
//     sheet rather than JSON saved to the operator's disk as a .csv;
//   • `?days=` is clamped to what the client is promised (0 is 1, not 30);
//   • the export is a real CSV: BOM, header, pages of a thousand, and a tag
//     ref that starts with '=' is defused before a spreadsheet can execute it.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { nfcRoutes } from '../src/routes/admin.js';

const SHER = 'fafafafa-bcbc-4ded-8efe-abababababab';
const ABBA = 'abababab-cdcd-4efe-8aba-cdcdcdcdcdcd';
const IRVINGS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/* ---------- a fake PostgREST ---------- */

const realFetch = globalThis.fetch;
let handlers = {};      // 'table' or 'rpc/name' -> (call) => reply
let fallback = null;    // (call) => reply, for anything unlisted
let calls = [];

const missingTable = (path) => ({ status: 404, data: { code: 'PGRST205', message: `Could not find the table 'public.${path}' in the schema cache` } });
const missingFn = (path) => ({ status: 404, data: { code: 'PGRST202', message: `Could not find the function public.${path.slice(4)}` } });

function reply(call, out) {
  const { status = 200, data = [], total } = out ?? {};
  const headers = { 'content-type': 'application/json' };
  if (/count=exact/.test(call.headers.get('prefer') ?? '')) {
    const n = Array.isArray(data) ? data.length : 0;
    const t = total ?? n;
    headers['content-range'] = n ? `${call.offset}-${call.offset + n - 1}/${t}` : `*/${t}`;
  }
  if (call.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'unit-test-placeholder.invalid') return realFetch(input, init);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const call = {
    method: String(init.method ?? 'GET').toUpperCase(),
    path,
    params: url.searchParams,
    offset: Number(url.searchParams.get('offset') ?? 0),
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  const h = handlers[path] ?? fallback;
  if (h) return reply(call, await h(call));
  return reply(call, path.startsWith('rpc/') ? missingFn(path) : missingTable(path));
};

/* ---------- the app under test ---------- */

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/nfc', nfcRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'INTERNAL', message: String(err?.message ?? err) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin/nfc`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  handlers = {};
  fallback = null;
  calls = [];
});

/**
 * One request; `body` is parsed only when the answer says it is JSON.
 * The bytes are decoded by hand because res.text() silently strips a leading
 * BOM (the Fetch spec's UTF-8 decode does), and the BOM is one of the things
 * the export tests exist to see.
 */
async function get(path, opts = {}) {
  const res = await realFetch(`${base}${path}`, opts);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  const json = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, headers: res.headers, text, body: json && text ? JSON.parse(text) : null };
}

const callsTo = (path) => calls.filter((c) => c.path === path);

const vendors = () => [
  { id: SHER, name: 'Sher Halal', slug: 'sher-halal', active: true },
  { id: ABBA, name: 'Abba Java', slug: 'abba-java', active: false },
  { id: IRVINGS, name: "Irving's", slug: 'irvings', active: true },
];

const irvingsCounts = () => ({
  vendor_id: IRVINGS, taps: 12, taps_30d: 10, taps_7d: 4, taps_today: 1, app_taps_30d: 3, uniques_30d: 6,
  first_tap: '2026-09-01T12:00:00+00:00', last_tap: '2026-10-14T09:30:00+00:00',
});

/* ---------- GET / (the card) ---------- */

describe('GET /nfc', () => {
  test('every spot is listed, open ones first then by name, with zeros where nobody has tapped', async () => {
    handlers.vendors = () => ({ data: vendors() });
    handlers.nfc_tap_overview = () => ({ data: [irvingsCounts()] });
    handlers.nfc_tap_unmatched = () => ({
      data: [
        { ref: 'generic', taps: 5, taps_30d: 2, last_tap: '2026-10-13T20:00:00+00:00' },
        { ref: 'irvngs', taps: 1, taps_30d: 1, last_tap: '2026-10-12T20:00:00+00:00' },
      ],
    });

    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.equal(body.unavailable, undefined);
    // Abba Java sorts first alphabetically and is listed LAST: it is switched
    // off, and the card is read top-down by someone sticking tags to counters.
    assert.deepEqual(body.vendors.map((v) => v.name), ["Irving's", 'Sher Halal', 'Abba Java']);

    assert.deepEqual(body.vendors[0], {
      vendorId: IRVINGS, name: "Irving's", slug: 'irvings', active: true,
      taps: 12, taps30d: 10, taps7d: 4, tapsToday: 1, appTaps30d: 3, uniques30d: 6,
      firstTap: '2026-09-01T12:00:00+00:00', lastTap: '2026-10-14T09:30:00+00:00',
    });
    // No view row is zeros and nulls, not a missing spot: the operator copies
    // this spot's tag URL from here before its first tap ever happens.
    assert.deepEqual(body.vendors[1], {
      vendorId: SHER, name: 'Sher Halal', slug: 'sher-halal', active: true,
      taps: 0, taps30d: 0, taps7d: 0, tapsToday: 0, appTaps30d: 0, uniques30d: 0,
      firstTap: null, lastTap: null,
    });
    assert.equal(body.vendors[2].active, false);

    assert.deepEqual(body.unmatched, [
      { ref: 'generic', taps: 5, taps30d: 2, lastTap: '2026-10-13T20:00:00+00:00' },
      { ref: 'irvngs', taps: 1, taps30d: 1, lastTap: '2026-10-12T20:00:00+00:00' },
    ]);

    // One read each: the counting happens in the views, never in Node.
    assert.equal(callsTo('vendors').length, 1);
    assert.equal(callsTo('nfc_tap_overview').length, 1);
    assert.equal(callsTo('nfc_tap_unmatched').length, 1);
    assert.equal(callsTo('nfc_taps').length, 0, 'the raw table is not read for the card');
  });

  test('without migration-065: 200, unavailable, nothing else', async () => {
    handlers.vendors = () => ({ data: vendors() });
    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.deepEqual(body, { unavailable: 'migration-065', vendors: [], unmatched: [] });
  });

  test('half a paste (the overview there, the unmatched view not) is still named, not a 500', async () => {
    handlers.vendors = () => ({ data: vendors() });
    handlers.nfc_tap_overview = () => ({ data: [] });
    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.equal(body.unavailable, 'migration-065');
  });

  test('views that are there but empty are zeros, not "not applied"', async () => {
    handlers.vendors = () => ({ data: vendors() });
    handlers.nfc_tap_overview = () => ({ data: [] });
    handlers.nfc_tap_unmatched = () => ({ data: [] });
    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.equal(body.unavailable, undefined);
    assert.equal(body.vendors.length, 3);
    assert.ok(body.vendors.every((v) => v.taps === 0 && v.lastTap === null));
    assert.deepEqual(body.unmatched, []);
  });

  test('any other database error is NOT reported as a missing migration', async () => {
    // Saying "not applied" about a real fault would send the operator off to
    // paste SQL that is already there.
    handlers.vendors = () => ({ data: vendors() });
    handlers.nfc_tap_overview = () => ({ status: 500, data: { code: '57014', message: 'canceling statement due to statement timeout' } });
    handlers.nfc_tap_unmatched = () => ({ data: [] });
    const { status, body } = await get('');
    assert.equal(status, 500);
    assert.equal(body.unavailable, undefined);
  });
});

/* ---------- GET /:vendorId/detail ---------- */

describe('GET /nfc/:vendorId/detail', () => {
  const echo = () => {
    handlers['rpc/nfc_tap_detail'] = (call) => ({
      data: { vendor_id: call.body.p_vendor_id, days: call.body.p_days, timezone: 'America/New_York', daily: [], hourly: [] },
    });
  };

  test('days is clamped to 1..365 and defaults to 30', async () => {
    echo();
    for (const [query, days] of [['?days=0', 1], ['?days=999', 365], ['', 30], ['?days=abc', 30], ['?days=7.9', 7], ['?days=-3', 1]]) {
      const { status, body } = await get(`/${IRVINGS}/detail${query}`);
      assert.equal(status, 200, query);
      assert.equal(body.days, days, `${query || '(none)'} should ask the function for ${days} days`);
      assert.equal(body.vendor_id, IRVINGS);
    }
    assert.ok(callsTo('rpc/nfc_tap_detail').every((c) => c.body.p_vendor_id === IRVINGS));
  });

  test('an object smuggled into ?days cannot throw', async () => {
    // express parses ?days[toString]=1 into an object whose Number() throws;
    // queryScalar drops it and the default applies. See that helper's note.
    echo();
    const { status, body } = await get(`/${IRVINGS}/detail?days[toString]=1`);
    assert.equal(status, 200);
    assert.equal(body.days, 30);
  });

  test('a non-uuid is a 404 before any query', async () => {
    echo();
    const { status } = await get('/not-a-vendor/detail');
    assert.equal(status, 404);
    assert.equal(callsTo('rpc/nfc_tap_detail').length, 0);
  });

  test('without migration-065: 200 with the empty shape, named', async () => {
    const { status, body } = await get(`/${IRVINGS}/detail?days=14`);
    assert.equal(status, 200);
    assert.deepEqual(body, { unavailable: 'migration-065', days: 14, daily: [], hourly: [] });
  });
});

/* ---------- GET /export ---------- */

const HEADER = 'Tapped at (UTC),Spot,Tag,Source,Matched,Device / user agent';

describe('GET /nfc/export', () => {
  test('is a CSV with a BOM, a header, the spot name, and a defused formula', async () => {
    handlers.vendors = () => ({ data: [{ id: SHER, name: 'Sher Halal' }] });
    handlers.nfc_taps = () => ({
      data: [
        { tapped_at: '2026-10-14T12:00:00+00:00', vendor_id: SHER, ref: 'sher-halal', source: 'web', known: true, user_agent: 'Mozilla/5.0 (iPhone)' },
        // A ref the database could hold but a tag never would: the cell must
        // not open as a formula in Excel or Sheets.
        { tapped_at: '2026-10-14T11:00:00+00:00', vendor_id: null, ref: '=cmd|calc', source: 'app', known: false, user_agent: null },
      ],
    });

    const { status, headers, text } = await get('/export');
    assert.equal(status, 200);
    assert.match(headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(headers.get('content-disposition') ?? '', /werewards-nfc-taps\.csv/);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.ok(text.startsWith('﻿'), 'a BOM, so Excel on Windows reads it as UTF-8');

    const lines = text.slice(1).split('\r\n');
    assert.equal(lines[0], HEADER);
    assert.equal(lines[1], '2026-10-14T12:00:00+00:00,Sher Halal,sher-halal,web,yes,Mozilla/5.0 (iPhone)');
    assert.equal(lines[2], "2026-10-14T11:00:00+00:00,,'=cmd|calc,app,no,");
    assert.deepEqual(lines.slice(3), [''], 'one trailing newline and nothing after it');
  });

  test('pages through the table a thousand at a time and stops at the first short page', async () => {
    handlers.vendors = () => ({ data: [] });
    const row = (i) => ({ tapped_at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00+00:00`, vendor_id: null, ref: `tag-${i}`, source: 'web', known: false, user_agent: null });
    handlers.nfc_taps = (call) => ({
      data: call.offset === 0 ? Array.from({ length: 1000 }, (_, i) => row(i)) : [row(1000)],
    });

    const { status, text } = await get('/export');
    assert.equal(status, 200);
    assert.deepEqual(callsTo('nfc_taps').map((c) => c.offset), [0, 1000]);
    const lines = text.slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines.length, 1 + 1001, 'header plus every row of both pages');
    assert.ok(!lines.some((l) => l.startsWith('TRUNCATED')), 'a complete file carries no truncation notice');
  });

  test('without migration-065: an empty sheet with the header, not JSON', async () => {
    // The admin client saves whatever comes back as a .csv (saveBlob), so a
    // JSON body here would land on the operator's disk as a spreadsheet full
    // of braces. The card above the button already carries the banner.
    handlers.vendors = () => ({ data: [] });
    const { status, headers, text } = await get('/export');
    assert.equal(status, 200);
    assert.match(headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(text, `﻿${HEADER}\r\n`);
  });

  test('the literal path is not swallowed by /:vendorId/detail', async () => {
    handlers.vendors = () => ({ data: [] });
    handlers.nfc_taps = () => ({ data: [] });
    const { status, headers } = await get('/export');
    assert.equal(status, 200);
    assert.match(headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(callsTo('rpc/nfc_tap_detail').length, 0);
  });
});
