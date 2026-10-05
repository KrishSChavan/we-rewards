// The Home redesign (merged from home-redesign, b173bb4) and the fixes that
// followed it on staging. Slices the real functions out of
// public/student/app.js between landmarks, the same way
// test/recent-spots-client.test.js does, so a moved landmark fails loudly
// rather than quietly testing nothing. Reads public/, not .build/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const CSS = fileURLToPath(new URL('../public/student/styles.css', import.meta.url));
const src = readFileSync(APP, 'utf8');

function block(fromNeedle, toNeedle) {
  const from = src.indexOf(fromNeedle);
  const to = src.indexOf(toNeedle, from + 1);
  assert.ok(from > 0 && to > from, `landmark moved in public/student/app.js — re-anchor this test: ${fromNeedle}`);
  return src.slice(from, to);
}

const rewardHelpers = block('/* ---------- reward progress (card bars', 'function buildVendorCard(');
// The landmark after the Home block sits INSIDE the Spots tab's comment banner,
// so cut back to where that banner opens or the slice ends in an unclosed /*.
const homeRaw = block('/* ---------- Home: rewards ready / closest reward / getting started', ' * The Spots tab — every vendor');
const homeBlock = homeRaw.slice(0, homeRaw.lastIndexOf('/*'));
const patchBlock = block('function patchVendorCard(', '/* ==================== the spots map');
const balanceHandler = block("socket.on('balance'", "socket.on('punch'");
const escapeBlock = block('function escapeHtml(', '/* ==================== punch cards');

/* ---------- a DOM just big enough ---------- */

function fakeEl(id) {
  let html = '';
  const el = {
    id, hidden: true, className: '', textContent: '', dataset: {}, attrs: {}, writes: 0, cards: [],
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; el.writes++; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    querySelectorAll() { return el.cards; },
  };
  return el;
}

// localStorage as the app sees it. `blocked` reproduces site data being off,
// where every access THROWS rather than returning null.
function memoryStorage({ blocked = false } = {}) {
  const map = new Map();
  const guard = () => { if (blocked) throw new Error('SecurityError: storage blocked'); };
  return {
    map,
    getItem: (k) => { guard(); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { guard(); map.set(k, String(v)); },
    removeItem: (k) => { guard(); map.delete(k); },
  };
}

function sandbox({ vendors = [], email = null, allTime = true, uid = 'user-a', storage = memoryStorage() } = {}) {
  const els = {};
  const $ = (id) => (els[id] ??= fakeEl(id));
  const calls = { opened: [], itemTaps: [], fits: 0 };
  // eslint-disable-next-line no-new-func
  const api = new Function('$', 'calls', 'seed', 'email', 'allTime', 'uid', 'localStorage', `
    let allVendors = seed;
    let studentEmail = email;
    let visitedAllTime = allTime;
    let currentUserId = uid;
    let vendor = null;
    const document = { querySelectorAll: () => [] };
    const vendorMonogram = (n) => String(n).slice(0, 2).toUpperCase();
    function openVendor(id) { calls.opened.push(id); vendor = allVendors.find((x) => String(x.vendorId) === String(id)) ?? null; }
    function onItemTap(e) { calls.itemTaps.push(e.target.dataset.id); }
    ${escapeBlock}
    ${rewardHelpers}
    ${homeBlock}
    return { renderHomeReward, renderHomeStart, renderHomeEmailNudge, renderHomeExtras, onHomeRewardTap,
             refreshHomeRewards, dismissEmailNudge,
             setVendors: (v) => { allVendors = v; }, closeVendor: () => { vendor = null; },
             signIn: (id) => { currentUserId = id; } };
  `)($, calls, vendors, email, allTime, uid, storage);
  return { ...api, $, calls, storage };
}

const spot = (over = {}) => ({
  vendorId: 'v1', name: 'Sauly Bolt', balance: 0, recent: true, visited: true, poolId: null, hasLogo: false,
  rewards: [{ id: 'r-cookie', title: 'Free cookie', cost_in_points: 100 }, { id: 'r-sandwich', title: 'Free sandwich', cost_in_points: 300 }],
  ...over,
});

// A tap on an element inside the card: closest() finds the row we built.
function tapRow(api, selector) {
  const html = api.$('home-reward').innerHTML;
  const m = new RegExp(`<button class="${selector}"[^>]*>`).exec(html);
  assert.ok(m, `no ${selector} in the card`);
  const dataset = {};
  for (const [, k, v] of m[0].matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[k] = v;
  return { target: { closest: () => ({ dataset }) } };
}

/* ---------- the History row regression ---------- */

describe('History rows keep their own styles', () => {
  test('no rule outside History restyles a class the History rows use', () => {
    // History rows (renderHistory) use .hr-icon/.hr-body/.hr-title/.hr-sub/
    // .hr-points. The Home reward card reused three of those names, and its
    // UNSCOPED rules, later in the file, clipped every History title mid-letter.
    // Everything the card owns is now under .home-reward; the only unscoped
    // .hr-* rules left must be History's own, once each.
    const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}@;]+)\{/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')));
    const unscoped = selectors.filter((s) => /^\.hr-/.test(s)).sort();
    assert.deepEqual(unscoped, ['.hr-body', '.hr-icon', '.hr-points', '.hr-points small', '.hr-sub', '.hr-title']);
  });
});

