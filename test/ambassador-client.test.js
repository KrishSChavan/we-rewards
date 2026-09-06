// The ambassador block in public/student/app.js — the half of migration-053
// that runs on an ambassador's own phone and decides what QR they hand somebody.
//
// TWO THINGS HERE HAVE NO OTHER SAFETY NET, and they are why this file exists.
//
//   THE QR ENCODES A URL IN BYTE MODE. Every other QR this app draws carries an
//   uppercase "WRW:…" payload in Alphanumeric mode, which is denser and is what
//   drawQr defaults to. QR Alphanumeric has NO LOWERCASE IN ITS ALPHABET, so
//   asking for it with an https:// URL throws inside the vendored encoder — and
//   the catch around the draw turns that into a sheet with no QR in it, which is
//   a feature that silently does not work. The mode and the payload are asserted
//   here because nothing else can catch that swap.
//
//   THE BUTTON MUST NOT SURVIVE ITS OWNER. It is revealed for a handful of
//   students, so every path that puts it away — not an ambassador, a paused one,
//   a sign-out — is a path nobody exercises by accident.
//
// SLICED AND EVALUATED, following test/nearby-client.test.js: the four
// front-ends under public/ are browser scripts, not modules, so nothing in test/
// can import from them. The landmarks are deliberately brittle — if either
// moves, this throws rather than quietly testing nothing. It reads public/, not
// .build/, because the source is what a person edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');
const from = src.indexOf('/* ---------- ambassador code (migration-053) ----------');
const to = src.indexOf('/* ---------- hub: tier meter');
assert.ok(from > 0 && to > from, 'ambassador block landmarks moved in public/student/app.js — re-anchor this test');
const slice = src.slice(from, to);

/**
 * A fake element that records what was done to it, so a test can assert the
 * ORDER of two writes and not just the end state. That matters once: the
 * button's description has to be written BEFORE the button is unhidden, or a
 * screen reader can reach a control whose only label is the markup's default.
 */
function el(id, log) {
  const node = {
    id,
    _hidden: true,
    _text: '',
    get hidden() { return this._hidden; },
    set hidden(v) { this._hidden = v; log.push({ id, set: 'hidden', value: v }); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; log.push({ id, set: 'text', value: v }); },
    style: {},
    classList: {
      _on: new Set(),
      add(c) { this._on.add(c); },
      remove(c) { this._on.delete(c); },
      contains(c) { return this._on.has(c); },
    },
    setAttribute(k, v) { log.push({ id, set: k, value: v }); },
    focus() {},
    contains: () => false,
    getBoundingClientRect: () => ({ height: 400 }),
    offsetWidth: 0,
  };
  return node;
}

const AMBASSADOR = {
  code: 'SARAH7',
  name: 'Sarah',
  shareUrl: 'https://we-rewards.com/r/SARAH7',
  points: 200,
  scans: 43,
  signups: 6,
  pointsEarned: 1200,
};

/**
 * Build a fresh sandbox per test. Everything the block reaches for that only
 * exists in a browser is shadowed by a local binding, so the slice runs
 * unmodified and nothing leaks between tests.
 *
 * `reply` is what /api/me/ambassador answers; `fail` makes the fetch throw,
 * which is the offline case; `qrThrows` stands in for a device where the
 * vendored encoder is missing or refused the payload.
 */
function sandbox({
  reply = { ambassador: null }, ok = true, fail = false,
  qrThrows = false, viewport = { innerWidth: 390, innerHeight: 844 },
  share = null, clipboard = null,
} = {}) {
  const log = [];
  const calls = { fetches: [], qr: [], toasts: [], shares: [], copies: [] };
  const nodes = new Map();

  const deps = {
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, el(id, log));
      return nodes.get(id);
    },
    authFetch: async (url) => {
      calls.fetches.push(url);
      if (fail) throw new Error('offline');
      return { ok, json: async () => reply };
    },
    // The assertion target: what payload, at what size, in WHICH MODE.
    drawQr: (canvas, payload, target, mode) => {
      calls.qr.push({ payload, target, mode });
      if (qrThrows) throw new Error('no encoder');
    },
    punchToast: (msg) => { calls.toasts.push(msg); },
    sheetOffset: () => 0,
    navigator: {
      ...(share ? { share: async (data) => { calls.shares.push(data); return share(); } } : {}),
      ...(clipboard ? { clipboard: { writeText: async (t) => { calls.copies.push(t); return clipboard(); } } } : {}),
    },
    window: viewport,
    document: { activeElement: null },
    setTimeout: (fn) => { fn(); return 0; },
  };

  // eslint-disable-next-line no-new-func
  const api = new Function('deps', `
    let { $, authFetch, drawQr, punchToast, sheetOffset, navigator, window,
          document, setTimeout } = deps;
    ${slice}
    return {
      loadAmbassador, resetAmbassador, openAmbassadorSheet, closeAmbassadorSheet,
      dropAmbassadorSheet, renderAmbassadorSheet, shareAmbassador,
      state: () => ambassadorState,
      setState: (s) => { ambassadorState = s; },
    };
  `)(deps);

  return { api, log, calls, node: (id) => deps.$(id) };
}

