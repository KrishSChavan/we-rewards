// Unit tests for the bonus window's pure halves (src/lib/bonus-window.js) and
// for the two admin rules that bound it (validIncentive in src/routes/admin.js).
// All of them decide before any query runs, so no database is needed.
//
// WHAT IS ACTUALLY AT RISK HERE, and why these tests are shaped the way they
// are. This is the only incentive kind that spends the VENDORS' points — it
// multiplies the balance a student spends at the shop, at every active shop,
// with nobody opting in (see the header of src/lib/bonus-window.js). So the
// three things worth being paranoid about are:
//
//   1. THE BOUNDS. A window with no end date is a permanent platform-wide
//      discount reachable by leaving a field blank, and a budget field that
//      silently does nothing is worse than no field. Both are asserted as
//      REFUSALS, with the exact shapes an operator would actually submit.
//   2. THE CAP. min(tier x window, cap) is what stops a 2x-tier student on a 2x
//      weekend earning 4x. Asserted at the boundary in both directions.
//   3. FLOAT EXACTNESS. Both award paths do `Math.floor(basePoints * applied)`,
//      and src/lib/tiers.js gets away with that only because 1, 1.5 and 2 are
//      exact in binary. MULTIPLIER_STEP exists to keep that true once a window
//      joins the product. The last block proves it over every combination
//      rather than trusting the argument — that is the bug class (a customer
//      paid one point less than the rate they were promised, at the counter)
//      the whole award path is written to avoid.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validBonusWindowConfig, effectiveMultiplier, tierPreview, BONUS_WINDOW_DEFAULTS,
  announceCopy,
} from '../src/lib/bonus-window.js';
import { validIncentive } from '../src/routes/admin.js';

/* ---------- validBonusWindowConfig ---------- */

test('an empty form falls back to the documented defaults', () => {
  // Compared against the exported defaults object WHOLE, rather than against a
  // hand-listed copy of its fields: a new knob added to BONUS_WINDOW_DEFAULTS
  // and forgotten in the validator is exactly the drift worth catching here,
  // and a hand-listed expectation would have silently stopped checking it.
  for (const raw of [undefined, null, {}, { multiplier: '', maxMultiplier: '' }]) {
    assert.deepEqual(
      validBonusWindowConfig(raw).config, BONUS_WINDOW_DEFAULTS,
      `should default ${JSON.stringify(raw)}`,
    );
  }
});

test('the form’s values arrive as strings and come back as numbers', () => {
  // Every field in the admin panel is read with .value.trim(), so the server
  // only ever sees strings. Storing "2" in config.multiplier would make
  // `tier * windowMultiplier` a string concatenation at award time.
  const out = validBonusWindowConfig({ multiplier: '2.5', maxMultiplier: '4' });
  assert.deepEqual(out.config, { multiplier: 2.5, maxMultiplier: 4, announce: true });
  assert.equal(typeof out.config.multiplier, 'number');
  assert.equal(typeof out.config.maxMultiplier, 'number');
});

test('a multiplier off the half step is refused', () => {
  // The whole reason for the restriction: 1.1 and 2.3 are not representable, so
  // basePoints * applied would land fractionally low on some amounts and the
  // floor in both award paths would eat a point. See MULTIPLIER_STEP.
  for (const raw of [1.1, 2.3, 1.75, 2.01, '3.33']) {
    assert.match(
      validBonusWindowConfig({ multiplier: raw }).error,
      /steps of 0\.5/,
      `should reject ${raw}`,
    );
  }
});

