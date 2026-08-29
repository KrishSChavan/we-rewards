// public/student/install-prompt.js — the Chromium native-prompt path.
//
// This file exists because of a bug that ran in production with no visible
// symptom beyond a crash row: Chrome only lets a captured beforeinstallprompt
// event be prompt()ed while the page holds transient user activation, four of
// the five triggers fire from a setTimeout where there is none, and prompt()
// there throws NotAllowedError. Every automatic Chromium nudge was therefore a
// crash report rather than an install prompt — and since markShown() ran first,
// it also spent a lifetime-cap slot, so after three of them the student was
// suppressed for good having never been asked once.
//
// Nothing about that is observable from the outside: no UI is drawn either way,
// and the student simply never installs. So the cases below assert the two
// halves that have to stay true — that a prompt is never fired without
// activation, and that nothing is CHARGED until one actually appears.
//
// EVALUATED IN A SANDBOX rather than imported: the four front-ends under
// public/ are browser scripts, not modules (build-client.js transforms each
// file with no bundling), so nothing in test/ can import from them. The file is
// an IIFE that hangs itself off `window`, so handing it a fake window is enough
// — no source slicing and no landmarks to keep in step. It reads public/, not
// .build/, because the source is what a person edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../public/student/install-prompt.js', import.meta.url)), 'utf8');

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';

/**
 * Load the module against a fake browser.
 *
 * `activation` stands in for navigator.userActivation.isActive — the switch the
 * whole fix turns on. The tests flip it to model "inside a tap" vs "in a timer
 * callback". `hasActivationApi: false` models the older engines where the
 * property is missing and the only way to find out is to call prompt() and see
 * it throw.
 */
