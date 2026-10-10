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
} from '../src/lib/bonus-window.js';
import { validIncentive } from '../src/routes/admin.js';

/* ---------- validBonusWindowConfig ---------- */

test('an empty form falls back to the documented defaults', () => {
  for (const raw of [undefined, null, {}, { multiplier: '', maxMultiplier: '' }]) {
    assert.deepEqual(
      validBonusWindowConfig(raw).config,
      { multiplier: BONUS_WINDOW_DEFAULTS.multiplier, maxMultiplier: BONUS_WINDOW_DEFAULTS.maxMultiplier },
      `should default ${JSON.stringify(raw)}`,
    );
  }
});

test('the form’s values arrive as strings and come back as numbers', () => {
  // Every field in the admin panel is read with .value.trim(), so the server
  // only ever sees strings. Storing "2" in config.multiplier would make
  // `tier * windowMultiplier` a string concatenation at award time.
  const out = validBonusWindowConfig({ multiplier: '2.5', maxMultiplier: '4' });
  assert.deepEqual(out.config, { multiplier: 2.5, maxMultiplier: 4 });
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
    assert.deepEqual(out.row.config, { multiplier: 2, maxMultiplier: 3 });
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