test('a multiplier outside 1.5–5 is refused', () => {
  // Below 1.5 it is not a promotion (1x is an ordinary day, and the evaluator
  // treats anything <= 1 as "no window" anyway); above 5 it is a typo.
  for (const raw of [0, 1, 0.5, 5.5, 10, -2, 'abc', Infinity]) {
    assert.ok(validBonusWindowConfig({ multiplier: raw }).error, `should reject ${raw}`);
  }
  // Each with a cap that clears it. Passing these alone would fall back to the
  // DEFAULT cap of 3 and the ones above it would be refused by the
  // cap-below-multiplier rule instead — a pass for the wrong reason, which is
  // also the real behaviour an operator meets if they raise the multiplier in
  // the panel and leave the cap select alone.
  for (const raw of [1.5, 2, 3, 4.5, 5]) {
    assert.equal(
      validBonusWindowConfig({ multiplier: raw, maxMultiplier: 10 }).error, undefined,
      `should accept ${raw}`,
    );
  }
});

test('raising the multiplier past the default cap is refused, not silently clamped', () => {
  // The panel keeps both selects on screen, so this is the error an operator
  // sees if they bump the multiplier to 4x and leave the cap at 3x. It names
  // both numbers, which is the only way to act on it.
  assert.match(
    validBonusWindowConfig({ multiplier: 4 }).error,
    /cap can’t be lower than the multiplier itself \(4x\)/,
  );
});

test('a cap below the multiplier itself is refused', () => {
  // It would make the headline number unreachable: a "3x weekend" capped at 2x
  // pays 2x to everybody, including tier 1, and nothing on screen says why.
  const out = validBonusWindowConfig({ multiplier: 3, maxMultiplier: 2 });
  assert.match(out.error, /can’t be lower than the multiplier itself \(3x\)/);
  // Equal is fine, and is the "no stacking on top of tier" setting.
  assert.equal(validBonusWindowConfig({ multiplier: 3, maxMultiplier: 3 }).error, undefined);
});

test('a cap above 10 is refused', () => {
  assert.ok(validBonusWindowConfig({ multiplier: 2, maxMultiplier: 12 }).error);
  assert.equal(validBonusWindowConfig({ multiplier: 2, maxMultiplier: 10 }).error, undefined);
});

/* ---------- the announce switch ---------- */

describe('config.announce', () => {
  test('defaults to on, because a promotion nobody hears about is just a discount', () => {
    assert.equal(validBonusWindowConfig({}).config.announce, true);
    assert.equal(BONUS_WINDOW_DEFAULTS.announce, true);
  });

  test('an explicit false survives the round trip', () => {
    // The bug this guards: a window the operator deliberately silenced coming
    // back ticked, and announcing itself the next time they save.
    assert.equal(validBonusWindowConfig({ announce: false }).config.announce, false);
  });

  test('⚠ the STRING "false" is false, not true', () => {
    // Boolean('false') === true. This value decides whether the entire student
    // body is interrupted, so a form that ever serialised its checkbox as a
    // string would turn every "don't announce" into an announcement. The admin
    // panel sends a real boolean; this is the belt under that.
    assert.equal(validBonusWindowConfig({ announce: 'false' }).config.announce, false);
    assert.equal(validBonusWindowConfig({ announce: '0' }).config.announce, false);
    assert.equal(validBonusWindowConfig({ announce: 0 }).config.announce, false);
  });

  test('anything else truthy is on', () => {
    for (const raw of [true, 'true', 'on', 1]) {
      assert.equal(validBonusWindowConfig({ announce: raw }).config.announce, true, `announce=${raw}`);
    }
  });

  test('a missing value falls back to the default rather than to false', () => {
    for (const raw of [undefined, null, '']) {
      assert.equal(
        validBonusWindowConfig({ announce: raw }).config.announce, true,
        `announce=${JSON.stringify(raw)} should default on`,
      );
    }
  });
});

/* ---------- the generated push ---------- */