/* ---------- the Home reward card ---------- */

describe('Home reward card', () => {
  test('one spot ready says "Reward ready"; several count SPOTS, matching the rows', () => {
    const api = sandbox({ vendors: [spot({ balance: 120 })] });
    api.renderHomeReward();
    assert.match(api.$('home-reward').innerHTML, />Reward ready</);
    api.setVendors([spot({ balance: 400 }), spot({ vendorId: 'v2', name: 'Irving', balance: 150 })]);
    api.renderHomeReward();
    const html = api.$('home-reward').innerHTML;
    assert.match(html, /Rewards ready at 2 spots/);
    assert.doesNotMatch(html, /rewards ready</i, 'no bare "N rewards ready" any more');
    assert.equal((html.match(/class="hr-row"/g) ?? []).length, 2);
  });

  test('each ready row carries the reward it names, so Redeem can open it', () => {
    const api = sandbox({ vendors: [spot({ balance: 400 })] });
    api.renderHomeReward();
    // 400 covers both; the row names the dearest one it covers.
    assert.match(api.$('home-reward').innerHTML, /data-vendor="v1" data-reward="r-sandwich"/);
  });

  test('the card is only rewritten when what it says changes (it is aria-live)', () => {
    const api = sandbox({ vendors: [spot({ balance: 120 })] });
    const el = api.$('home-reward');
    api.renderHomeReward();
    api.renderHomeReward();
    api.renderHomeReward();
    assert.equal(el.writes, 1, 'identical repaints do not touch the DOM');
    api.setVendors([spot({ balance: 60 })]);     // drops from ready to closest
    api.renderHomeReward();
    assert.equal(el.writes, 2);
    assert.match(el.innerHTML, /40 pts to Free cookie/);
    assert.equal(el.className, 'home-reward is-close');
  });

  test('nothing to show hides the card', () => {
    const api = sandbox({ vendors: [spot({ balance: 120 })] });
    api.renderHomeReward();
    assert.equal(api.$('home-reward').hidden, false);
    api.setVendors([spot({ balance: 0 })]);
    api.renderHomeReward();
    assert.equal(api.$('home-reward').hidden, true);
  });
});

describe('Redeem on Home opens that reward', () => {
  const withItems = (api, ids) => { api.$('items').cards = ids.map((id) => ({ dataset: { id } })); };

  test('a ready row opens the spot AND that reward\'s sheet', () => {
    const api = sandbox({ vendors: [spot({ balance: 120 })] });
    withItems(api, ['r-cookie', 'r-sandwich']);
    api.renderHomeReward();
    api.onHomeRewardTap(tapRow(api, 'hr-row'));
    assert.deepEqual(api.calls.opened, ['v1']);
    assert.deepEqual(api.calls.itemTaps, ['r-cookie']);
  });

  test('the "Closest reward" row opens the spot only', () => {
    const api = sandbox({ vendors: [spot({ balance: 60 })] });
    withItems(api, ['r-cookie']);
    api.renderHomeReward();
    api.onHomeRewardTap(tapRow(api, 'hr-close'));
    assert.deepEqual(api.calls.opened, ['v1']);
    assert.deepEqual(api.calls.itemTaps, []);
  });

  test('a reward gone since the card was drawn leaves the student on the spot screen', () => {
    const api = sandbox({ vendors: [spot({ balance: 120 })] });
    withItems(api, ['r-sandwich']);             // r-cookie no longer on the menu
    api.renderHomeReward();
    api.onHomeRewardTap(tapRow(api, 'hr-row'));
    assert.deepEqual(api.calls.opened, ['v1']);
    assert.deepEqual(api.calls.itemTaps, []);
  });
});

/* ---------- live balance pushes ---------- */

describe('a balance push repaints the bars and the Home card', () => {
  test('patchVendorCard repaints the number AND the card\'s reward bars from the row', () => {
    const painted = [];
    const num = { textContent: '50' };
    const card = { querySelector: () => num };
    // eslint-disable-next-line no-new-func
    const patchVendorCard = new Function('vendorCards', 'allVendors', 'paintCardProgress', `
      ${patchBlock}
      return patchVendorCard;
    `)(new Map([['v1', card]]), [{ vendorId: 'v1', balance: 120 }], (c, row) => painted.push([c, row.balance]));
    patchVendorCard('v1', 120);
    assert.equal(num.textContent, 120);
    assert.deepEqual(painted, [[card, 120]]);
  });

  test('the socket handler refreshes the Home card after patching, before the visit shortcut', () => {
    // A regular's earn does not reach renderVendors() (applyVisitLocally
    // returns early), so the refresh has to be on this path itself.
    const patch = balanceHandler.indexOf('patchVendorCard(id, next)');
    const refresh = balanceHandler.indexOf('refreshHomeRewards();');
    const visit = balanceHandler.indexOf('applyVisitLocally(payload.vendorId)');
    assert.ok(patch > 0 && refresh > patch && visit > refresh, 'order: patch, refresh, visit');
  });

  test('refreshHomeRewards repaints the card, then re-fits the bars', () => {
    const api = sandbox({ vendors: [spot({ balance: 60 })] });
    api.renderHomeReward();
    assert.match(api.$('home-reward').innerHTML, /Closest reward/);
    api.setVendors([spot({ balance: 120 })]);   // a push wrote the new balance
    api.refreshHomeRewards();
    assert.match(api.$('home-reward').innerHTML, />Reward ready</);
  });
});

