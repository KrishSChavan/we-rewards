// The home-screen earn-code loop: what a student sees when POST /api/me/earn-code
// does not answer.
//
// WHY THIS HAS A TEST. The loop swallows every failure on purpose — a code on
// screen is still valid for 300s and this refreshes every 120s, so a missed
// refresh must not blank the digits a cashier is mid-way through typing. The cost
// of that silence is the FIRST call: nothing has been painted, so the sheet opens
// on index.html's •••••• with no QR and no explanation, and the next attempt is
// two minutes away. Nothing throws and nothing logs, so the only symptom is a
// student who thinks the app is broken — invisible to every other test here.
//
// This is also the endpoint that filed log 0834ce36 on 2026-09-12 (a Supabase
// gateway 504 surfacing as a 500). The server side of that is fixed in
// src/lib/supabase.js and migration-056; this is the half the student sees.
//
// SLICED AND EVALUATED, following test/recent-spots-client.test.js: the four
// front-ends under public/ are browser scripts, not modules, so nothing in test/
// can import them. The landmarks are deliberately brittle — if one moves this
// throws rather than quietly testing nothing. Reads public/, not .build/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');

function block(fromNeedle, toNeedle) {
  const from = src.indexOf(fromNeedle);
  const to = src.indexOf(toNeedle, from + 1);
  assert.ok(
    from > 0 && to > from,
    `landmark moved in public/student/app.js — re-anchor this test: ${fromNeedle}`
  );
  return src.slice(from, to);
}

const codeBlock = block('function startMyCode(', '/* ---------- home → the full-screen earn code sheet');

/**
 * Build the loop with a scripted server and hand-driven timers.
 *
 * `answers` is one entry per call: a 6-digit string to succeed with, or an Error
 * to fail with. Timers are collected rather than run, so a test fires the retry
 * itself instead of waiting 1.5 real seconds.
 */
function sandbox(answers) {
  const state = {
    calls: 0, painted: [], qrs: [], timers: [], intervals: [], cleared: 0,
  };
  const el = {
    'my-code-value': { textContent: '••••••' },
    'my-code-qr': {},
    'my-code-qr-card': { hidden: true },
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'el', 'answers', `
    // Declared at the top of app.js, outside the slice.
    let myCodeTimer = null;
    const $ = (id) => el[id];
    const window = { innerWidth: 390, innerHeight: 844 };
    function drawQr(node, text) { state.qrs.push(text); }
    async function authFetch() {
      const answer = answers[state.calls];
      state.calls += 1;
      if (answer instanceof Error) throw answer;
      if (answer === 'http-error') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ code: answer }) };
    }
    function setTimeout(fn, ms) { state.timers.push({ fn, ms }); return state.timers.length; }
    function clearTimeout(id) { if (id) state.cleared += 1; }
    function setInterval(fn, ms) { state.intervals.push({ fn, ms }); return state.intervals.length; }
    function clearInterval(id) { /* counted via cleared on stop */ }
    ${codeBlock}
    return {
      startMyCode, stopMyCode, refreshMyCode,
      code: () => el['my-code-value'].textContent,
      shown: () => el['my-code-qr-card'].hidden === false,
    };
  `)(state, el, answers);
  api.state = state;
  return api;
}

/** Run every timer queued so far, in order, awaiting each. */
async function fireTimers(api) {
  const due = api.state.timers.splice(0);
  for (const t of due) await t.fn();
  return due;
}