describe('announceCopy', () => {
  const WINDOW_ROW = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    name: 'Double points weekend',
    // A Sunday, 23:59 US Eastern, expressed as the UTC instant the database
    // would hand back. PUNCH_TIMEZONE is unset in tests, so the formatter uses
    // its America/New_York default: 03:59Z Monday is 23:59 Sunday on campus.
    ends_at: '2026-10-12T03:59:00.000Z',
    config: { multiplier: 2, maxMultiplier: 3, announce: true },
  };

  test('the headline is the WINDOW’s multiplier, not any one student’s', () => {
    // One push goes to everybody and their tiers differ, so it promises the
    // floor; the in-app banner pays each of them more (studentBonusWindow).
    // The reverse would be a lie to most of the audience.
    const { title, body } = announceCopy(WINDOW_ROW);
    assert.match(title, /^2x points/);
    assert.match(body, /2x points/);
    assert.ok(!title.includes('3x'), 'the cap must not leak into the headline');
  });

  test('⚠ the deadline is in CAMPUS time, not UTC', () => {
    // A dyno runs in UTC. Without the timezone this window reads "Monday
    // 3:59 AM", which is a day and an hour that are wrong for every single
    // person reading it.
    const { title } = announceCopy(WINDOW_ROW);
    assert.match(title, /Sunday/, `expected a Sunday deadline, got: ${title}`);
    assert.ok(!title.includes('Monday'), `UTC leaked into the copy: ${title}`);
  });

  test('⚠ no em dash reaches a student (the repo copy rule)', () => {
    // POST /api/admin/broadcasts refuses em dashes outright, and this path does
    // not go through that route — so the rule has to hold here on purpose. A
    // generated string is the one that would put an em dash in front of the
    // whole campus at once. Same assertion broadcasts.test.js makes.
    const { title, body } = announceCopy(WINDOW_ROW);
    assert.ok(!title.includes('—'), `em dash in title: ${title}`);
    assert.ok(!body.includes('—'), `em dash in body: ${body}`);
  });

  test('it fits a notification shade', () => {
    // Mirrors BROADCAST_TITLE_MAX / BROADCAST_BODY_MAX. A long operator name
    // cannot blow these, because the name is deliberately not spliced into
    // either string, but the lengths are asserted rather than assumed.
    const long = { ...WINDOW_ROW, name: 'x'.repeat(80), config: { multiplier: 2.5 } };
    for (const w of [WINDOW_ROW, long]) {
      const { title, body } = announceCopy(w);
      assert.ok(title.length <= 60, `title ${title.length} chars: ${title}`);
      assert.ok(body.length <= 140, `body ${body.length} chars: ${body}`);
      assert.ok(title.length > 0 && body.length > 0, 'neither may be empty');
    }
  });

  test('a missing or unparseable end date still produces a usable push', () => {
    // validIncentive makes both dates mandatory, so this is unreachable through
    // the panel. It is asserted because the fallback has to be a sentence and
    // not the string "Invalid Date" or an empty title, which create_admin_
    // broadcast would reject with TITLE_REQUIRED.
    for (const ends_at of [null, undefined, 'not-a-date']) {
      const { title, body } = announceCopy({ ...WINDOW_ROW, ends_at });
      assert.match(title, /2x points/);
      assert.ok(!/Invalid Date|NaN|undefined|null/.test(title + body), `leaked a bad date: ${title} / ${body}`);
    }
  });

  test('it always lands students on the home screen', () => {
    // Where the banner is. A push about a multiplier that opened some other
    // screen would be a push about nothing the student can see.
    assert.equal(announceCopy(WINDOW_ROW).url, '/');
  });

  test('a window with no config falls back to the defaults rather than NaN', () => {
    const { title } = announceCopy({ ...WINDOW_ROW, config: null });
    assert.match(title, /^2x points/, `expected the default multiplier, got: ${title}`);
  });
});

/* ---------- effectiveMultiplier ---------- */

