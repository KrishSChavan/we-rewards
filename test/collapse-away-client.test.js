// collapseAway (public/student/app.js): how a card a student closes leaves the
// page. It fades, then its height and the space it held fold to zero so what
// is below slides up, and only then is it hidden. Slices the real function out
// of app.js (same pattern as recent-spots-client.test.js) and runs it against
// a few fake nodes whose layout follows the card's inline styles, with the
// timers held in a queue so each phase can be inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../public/student/app.js', import.meta.url)), 'utf8');
const from = src.indexOf('/* ---------- closing a card: fade, then fold it away');
const to = src.indexOf('/** Slide the spot screen in from the right', from);
assert.ok(from > 0 && to > from, 'landmark moved in public/student/app.js — re-anchor this test');
const collapseBlock = src.slice(from, to);

// An inline style when one is set, else the stylesheet's value.
const px = (v, sheet) => (v === undefined || v === '' ? sheet : parseFloat(v));

// A node with just the layout a fold reads. `top`/`bottom` are functions, so
// the follower can answer from the card's current state and inline styles.
function node(name, { top = () => 0, bottom = () => 0, height = () => 0, position = 'static', marginBottom = '0px', rendered = true, box = {} } = {}) {
  const styleLog = [];
  const n = {
    name, hidden: false, dataset: {}, offsetWidth: 1,
    parentElement: null, nextElementSibling: null, rendered, styleLog,
    // Every inline write is logged, so a value that is set and then folded
    // away within one callback can still be checked.
    style: new Proxy({}, { set(t, k, v) { styleLog.push([k, v]); t[k] = v; return true; } }),
    cs: { position, marginBottom, ...box },
    listeners: new Map(),
    addEventListener(type, fn) { (n.listeners.get(type) ?? n.listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { n.listeners.get(type)?.delete(fn); },
    fire(type, props) { for (const fn of [...(n.listeners.get(type) ?? [])]) fn({ type, target: n, ...props }); },
  };
  n.getClientRects = () => (n.hidden || !n.rendered ? [] : [{}]);
  n.getBoundingClientRect = () => ({ top: top(), bottom: bottom(), height: height() });
  return n;
}

// A card: 50px tall and 4px of bottom margin per the stylesheet.
function cardNode(h = 50, mb = 4, box = {}) {
  const c = node('card', { marginBottom: `${mb}px`, box });
  c.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: px(c.style.height, h) });
  c.h = () => px(c.style.height, h);
  c.mb = () => px(c.style.marginBottom, mb);
  return c;
}

function load({ reduced = false } = {}) {
  const timers = [];
  const body = { name: 'body', cs: { position: 'static' } };
  // eslint-disable-next-line no-new-func
  const collapseAway = new Function('deps', `
    const { timers, body, reduced } = deps;
    const document = { body };
    const window = { matchMedia: () => ({ matches: reduced }) };
    const getComputedStyle = (n) => n.cs;
    const setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
    ${collapseBlock}
    return collapseAway;
  `)({ timers, body, reduced });
  const run = () => { const t = timers.shift(); t.cb(); return t.ms; };
  return { collapseAway, timers, body, run };
}

// stack > [card, follower]. The follower sits at 100 once the card is gone;
// with it, it sits below the card's height, its bottom margin and a 10px gap.
// `bend` adds a fixed error once the margin goes negative, which is what block
// margin collapsing does to the arithmetic in the real page.
function scene(env, { bend = 0 } = {}) {
  const stack = node('stack'); stack.parentElement = env.body;
  const card = cardNode(50, 4);
  const follower = node('follower', {
    top: () => (card.hidden ? 100 : 100 + card.h() + card.mb() + 10 + (card.mb() < 0 ? bend : 0)),
  });
  card.parentElement = stack; follower.parentElement = stack;
  card.nextElementSibling = follower;
  return { stack, card, follower };
}

