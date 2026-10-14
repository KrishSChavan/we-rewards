// The NFC tags card on the QR poster tab of public/admin/admin.js, and the
// vendor web address (slug) field it put in the Edit dialog (migration-065).
//
// WHAT IS WORTH LOCKING IN. A tag is hardware: the slug an operator types here
// is written into a chip and stuck to a counter, so the client-side rule has
// to refuse exactly what the server refuses (a tag written with an address
// the server then rejects is a dead counter), the two links a row offers have
// to be the real /t/ addresses, and the refs that matched nothing are strings
// somebody wrote on a tag by hand and must never become markup in the one
// dashboard that can see every student. Everything else is the shape of the
// card: zeros are rows, a missing migration is a banner and not an error, and
// the export goes to the route the server exposes.
//
// SLICED AND EVALUATED, following test/admin-notifications-client.test.js:
// admin.js is a browser script, not a module, so nothing in test/ can import
// from it. The landmarks are deliberately brittle: if one moves, this throws
// rather than quietly testing nothing. It reads public/, not .build/, because
// the source is what a person edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADMIN = fileURLToPath(new URL('../public/admin/admin.js', import.meta.url));
const HTML = fileURLToPath(new URL('../public/admin/index.html', import.meta.url));
const src = readFileSync(ADMIN, 'utf8');
const html = readFileSync(HTML, 'utf8');

/** Slice `src` between two landmarks, insisting both are still there. */
function block(fromNeedle, toNeedle) {
  const from = src.indexOf(fromNeedle);
  const to = src.indexOf(toNeedle, from + 1);
  assert.ok(from > 0 && to > from,
    `landmark moved in public/admin/admin.js, re-anchor this test: ${fromNeedle}`);
  return src.slice(from, to);
}

const slice = block('/* ---------- NFC tags (migration-065) ----------', '/* ---------- end NFC tags ---------- */');
// The REAL helpers the block leans on from the trackable-QR card, not copies:
// the stat chips, the date, the row error line and the bar chart. Running the
// block against anything else would test a drawing nobody ships.
const qrText = block('function qrWhen(iso) {', 'function buildQrRow(c) {');
const qrRowErr = block('function qrRowError(el, msg) {', 'async function saveQr(');
const qrChartSrc = block('function qrChart(series, labelOf', 'function paintQrDetail(');