describe('effectiveMultiplier', () => {
  test('the two multipliers multiply, so loyalty still pays during a window', () => {
    // Not max() and not addition: a student who earned 2x over thirty days of
    // visiting should get more out of a double-points weekend than one who
    // joined this morning. That is what the tier system is for.
    assert.equal(effectiveMultiplier({ tierMultiplier: 1, windowMultiplier: 2, maxMultiplier: 99 }).applied, 2);
    assert.equal(effectiveMultiplier({ tierMultiplier: 1.5, windowMultiplier: 2, maxMultiplier: 99 }).applied, 3);
    assert.equal(effectiveMultiplier({ tierMultiplier: 2, windowMultiplier: 2, maxMultiplier: 99 }).applied, 4);
  });

  test('the cap clamps the product and says that it did', () => {
    // 2x tier on a 2x weekend is 4x; capped at 3 it is 3, and `capped` is what
    // the admin preview uses to label the row.
    const out = effectiveMultiplier({ tierMultiplier: 2, windowMultiplier: 2, maxMultiplier: 3 });
    assert.equal(out.applied, 3);
    assert.equal(out.capped, true);
  });

  test('a product exactly on the cap is not reported as capped', () => {
    // The boundary. 1.5 x 2 === 3 exactly (both are exact in binary), so this
    // is a real equality rather than a float coin toss — and an operator should
    // not see "capped from 3x" beside a 3x.
    const out = effectiveMultiplier({ tierMultiplier: 1.5, windowMultiplier: 2, maxMultiplier: 3 });
    assert.equal(out.applied, 3);
    assert.equal(out.capped, false);
  });

  test('no window leaves the tier multiplier exactly as it was', () => {
    // This is the ordinary-day path and it runs on every award at every till,
    // so it has to be the identity — including for the nonsense inputs an
    // older or broken config row could produce.
    for (const windowMultiplier of [null, undefined, 1, 0, -3, NaN, 'x']) {
      for (const tierMultiplier of [1, 1.5, 2]) {
        const out = effectiveMultiplier({ tierMultiplier, windowMultiplier, maxMultiplier: 3 });
        assert.equal(out.applied, tierMultiplier, `${tierMultiplier} with window ${windowMultiplier}`);
        assert.equal(out.capped, false);
      }
    }
  });

  test('a missing or nonsense cap does not clamp, and never returns zero', () => {
    // A zero here would award nothing and read to a customer as "my points
    // didn't go through". The function runs inside an award; it has no safe way
    // to fail, so it degrades upward.
    for (const maxMultiplier of [null, undefined, NaN, 'x', 0]) {
      const out = effectiveMultiplier({ tierMultiplier: 2, windowMultiplier: 2, maxMultiplier });
      assert.equal(out.applied, 4, `cap ${maxMultiplier} should not clamp`);
    }
    assert.equal(effectiveMultiplier({ tierMultiplier: 0, windowMultiplier: 2, maxMultiplier: 3 }).applied, 2);
  });
});

/* ---------- tierPreview ---------- */

test('the admin preview shows the cap flattening the top tiers', () => {
  // The panel draws this so an operator meets the behaviour before they turn a
  // window on: at 2x capped to 3x, tier 2 and tier 3 both land on 3x and the
  // tier-3 student's extra loyalty buys nothing that weekend. Inherent to
  // capping a product, which is exactly why it has to be visible.
  const rows = tierPreview({ multiplier: 2, maxMultiplier: 3 });
  assert.deepEqual(rows.map((r) => r.applied), [2, 3, 3]);
  assert.deepEqual(rows.map((r) => r.capped), [false, false, true]);
});

/* ---------- validIncentive: the two rules that bound this kind ---------- */

const WINDOW = {
  kind: 'bonus_window',
  name: 'Double points weekend',
  startsAt: '2026-10-09T17:00',
  endsAt: '2026-10-12T00:00',
  config: { multiplier: '2', maxMultiplier: '3' },
};