/** Every write to `id`, in order — for the "before it was unhidden" assertions. */
const writes = (log, id) => log.filter((e) => e.id === id);

/* ---------- who gets a button at all ---------- */

test('a student who is not an ambassador is left with no button', async () => {
  const { api, node } = sandbox({ reply: { ambassador: null } });
  await api.loadAmbassador();
  assert.equal(node('ambassador-btn').hidden, true);
  assert.equal(node('ambassador-title').hidden, true);
  assert.equal(api.state(), null);
});

test('an ambassador gets the section, and the description is written BEFORE it is reachable', async () => {
  const { api, node, log } = sandbox({ reply: { ambassador: AMBASSADOR } });
  await api.loadAmbassador();

  assert.equal(node('ambassador-btn').hidden, false);
  assert.equal(node('ambassador-title').hidden, false);

  // The ordering guard. A screen reader that reached the button between these
  // two writes would announce the markup's generic default over live state.
  const desc = writes(log, 'ambassador-btn-desc').findIndex((e) => e.set === 'text');
  assert.ok(desc >= 0, 'the description should be written');
  const unhide = log.findIndex((e) => e.id === 'ambassador-btn' && e.set === 'hidden' && e.value === false);
  const descAt = log.findIndex((e) => e.id === 'ambassador-btn-desc' && e.set === 'text');
  assert.ok(descAt < unhide, 'the description must be written before the button is unhidden');
});

test('the description names the code, and reports what has actually happened', async () => {
  for (const [row, expected] of [
    [{ ...AMBASSADOR, signups: 0, pointsEarned: 0 }, 'Code SARAH7 · nobody has joined through it yet'],
    [{ ...AMBASSADOR, signups: 6, pointsEarned: 0 }, 'Code SARAH7 · 6 joined'],
    [{ ...AMBASSADOR, signups: 6, pointsEarned: 1200 }, 'Code SARAH7 · 6 joined · 1200 points earned'],
  ]) {
    const { api, node } = sandbox({ reply: { ambassador: row } });
    await api.loadAmbassador();
    assert.equal(node('ambassador-btn-desc').textContent, expected);
  }
});

test('a paused ambassador loses the button AND has the sheet taken down', async () => {
  // The server filters `active = false` out, so this arrives as a plain null —
  // but the student may be looking at the sheet when it does. Their link now
  // redirects home, so leaving it up would be showing a QR that goes nowhere.
  const { api, node } = sandbox({ reply: { ambassador: AMBASSADOR } });
  await api.loadAmbassador();
  api.openAmbassadorSheet();
  assert.equal(node('ambassador-modal').hidden, false);

  const { api: api2, node: node2 } = sandbox({ reply: { ambassador: null } });
  api2.setState(AMBASSADOR);
  node2('ambassador-modal').hidden = false;
  node2('ambassador-modal').classList.add('is-open');
  await api2.loadAmbassador();
  assert.equal(node2('ambassador-btn').hidden, true);
  assert.equal(node2('ambassador-modal').hidden, true, 'the sheet must come down with the button');
  assert.equal(node2('ambassador-modal').classList.contains('is-open'), false);
});

test('a failed load leaves the button exactly as it was, rather than blanking it', async () => {
  // Offline on a phone that already has the section up: re-hiding it here would
  // make an ambassador lose their code every time they opened the app on the bus.
  const { api, node } = sandbox({ reply: { ambassador: AMBASSADOR } });
  await api.loadAmbassador();
  assert.equal(node('ambassador-btn').hidden, false);

  const { api: offline, node: n2 } = sandbox({ fail: true });
  n2('ambassador-btn').hidden = false;
  await offline.loadAmbassador();
  assert.equal(n2('ambassador-btn').hidden, false, 'a network failure must not put the button away');

  const { api: bad, node: n3 } = sandbox({ ok: false });
  n3('ambassador-btn').hidden = false;
  await bad.loadAmbassador();
  assert.equal(n3('ambassador-btn').hidden, false, 'a non-2xx must not put the button away either');
});

test('sign-out puts the section away even though loadAmbassador may never run again', () => {
  // resetAmbassador exists precisely because the offline case above returns
  // early: without it, the next student on a phone with no signal would open
  // Account and read the previous one's code.
  const { api, node } = sandbox();
  api.setState(AMBASSADOR);
  node('ambassador-btn').hidden = false;
  node('ambassador-title').hidden = false;
  api.resetAmbassador();
  assert.equal(api.state(), null);
  assert.equal(node('ambassador-btn').hidden, true);
  assert.equal(node('ambassador-title').hidden, true);
});