const UUID_A = '6f1c2a4e-9b0d-4c7a-8e3f-1d2b3c4d5e6f';
const UUID_B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = Date.parse('2026-10-14T15:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

const IRVINGS = {
  vendorId: UUID_A, name: "Irving's", slug: 'irvings', active: true,
  taps: 120, taps30d: 40, taps7d: 10, tapsToday: 3, appTaps30d: 4, uniques30d: 25,
  firstTap: ago(400 * HOUR), lastTap: ago(2 * HOUR),
};
const CAFE = {
  vendorId: UUID_B, name: 'Cafe 210', slug: 'cafe-210', active: false,
  taps: 0, taps30d: 0, taps7d: 0, tapsToday: 0, appTaps30d: 0, uniques30d: 0,
  firstTap: null, lastTap: null,
};

/**
 * One fake element. Enough of the DOM for the block to build rows with:
 * textContent clears children when set, as it does in a browser (renderNfc
 * empties the list that way), listeners are kept so a test can click a
 * button, and click() hands back whatever the handler returned so an async
 * one can be awaited.
 */
function fakeNode(tag, hidden = false) {
  const cls = new Set();
  const listeners = {};
  let text = '';
  const node = {
    tag, id: tag, hidden, innerHTML: '', value: '', placeholder: '', title: '',
    disabled: false, className: '', type: '', style: {}, dataset: {}, attrs: {},
    children: [], focused: false,
    get textContent() { return text; },
    set textContent(v) { text = String(v); node.children = []; },
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    },
    setAttribute(k, v) { node.attrs[k] = v; },
    focus() { node.focused = true; },
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { return listeners.click?.(); },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  return node;
}

/** Every string in the subtree, in document order, whitespace collapsed. */
function flatText(node) {
  const own = node.textContent ?? '';
  const kids = (node.children ?? []).map(flatText);
  return [own, ...kids].join(' ').replace(/\s+/g, ' ').trim();
}

/** Depth-first: the first node `pred` accepts, or undefined. */
function find(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

/** Depth-first: every node `pred` accepts. */
function all(node, pred) {
  const out = [];
  (function walk(n) {
    if (pred(n)) out.push(n);
    for (const child of n.children ?? []) walk(child);
  }(node));
  return out;
}

/**
 * A fresh sandbox per test. `routes` maps a path (no query string) to
 * `{ status, body }`, an Error (the offline case), or is a function of
 * (url, opts). `roster` is the vendors array the block reads; `lateRoster`
 * is what a loadVendors() call appends to it, modelling the fetch.
 */
function sandbox({ routes = {}, roster = [], lateRoster = [], clipboardFails = false } = {}) {
  const nodes = new Map();
  // Ids from the markup start hidden, as the banner, the error lines and the
  // unmatched block do in index.html; what a test needs visible it sets.
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, fakeNode(id, true));
    return nodes.get(id);
  };
  const calls = { fetches: [], denied: 0, saved: [], copied: [], notes: [], opened: [], rosterLoads: 0, rosterPaints: 0 };
  const document = {
    createElement: (tag) => fakeNode(tag, false),
    // A text node has no markup in it, and the innerHTML assertions below walk
    // every node, so it has to say so rather than be undefined.
    createTextNode: (s) => ({ textContent: String(s), innerHTML: '', children: [] }),
    querySelector: () => null,
  };
  const deps = {
    $,
    document,
    location: { origin: 'https://we-rewards.com', host: 'we-rewards.com' },
    navigator: {
      clipboard: {
        writeText: async (s) => {
          if (clipboardFails) throw new Error('denied');
          calls.copied.push(s);
        },
      },
    },
    setTimeout: () => 0,
    authFetch: async (url, opts = {}) => {
      calls.fetches.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
      const path = url.split('?')[0];
      const r = await (typeof routes === 'function' ? routes(url, opts) : routes[path]);
      if (r instanceof Error) throw r;
      const { status = 200, body = {} } = r || { status: 500 };
      return { status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => ({ size: 1 }) };
    },
    denyAccess: async () => { calls.denied += 1; },
    setNote: (el, text, kind) => { el.textContent = text; el.kind = kind; calls.notes.push({ id: el.id, text, kind }); },
    num: (n) => (Number(n) || 0).toLocaleString('en-US'),
    saveBlob: (blob, name) => { calls.saved.push(name); },
    vendors: roster,
    loadVendors: async () => { calls.rosterLoads += 1; roster.push(...lateRoster); },
    openVendorModal: (v, infoEl) => { calls.opened.push({ v, infoEl }); },
    vendorInfoHtml: (v) => `<span class="vendor-meta">${v.slug}</span>`,
    renderVendors: () => { calls.rosterPaints += 1; },
  };

  // eslint-disable-next-line no-new-func
  const api = new Function('deps', `
    let { $, document, location, navigator, setTimeout, authFetch, denyAccess, setNote, num,
          saveBlob, vendors, loadVendors, openVendorModal, vendorInfoHtml, renderVendors } = deps;
    let editVendor = null;
    ${qrText}
    ${qrRowErr}
    ${qrChartSrc}
    ${slice}
    return {
      validSlugClient, slugify, nfcUrl, nfcPermanentUrl, loadNfc, renderNfc, buildNfcRow,
      renderNfcUnmatched, exportNfcAll, editNfcSlug, toggleNfcDetail, syncVendorSlugHint,
      saveVendorSlug, nfcSlugChanged, syncNewVendorSlugPlaceholder,
      setEditVendor: (e) => { editVendor = e; },
      state: () => ({ nfcRows, nfcUnmatched, nfcUnavailable, nfcLoaded }),
    };
  `)(deps);

  return { api, calls, node: $, document };
}

const button = (row, label) => find(row, (n) => n.tag === 'button' && n.textContent === label);

/* ---------- the card ---------- */