describe('validIncentive, for a bonus window', () => {
  test('a complete window is accepted and normalised', () => {
    const out = validIncentive(WINDOW);
    assert.equal(out.error, undefined);
    assert.equal(out.row.kind, 'bonus_window');
    assert.equal(out.row.budget_points, null);
    assert.deepEqual(out.row.config, { multiplier: 2, maxMultiplier: 3, announce: true });
    assert.ok(out.row.starts_at && out.row.ends_at);
  });

  test('⚠ a window with no end date is refused', () => {
    // THE catastrophic misconfiguration for this kind, and the one an operator
    // reaches by habit: both dates are optional on the referral form and the end
    // date is optional on the signup form. Left blank here it is a permanent
    // platform-wide discount on every vendor's product, with no budget rail to
    // stop it.
    for (const endsAt of ['', null, undefined]) {
      assert.match(
        validIncentive({ ...WINDOW, endsAt }).error,
        /needs both a start and an end/,
        `should reject endsAt=${JSON.stringify(endsAt)}`,
      );
    }
  });

  test('a window with no start date is refused', () => {
    assert.match(validIncentive({ ...WINDOW, startsAt: '' }).error, /needs both a start and an end/);
  });

  test('a budget is refused rather than silently ignored', () => {
    // incentives.budget_points is a COMMUNITY-point rail: only
    // grant_community_points moves spent_points, and this kind never calls it.
    // Accepting a budget would show an operator a cap that can never fire next
    // to a spend of 0 that never moves.
    const out = validIncentive({ ...WINDOW, budgetPoints: '5000' });
    assert.match(out.error, /no points budget/);
  });

  test('a blank budget is fine — the panel just does not send one', () => {
    for (const budgetPoints of ['', null, undefined]) {
      assert.equal(
        validIncentive({ ...WINDOW, budgetPoints }).error, undefined,
        `blank budget ${JSON.stringify(budgetPoints)} should be accepted`,
      );
    }
  });

  test('the end date still has to be after the start date', () => {
    assert.match(
      validIncentive({ ...WINDOW, startsAt: '2026-10-12T00:00', endsAt: '2026-10-09T17:00' }).error,
      /end date has to be after/,
    );
  });

  test('a bad config is refused through the kind’s own validator', () => {
    assert.match(
      validIncentive({ ...WINDOW, config: { multiplier: '1.1' } }).error,
      /steps of 0\.5/,
    );
  });

  test('the other two kinds are unaffected by the bonus-window rules', () => {
    // A referral program may still have no dates and may still have a budget —
    // the new rules are keyed to the kind, not bolted onto every form.
    const referral = {
      kind: 'referral',
      name: 'Refer a friend',
      budgetPoints: '5000',
      startsAt: '',
      endsAt: '',
      config: { referrerPoints: '10', friendPoints: '10', maxPerReferrer: '10', signupWindowDays: '14' },
    };
    const out = validIncentive(referral);
    assert.equal(out.error, undefined);
    assert.equal(out.row.budget_points, 5000);
  });
});

/* ---------- the admin form's options match what the server accepts ---------- */

// Both knobs are <select>s, which is what makes the half-step rule unreachable
// rather than merely validated — an operator cannot type 1.1. The cost of that
// choice is DRIFT: the options are a hand-written list in one file and the
// bounds are constants in another, and a mismatch fails in two silent ways.
//   · an option the server refuses  -> a 400 on save, from a control the panel
//     itself offered;
//   · an accepted value with no option -> a saved config that matches nothing,
//     which a <select> renders BLANK and renderBonusPreview reads as
//     Number('') === 0, drawing "0x" for a window that is paying 3x.
// So the list is asserted against the validator in both directions.
const ADMIN_HTML = readFileSync(
  fileURLToPath(new URL('../public/admin/index.html', import.meta.url)), 'utf8',
);