const FOLD_PROPS = ['transition', 'opacity', 'transform', 'overflow', 'height', 'minHeight',
  'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'marginBottom'];

test('it fades first, then folds onto exactly where the page will settle, then hides', () => {
  const env = load();
  const { card, follower } = scene(env);
  let done = 0;
  env.collapseAway(card, () => { done++; });

  assert.equal(card.hidden, false, 'still there: the measurement put it straight back');
  assert.equal(card.dataset.collapsing, '1');
  assert.equal(card.style.opacity, '0');
  assert.equal(card.style.transform, 'scale(0.97)');
  for (const p of ['height', 'overflow', 'marginBottom', 'paddingTop']) {
    assert.equal(card.style[p] ?? '', '', `${p}: the dry run of the end state left nothing behind`);
  }
  assert.equal(done, 0);

  assert.equal(env.run(), 240, 'the fade');
  assert.equal(card.style.overflow, 'hidden');
  assert.equal(card.style.height, '0px');
  assert.equal(card.style.paddingTop, '0px');
  assert.equal(card.style.borderBottomWidth, '0px');
  // 64px of travel = 50 of card + 14 of margin and gap: the 4px margin goes to -10.
  assert.equal(card.style.marginBottom, '-10px');
  assert.equal(follower.getBoundingClientRect().top, 100, 'the folded card leaves the follower where it will stay');
  assert.equal(card.hidden, false, 'not hidden on a timer: it waits for the height to arrive');

  card.fire('transitionend', { propertyName: 'height' });   // the fold has really finished
  assert.equal(card.hidden, true);
  assert.equal(follower.getBoundingClientRect().top, 100, 'and hiding it moves nothing');
  assert.equal(done, 1);
  assert.equal(card.dataset.collapsing, undefined);
  for (const p of FOLD_PROPS) assert.equal(card.style[p] ?? '', '', `${p} put back`);

  assert.equal(env.run(), 420, 'the fallback timer is still queued...');
  assert.equal(done, 1, '...and finishing twice is not possible');
  assert.equal(env.timers.length, 0);
});

test('borders are traded for padding before the fold, so no sub-pixel border snapping leaves it short', () => {
  const env = load();
  const { card } = scene(env);
  card.cs.paddingTop = '14.4px'; card.cs.paddingBottom = '14.4px';
  card.cs.borderTopWidth = '3px'; card.cs.borderBottomWidth = '3px';
  env.collapseAway(card);
  card.styleLog.length = 0;                     // only the fold's own writes
  env.run();
  const writes = (p) => card.styleLog.filter(([k]) => k === p).map(([, v]) => v);
  assert.deepEqual(writes('paddingTop'), ['17.4px', '0px'], 'border added to the padding, then the padding folds');
  assert.deepEqual(writes('paddingBottom'), ['17.4px', '0px']);
  assert.deepEqual(writes('borderTopWidth'), ['0px'], 'the border goes at once, while the card is invisible');
  assert.doesNotMatch(card.style.transition, /border/, 'and is never animated');
});

test('only the card\'s own height transition finishes it; anything else waits for the fallback', () => {
  const env = load();
  const { card } = scene(env);
  let done = 0;
  env.collapseAway(card, () => { done++; });
  env.run();
  card.fire('transitionend', { propertyName: 'padding-top' });
  const child = { name: 'child' };
  for (const fn of [...card.listeners.get('transitionend')]) fn({ type: 'transitionend', target: child, propertyName: 'height' });
  assert.equal(card.hidden, false, 'a padding end, or a child\'s height end, is not the fold ending');
  assert.equal(env.run(), 420);
  assert.equal(card.hidden, true, 'the fallback still finishes it');
  assert.equal(done, 1);
  assert.equal(card.listeners.get('transitionend').size, 0, 'and the listener is removed');
});

test('a layout that bends the arithmetic (margin collapsing) still lands exactly: the end is measured', () => {
  const env = load();
  const { card, follower } = scene(env, { bend: 2 });
  env.collapseAway(card);
  env.run();
  // The arithmetic alone says -10 and would stop 2px short (the real nearby
  // opt-in did, then jumped 2px when it was hidden); the check corrects it.
  assert.equal(card.style.marginBottom, '-12px');
  assert.equal(follower.getBoundingClientRect().top, 100);
});

test('inline styles the card had before are put back exactly', () => {
  const env = load();
  const { card } = scene(env);
  card.style.transition = 'color 1s';
  card.style.marginBottom = '4px';
  env.collapseAway(card);
  env.run(); env.run();
  assert.equal(card.style.transition, 'color 1s');
  assert.equal(card.style.marginBottom, '4px');
});

test('with reduced motion it just hides, at once', () => {
  const env = load({ reduced: true });
  const { card } = scene(env);
  let done = 0;
  env.collapseAway(card, () => { done++; });
  assert.equal(card.hidden, true);
  assert.equal(done, 1);
  assert.equal(env.timers.length, 0);
  assert.equal(card.style.opacity, undefined, 'no fade was started');
});

test('a card that is not on screen (closed hub, hidden shell) just hides', () => {
  const env = load();
  const { card } = scene(env);
  card.rendered = false;
  let done = 0;
  env.collapseAway(card, () => { done++; });
  assert.equal(card.hidden, true);
  assert.equal(done, 1);
  assert.equal(env.timers.length, 0);
  assert.equal(card.dataset.collapsing, undefined);
});

test('a second tap mid-fold is ignored; the first one finishes the job once', () => {
  const env = load();
  const { card } = scene(env);
  let first = 0; let second = 0;
  env.collapseAway(card, () => { first++; });
  env.collapseAway(card, () => { second++; });
  assert.equal(env.timers.length, 1, 'no second fade queued');
  env.run(); env.collapseAway(card, () => { second++; }); env.run();
  assert.deepEqual([first, second], [1, 0]);
  assert.equal(env.timers.length, 0);
});

test('an already hidden card just reports done', () => {
  const env = load();
  const { card } = scene(env);
  card.hidden = true;
  let done = 0;
  env.collapseAway(card, () => { done++; });
  assert.equal(done, 1);
  assert.equal(env.timers.length, 0);
});

test('overlays after the card are skipped; the next thing in flow, even outside its container, is what is measured', () => {
  const env = load();
  const stack = node('stack'); stack.parentElement = env.body;
  const card = cardNode(50, 0);
  const sheet = node('sheet', { top: () => 0, position: 'fixed' });          // never moves
  const spots = node('spots', { top: () => (card.hidden ? 200 : 200 + card.h() + card.mb() + 11) });
  card.parentElement = stack; sheet.parentElement = stack;
  card.nextElementSibling = sheet; stack.nextElementSibling = spots; spots.parentElement = env.body;
  env.collapseAway(card);
  env.run();
  assert.equal(card.style.marginBottom, '-11px', '61px of travel: 50 of card, 11 of gap');
  assert.equal(spots.getBoundingClientRect().top, 200);
});

test('with nothing after it, its container\'s bottom edge is what folds', () => {
  const env = load();
  const stack = node('stack'); stack.parentElement = env.body;
  const card = cardNode(50, 6);
  card.parentElement = stack;
  stack.getBoundingClientRect = () => ({ top: 0, bottom: card.hidden ? 0 : card.h() + card.mb(), height: 0 });
  env.collapseAway(card);
  env.run();
  assert.equal(card.style.height, '0px');
  assert.equal(card.style.marginBottom, '0px', 'its 6px margin goes too: the container ends where it will end');
});

test('never looks past an overlay: a card at the foot of the hub folds against its own block, not the tab bar outside', () => {
  const env = load();
  const hub = node('hub', { position: 'fixed' }); hub.parentElement = env.body;
  const deals = node('deals'); deals.parentElement = hub;
  const card = cardNode(40, 8); card.parentElement = deals;
  const tabbar = node('tabbar', { top: () => 800 }); tabbar.parentElement = env.body;
  hub.nextElementSibling = tabbar;
  deals.getBoundingClientRect = () => ({ top: 300, bottom: 300 + (card.hidden ? 0 : card.h() + card.mb() + 12), height: 0 });
  env.collapseAway(card);
  env.run();
  // Against the tab bar (which never moves) it would keep its space: +48px.
  assert.equal(card.style.marginBottom, '-12px');
  assert.equal(deals.getBoundingClientRect().bottom, 300);
});

test('if something else hides it mid-fade, it settles without folding', () => {
  const env = load();
  const { card } = scene(env);
  let done = 0;
  env.collapseAway(card, () => { done++; });
  card.hidden = true;                           // e.g. a sign-out reset
  env.run();
  assert.equal(env.timers.length, 0, 'no fold queued');
  assert.equal(done, 1);
  assert.equal(card.dataset.collapsing, undefined);
  for (const p of FOLD_PROPS) assert.equal(card.style[p] ?? '', '', `${p} put back`);
});