function sandbox({ ua = ANDROID_CHROME, activation = false, hasActivationApi = true,
                   store = null, now = 1_000_000, touch = 0 } = {}) {
  const clock = { now };
  const state = { activation };
  const calls = { prompts: 0, events: [] };
  const listeners = { window: new Map(), document: new Map() };

  const bag = new Map();
  if (store) bag.set('werewards.install.v1', JSON.stringify(store));
  const localStorage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, v),
    removeItem: (k) => bag.delete(k),
  };

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const off = (map) => (type, fn) => { map.get(type)?.delete(fn); };

  const navigator = {
    userAgent: ua,
    // iPadOS reports a Macintosh UA, so this is the only thing that separates an
    // iPad from a desktop — and the two want the arrow at opposite screen edges.
    maxTouchPoints: touch,
    ...(hasActivationApi ? { userActivation: { get isActive() { return state.activation; } } } : {}),
  };

  // Timers are queued, not run: every trigger sits behind a delay (1.5s for a
  // redemption) and this suite is about what that callback does, not the wait.
  const timers = new Map();
  let nextTimer = 1;

  const win = {
    navigator,
    matchMedia: () => ({ matches: false }),
    location: { origin: 'https://we-rewards.com' },
    addEventListener: on(listeners.window),
    removeEventListener: off(listeners.window),
  };
  // A registry of stub elements, created on demand. The Chromium path draws
  // nothing of ours, but every other platform does, and "which surface came up"
  // is the whole question on those — so the stubs record enough to answer it:
  // hidden, the classes toggled on them, and what got appended.
  const nodes = new Map();
  const makeEl = (id) => ({
    id, hidden: true, textContent: '', innerHTML: '', offsetWidth: 0,
    children: [], style: {}, handlers: {},
    classes: new Set(),
    classList: {
      add(c) { nodes.get(id).classes.add(c); },
      remove(c) { nodes.get(id).classes.delete(c); },
      contains(c) { return nodes.get(id).classes.has(c); },
    },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); },
    setAttribute() {}, select() {},
  });
  const doc = {
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, makeEl(id));
      return nodes.get(id);
    },
    createElement: () => makeEl('created'),
    addEventListener: on(listeners.document),
    removeEventListener: off(listeners.document),
  };

  const fn = new Function('window', 'document', 'navigator', 'localStorage',
    'Date', 'setTimeout', 'clearTimeout', 'console', SRC);
  fn(win, doc, navigator, localStorage,
    { now: () => clock.now },
    (cb, ms) => { const id = nextTimer++; timers.set(id, { cb, at: clock.now + ms }); return id; },
    (id) => timers.delete(id),
    console);

  const fire = (map, type, ev) => { for (const f of [...(map.get(type) ?? [])]) f(ev); };

  return {
    api: win.InstallPrompt,
    calls,
    clock,
    setActivation: (v) => { state.activation = v; },
    // Hand the module a deferred prompt, as Chrome does on a page that qualifies.
    capture() {
      fire(listeners.window, 'beforeinstallprompt', {
        preventDefault() {},
        prompt: () => {
          // The real thing throws SYNCHRONOUSLY when activation is missing —
          // which is why the crash report's stack pointed straight at fireNative.
          if (!state.activation) {
            const err = new Error("Failed to execute 'prompt' on 'BeforeInstallPromptEvent': "
              + 'The prompt() method must be called with a user gesture');
            err.name = 'NotAllowedError';
            throw err;
          }
          calls.prompts += 1;
          return Promise.resolve({ outcome: 'dismissed' });
        },
        userChoice: null,
      });
    },
    // A trusted tap: activation is live for the duration of the handler, exactly
    // as it is in a browser.
    tap(type = 'click', extra = {}) {
      const was = state.activation;
      state.activation = true;
      fire(listeners.document, type, { type, isTrusted: true, ...extra });
      state.activation = was;
    },
    // An event that is trusted but is not the activating one — a touch
    // pointerdown, say. The browser reports isActive false for these.
    inertEvent(type) {
      fire(listeners.document, type, { type, isTrusted: true });
    },
    // A tap the page made itself (el.click()) — grants nothing.
    syntheticTap() {
      fire(listeners.document, 'click', { type: 'click', isTrusted: false });
    },
    runTimers() {
      for (const [id, t] of [...timers]) { timers.delete(id); t.cb(); }
    },
    armed: () => (listeners.document.get('click')?.size ?? 0) > 0,
    rec: () => win.InstallPrompt.getState().users.u1,
    el: (id) => doc.getElementById(id),
    // Press one of OUR buttons (the card's Add, its ✕): runs the handler the
    // module wired, inside a gesture, exactly as a tap on it would.
    press(id) {
      const target = doc.getElementById(id);
      const was = state.activation;
      state.activation = true;
      for (const fn of target.handlers.click ?? []) fn({ type: 'click', isTrusted: true, target });
      state.activation = was;
    },
    // Is a surface up? Sheet and guide both open by clearing hidden.
    shown: (id) => doc.getElementById(id).hidden === false,
  };
}

// Drive a real automatic trigger (redemption, priority 1) to the point where the
// old code called e.prompt() from the timer and threw.
function reachTrigger(s) {
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.capture();
  s.api.setUser('u1');
  s.api.onRedemption();
  s.runTimers();
}

test('an automatic trigger never prompts without activation — it waits for a tap', () => {
  const s = sandbox();
  reachTrigger(s);

  assert.equal(s.calls.prompts, 0, 'prompt() must not be called from the timer');
  assert.ok(s.armed(), 'the next tap should have been armed instead');
  assert.equal(s.rec().shownCount, 0, 'nothing was shown, so nothing may be charged');

  s.tap();
  assert.equal(s.calls.prompts, 1, 'the tap releases the held prompt');
  assert.equal(s.rec().shownCount, 1, 'now it appeared, so now it counts');
  assert.equal(s.armed(), false, 'and the listeners are gone — one prompt, not one per tap');
});

test('the deferral is reported, then followed by the shown event', () => {
  const s = sandbox();
  reachTrigger(s);
  const names = () => s.calls.events.map(([e]) => e);

  assert.ok(names().includes('install_prompt_deferred'), 'a wait is worth knowing about');
  assert.equal(names().includes('install_prompt_shown'), false, 'nothing has been shown yet');

  s.tap();
  assert.ok(names().includes('install_prompt_shown'));
  assert.equal(s.calls.events.filter(([e]) => e === 'install_prompt_deferred').length, 1,
    'deferred is once per page, not once per re-arm');
});