test('every spot gets a row, zeros included, and every row carries its tag link', async () => {
  const { api, node } = sandbox({ routes: { '/api/admin/nfc': { body: { vendors: [IRVINGS, CAFE], unmatched: [] } } } });
  await api.loadNfc();
  assert.equal(api.state().nfcLoaded, true);

  const list = node('nfc-list');
  assert.equal(list.children.length, 3, 'two spots and the generic tag');
  const [a, b, generic] = list.children;

  assert.equal(find(a, (n) => n.className === 'nfc-name').textContent, "Irving's");
  const linkA = find(a, (n) => n.className === 'qr-link');
  assert.equal(linkA.textContent, '/t/irvings');
  assert.equal(linkA.title, 'https://we-rewards.com/t/irvings', 'the title is the full address, for hovering');
  const textA = flatText(a);
  assert.match(textA, /3 taps today/);
  assert.match(textA, /10 in 7 days/);
  assert.match(textA, /40 in 30 days/);
  assert.match(textA, /120 all time/);
  assert.match(textA, /25 people in 30 days/);
  assert.match(textA, /4 of 40 from the app/);
  assert.match(textA, /last tap /);
  assert.doesNotMatch(textA, /never/);

  // The zero row is a row: a counter with no tag yet still has an address to
  // copy, and "nobody taps it" is the operator's business to know.
  const linkB = find(b, (n) => n.className === 'qr-link');
  assert.equal(linkB.textContent, '/t/cafe-210');
  const textB = flatText(b);
  assert.match(textB, /0 taps today/);
  assert.match(textB, /0 in 30 days/);
  assert.match(textB, /0 all time/);
  assert.match(textB, /last tap never/);
  assert.doesNotMatch(textB, /from the app/, '"0 of 0 from the app" is noise');
  assert.ok(b.classList.contains('is-off'), 'a spot turned off is faded, not dropped');
  assert.match(textB, /\bOff\b/);
  assert.ok(button(b, 'Copy link') && button(b, 'Copy permanent link') && button(b, 'Traffic') && button(b, 'Edit slug'));

  assert.match(flatText(generic), /Generic tag \(\/t\)/);
  assert.equal(find(generic, (n) => n.className === 'qr-link').textContent, '/t');
  assert.match(flatText(generic), /last tap never/);

  assert.equal(node('nfc-count').textContent, '2 spots · 40 taps in 30 days');
  assert.equal(node('nfc-export').hidden, false);
  assert.equal(node('nfc-unavailable').hidden, true);
  assert.equal(node('nfc-unmatched').hidden, true, 'no unmatched refs, no Unmatched heading');
  assert.equal(node('nfc-error').hidden, true);
});

test('migration-065 missing: the banner shows, the list is empty, and it is not an error', async () => {
  let answer = { unavailable: 'migration-065', vendors: [], unmatched: [] };
  const { api, node } = sandbox({ routes: () => ({ body: answer }) });
  node('nfc-export').hidden = false;
  await api.loadNfc();
  assert.equal(node('nfc-unavailable').hidden, false);
  assert.equal(node('nfc-list').children.length, 0, 'no rows, not even the generic tag: a zero here would mean "no table", not "no taps"');
  assert.equal(node('nfc-unmatched').hidden, true);
  assert.equal(node('nfc-error').hidden, true, 'a missing table is a paste away, not a failure');
  assert.equal(node('nfc-export').hidden, true, 'nothing to export from a table that is not there');
  assert.equal(node('nfc-count').textContent, '');
  assert.equal(api.state().nfcUnavailable, 'migration-065');

  // Once the migration is pasted and the operator reloads, the banner goes.
  answer = { vendors: [IRVINGS], unmatched: [] };
  await api.loadNfc();
  assert.equal(node('nfc-unavailable').hidden, true);
  assert.equal(node('nfc-list').children.length, 2);
  assert.equal(api.state().nfcUnavailable, null);
});

test('the banner sentence in the markup names the file to paste', () => {
  const at = html.indexOf('id="nfc-unavailable"');
  assert.ok(at > 0, '#nfc-unavailable is gone from index.html');
  const banner = html.slice(at, html.indexOf('</p>', at));
  assert.match(banner, /Migration 065 not applied: paste supabase\/migrations\/20261014120000_migration-065\.sql into the SQL editor, then reload\./);
  assert.match(banner, /\shidden[\s>]/, 'it ships hidden and renderNfc reveals it');
});