/** The `value="..."` of every option inside one <select id="..."> */
function selectOptions(id) {
  const open = ADMIN_HTML.indexOf(`<select id="${id}"`);
  assert.ok(open > 0, `<select id="${id}"> is gone from public/admin/index.html — re-anchor this test`);
  const close = ADMIN_HTML.indexOf('</select>', open);
  assert.ok(close > open, `<select id="${id}"> is unterminated`);
  return [...ADMIN_HTML.slice(open, close).matchAll(/value="([^"]+)"/g)].map((m) => Number(m[1]));
}

/** Inclusive range in half steps, the same granularity the validator enforces. */
const halfSteps = (from, to) => {
  const out = [];
  for (let n = from; n <= to + 1e-9; n += 0.5) out.push(Math.round(n * 2) / 2);
  return out;
};

describe('the admin form’s multiplier options', () => {
  test('every multiplier option is accepted by the server', () => {
    for (const multiplier of selectOptions('bw-multiplier')) {
      assert.equal(
        // Paired with the highest cap so this tests the multiplier's own bounds
        // and not the cap-below-multiplier rule.
        validBonusWindowConfig({ multiplier, maxMultiplier: 10 }).error, undefined,
        `the panel offers ${multiplier} but the server refuses it`,
      );
    }
  });

  test('every multiplier the server accepts has an option', () => {
    const offered = new Set(selectOptions('bw-multiplier'));
    for (const multiplier of halfSteps(1.5, 5)) {
      assert.ok(offered.has(multiplier), `${multiplier} is accepted but the panel cannot select it`);
    }
  });

  test('every cap option is accepted by the server', () => {
    for (const maxMultiplier of selectOptions('bw-cap')) {
      assert.equal(
        // Paired with the lowest multiplier for the same reason as above.
        validBonusWindowConfig({ multiplier: 1.5, maxMultiplier }).error, undefined,
        `the panel offers a cap of ${maxMultiplier} but the server refuses it`,
      );
    }
  });

  test('every cap the server accepts has an option', () => {
    // The gap this caught: 4.5 was accepted and unselectable, so a window saved
    // with that cap came back to a blank select and a 0x preview.
    const offered = new Set(selectOptions('bw-cap'));
    for (const maxMultiplier of halfSteps(1.5, 10)) {
      assert.ok(offered.has(maxMultiplier), `a cap of ${maxMultiplier} is accepted but unselectable`);
    }
  });

  test('the defaults are selectable', () => {
    // Otherwise a brand new panel opens on a blank select.
    assert.ok(selectOptions('bw-multiplier').includes(BONUS_WINDOW_DEFAULTS.multiplier));
    assert.ok(selectOptions('bw-cap').includes(BONUS_WINDOW_DEFAULTS.maxMultiplier));
  });
});

/* ---------- the float-exactness property ---------- */

test('⚠ floor(basePoints × applied) is EXACT for every allowed combination', () => {
  // THE REASON MULTIPLIER_STEP EXISTS, asserted rather than argued.
  //
  // Both award paths finish with `Math.floor(basePoints * applied)`. That is
  // safe only while `applied` is exactly representable: src/lib/tiers.js says
  // so explicitly about 1, 1.5 and 2, and a window multiplier off the half step
  // would end it quietly — the floor would drop a point on some amounts and the
  // customer would be paid less than the rate they were promised, at the
  // counter, in front of them. (1.16 * 25 === 28.999999999999996 is the same
  // bug one layer down, which is why pointsFor() exists.)
  //
  // Checked against integer arithmetic over every multiplier the validator will
  // accept, every tier, and a wide span of base points — MAX_AWARD_DOLLARS is
  // $200 and points_per_dollar is numeric(6,2), so real basePoints stay far
  // below this ceiling.
  const multipliers = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const caps = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const tiers = [1, 1.5, 2];

  for (const windowMultiplier of multipliers) {
    for (const maxMultiplier of caps) {
      if (maxMultiplier < windowMultiplier) continue;   // the validator refuses these
      for (const tierMultiplier of tiers) {
        const { applied } = effectiveMultiplier({ tierMultiplier, windowMultiplier, maxMultiplier });
        // `applied` is always a multiple of 0.25 — a product of halves, or a
        // half from the cap — so scaling by 4 is exact and integer division
        // gives the true mathematical floor to compare against.
        const quarters = Math.round(applied * 4);
        assert.equal(quarters / 4, applied, `applied ${applied} is not a clean quarter`);

        for (let basePoints = 1; basePoints <= 3000; basePoints += 1) {
          assert.equal(
            Math.floor(basePoints * applied),
            Math.floor((basePoints * quarters) / 4),
            `floor(${basePoints} * ${applied}) drifted `
            + `(tier ${tierMultiplier}, window ${windowMultiplier}, cap ${maxMultiplier})`,
          );
        }
      }
    }
  }
});