test('a page-made click grants nothing and is ignored', () => {
  const s = sandbox();
  reachTrigger(s);
  s.syntheticTap();
  assert.equal(s.calls.prompts, 0, 'isTrusted:false would only throw again');
  assert.ok(s.armed(), 'and the real tap still has to be waited for');
});

test('Escape is not a gesture; the key after it is', () => {
  const s = sandbox();
  reachTrigger(s);
  s.tap('keydown', { key: 'Escape' });
  assert.equal(s.calls.prompts, 0);
  s.tap('keydown', { key: 'a' });
  assert.equal(s.calls.prompts, 1);
});

test('a touch pointerdown carries no activation, so the pointerup behind it fires it', () => {
  const s = sandbox();
  reachTrigger(s);
  s.inertEvent('pointerdown');
  assert.equal(s.calls.prompts, 0, 'burning the one captured event on it would lose the install');
  assert.ok(s.armed(), 'still listening for the event that does carry activation');
  s.tap('pointerup');
  assert.equal(s.calls.prompts, 1);
});

test('an engine with no userActivation API re-arms instead of losing the install', () => {
  // Here the module cannot ask, so it calls prompt() optimistically from the
  // timer, catches the NotAllowedError, and puts the event back.
  const s = sandbox({ hasActivationApi: false });
  reachTrigger(s);
  assert.equal(s.calls.prompts, 0);
  assert.ok(s.armed(), 'the throw must re-arm, not drop the captured event');
  assert.equal(s.rec().shownCount, 0, 'a throw is not a showing');

  s.tap();
  assert.equal(s.calls.prompts, 1);
  assert.equal(s.rec().shownCount, 1);
});

test('the manual settings row still prompts inside its own click, with no wait', () => {
  const s = sandbox();
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.capture();
  s.api.setUser('u1');
  s.setActivation(true);          // openManual is called from a click handler
  s.api.openManual();
  assert.equal(s.calls.prompts, 1, 'no reason to defer — the gesture is right here');
  assert.equal(s.armed(), false);
  assert.equal(s.rec().shownCount, 0, 'manual bypasses the cap, as it always did');
});

test('a tap long after the moment has passed is left alone', () => {
  const s = sandbox();
  reachTrigger(s);
  s.clock.now += 6 * 60 * 1000;   // the window is 5 minutes
  s.tap();
  assert.equal(s.calls.prompts, 0, 'an install sheet out of nowhere is worse than none');
  assert.equal(s.armed(), false, 'and it stops listening');
});

test('the v1 store keeps dismissals but gives back the cap the throws ate', () => {
  // u1 was nudged four times on Chrome: every one threw, none was ever seen,
  // and shownCount 4 had locked them out of the feature permanently.
  const mk = (over) => ({ shownCount: 0, lastShownAt: 5, lastDismissedAt: 0, dismissedCount: 0,
    accepted: false, redemptionFired: false, thresholdFired: false, firstPointsFired: false,
    thirdSessionFired: false, session: { count: 1, lastSeenAt: 0 }, lastPromptSession: 1, ...over });
  const s = sandbox({ store: { v: 1, installed: false, users: {
    u1: mk({ shownCount: 4, redemptionFired: true, lastPromptSession: 3 }),
    u2: mk({ shownCount: 3, dismissedCount: 3, lastDismissedAt: 90 }),
  } } });
  const users = s.api.getState().users;

  assert.equal(users.u1.shownCount, 0, 'four prompts nobody saw are not four prompts');
  assert.equal(users.u1.redemptionFired, true, 'the per-trigger latches are untouched');
  // u2 dismissed three real sheets on iOS. Those were seen, so the cap stands.
  assert.equal(users.u2.shownCount, 3);
  assert.equal(users.u2.lastDismissedAt, 90, 'and the cooldown with it');
});