test('a 403 goes to denyAccess, a 500 to the error line, and the list keeps the banner state it had', async () => {
  const denied = sandbox({ routes: { '/api/admin/nfc': { status: 403 } } });
  await denied.api.loadNfc();
  assert.equal(denied.calls.denied, 1);
  assert.equal(denied.node('nfc-error').hidden, true);

  const broken = sandbox({ routes: { '/api/admin/nfc': { status: 500 } } });
  await broken.api.loadNfc();
  assert.equal(broken.node('nfc-error').hidden, false);
  assert.match(broken.node('nfc-error').textContent, /↻/, 'the message names the button loadAll makes work');
  assert.equal(broken.api.state().nfcLoaded, false, 'a failed first load does not sign the card up for refreshes');

  const offline = sandbox({ routes: { '/api/admin/nfc': new Error('offline') } });
  await offline.api.loadNfc();
  assert.equal(offline.node('nfc-error').hidden, false);
  assert.match(offline.node('nfc-error').textContent, /connection/);
});

/* ---------- the links ---------- */

test('nfcUrl is the dashboard origin plus /t/<slug>, and the permanent link uses the id', async () => {
  const { api, calls } = sandbox();
  assert.equal(api.nfcUrl('irvings'), 'https://we-rewards.com/t/irvings');
  assert.equal(api.nfcUrl(''), 'https://we-rewards.com/t', 'no slug is the generic campus tag');
  assert.equal(api.nfcPermanentUrl(UUID_A), `https://we-rewards.com/t/${UUID_A}`);

  // And the two buttons copy exactly those, not a /spots/ page or a /r/ code.
  const row = api.buildNfcRow(IRVINGS);
  const copy = button(row, 'Copy link');
  await copy.click();
  assert.deepEqual(calls.copied, ['https://we-rewards.com/t/irvings']);
  assert.equal(copy.textContent, 'Copied');
  await button(row, 'Copy permanent link').click();
  assert.equal(calls.copied.at(-1), `https://we-rewards.com/t/${UUID_A}`);
});

test('when the clipboard refuses, the button shows the address instead of pretending', async () => {
  const { api } = sandbox({ clipboardFails: true });
  const row = api.buildNfcRow(IRVINGS);
  const copy = button(row, 'Copy permanent link');
  await copy.click();
  assert.equal(copy.textContent, `https://we-rewards.com/t/${UUID_A}`);
});

/* ---------- the slug rule, mirrored from the server ---------- */