/* ---------- the student-facing card ---------- */

// renderBonusWindowCard is lifted out of the browser bundle and run against a
// stub `$`, the same way test/signup-bonus.test.js lifts welcomeBonusMessage.
// public/ cannot import from src/, so this is the only way to assert the copy
// without a headless browser.
//
// WHAT IS WORTH ASSERTING IS THE LAST LINE OF THE CARD. A student is pushed
// "2x points until Sunday" and their own banner says 3x, because the push is
// addressed to everybody and the banner is personal. This card is the only
// surface that explains which number is which, and the THREE cases read very
// differently: telling a maxed-out student to "climb your tier" is nonsense,
// and so is implying a tier-1 student is being short-changed.
const STUDENT_APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const studentSrc = readFileSync(STUDENT_APP, 'utf8');

const cardFrom = studentSrc.indexOf('function renderBonusWindowCard(');
const cardTo = studentSrc.indexOf('/* ---------- hub: "how you climb"');
assert.ok(
  cardFrom > 0 && cardTo > cardFrom,
  'renderBonusWindowCard moved in public/student/app.js — re-anchor this test',
);

/** Run the real function against a stub DOM; returns { id: text }. */
function paintCard(w, t, ends) {
  const painted = {};
  const $ = (id) => ({
    set textContent(v) { painted[id] = v; },
    get textContent() { return painted[id]; },
  });
  // eslint-disable-next-line no-new-func
  const fn = new Function('$', `${studentSrc.slice(cardFrom, cardTo)}; return renderBonusWindowCard;`)($);
  fn(w, t, ends);
  return painted;
}

const SUNDAY = new Date('2026-10-12T03:59:00.000Z');