test('an already-migrated store is left exactly as it is', () => {
  const s = sandbox({ store: { v: 2, installed: false, users: {
    u1: { shownCount: 2, lastShownAt: 5, lastDismissedAt: 0, dismissedCount: 0,
          accepted: false, redemptionFired: false, thresholdFired: false,
          firstPointsFired: false, thirdSessionFired: false,
          session: { count: 1, lastSeenAt: 0 }, lastPromptSession: 1 },
  } } });
  assert.equal(s.api.getState().users.u1.shownCount, 2, 'v2 counts are real showings');
});

/* ===================================================================
   Platform routing: which surface a student actually gets.

   The rule this section checks is that we never put something on screen
   unasked that cannot install the app. Chromium can, in one tap, so it still
   gets the automatic triggers. Nowhere else can — the best we could do
   unprompted is explain a menu the student did not open — so those platforms
   are reached only through a control they deliberately tapped.
   =================================================================== */

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const INSTAGRAM_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 13; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Sign in and fire the highest-priority automatic trigger, past its delay.
function autoTrigger(s) {
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.api.setUser('u1');
  s.api.onRedemption();
  s.runTimers();
}

test('an iPhone gets nothing unasked — no sheet, no guide', () => {
  const s = sandbox({ ua: IPHONE_SAFARI });
  autoTrigger(s);
  assert.equal(s.shown('install-guide'), false, 'iOS cannot install from a trigger, so it must not interrupt');
  assert.equal(s.shown('install-modal'), false);
  assert.equal(s.rec().shownCount, 0, 'and nothing was charged for it');
});

test('but tapping Add on the iPhone opens the pointer guide, not the old sheet', () => {
  const s = sandbox({ ua: IPHONE_SAFARI });
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.api.setUser('u1');
  s.setActivation(true);          // openManual runs inside the click
  s.api.openManual();
  assert.ok(s.shown('install-guide'), 'the guide is the iOS surface now');
  assert.equal(s.shown('install-modal'), false, 'the numbered sheet is not');
});

test('the arrow points at the bottom bar on iPhone and the address bar on iPad', () => {
  const phone = sandbox({ ua: IPHONE_SAFARI });
  phone.setActivation(true); phone.api.openManual();
  assert.equal(phone.el('install-guide').classes.has('is-ipad'), false,
    'iPhone: Share is the middle icon of the bottom toolbar');

  // iPadOS ships a desktop UA, so touch points are the only tell — and getting
  // this wrong aims the arrow at the opposite end of the screen.
  const pad = sandbox({ ua: IPAD, touch: 5 });
  pad.setActivation(true); pad.api.openManual();
  assert.ok(pad.el('install-guide').classes.has('is-ipad'),
    'iPad: Share is top-right, in the address bar');
});

test('an in-app browser still gets the copy-link route', () => {
  const s = sandbox({ ua: INSTAGRAM_IOS });
  s.setActivation(true);
  s.api.openManual();
  assert.ok(s.shown('install-modal'));
  assert.equal(s.el('install-inapp').hidden, false, 'copy link + open in Safari');
  assert.equal(s.el('install-steps').hidden, true, 'steps they cannot follow here');
});

test('Firefox on Android gets the menu steps with no "show me how" stage first', () => {
  const s = sandbox({ ua: FIREFOX_ANDROID });
  s.setActivation(true);
  s.api.openManual();
  assert.ok(s.shown('install-modal'));
  assert.equal(s.el('install-steps').hidden, false,
    'the tap that opened this already said yes — asking again is a wasted tap');
  assert.equal(s.el('install-steps-list').children.length, 3);
});

/* ---------- the permanent Home card ---------- */

test('the card is up wherever an install is possible, and gone once installed', () => {
  const s = sandbox({ ua: IPHONE_SAFARI });
  s.api.init({ track: () => {} });
  s.api.setUser('u1');
  s.api.syncCard();
  assert.ok(s.shown('install-banner'), 'iOS can install, just not from a button');
  assert.ok(s.api.canOffer());

  const done = sandbox({ ua: IPHONE_SAFARI, store: { v: 2, installed: true, users: {} } });
  done.api.syncCard();
  assert.equal(done.shown('install-banner'), false);
  assert.equal(done.api.canOffer(), false, 'and the Account row goes with it');
});