test('validSlugClient accepts and refuses the same table as the server', () => {
  const { api } = sandbox();
  for (const s of ['irvings', 'cafe-210', 'x', 'a'.repeat(60)]) {
    assert.deepEqual(api.validSlugClient(s), { ok: true, slug: s }, s);
  }
  assert.deepEqual(api.validSlugClient('  Irvings '), { ok: true, slug: 'irvings' }, 'trimmed and lower-cased, never refused for case');
  const bad = ['-x', 'x-', 'a b', 'a'.repeat(61), UUID_A, UUID_A.toUpperCase(), 'admin', '', '   ', 'a_b', 'café', 'x--', null, undefined,
    't', 'spots', 'terminal', 'scan', 'join', 'legal', 'api', 'r'];
  for (const s of bad) {
    const r = api.validSlugClient(s);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(s)}`);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, `a refusal needs a sentence: ${JSON.stringify(s)}`);
  }
  assert.match(api.validSlugClient('admin').error, /reserved/);
  assert.match(api.validSlugClient(UUID_A).error, /id/);
  assert.match(api.validSlugClient('a b').error, /hyphen/);
  assert.match(api.validSlugClient('a'.repeat(61)).error, /60/);
});

test("slugify matches the server's: Irving's Cafe & Bar becomes irving-s-cafe-bar", () => {
  const { api } = sandbox();
  assert.equal(api.slugify("Irving's Cafe & Bar"), 'irving-s-cafe-bar');
  assert.equal(api.slugify('  The HUB  '), 'the-hub');
  assert.equal(api.slugify('!!!'), 'vendor', 'nothing usable falls back as the server does');
  const long = api.slugify('a'.repeat(59) + ' b');
  assert.equal(long.length, 59, 'cut at 60 and then stripped of the trailing hyphen the cut left');
  assert.doesNotMatch(long, /-$/);
});

test('the Add vendor placeholder follows the name', () => {
  const { api, node } = sandbox();
  node('nv-name').value = "Irving's Cafe & Bar";
  api.syncNewVendorSlugPlaceholder();
  assert.equal(node('nv-slug').placeholder, 'irving-s-cafe-bar');
  node('nv-name').value = '   ';
  api.syncNewVendorSlugPlaceholder();
  assert.equal(node('nv-slug').placeholder, '', 'no name, no invented "vendor" placeholder');
});

/* ---------- unmatched refs ---------- */

test('unmatched refs are rendered as text, never as markup, and the generic tag is its own row', async () => {
  const hostile = '<img src=x onerror=1>';
  const { api, node } = sandbox({
    routes: {
      '/api/admin/nfc': {
        body: {
          vendors: [IRVINGS],
          unmatched: [
            { ref: hostile, taps: 2, taps30d: 2, lastTap: ago(HOUR) },
            { ref: 'generic', taps: 9, taps30d: 5, lastTap: ago(3 * HOUR) },
          ],
        },
      },
    },
  });
  await api.loadNfc();

  assert.equal(node('nfc-unmatched').hidden, false);
  const rows = node('nfc-unmatched-list').children;
  assert.equal(rows.length, 1, "'generic' is the campus tag, not a mistake, so it is not listed here");
  const ref = find(rows[0], (n) => n.textContent === `/t/${hostile}`);
  assert.ok(ref, 'the ref is shown exactly as the tag carried it');
  assert.equal(all(node('nfc-unmatched-list'), (n) => n.innerHTML !== '').length, 0, 'innerHTML is never assigned under the unmatched list');
  assert.match(flatText(rows[0]), /2 taps, 2 in 30 days, last /);

  const generic = node('nfc-list').children.at(-1);
  assert.match(flatText(generic), /Generic tag \(\/t\)/);
  assert.match(flatText(generic), /5 in 30 days/);
  assert.match(flatText(generic), /9 all time/);
  assert.equal(node('nfc-count').textContent, '1 spot · 47 taps in 30 days', 'unmatched taps were still people at counters');
});

test('the vendor name is text too', () => {
  const { api } = sandbox();
  const row = api.buildNfcRow({ ...IRVINGS, name: '<script>alert(1)</script>', slug: 'x' });
  assert.equal(find(row, (n) => n.className === 'nfc-name').textContent, '<script>alert(1)</script>');
  assert.equal(all(row, (n) => n.innerHTML !== '').length, 0);
});

/* ---------- export ---------- */

test('Export all as CSV fetches the export route and saves it as nfc-taps.csv', async () => {
  const { api, node, calls } = sandbox({ routes: { '/api/admin/nfc/export': { body: {} } } });
  const btn = node('nfc-export');
  btn.textContent = 'Export all as CSV';
  await api.exportNfcAll(btn);
  assert.deepEqual(calls.fetches.map((f) => f.url), ['/api/admin/nfc/export']);
  assert.deepEqual(calls.saved, ['werewards-nfc-taps.csv']);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Export all as CSV', 'the label comes back');
  assert.equal(node('nfc-error').hidden, true);

  const broken = sandbox({ routes: { '/api/admin/nfc/export': { status: 500 } } });
  await broken.api.exportNfcAll(broken.node('nfc-export'));
  assert.deepEqual(broken.calls.saved, []);
  assert.equal(broken.node('nfc-error').hidden, false);
});

/* ---------- the traffic panel ---------- */

test('Traffic draws taps, says taps, and explains a missing migration instead of drawing nothing', async () => {
  const detail = {
    vendor_id: UUID_A, days: 30, timezone: 'America/New_York',
    daily: [{ day: '2026-10-12', taps: 3 }, { day: '2026-10-13', taps: 0 }, { day: '2026-10-14', taps: 1 }],
    hourly: [{ hour: 8, taps: 2 }, { hour: 9, taps: 0 }],
  };
  const { api, calls } = sandbox({ routes: { [`/api/admin/nfc/${UUID_A}/detail`]: { body: detail } } });
  const row = api.buildNfcRow(IRVINGS);
  const panel = find(row, (n) => n.className === 'qr-detail');
  const btn = button(row, 'Traffic');
  await btn.click();
  assert.equal(calls.fetches.at(-1).url, `/api/admin/nfc/${UUID_A}/detail?days=30`);
  assert.equal(panel.hidden, false);
  assert.equal(btn.textContent, 'Hide traffic');
  const text = flatText(panel);
  assert.match(text, /Last 30 days peak 3 in a day/);
  assert.match(text, /Time of day local time · peak 2 in an hour/);
  assert.match(text, /first tap /);
  const bars = all(panel, (n) => n.className === 'qr-bar-col');
  assert.equal(bars.length, 5);
  assert.equal(bars[0].title, '2026-10-12: 3 taps');
  assert.equal(bars[2].title, '2026-10-14: 1 tap');
  assert.ok(!bars.some((b) => /scan/.test(b.title)), 'a tag is tapped, not scanned');
  assert.ok(find(bars[1], (n) => n.classList.contains('qr-bar-empty')), 'a day with nothing is a hairline, not a gap');

  await btn.click();
  assert.equal(panel.hidden, true);
  assert.equal(btn.textContent, 'Traffic');

  const missing = sandbox({ routes: { [`/api/admin/nfc/${UUID_A}/detail`]: { body: { unavailable: 'migration-065', days: 30, daily: [], hourly: [] } } } });
  const row2 = missing.api.buildNfcRow(IRVINGS);
  await button(row2, 'Traffic').click();
  assert.match(flatText(find(row2, (n) => n.className === 'qr-detail')), /Migration 065 not applied/);
});

/* ---------- Edit slug, from the card ---------- */

test('Edit slug opens the Edit dialog on the roster row, loading the roster first if it has not arrived', async () => {
  const rosterRow = { id: UUID_A, name: "Irving's", slug: 'irvings' };
  const { api, node, calls } = sandbox({ roster: [], lateRoster: [rosterRow] });
  const row = api.buildNfcRow(IRVINGS);
  await button(row, 'Edit slug').click();
  assert.equal(calls.rosterLoads, 1, 'the roster was fetched because it was empty');
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].v, rosterRow, 'the dialog edits the live roster object, not the card\'s copy');
  assert.equal(node('vendor-edit-slug').focused, true);

  // A roster that already has the row is not fetched again.
  const warm = sandbox({ roster: [rosterRow] });
  await button(warm.api.buildNfcRow(IRVINGS), 'Edit slug').click();
  assert.equal(warm.calls.rosterLoads, 0);
  assert.equal(warm.calls.opened.length, 1);

  // A spot the roster does not know (deleted meanwhile) is a row error, not a crash.
  const gone = sandbox({ roster: [], lateRoster: [] });
  const row3 = gone.api.buildNfcRow(IRVINGS);
  await button(row3, 'Edit slug').click();
  assert.equal(gone.calls.opened.length, 0);
  const err = find(row3, (n) => n.className === 'qr-row-error');
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /roster/);
});

/* ---------- the field in the Edit dialog ---------- */

test('the live hint shows both addresses for a good slug and the reason for a bad one', () => {
  const { api, node } = sandbox();
  node('vendor-edit-slug').value = 'Irvings';
  api.syncVendorSlugHint();
  assert.equal(node('vendor-slug-urls').textContent, 'we-rewards.com/spots/irvings · we-rewards.com/t/irvings');
  assert.equal(node('vendor-slug-urls').classList.contains('is-err'), false);

  node('vendor-edit-slug').value = '-bad';
  api.syncVendorSlugHint();
  assert.match(node('vendor-slug-urls').textContent, /hyphen/);
  assert.equal(node('vendor-slug-urls').classList.contains('is-err'), true);

  node('vendor-edit-slug').value = '';
  api.syncVendorSlugHint();
  assert.equal(node('vendor-slug-urls').textContent, '', 'an empty field is not yet a mistake');
  assert.equal(node('vendor-slug-urls').classList.contains('is-err'), false);
});

test('Save address refuses a bad slug locally, shows a 409 in the server\'s words, and updates the card on success', async () => {
  const rosterRow = { id: UUID_A, name: "Irving's", slug: 'irvings' };
  let answer = { status: 409, body: { error: 'SLUG_TAKEN', message: 'That slug is already used by another spot.' } };
  const { api, node, calls } = sandbox({
    routes: (url, opts) => (opts.method === 'PATCH' ? answer : { body: { vendors: [IRVINGS], unmatched: [] } }),
    roster: [rosterRow],
  });
  await api.loadNfc();
  const info = fakeNode('info');
  info.isConnected = true;
  api.setEditVendor({ v: rosterRow, infoEl: info });

  // Refused here, before any round trip.
  node('vendor-edit-slug').value = 'admin';
  await api.saveVendorSlug();
  assert.equal(calls.fetches.filter((f) => f.method === 'PATCH').length, 0);
  assert.match(node('vendor-slug-note').textContent, /reserved/);
  assert.equal(node('vendor-slug-note').kind, 'err');

  // Taken: the server's sentence, verbatim.
  node('vendor-edit-slug').value = 'cafe-210';
  await api.saveVendorSlug();
  const patch = calls.fetches.find((f) => f.method === 'PATCH');
  assert.equal(patch.url, `/api/admin/vendors/${UUID_A}`);
  assert.deepEqual(patch.body, { slug: 'cafe-210' });
  assert.equal(node('vendor-slug-note').textContent, 'That slug is already used by another spot.');
  assert.equal(node('vendor-slug-note').kind, 'err');
  assert.equal(node('vendor-slug-save').disabled, false);
  assert.equal(rosterRow.slug, 'irvings', 'nothing changed');

  // Saved: the roster object, its row, the card's row and the hint all follow.
  answer = { body: { ...rosterRow, slug: 'irvings-downtown' } };
  node('vendor-edit-slug').value = ' Irvings-Downtown ';
  await api.saveVendorSlug();
  assert.equal(calls.fetches.at(-1).body.slug, 'irvings-downtown', 'sent normalised, so what the server stores is what the hint showed');
  assert.equal(rosterRow.slug, 'irvings-downtown');
  assert.match(info.innerHTML, /irvings-downtown/);
  assert.equal(calls.rosterPaints, 0, 'the row was on screen, so no full repaint');
  assert.equal(node('vendor-edit-slug').value, 'irvings-downtown');
  assert.equal(node('vendor-slug-urls').textContent, 'we-rewards.com/spots/irvings-downtown · we-rewards.com/t/irvings-downtown');
  assert.equal(node('vendor-slug-note').kind, 'ok');
  assert.match(node('vendor-slug-note').textContent, /Rewrite any tag/, 'the save is the moment to say what the operator now has to do');
  assert.equal(api.state().nfcRows[0].slug, 'irvings-downtown');
  const link = find(node('nfc-list').children[0], (n) => n.className === 'qr-link');
  assert.equal(link.textContent, '/t/irvings-downtown', 'the card repaints with the new address');
  assert.equal(node('nfc-ok').hidden, false);
  assert.match(node('nfc-ok').textContent, /Rewrite any tag/);
});

test('a save from the NFC card with the roster row off screen repaints the roster', async () => {
  const rosterRow = { id: UUID_A, name: "Irving's", slug: 'irvings' };
  const { api, node, calls } = sandbox({ routes: () => ({ body: { ...rosterRow, slug: 'new' } }), roster: [rosterRow] });
  api.setEditVendor({ v: rosterRow, infoEl: fakeNode('div') });   // a detached stand-in, as editNfcSlug makes
  node('vendor-edit-slug').value = 'new';
  await api.saveVendorSlug();
  assert.equal(calls.rosterPaints, 1);
  assert.equal(rosterRow.slug, 'new');
});

/* ---------- copy and wiring ---------- */

test('the block has no em dash anywhere, and neither does the markup it drives', () => {
  // Comments are exempt from the copy rule, but telling a comment from a
  // string by regex is unreliable, so the whole block is held to it.
  assert.ok(!slice.includes('—'), 'em dash in the NFC block of admin.js');
  const card = html.slice(html.indexOf('<!-- ===== NFC TAGS (migration-065) ===== -->'), html.indexOf('<!-- ===== POOLS TAB ===== -->'));
  assert.ok(card.length > 0, 'the NFC card moved in index.html');
  assert.ok(!card.includes('—'), 'em dash in the NFC card of index.html');
  const section = html.slice(html.indexOf('Web address and NFC tag'), html.indexOf('<!-- Which BRANCH this row is'));
  assert.ok(section.length > 0, 'the slug section moved in index.html');
  assert.ok(!section.includes('—'), 'em dash in the slug section of index.html');
  const field = html.slice(html.indexOf('for="nv-slug"'), html.indexOf('for="nv-email"'));
  assert.ok(field.length > 0 && !field.includes('—'), 'em dash in the nv-slug field of index.html');
});

test('every id the block and its wiring reach for exists in index.html', () => {
  const ids = [...src.matchAll(/\$\('((?:nfc|vendor-slug|vendor-edit-slug|nv-slug)[a-z-]*)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected the nfc ids in admin.js, found ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `admin.js reaches for #${id}, which is not in index.html`);
  }
  for (const id of ['nfc-count', 'nfc-error', 'nfc-ok', 'nfc-unavailable', 'nfc-export', 'nfc-list', 'nfc-unmatched',
    'vendor-edit-slug', 'vendor-slug-save', 'vendor-slug-note', 'vendor-slug-hint', 'nv-slug']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
  }
  const slugInput = html.match(/<input id="vendor-edit-slug"[^>]*>/)?.[0] ?? '';
  assert.match(slugInput, /maxlength="60"/);
  assert.match(slugInput, /autocapitalize="off"/, 'a phone keyboard would capitalise the first letter');
  assert.match(slugInput, /spellcheck="false"/);
  assert.match(html, /Changing it changes the spot's web address and any tag already written with the old one\. Rewrite those tags\./);
  assert.doesNotMatch(html, /short id beside it in the roster is fixed/, 'the old "fixed" hint is no longer true');
});

