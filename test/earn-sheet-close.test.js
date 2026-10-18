// The earn-code sheet closes itself once a counter scan lands (public/student/
// app.js). The sheet is the student's code; once the points are in, it has done
// its job, and leaving it up hid the only sign that anything happened (Home's
// card number changing under it) and held back the review prompt, which waits
// for every overlay to close.
//
// closeEarnSheetOnEarn is pulled out of the browser bundle and run against
// stubs, the same way test/address-format.test.js reads app.js. The realtime
// handler that calls it is a closure over half the app, so the rule for WHEN it
// is called is checked on the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../public/student/app.js', import.meta.url)), 'utf8');

function load() {
  const from = src.indexOf('function closeEarnSheetOnEarn(');
  const to = src.indexOf('// Hard reset, no animation', from);
  assert.ok(from > 0 && to > from, 'closeEarnSheetOnEarn landmarks moved in public/student/app.js — re-anchor this test');
  const calls = { closed: 0, toasts: [] };
  const sheet = { open: true };
  const deps = {
    $: (id) => {
      assert.equal(id, 'earn-modal');
      return { classList: { contains: (c) => c === 'is-open' && sheet.open } };
    },
    closeEarnSheet: () => { calls.closed += 1; sheet.open = false; },
    showToast: (text, kind) => calls.toasts.push([text, kind]),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(deps), `${src.slice(from, to)}\nreturn closeEarnSheetOnEarn;`)(...Object.values(deps));
  return { fn, calls, sheet };
}

test('a scan landing while the code is up closes it and says what arrived', () => {
  const { fn, calls } = load();
  fn(12, { name: 'Webster’s' }, false);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.toasts, [['✨  +12 pts at Webster’s', 'gain']]);
});

test('no second toast when the spot’s own screen is under the sheet', () => {
  // applyBalance → notifyPoints already pops "+12 pts" on that screen.
  const { fn, calls } = load();
  fn(12, { name: 'Webster’s' }, true);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.toasts, []);
});

test('a spot the app has not loaded yet still gets a toast, without a name', () => {
  const { fn, calls } = load();
  fn(7, undefined, false);
  assert.deepEqual(calls.toasts, [['✨  +7 pts', 'gain']]);
});

test('with the sheet closed nothing happens, so no other screen gains a toast', () => {
  const { fn, calls, sheet } = load();
  sheet.open = false;
  fn(12, { name: 'Webster’s' }, false);
  assert.equal(calls.closed, 0);
  assert.deepEqual(calls.toasts, []);
});

test('the realtime handler closes it on an earn only', () => {
  // A visit that raised the balance: not a redemption (a drop), not a review
  // credit (payload.review), not a community-points move (no payload.visit).
  assert.match(src,
    /if \(payload\.visit && next > prev && !payload\.review\) closeEarnSheetOnEarn\(next - prev, v, hitOpen\);/);
  // ...and it runs inside the 'balance' handler, after hitOpen is known.
  const handler = src.indexOf("let hitOpen = false;");
  const call = src.indexOf('closeEarnSheetOnEarn(next - prev');
  assert.ok(handler > 0 && call > handler, 'the close must come after hitOpen is worked out');
});