describe('the expanded bonus card', () => {
  test('a tier-1 student is told what everyone gets and what climbing buys', () => {
    // applied === the window's own multiplier, and their tier is 1, so there is
    // genuinely something to aim at.
    const c = paintCard(
      { name: 'Double points weekend', multiplier: 2, windowMultiplier: 2 },
      { multiplier: 1 }, SUNDAY,
    );
    assert.match(c['bw-card-tier'], /Everyone gets 2× right now/);
    assert.match(c['bw-card-tier'], /Climb your tier/);
    assert.match(c['bw-card-lead'], /2× points/);
  });

  test('a student whose tier lifts them above the base rate is told so', () => {
    // 1.5x tier on a 2x window, capped at 3x: they are on 3x and everyone else
    // is on 2x. The card has to name both numbers or the push looks wrong.
    const c = paintCard(
      { name: 'Double points weekend', multiplier: 3, windowMultiplier: 2 },
      { multiplier: 1.5 }, SUNDAY,
    );
    assert.match(c['bw-card-tier'], /Everyone gets 2× right now/);
    assert.match(c['bw-card-tier'], /1\.5× tier/);
    assert.match(c['bw-card-tier'], /takes you to 3×/);
    assert.ok(!/Climb your tier/.test(c['bw-card-tier']), 'they are already above the base rate');
  });

  test('⚠ a student the cap has flattened is NOT told to climb their tier', () => {
    // 2x tier, 2x window, cap 2x: applied === windowMultiplier even though
    // their tier is 2. The naive branch here would tell the most loyal student
    // on the platform to go and earn a tier they already have.
    const c = paintCard(
      { name: 'Double points weekend', multiplier: 2, windowMultiplier: 2 },
      { multiplier: 2 }, SUNDAY,
    );
    assert.ok(!/Climb your tier/.test(c['bw-card-tier']), `told a maxed student to climb: ${c['bw-card-tier']}`);
    assert.match(c['bw-card-tier'], /tops out at 2×/);
    assert.match(c['bw-card-tier'], /back to normal afterwards/);
  });

  test('the operator’s name and a full deadline both land', () => {
    const c = paintCard(
      { name: 'Homecoming weekend', multiplier: 2, windowMultiplier: 2 },
      { multiplier: 1 }, SUNDAY,
    );
    // The name goes in as text, never as markup: it is operator-written.
    assert.equal(c['bw-card-name'], 'Homecoming weekend');
    // The full date, not the banner's short form: "Sunday" alone is ambiguous
    // by Friday night, and this is the surface with room for the rest.
    assert.match(c['bw-card-when'], /Ends Sunday/);
    assert.match(c['bw-card-when'], /October/);
  });

  test('a missing end date degrades to a sentence, not "Invalid Date"', () => {
    const c = paintCard(
      { name: 'Double points weekend', multiplier: 2, windowMultiplier: 2 },
      { multiplier: 1 }, null,
    );
    assert.equal(c['bw-card-when'], 'Running right now.');
    for (const v of Object.values(c)) {
      assert.ok(!/Invalid Date|NaN|undefined/.test(v), `leaked a bad value: ${v}`);
    }
  });

  test('no em dash anywhere in the card (the repo copy rule)', () => {
    for (const tier of [1, 1.5, 2]) {
      const c = paintCard(
        { name: 'Double points weekend', multiplier: tier === 1 ? 2 : 3, windowMultiplier: 2 },
        { multiplier: tier }, SUNDAY,
      );
      for (const [id, v] of Object.entries(c)) {
        assert.ok(!String(v).includes('—'), `em dash in ${id}: ${v}`);
      }
    }
  });
});

/* ---------- every id the new client code touches exists ---------- */

test('every element the bonus-window client code reaches for is in the markup', () => {
  // The failure this catches is silent in the worst way: $('typo') returns null,
  // and `null.textContent = x` throws inside renderTier — which is wrapped in a
  // try/catch in loadTier, so the tier chip, the meter AND the levers would all
  // just quietly stop painting, with no error anywhere a student or an operator
  // would see.
  const html = readFileSync(
    fileURLToPath(new URL('../public/student/index.html', import.meta.url)), 'utf8',
  );
  const ids = [...studentSrc.matchAll(/\$\('(bonus-window[a-z-]*|bw-card-[a-z-]+|tier-earning-note)'\)/g)]
    .map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected to find the new ids in app.js, found ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `app.js reaches for #${id}, which is not in index.html`);
  }
  // The popover's three by-convention ids, which wireInfo derives rather than
  // spelling out, so the grep above cannot see them.
  for (const id of ['bonus-window-info', 'bonus-window-info-card', 'bonus-window-info-close']) {
    assert.ok(html.includes(`id="${id}"`), `wireInfo needs #${id}, which is not in index.html`);
  }
});

test('the admin panel’s bonus-window ids are in its markup too', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../public/admin/index.html', import.meta.url)), 'utf8',
  );
  const adminSrc = readFileSync(
    fileURLToPath(new URL('../public/admin/admin.js', import.meta.url)), 'utf8',
  );
  const ids = [...adminSrc.matchAll(/\$\('(bw-[a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `expected the bw- ids in admin.js, found ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `admin.js reaches for #${id}, which is not in index.html`);
  }
});
