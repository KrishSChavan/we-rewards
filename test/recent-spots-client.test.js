// The Home carousel's RECENT SPOTS row, and the one thing it could not do
// until now: change while you are looking at it.
//
// `recent` and `visited` are server flags, delivered by GET /api/me/balances.
// A balance push carries a NUMBER, so an earn repainted the card's points and
// left the spot out of the row until something unrelated happened to refetch —
// backing out of the spot screen, a punch, a socket reconnect. Standing at a
// counter watching your points go up while the row above still treats the place
// as a stranger is the bug these cases are here to keep closed.
//
// The failure mode is why it needs a test at all: nothing throws, nothing logs,
// and the row is CORRECT a few seconds later, so the only symptom is a student
// who thinks the app is slow. A regression here would be invisible in every
// other test in this suite.
//
// SLICED AND EVALUATED, following test/nearby-client.test.js: the four
// front-ends under public/ are browser scripts, not modules (build-client.js
// transforms each file with no bundling), so nothing in test/ can import from
// them. The landmarks are deliberately brittle — if any moves, this throws
// rather than quietly testing nothing. It reads public/, not .build/, because
// the source is what a person edits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');

/** Slice `src` between two landmarks, insisting both are still there. */
function block(fromNeedle, toNeedle) {
  const from = src.indexOf(fromNeedle);
  const to = src.indexOf(toNeedle, from + 1);
  assert.ok(
    from > 0 && to > from,
    `landmark moved in public/student/app.js — re-anchor this test: ${fromNeedle}`
  );
  return src.slice(from, to);
}

// The two functions a live visit goes through...
const visitBlock = block('function markVendorVisited(', '// Whether each vendor card carries');
// ...and the row that is supposed to notice.
const rowBlock = block("const RECOMMENDED_HEADING = 'RECOMMENDED'", '/* ---------- home: fitting one screen');
const lensLine = block('const hasRecentSpots = ', '\n');

/**
 * Build a fresh sandbox per test.
 *
 * `renderVendors` and `pruneNearbyDwell` are counted rather than run: they are
 * the whole of what "repaint" means here, and both reach into a DOM this file
 * has no business standing up. Counting them is also the only way to assert the
 * negative that matters — that a regular's second visit of the week repaints
 * NOTHING, which is what keeps this off the hot path of every push.
 *
 * `spotsOrder` and `recommendedList` are faithful stand-ins, not slices: this
 * file is about WHICH list the row shows and when it changes, not about how
 * that list is ordered or how recommendations are chosen. Those have their own
 * homes (test/address-format.test.js, the ranking comments in app.js).
 */
function sandbox(vendors = []) {
  const calls = { renders: 0, prunes: 0 };
  // eslint-disable-next-line no-new-func
  return new Function('calls', 'seed', `
    let allVendors = seed;
    let homeLens = null;
    function renderVendors() { calls.renders++; }
    function pruneNearbyDwell() { calls.prunes++; }
    const searchFold = (s) => String(s ?? '').toLowerCase();
    function spotsOrder(a, b) {
      return searchFold(a.name).localeCompare(searchFold(b.name), undefined, { numeric: true });
    }
    const recommendedList = () => allVendors.filter((v) => !v.visited);
    ${visitBlock}
    ${rowBlock}
    ${lensLine}
    return {
      markVendorVisited, applyVisitLocally, recentVendors, hasRecentSpots,
      vendors: () => allVendors,
      setLens: (l) => { homeLens = l; },
    };
  `)(calls, vendors);
}

const spot = (over = {}) => ({
  vendorId: over.vendorId ?? 'v1',
  name: over.name ?? 'Fresh Spot',
  recent: over.recent ?? false,
  visited: over.visited ?? false,
  favorite: over.favorite ?? false,
  recommendedRank: over.recommendedRank ?? null,
  createdAt: over.createdAt ?? '2026-01-01T00:00:00Z',
});

describe('markVendorVisited', () => {
  test('a visit sets BOTH flags, because it answers both questions', () => {
    const api = sandbox([spot()]);
    assert.equal(api.markVendorVisited('v1'), true);
    const v = api.vendors()[0];
    // `recent` is "have I been here lately" — its window is 7 days, so a visit
    // today is inside it by definition. `visited` is "do I know this place at
    // all", which is a one-way door. Setting only the first would leave the
    // spot eligible to be RECOMMENDED back at the student.
    assert.equal(v.recent, true, 'recent');
    assert.equal(v.visited, true, 'visited');
  });

  test('a repeat visit changes nothing and says so', () => {
    const api = sandbox([spot({ recent: true, visited: true })]);
    // The common case — a regular's second coffee of the week. Returning false
    // is what stops every balance push rebuilding the whole row for nothing.
    assert.equal(api.markVendorVisited('v1'), false);
  });

  test('a spot known but not visited lately is still a change', () => {
    // Somewhere they went last month: `visited` is already true, `recent` is
    // not. A short-circuit on `visited` alone would miss the case the Recent
    // row exists for.
    const api = sandbox([spot({ recent: false, visited: true })]);
    assert.equal(api.markVendorVisited('v1'), true);
    assert.equal(api.vendors()[0].recent, true);
  });

  test('an unknown vendor is a no-op, not a throw', () => {
    // A push can name a spot this catalogue has not loaded — a vendor
    // deactivated since the last /balances, or an event landing mid-boot before
    // the first fetch resolves.
    const api = sandbox([spot()]);
    assert.equal(api.markVendorVisited('nope'), false);
    assert.equal(api.markVendorVisited(undefined), false);
  });
});