test('a desktop browser that never offered an install is offered nothing', () => {
  // resolvePlatform() only says 'chromium' once a deferred prompt exists; before
  // that this is 'desktop', where every route we have is a dead end.
  const s = sandbox({ ua: DESKTOP });
  s.api.init({ track: () => {} });
  s.api.syncCard();
  assert.equal(s.api.canOffer(), false, 'a button that cannot install is worse than no button');
  assert.equal(s.shown('install-banner'), false);
});

test('the card and the row come back the moment Chrome offers a prompt', () => {
  const changes = [];
  const s = sandbox({ ua: DESKTOP });
  s.api.init({ track: () => {}, onChange: () => changes.push(s.api.canOffer()) });
  s.api.setUser('u1');
  s.api.syncCard();
  assert.equal(s.api.canOffer(), false);

  s.capture();     // beforeinstallprompt lands, often well after first paint
  assert.ok(s.api.canOffer(), 'now there is a real one-tap install to offer');
  assert.deepEqual(changes, [true], 'and app.js is told, rather than left to poll');
  assert.ok(s.shown('install-banner'));
});

test('the card X puts it away for a fortnight and calls off the auto prompt too', () => {
  const s = sandbox();
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.capture();
  s.api.setUser('u1');
  s.api.syncCard();
  assert.ok(s.shown('install-banner'));

  s.press('install-banner-close');
  s.runTimers();                                  // the 300ms slide-out
  assert.equal(s.shown('install-banner'), false);

  s.api.syncCard();
  assert.equal(s.shown('install-banner'), false, 'and it stays down across renders');

  // "No thanks" to the card is "no thanks" to Chrome's dialog: firing that at
  // someone who just closed this would be a bait, so the dismissal arms the
  // shared cooldown as well.
  s.api.onRedemption();
  s.runTimers();
  assert.equal(s.calls.prompts, 0);
  assert.equal(s.armed(), false, 'not even armed for the next tap');

  s.clock.now += 15 * 24 * 60 * 60 * 1000;        // past the 14-day card cooldown
  s.api.syncCard();
  assert.ok(s.shown('install-banner'), 'a fortnight later it may ask again');
});

test('the card Add button installs outright on Chromium — no sheet in between', () => {
  const s = sandbox();
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.capture();
  s.api.setUser('u1');
  s.api.syncCard();

  s.press('install-banner-add');
  assert.equal(s.calls.prompts, 1, 'the tap IS the gesture, so it prompts on the spot');
  assert.equal(s.shown('install-modal'), false, 'and no instructions are involved');
  assert.equal(s.armed(), false, 'nothing to wait for');
});

test('the card survives a cancelled install, so they can try again', () => {
  const s = sandbox();
  s.api.init({ track: () => {} });
  s.capture();
  s.api.setUser('u1');
  s.api.syncCard();
  s.press('install-banner-add');
  assert.ok(s.shown('install-banner'), 'Chrome draws its own dialog over us; ours stays put');
});

test('Esc closes the guide, and stops being listened for once it is gone', () => {
  const s = sandbox({ ua: IPHONE_SAFARI });
  s.api.init({ track: (e, p) => s.calls.events.push([e, p]) });
  s.setActivation(true);
  s.api.openManual();
  assert.ok(s.shown('install-guide'));

  s.tap('keydown', { key: 'Escape' });
  s.runTimers();                       // the 260ms fade
  assert.equal(s.shown('install-guide'), false);
  // The listener has to come off with it: left attached, every later Esc would
  // re-run dismissGuide and file another install_prompt_dismissed for a scrim
  // that is not on screen.
  s.tap('keydown', { key: 'Escape' });
  assert.equal(s.calls.events.filter(([e]) => e === 'install_prompt_dismissed').length, 1);
});