describe('the first call', () => {
  test('paints the digits and the QR', async () => {
    const api = sandbox(['482913']);
    await api.refreshMyCode();
    assert.equal(api.code(), '482913');
    assert.deepEqual(api.state.qrs, ['WRW:E:482913']);
    assert.equal(api.shown(), true);
    assert.equal(api.state.timers.length, 0, 'a success schedules no retry');
  });

  test('A FAILURE IS RETRIED SHORTLY, not in two minutes', async () => {
    const api = sandbox([new Error('network'), '482913']);
    await api.refreshMyCode();
    assert.equal(api.shown(), false, 'nothing painted yet');

    const [retry] = await fireTimers(api);
    assert.ok(retry, 'no retry was scheduled for a first-call failure');
    assert.ok(retry.ms <= 2000, `retry was ${retry.ms}ms away`);
    assert.equal(api.code(), '482913', 'the retry painted the code');
    assert.equal(api.shown(), true);
  });

  test('a 503 from the server is treated exactly like a dropped connection', async () => {
    // What the server now answers when Supabase's gateway is unreachable
    // (UPSTREAM_UNAVAILABLE). It is transient by definition, so it retries.
    const api = sandbox(['http-error', '482913']);
    await api.refreshMyCode();
    await fireTimers(api);
    assert.equal(api.code(), '482913');
  });

  test('it gives up after two tries rather than retrying forever', async () => {
    const api = sandbox([new Error('down'), new Error('down'), new Error('down'), new Error('down')]);
    await api.refreshMyCode();
    await fireTimers(api);          // retry 1
    await fireTimers(api);          // retry 2
    const third = await fireTimers(api);
    assert.equal(third.length, 0, 'a third retry was scheduled — this is a loop, not a nudge');
    assert.equal(api.state.calls, 3, 'one call plus two retries');
    assert.equal(api.shown(), false);
  });

  test('the retries back off rather than firing twice in a row', async () => {
    const api = sandbox([new Error('down'), new Error('down'), '482913']);
    await api.refreshMyCode();
    const [first] = await fireTimers(api);
    const [second] = await fireTimers(api);
    assert.ok(second.ms > first.ms, `${second.ms}ms was not longer than ${first.ms}ms`);
  });
});

describe('a later refresh', () => {
  test('A FAILED REFRESH LEAVES THE LIVE CODE ALONE AND SCHEDULES NOTHING', async () => {
    // The case the silence exists for: the code on screen is good for another
    // 180s, and a student may be reading it to a cashier right now. Blanking it,
    // or hammering the endpoint, are both worse than doing nothing.
    const api = sandbox(['482913', new Error('network')]);
    await api.refreshMyCode();
    await api.refreshMyCode();
    assert.equal(api.code(), '482913', 'the live code survived the failure');
    assert.equal(api.shown(), true);
    assert.equal(api.state.timers.length, 0, 'no retry storm behind a working code');
  });

  test('an hour of failed refreshes still schedules nothing and blanks nothing', async () => {
    // The silence has to hold for a LONG outage, not just one tick. A student
    // whose phone has no signal for half an hour keeps a readable code (the
    // server re-extends the same one when it comes back) and generates no extra
    // traffic, which is the opposite of what a retry loop here would do.
    const api = sandbox(['482913', ...Array.from({ length: 30 }, () => new Error('offline'))]);
    await api.refreshMyCode();
    for (let i = 0; i < 30; i++) await api.refreshMyCode();

    assert.equal(api.code(), '482913');
    assert.equal(api.shown(), true);
    assert.equal(api.state.timers.length, 0, 'a retry was scheduled behind a working code');
    assert.equal(api.state.qrs.length, 1, 'the QR was redrawn for a failure');
  });
});

describe('the loop itself', () => {
  test('starts one 120s interval and refreshes immediately', async () => {
    const api = sandbox(['482913', '482913']);
    api.startMyCode();
    await Promise.resolve();
    assert.equal(api.state.intervals.length, 1);
    assert.equal(api.state.intervals[0].ms, 120_000);
    assert.equal(api.state.calls, 1, 'startMyCode refreshes at once, not only in two minutes');
  });

  test('a second startMyCode does not stack a second interval', async () => {
    // A silent token refresh re-enters render(), which calls startMyCode() again.
    const api = sandbox(['482913', '482913', '482913']);
    api.startMyCode();
    api.startMyCode();
    await Promise.resolve();
    assert.equal(api.state.intervals.length, 1, 'two intervals means the digits can change twice a tick');
  });

  test('SIGNING OUT CANCELS A PENDING RETRY, not just the interval', async () => {
    // Otherwise a queued retry fires after sign-out and posts with the next
    // student's token — or with none.
    const api = sandbox([new Error('down'), '482913']);
    api.startMyCode();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(api.state.timers.length, 1, 'a retry is pending');
    api.stopMyCode();
    assert.ok(api.state.cleared > 0, 'stopMyCode did not clear the pending retry');
  });
});