/* ---------- the QR itself ----------
   The reason this file exists. The first two failures below are SILENT in
   production: the wrong mode throws inside the encoder and the catch hides the
   QR card, and the wrong payload draws a QR that scans to a string a camera app
   has nothing to do with. Either way the sheet still opens and still looks
   almost right. */

test('the QR carries the /r/ URL, not the bare code', () => {
  const { api, calls } = sandbox();
  api.setState(AMBASSADOR);
  api.renderAmbassadorSheet();
  assert.equal(calls.qr.length, 1);
  assert.equal(calls.qr[0].payload, AMBASSADOR.shareUrl);
  assert.notEqual(calls.qr[0].payload, AMBASSADOR.code,
    'a stranger’s camera app can only open a link — the code alone does nothing');
});

test('the QR is drawn in Byte mode, because Alphanumeric has no lowercase', () => {
  const { api, calls } = sandbox();
  api.setState(AMBASSADOR);
  api.renderAmbassadorSheet();
  assert.equal(calls.qr[0].mode, 'Byte');
  // Belt and braces on the reason: if this ever stops being true the mode could
  // safely change, and this line says why it currently cannot.
  assert.match(AMBASSADOR.shareUrl, /[a-z]/, 'the payload contains lowercase');
});

test('the URL the server built is used verbatim — the client never assembles one', () => {
  // A student on staging must not hand somebody a link into staging, which is
  // what location.origin would produce. The origin is decided once, server-side.
  const staging = { ...AMBASSADOR, shareUrl: 'https://staging.example.com/r/SARAH7' };
  const { api, calls } = sandbox();
  api.setState(staging);
  api.renderAmbassadorSheet();
  assert.equal(calls.qr[0].payload, staging.shareUrl);
});

test('the QR is sized to the viewport, and never below the scannable floor', () => {
  const tall = sandbox();
  tall.api.setState(AMBASSADOR);
  tall.api.renderAmbassadorSheet();
  assert.ok(tall.calls.qr[0].target >= 180 && tall.calls.qr[0].target <= 300,
    `a 390x844 phone should land inside the band, got ${tall.calls.qr[0].target}`);

  // A phone held sideways: 844x390 makes the height arithmetic go NEGATIVE, and
  // the floor is the only thing between that and a canvas nothing can read.
  const wide = sandbox({ viewport: { innerWidth: 844, innerHeight: 390 } });
  wide.api.setState(AMBASSADOR);
  wide.api.renderAmbassadorSheet();
  assert.equal(wide.calls.qr[0].target, 180, 'a landscape phone should land exactly on the floor');

  // A tablet: the cap is what stops the QR ballooning to fill it.
  const tablet = sandbox({ viewport: { innerWidth: 1024, innerHeight: 1366 } });
  tablet.api.setState(AMBASSADOR);
  tablet.api.renderAmbassadorSheet();
  assert.equal(tablet.calls.qr[0].target, 300, 'a tablet should land exactly on the cap');
});

test('an encoder that throws hides the card rather than leaving a blank white square', () => {
  const { api, node } = sandbox({ qrThrows: true });
  api.setState(AMBASSADOR);
  api.renderAmbassadorSheet();
  assert.equal(node('ambassador-qr-card').hidden, true);
  // …and the code and link are still on screen, which is the whole reason the
  // sheet is allowed to open without a QR at all.
  assert.equal(node('ambassador-value').textContent, AMBASSADOR.code);
  assert.equal(node('ambassador-link').textContent, 'we-rewards.com/r/SARAH7');
});

test('a successful draw reveals the card', () => {
  const { api, node } = sandbox();
  api.setState(AMBASSADOR);
  api.renderAmbassadorSheet();
  assert.equal(node('ambassador-qr-card').hidden, false);
});

/* ---------- what is written under it ---------- */

test('the link line drops the scheme but keeps everything that identifies it', () => {
  const { api, node } = sandbox();
  api.setState(AMBASSADOR);
  api.renderAmbassadorSheet();
  assert.equal(node('ambassador-link').textContent, 'we-rewards.com/r/SARAH7');
});

test('the code is shown in full, exactly as it was issued', () => {
  const { api, node } = sandbox();
  api.setState({ ...AMBASSADOR, code: 'PSUSARAH12' });
  api.renderAmbassadorSheet();
  assert.equal(node('ambassador-value').textContent, 'PSUSARAH12');
});

