// The redemption funnel: the client's track() calls, the server's allowlist, and
// the code's time-to-live.
//
// WHY THIS FILE IS TEXT-BASED. The three things it checks live in three files
// that cannot be imported together cheaply: CLIENT_EVENTS is a module-level
// const inside server.js (importing which runs buildClientAssets() and rewrites
// .build/ — see the test-concurrency comment in package.json), and app.js is a
// browser bundle with no module boundary at all. Reading them as text costs
// nothing, needs no harness, and checks exactly the property that matters.
//
// The property that matters is this: POST /api/client-event validates the event
// name against CLIENT_EVENTS and answers 204 for anything it does not know —
// SILENTLY, on purpose, so a client rolled ahead of the server never spams its
// own console. That is the right behaviour in production and a trap in
// development: a typo'd or unregistered event name is not an error anywhere. It
// simply never arrives, and the funnel it belonged to reads as a step nobody
// took. These tests are the thing standing between that and a week of looking at
// an empty chart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const SERVER = read('server.js');
const APP = read('public/student/app.js');
const INSTALL = read('public/student/install-prompt.js');
const STUDENT_ROUTE = read('src/routes/student.js');

/** The names inside `const CLIENT_EVENTS = new Set([ ... ])`, comments stripped. */
function allowlist() {
  const open = SERVER.indexOf('const CLIENT_EVENTS = new Set([');
  assert.notEqual(open, -1, 'CLIENT_EVENTS moved or was renamed in server.js');
  const close = SERVER.indexOf(']);', open);
  assert.notEqual(close, -1, 'could not find the end of the CLIENT_EVENTS literal');
  const body = SERVER.slice(open, close)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))   // the block is heavily commented
    .join('\n');
  return new Set([...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
}

/** Every event name passed to track() in a client bundle. */
function fired(src) {
  return new Set([...src.matchAll(/\btrack\(\s*'([^']+)'/g)].map((m) => m[1]));
}

test('every event the student app fires is on the server allowlist', () => {
  const allowed = allowlist();
  const sent = fired(APP);
  assert.ok(sent.size > 0, 'found no track() calls in app.js — did the helper get renamed?');
  for (const ev of sent) {
    assert.ok(
      allowed.has(ev),
      `app.js fires '${ev}' but CLIENT_EVENTS in server.js does not list it, so `
      + '/api/client-event will answer 204 and the event will vanish without an error'
    );
  }
});

test('every event the install prompt fires is on the server allowlist', () => {
  // The pre-existing funnel, and the reason the allowlist exists at all. It is
  // checked here too so this file covers the whole contract rather than only the
  // half that was added last.
  const allowed = allowlist();
  for (const ev of fired(INSTALL)) {
    assert.ok(allowed.has(ev), `install-prompt.js fires '${ev}', absent from CLIENT_EVENTS`);
  }
});

test('the redemption funnel has both ends, or it measures nothing', () => {
  // A funnel with a start and no finish cannot answer the question it was built
  // for. redeem_code_shown without redeem_confirmed would say how many students
  // reached the counter and nothing about how many got served; the pair is the
  // measurement. redeem_code_expired and redeem_code_renewed separate the two
  // ways it goes wrong (walked away, versus a counter slower than one code).
  const sent = fired(APP);
  for (const ev of ['redeem_code_shown', 'redeem_confirmed', 'redeem_code_expired', 'redeem_code_renewed']) {
    assert.ok(sent.has(ev), `app.js no longer fires '${ev}'`);
  }
});

test('the redeem code TTL is one named constant, not two literals', () => {
  // It used to be the number 120 written twice, three lines apart: once for the
  // RPC and once for the response the countdown is drawn from. Those two drifting
  // apart is a silent bug of the worst kind — the phone would draw a timer that
  // outlived the code, and send the student to the counter holding a number the
  // terminal had already forgotten.
  assert.match(
    STUDENT_ROUTE,
    /const REDEEM_TTL_SECONDS = (\d+);/,
    'REDEEM_TTL_SECONDS is gone from src/routes/student.js'
  );
  const ttl = Number(STUDENT_ROUTE.match(/const REDEEM_TTL_SECONDS = (\d+);/)[1]);
  assert.ok(ttl >= 180, `a ${ttl}s code is shorter than a queue; it was raised off 120 for that reason`);

  // Scoped to the redeem-code handler alone: the EARN-code route a few lines
  // above legitimately carries its own `ttlSeconds: 300` literal, and a sloppy
  // slice that swallowed it would make the last assertion here fail for the
  // wrong reason.
  const start = STUDENT_ROUTE.indexOf("router.post('/redeem-code'");
  assert.notEqual(start, -1, 'the redeem-code route moved or was renamed');
  const after = STUDENT_ROUTE.indexOf('\nrouter.', start + 1);
  const body = STUDENT_ROUTE.slice(start, after === -1 ? undefined : after);
  assert.ok(body.includes('create_redeem_code'), 'scoping failed: that is not the redeem route');
  assert.ok(!body.includes("/earn-code"), 'scoping failed: the earn route leaked in');
  assert.match(body, /p_ttl_seconds: REDEEM_TTL_SECONDS/, 'the RPC call stopped using the constant');
  assert.match(body, /ttlSeconds: REDEEM_TTL_SECONDS/, 'the response stopped using the constant');
  assert.doesNotMatch(body, /ttlSeconds: \d/, 'a bare TTL literal is back in the redeem response');
});

test('an expired code is replaced rather than relabelled', () => {
  // The dead end this whole change set exists to remove: the countdown used to
  // write "Expired" and leave the QR on screen, with no way to mint another. A
  // code the terminal will refuse is worse than no code, because the student goes
  // on holding it up at the counter and reads the refusal as a broken app.
  const fn = APP.slice(APP.indexOf('function showRedemptionCode('));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /\$\('item-code'\)\.hidden = true/, 'the expired branch no longer hides the dead QR');
  assert.match(body, /\$\('item-renew'\)\.hidden = false/, 'the expired branch no longer offers a new code');
  assert.ok(
    APP.includes('function renewRedemptionCode('),
    'renewRedemptionCode is gone, so the renew button has nothing behind it'
  );
});

test('no em dash reaches a student through the new sheets (the repo copy rule)', () => {
  // The same rule test/campaigns.test.js enforces for notification copy, applied
  // to the markup added for the expired state and the help sheet. Checked on
  // TEXT NODES only: the comments around them are for us, not for students, and
  // this codebase's comments use em dashes freely.
  const html = read('public/student/index.html');
  for (const id of ['item-expired', 'help-modal']) {
    const open = html.indexOf(`id="${id}"`);
    assert.notEqual(open, -1, `#${id} is missing from index.html`);
    const seg = html.slice(open, open + 3000).replace(/<!--[\s\S]*?-->/g, '');
    const offenders = [...seg.matchAll(/>([^<>]*—[^<>]*)</g)].map((m) => m[1].trim());
    assert.deepEqual(offenders, [], `em dash in student-facing copy near #${id}`);
  }
});