test('the wiring outside the block: the tab, the refresh, the dialog, the form and the worker', () => {
  const boot = src.slice(src.indexOf('(async function boot() {'), src.indexOf('sb.auth.onAuthStateChange(onAuthEvent);'));
  assert.match(boot, /\$\('nfc-export'\)\.addEventListener\('click', \(\) => exportNfcAll\(\$\('nfc-export'\)\)\)/);
  assert.match(boot, /\$\('vendor-slug-save'\)\.addEventListener\('click', saveVendorSlug\)/);
  assert.match(boot, /\$\('vendor-edit-slug'\)\.addEventListener\('input', syncVendorSlugHint\)/);
  assert.match(boot, /\$\('nv-name'\)\.addEventListener\('input', syncNewVendorSlugPlaceholder\)/);

  const openPoster = src.slice(src.indexOf('function openPoster() {'), src.indexOf('/* ---------- NFC tags (migration-065)'));
  assert.match(openPoster, /loadQrCodes\(\);\s*loadNfc\(\);/, 'the poster tab loads the tag card on every open');

  const loadAll = src.slice(src.indexOf('async function loadAll() {'), src.indexOf('/* ---------- view tabs ---------- */'));
  assert.match(loadAll, /nfcLoaded \? loadNfc\(\) : null,/, 'the ↻ button the error line names must reach the card');

  const openModal = src.slice(src.indexOf('function openVendorModal(v, infoEl) {'), src.indexOf('function closeVendorModal() {'));
  assert.match(openModal, /\$\('vendor-edit-slug'\)\.value = v\.slug \?\? '';/);
  assert.match(openModal, /syncVendorSlugHint\(\);/);

  const problem = src.slice(src.indexOf('function firstNewVendorProblem() {'), src.indexOf('async function createVendor(e) {'));
  assert.match(problem, /validSlugClient\(slug\)/, 'the Add vendor form checks the address before the round trip');
  const create = src.slice(src.indexOf('async function createVendor(e) {'), src.indexOf('function buildChart(daily) {'));
  assert.match(create, /slug: \$\('nv-slug'\)\.value\.trim\(\) \|\| undefined,/, 'sent only when typed');

  const rows = src.slice(src.indexOf('function paintVendorRows(list) {'), src.indexOf('function setAddrNote(note, v) {'));
  assert.match(rows, /row\.dataset\.vendorId = v\.id;/, 'how Edit slug finds the roster row to repaint');

  const sw = readFileSync(fileURLToPath(new URL('../public/admin/sw.js', import.meta.url)), 'utf8');
  const m = /const CACHE = 'werewards-admin-v(\d+)'/.exec(sw);
  assert.ok(m && Number(m[1]) >= 33, 'index.html changed: the admin worker CACHE must be v33 or later');
  assert.match(src.slice(src.indexOf('const VIEWS'), src.indexOf('const VIEWS') + 200), /'poster'/, 'no new tab: the card lives on the poster view');
});