test('the stats line says what has happened, or what is on offer, or nothing', () => {
  for (const [row, expected] of [
    [{ ...AMBASSADOR, signups: 6, pointsEarned: 1200 }, '6 joined through your code · 1200 points earned'],
    [{ ...AMBASSADOR, signups: 6, pointsEarned: 0 }, '6 joined through your code'],
    [{ ...AMBASSADOR, signups: 0, pointsEarned: 0, points: 200 }, 'You get 200 points for each person who joins'],
  ]) {
    const { api, node } = sandbox();
    api.setState(row);
    api.renderAmbassadorSheet();
    assert.equal(node('ambassador-stats').hidden, false);
    assert.equal(node('ambassador-stats').textContent, expected);
  }

  // A 0-rate ambassador with nobody yet has nothing true to say, so it says
  // nothing rather than promising points that would never be paid.
  const { api, node } = sandbox();
  api.setState({ ...AMBASSADOR, signups: 0, pointsEarned: 0, points: 0 });
  api.renderAmbassadorSheet();
  assert.equal(node('ambassador-stats').hidden, true);
});

/* ---------- opening it ---------- */

test('the sheet refuses to open with no code behind it', () => {
  // Reachable: the button is markup, so a stale one left over from a failed
  // load is a tap away from a sheet showing bullets and a blank QR.
  const { api, node, calls } = sandbox();
  api.openAmbassadorSheet();
  assert.equal(node('ambassador-modal').hidden, true);
  assert.equal(calls.qr.length, 0, 'nothing should be drawn');
});

test('opening paints the sheet and marks the button expanded', () => {
  const { api, node, log } = sandbox();
  api.setState(AMBASSADOR);
  api.openAmbassadorSheet();
  assert.equal(node('ambassador-modal').hidden, false);
  assert.equal(node('ambassador-modal').classList.contains('is-open'), true);
  assert.equal(node('ambassador-value').textContent, AMBASSADOR.code);
  assert.ok(writes(log, 'ambassador-btn').some((e) => e.set === 'aria-expanded' && e.value === 'true'));
});

test('a second open while it is already up is a no-op, not a second paint', () => {
  const { api, calls } = sandbox();
  api.setState(AMBASSADOR);
  api.openAmbassadorSheet();
  api.openAmbassadorSheet();
  assert.equal(calls.qr.length, 1);
});

test('closing an already-closed sheet does nothing', () => {
  // closeEarnSheet's own guard, and it matters for the same reason: Esc calls
  // every close in the app, most of which are already shut.
  const { api, log } = sandbox();
  api.setState(AMBASSADOR);
  api.closeAmbassadorSheet();
  assert.equal(writes(log, 'ambassador-btn').filter((e) => e.set === 'aria-expanded').length, 0);
});

test('close leaves it hidden and the button collapsed', () => {
  const { api, node, log } = sandbox();
  api.setState(AMBASSADOR);
  api.openAmbassadorSheet();
  api.closeAmbassadorSheet();
  assert.equal(node('ambassador-modal').classList.contains('is-open'), false);
  // setTimeout is synchronous in the sandbox, so the deferred hide has run.
  assert.equal(node('ambassador-modal').hidden, true);
  assert.ok(writes(log, 'ambassador-btn').some((e) => e.set === 'aria-expanded' && e.value === 'false'));
});

/* ---------- sharing it ---------- */

test('a cancelled share sheet does NOT fall through to the clipboard', () => {
  // The one bug that is easy to write here: AbortError is the student deciding
  // not to share, and treating it as a failure claims "Link copied!" over a
  // decision they just made.
  const abort = () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
  const { api, calls } = sandbox({ share: abort, clipboard: () => true });
  api.setState(AMBASSADOR);
  return api.shareAmbassador().then(() => {
    assert.equal(calls.shares.length, 1);
    assert.equal(calls.copies.length, 0, 'a cancel must not copy');
    assert.equal(calls.toasts.length, 0, 'and must not claim it did');
  });
});

test('the share sheet gets the full URL, scheme and all', async () => {
  const { api, calls } = sandbox({ share: () => true });
  api.setState(AMBASSADOR);
  await api.shareAmbassador();
  assert.equal(calls.shares[0].url, AMBASSADOR.shareUrl);
});

test('no share sheet falls back to the clipboard, and no clipboard to the code', async () => {
  const { api, calls } = sandbox({ clipboard: () => true });
  api.setState(AMBASSADOR);
  await api.shareAmbassador();
  assert.deepEqual(calls.copies, [AMBASSADOR.shareUrl]);
  assert.deepEqual(calls.toasts, ['Link copied!']);

  const denied = sandbox({ clipboard: () => { throw new Error('denied'); } });
  denied.api.setState(AMBASSADOR);
  await denied.api.shareAmbassador();
  assert.deepEqual(denied.calls.toasts, ['Your code: SARAH7'],
    'the last resort is the short string they can read out');
});

test('sharing with no code does nothing at all', async () => {
  const { api, calls } = sandbox({ share: () => true, clipboard: () => true });
  await api.shareAmbassador();
  assert.equal(calls.shares.length + calls.copies.length + calls.toasts.length, 0);
});