// Its own sandbox, because these cases are about the two calls applyVisitLocally
// makes rather than about the list it makes them for — so the row block, and
// everything it needs, is left out entirely.
describe('applyVisitLocally', () => {
  function counted(vendors) {
    const calls = { renders: 0, prunes: 0 };
    // eslint-disable-next-line no-new-func
    const api = new Function('calls', 'seed', `
      let allVendors = seed;
      let homeLens = null;
      function renderVendors() { calls.renders++; }
      function pruneNearbyDwell() { calls.prunes++; }
      ${visitBlock}
      return { applyVisitLocally, vendors: () => allVendors };
    `)(calls, vendors);
    return { api, calls };
  }

  test('the first visit repaints; the second does not', () => {
    const { api, calls } = counted([spot()]);
    api.applyVisitLocally('v1');
    assert.equal(calls.renders, 1, 'first visit repaints the row');
    // Prunes for the same reason loadVendors() does: somewhere they have now
    // been is no longer somewhere to interrupt them about, and a dwell timer
    // left running would fire the moment the server refused the claim.
    assert.equal(calls.prunes, 1, 'first visit prunes the nearby dwell');
    api.applyVisitLocally('v1');
    assert.equal(calls.renders, 1, 'a repeat visit must not rebuild the row');
    assert.equal(calls.prunes, 1);
  });

  test('an unknown vendor repaints nothing', () => {
    const { api, calls } = counted([spot()]);
    api.applyVisitLocally('ghost');
    assert.equal(calls.renders, 0);
    assert.equal(calls.prunes, 0);
  });
});

/* ---------- the wiring, not just the mechanism ----------
   Everything above works on a direct call. What makes the row update RIGHT
   AWAY is the socket handlers making that call — and that is a single line in
   each, of the kind that gets dropped in a refactor without anything failing.
   So these cases register the real handlers through the real connectSocket()
   and push real payloads at them, rather than trusting that they still ask.

   `visit` is a server flag, not something the client can infer: a
   community-points move fires the SAME balance event with a vendorId and is
   deliberately not a visit (see emitBalance in src/lib/realtime.js). The
   negative case below is the one that would silently put a spot the student
   has never walked into at the top of their Recent row. */
describe('the socket handlers', () => {
  const socketBlock = block('function connectSocket()', '// Foreground/background, so the campaign worker');

  function wired(vendors) {
    const calls = { visits: [], renders: 0 };
    const handlers = {};
    const noop = () => {};
    const deps = {
      calls,
      handlers,
      // The socket.io client, standing in for the one served at
      // /socket.io/socket.io.js. `on` is what the block is being tested for, so
      // it records rather than pretends.
      io: () => ({
        on: (name, fn) => { handlers[name] = fn; },
        connect: noop,
        connected: false,
        emit: noop,
        disconnect: noop,
      }),
      seed: vendors,
    };
    // eslint-disable-next-line no-new-func
    new Function('deps', `
      const { calls, handlers, io, seed } = deps;
      let socket = null;
      let currentToken = 't';
      let allVendors = seed;
      let vendor = null;
      let historyLoaded = false;
      const document = { hidden: false, querySelectorAll: () => [] };
      const $ = () => ({ hidden: true });
      const InstallPrompt = { onPointsEarned() {} };
      // The one call under test. Counted rather than run: what it does is
      // covered above, what matters here is THAT the handler asks for it.
      function applyVisitLocally(id) { calls.visits.push(id); calls.renders++; }
      function patchVendorCard() {}
      function applyBalance() {}
      function loadTier() {}
      function loadCommunity() {}
      function setCommunityPoints() {}
      function loadHistory() {}
      function loadVendors() {}
      function loadDeals() {}
      function reportVisibility() {}
      function renderPunchUi() {}
      function decorateCard() {}
      function punchToast() {}
      function closePunchModal() {}
      function closeItemModal() {}
      ${socketBlock}
      connectSocket();
    `)(deps);
    return { handlers, calls };
  }

  test('an award push puts the spot in the Recent row on the spot', () => {
    const { handlers, calls } = wired([spot({ vendorId: 'v1' })]);
    handlers.balance({ vendorId: 'v1', balance: 50, visit: true });
    assert.deepEqual(calls.visits, ['v1']);
  });

  test('a community-points move does NOT count as a visit', () => {
    // Same event, same vendorId, no flag: moving points into a spot happens on
    // the student's phone, not at its counter, which is why the server leaves
    // 'community_transfer' out of the recent query. Claiming a visit here would
    // show the spot in RECENT SPOTS until the next refetch quietly removed it.
    const { handlers, calls } = wired([spot({ vendorId: 'v1' })]);
    handlers.balance({ vendorId: 'v1', balance: 50, community: 10 });
    assert.deepEqual(calls.visits, []);
  });

  test('only the counter that rang it up, never the pooled siblings', () => {
    // One shared purse repaints three cards, but the student walked through one
    // door. Marking the siblings would fill the row with branches of a chain
    // they have never been to.
    const { handlers, calls } = wired([spot({ vendorId: 'v1' }), spot({ vendorId: 'v2' })]);
    handlers.balance({ vendorId: 'v1', poolVendorIds: ['v1', 'v2'], balance: 50, visit: true });
    assert.deepEqual(calls.visits, ['v1']);
  });

  test('a scanned visit counts, an undo restoring visits does not', () => {
    const { handlers, calls } = wired([spot({ vendorId: 'v1' })]);
    handlers.punch({ vendorId: 'v1', visits: 3, visit: true });
    assert.deepEqual(calls.visits, ['v1']);
    // The same event fires when a vendor undoes a visits redemption and the
    // forfeited visits go back. That is not somewhere the student just was.
    handlers.punch({ vendorId: 'v1', visits: 5 });
    assert.deepEqual(calls.visits, ['v1'], 'an undo must not claim a visit');
  });
});

