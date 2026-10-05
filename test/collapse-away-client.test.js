// collapseAway (public/student/app.js): how a card a student closes leaves the
// page. It fades, then its height and the space it held fold to zero so what
// is below slides up, and only then is it hidden. Slices the real function out
// of app.js (same pattern as recent-spots-client.test.js) and runs it against
// a few fake nodes whose layout answers depend on what is hidden, with the
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

// A node with just the layout a fold reads. `top` may be a function, so a
// follower can answer differently while the card is (briefly) hidden.
function node(name, { top = 0, height = 0, position = 'static', marginBottom = '0px', rendered = true } = {}) {
  const n = {
    name, hidden: false, dataset: {}, style: {}, offsetWidth: 1,
    parentElement: null, nextElementSibling: null, rendered,
    cs: { position, marginBottom },
  };
  n.getClientRects = () => (n.hidden || !n.rendered ? [] : [{}]);
  n.getBoundingClientRect = () => ({ top: typeof top === 'function' ? top() : top, height });
  return n;
}

function load({ reduced = false } = {}) {
  const timers = [];
  const body = { name: 'body' };
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

// stack > [card, follower]; the follower is 100px down once the card has gone,
// 164px down while it is there: the card is 50px tall and takes 14px of gap
// and margin with it.
function scene(env, { cardMargin = '4px' } = {}) {
  const stack = node('stack'); stack.parentElement = env.body;
  const card = node('card', { height: 50, marginBottom: cardMargin });
  const follower = node('follower', { top: () => (card.hidden ? 100 : 164) });
  card.parentElement = stack; follower.parentElement = stack;
  card.nextElementSibling = follower;
  return { stack, card, follower };
}

const FOLD_PROPS = ['transition', 'opacity', 'transform', 'overflow', 'height', 'minHeight',
  'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'marginBottom'];

test('it fades first, then folds by exactly what the page will move, then hides', () => {
  const env = load();
  const { card } = scene(env);
  let done = 0;
  env.collapseAway(card, () => { done++; });

  assert.equal(card.hidden, false, 'still there: the measurement put it straight back');
  assert.equal(card.dataset.collapsing, '1');
  assert.equal(card.style.opacity, '0');
  assert.equal(card.style.transform, 'scale(0.97)');
  assert.equal(done, 0);

  assert.equal(env.run(), 240, 'the fade');
  assert.equal(card.style.overflow, 'hidden');
  assert.equal(card.style.height, '0px');
  assert.equal(card.style.paddingTop, '0px');
  assert.equal(card.style.borderBottomWidth, '0px');
  // 64px of travel = 50 of card + 14 of space; the card's own 4px bottom margin
  // goes to 4 - 14, so the follower ends where it will sit once it is hidden.
  assert.equal(card.style.marginBottom, '-10px');
  assert.equal(card.hidden, false);

  assert.equal(env.run(), 320, 'the fold');
  assert.equal(card.hidden, true);
  assert.equal(done, 1);
  assert.equal(card.dataset.collapsing, undefined);
  for (const p of FOLD_PROPS) assert.equal(card.style[p] ?? '', '', `${p} put back`);
  assert.equal(env.timers.length, 0);
});

test('inline styles the card had before are put back exactly', () => {
  const env = load();
  const { card } = scene(env);
  card.style.transition = 'color 1s';
  card.style.marginBottom = '2px';
  env.collapseAway(card);
  env.run(); env.run();
  assert.equal(card.style.transition, 'color 1s');
  assert.equal(card.style.marginBottom, '2px');
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
  const card = node('card', { height: 50, marginBottom: '0px' });
  const sheet = node('sheet', { top: 0, position: 'fixed' });          // never moves
  const spots = node('spots', { top: () => (card.hidden ? 200 : 261) }); // the block after the stack
  card.parentElement = stack; sheet.parentElement = stack;
  card.nextElementSibling = sheet; stack.nextElementSibling = spots; spots.parentElement = env.body;
  env.collapseAway(card);
  env.run();
  assert.equal(card.style.marginBottom, '-11px', '61px of travel: 50 of card, 11 of gap');
});

test('with nothing after it, only its own height folds', () => {
  const env = load();
  const stack = node('stack'); stack.parentElement = env.body;
  const card = node('card', { height: 50, marginBottom: '6px' });
  card.parentElement = stack;
  env.collapseAway(card);
  env.run();
  assert.equal(card.style.height, '0px');
  assert.equal(card.style.marginBottom, '6px');
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