/* ---------- checklist + nudge copy ---------- */

describe('first-visit checklist and email nudge', () => {
  const fresh = [spot({ visited: false, recent: false, balance: 0 })];

  test('the lead counts the steps actually listed', () => {
    const offer = sandbox({ vendors: fresh, email: { eligible: true, linked: false, bonus: { points: 50 } } });
    offer.renderHomeStart();
    assert.equal(offer.$('home-start-lead').textContent, 'Three steps, takes a minute.');
    assert.equal((offer.$('home-start-list').innerHTML.match(/<li/g) ?? []).length, 3);

    const noOffer = sandbox({ vendors: fresh, email: { eligible: false, linked: false, bonus: null } });
    noOffer.renderHomeStart();
    assert.equal(noOffer.$('home-start-lead').textContent, 'Two steps, takes a minute.');
    assert.equal((noOffer.$('home-start-list').innerHTML.match(/<li/g) ?? []).length, 2);
  });

  test('the nudge names the bonus as community points, and only when there is one', () => {
    const api = sandbox({ email: { eligible: true, linked: false, bonus: { points: 50 } } });
    api.renderHomeEmailNudge();
    assert.equal(api.$('home-email-nudge-wrap').hidden, false);
    assert.equal(api.$('home-email-nudge-sub').textContent, 'Get 50 community points to start');

    const unpaid = sandbox({ email: { eligible: true, linked: false, bonus: null } });
    unpaid.renderHomeEmailNudge();
    assert.equal(unpaid.$('home-email-nudge-sub').textContent, 'Bring your spots and points together');
  });
});

/* ---------- the nudge's ✕ ---------- */

describe('closing the student email nudge', () => {
  const offer = { eligible: true, linked: false, bonus: { points: 50 } };

  test('the ✕ hides it and remembers that under this account', () => {
    const api = sandbox({ email: offer, uid: 'user-a' });
    api.renderHomeEmailNudge();
    assert.equal(api.$('home-email-nudge-wrap').hidden, false);
    api.dismissEmailNudge();
    assert.equal(api.$('home-email-nudge-wrap').hidden, true);
    assert.equal(api.storage.map.get('wr-email-nudge-dismissed:user-a'), '1');
  });

  test('it stays closed through every repaint and the next app open', () => {
    const storage = memoryStorage();
    const first = sandbox({ email: offer, uid: 'user-a', storage });
    first.renderHomeEmailNudge();
    first.dismissEmailNudge();
    first.renderHomeExtras();                   // a balance push repaints Home
    assert.equal(first.$('home-email-nudge-wrap').hidden, true);

    const reopened = sandbox({ email: offer, uid: 'user-a', storage });   // a fresh page, same phone
    reopened.renderHomeEmailNudge();
    assert.equal(reopened.$('home-email-nudge-wrap').hidden, true);
  });

  test('a different account on the same phone is still offered it', () => {
    const api = sandbox({ email: offer, uid: 'user-a' });
    api.dismissEmailNudge();
    api.signIn('user-b');
    api.renderHomeEmailNudge();
    assert.equal(api.$('home-email-nudge-wrap').hidden, false);
  });

  test('with site data blocked it never throws, and stays closed for the session', () => {
    const api = sandbox({ email: offer, uid: 'user-a', storage: memoryStorage({ blocked: true }) });
    api.renderHomeEmailNudge();                 // reading throws: treated as not closed
    assert.equal(api.$('home-email-nudge-wrap').hidden, false);
    assert.doesNotThrow(() => api.dismissEmailNudge());
    api.renderHomeExtras();                     // ...and a repaint must not bring it back
    assert.equal(api.$('home-email-nudge-wrap').hidden, true);
  });

  test('signed out, the ✕ does nothing rather than saving under no one', () => {
    const api = sandbox({ email: offer, uid: null });
    api.dismissEmailNudge();
    assert.equal(api.storage.map.size, 0);
  });

  test('the markup keeps the two buttons as siblings, never nested', () => {
    const html = readFileSync(fileURLToPath(new URL('../public/student/index.html', import.meta.url)), 'utf8');
    const from = html.indexOf('id="home-email-nudge-wrap"');
    const card = html.slice(from, html.indexOf('</div>', from));
    assert.ok(from > 0, 'wrapper present');
    const nudgeEnd = card.indexOf('</button>');
    const close = card.indexOf('id="home-email-nudge-close"');
    assert.ok(nudgeEnd > 0 && close > nudgeEnd, 'the ✕ starts after the nudge button has closed');
    assert.match(card.slice(close - 20, close + 200), /aria-label="[^"]+"/, 'the ✕ has a spoken name');
  });
});