describe('what the student actually sees', () => {
  test('a first visit flips the row from RECOMMENDED to RECENT SPOTS', () => {
    // A brand-new student: nothing recent, so the carousel is showing
    // recommendations. This is the exact moment the row was wrong before —
    // points landed, the card's number moved, and the heading above it went on
    // saying RECOMMENDED with the spot they were standing in nowhere in it.
    const api = sandbox([spot({ vendorId: 'v1', name: 'Cafe One' }), spot({ vendorId: 'v2', name: 'Deli Two' })]);
    assert.equal(api.recentVendors().heading, 'RECOMMENDED');

    api.applyVisitLocally('v1');

    const after = api.recentVendors();
    assert.equal(after.heading, 'RECENT SPOTS');
    assert.equal(after.mode, 'recent');
    assert.deepEqual(after.list.map((v) => v.vendorId), ['v1'], 'only the spot they were at');
  });

  test('the spot they just visited stops being recommended back at them', () => {
    const api = sandbox([spot({ vendorId: 'v1', name: 'Cafe One' }), spot({ vendorId: 'v2', name: 'Deli Two' })]);
    api.applyVisitLocally('v1');
    // Asked for recommendations explicitly, the row skips the recent branch —
    // and must not offer somewhere they were five seconds ago.
    api.setLens('recommended');
    const rec = api.recentVendors();
    assert.equal(rec.heading, 'RECOMMENDED');
    assert.deepEqual(rec.list.map((v) => v.vendorId), ['v2']);
  });

  test('the heading becomes a menu the moment there is a choice to offer', () => {
    // syncHomeLens only offers the picker when the RECENT list would contain
    // something. Before the visit there is nothing to switch between, so the
    // heading is just a heading; after it, both lists exist.
    const api = sandbox([spot({ vendorId: 'v1' }), spot({ vendorId: 'v2', name: 'Deli Two' })]);
    assert.equal(api.hasRecentSpots(), false);
    api.applyVisitLocally('v1');
    assert.equal(api.hasRecentSpots(), true);
  });

  test('a second visit somewhere else joins the row rather than replacing it', () => {
    const api = sandbox([
      spot({ vendorId: 'v1', name: 'Cafe One' }),
      spot({ vendorId: 'v2', name: 'Deli Two' }),
      spot({ vendorId: 'v3', name: 'Ace Bakery' }),
    ]);
    api.applyVisitLocally('v2');
    api.applyVisitLocally('v3');
    // Alphabetical within the row, which is what keeps it stable between
    // pushes instead of reshuffling under a thumb.
    assert.deepEqual(api.recentVendors().list.map((v) => v.name), ['Ace Bakery', 'Deli Two']);
  });

  test('a saved spot still sorts to the front of the row it just joined', () => {
    const api = sandbox([
      spot({ vendorId: 'v1', name: 'Zed Coffee', favorite: true }),
      spot({ vendorId: 'v2', name: 'Ace Bakery' }),
    ]);
    api.applyVisitLocally('v1');
    api.applyVisitLocally('v2');
    assert.deepEqual(api.recentVendors().list.map((v) => v.name), ['Zed Coffee', 'Ace Bakery']);
  });
});
