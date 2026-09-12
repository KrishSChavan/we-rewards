// Unit tests for the plan and dunning ladders (src/lib/plans.js).
//
// Two things are being protected here, and they fail in opposite directions:
//
//   * A vendor must never silently GAIN a feature. effectivePlan can only ever
//     move a vendor DOWN from their nominal plan, so a bug costs someone a
//     feature they paid for — annoying, visible, fixable — rather than handing
//     the paid product away for free, which nobody reports.
//
//   * A GRANDFATHERED vendor must never be treated as past due. There are
//     sixteen of them, they were promised free access verbally by someone who
//     knows them personally, and they have no Stripe subscription at all — so
//     any past_due_since on those rows is a data artefact, not a debt. Getting
//     this wrong turns a promise into a support call.
//
// The 30/45-day thresholds are ALSO written in migration-055's
// vendor_billing_overview view. The boundary assertions below exist so that if
// one side is edited without the other, a test fails instead of a vendor
// quietly keeping their deals for two extra weeks. behavior-055.sql asserts the
// SQL side of the same pair.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_RANK, DEGRADE_DAYS, SUSPEND_DAYS, ITEM_CAP,
  daysPastDue, effectivePlan, planAllows, itemCap, planRejection,
} from '../src/lib/plans.js';
import { requirePlan } from '../src/middleware/auth.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

const vendor = (over = {}) => ({
  id: 'v1', name: 'Fava Kitchen',
  plan: 'discovery', grandfathered: false, past_due_since: null,
  ...over,
});

describe('the plan ladder', () => {
  test('ranks freshman below discovery below goto', () => {
    assert.ok(PLAN_RANK.freshman < PLAN_RANK.discovery);
    assert.ok(PLAN_RANK.discovery < PLAN_RANK.goto);
  });

  test('a plan reaches itself and everything below it', () => {
    const v = vendor({ plan: 'goto' });
    assert.equal(planAllows(v, 'freshman', NOW), true);
    assert.equal(planAllows(v, 'discovery', NOW), true);
    assert.equal(planAllows(v, 'goto', NOW), true);
  });

  test('freshman does not reach discovery', () => {
    assert.equal(planAllows(vendor({ plan: 'freshman' }), 'discovery', NOW), false);
  });

  test('discovery does not reach goto', () => {
    assert.equal(planAllows(vendor({ plan: 'discovery' }), 'goto', NOW), false);
  });

  test('an unknown or missing plan is treated as freshman, never as goto', () => {
    // Fails CLOSED. A row that somehow escaped vendors_plan_check must not
    // become a free pass to the top tier.
    assert.equal(effectivePlan(vendor({ plan: 'platinum' }), NOW), 'freshman');
    assert.equal(effectivePlan(vendor({ plan: undefined }), NOW), 'freshman');
    assert.equal(effectivePlan({}, NOW), 'freshman');
    assert.equal(planAllows({ plan: 'platinum' }, 'discovery', NOW), false);
  });

  test('a plan named after an Object.prototype key is still just unknown', () => {
    // PLAN_RANK and ITEM_CAP are ordinary objects, so a bare `PLAN_RANK[plan]`
    // lookup answers with a FUNCTION for 'constructor' rather than undefined.
    // That made effectivePlan return 'constructor' and itemCap return the
    // Function constructor itself. vendors_plan_check makes it unreachable
    // from the database, but this module promises to normalise an unknown plan
    // and has to actually do it.
    for (const weird of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const v = vendor({ plan: weird });
      assert.equal(effectivePlan(v, NOW), 'freshman', `${weird} should read as freshman`);
      assert.equal(itemCap(v, NOW), 3, `${weird} should get the free-tier cap`);
      assert.equal(planAllows(v, 'discovery', NOW), false);
    }
  });

  test('an unrecognised REQUIRED plan denies instead of waving everything through', () => {
    // The gate used to read `PLAN_RANK[minimum] ?? 0`, so requirePlan('Discovery')
    // — one capital letter — resolved to rank 0 and allowed every request. The
    // paywall was simply absent, with no error, no log line and no failing
    // test. Denying is the only safe reading of a bug in a gate.
    const paid = vendor({ plan: 'goto' });
    for (const typo of ['Discovery', 'discovry', 'pro', '', undefined, null, 'constructor']) {
      assert.equal(planAllows(paid, typo, NOW), false, `"${typo}" must not open the gate`);
    }
    // ...and the three real names still work, on the same vendor.
    for (const real of ['freshman', 'discovery', 'goto']) {
      assert.equal(planAllows(paid, real, NOW), true);
    }
  });
});

describe('the dunning ladder', () => {
  test('a healthy vendor has null days past due, not 0', () => {
    assert.equal(daysPastDue(vendor(), NOW), null);
  });

  test('a few days late changes nothing yet', () => {
    const v = vendor({ past_due_since: daysAgo(3) });
    assert.equal(daysPastDue(v, NOW), 3);
    assert.equal(effectivePlan(v, NOW), 'discovery', 'still paid up as far as features go');
    assert.equal(planAllows(v, 'discovery', NOW), true);
  });

  test('the day before the degrade line, everything still works', () => {
    const v = vendor({ past_due_since: daysAgo(DEGRADE_DAYS - 1) });
    assert.equal(effectivePlan(v, NOW), 'discovery');
  });

  test('ON the degrade line, the plan drops to freshman', () => {
    const v = vendor({ past_due_since: daysAgo(DEGRADE_DAYS) });
    assert.equal(effectivePlan(v, NOW), 'freshman');
    assert.equal(planAllows(v, 'discovery', NOW), false);
  });

  test('a degraded goto vendor drops to freshman too, not to discovery', () => {
    const v = vendor({ plan: 'goto', past_due_since: daysAgo(40) });
    assert.equal(effectivePlan(v, NOW), 'freshman');
  });

  test('degrading never raises a plan', () => {
    // A freshman vendor cannot be "degraded" upward by a stray timestamp.
    const v = vendor({ plan: 'freshman', past_due_since: daysAgo(60) });
    assert.equal(effectivePlan(v, NOW), 'freshman');
  });

  test('the suspend line is past the degrade line and is the operator’s, not the code’s', () => {
    // Nothing in this module acts on SUSPEND_DAYS: suspension is a human
    // decision made in /admin with the day count on screen. The constant exists
    // so the number is written down once.
    assert.ok(SUSPEND_DAYS > DEGRADE_DAYS);
    const v = vendor({ past_due_since: daysAgo(SUSPEND_DAYS + 5) });
    assert.equal(effectivePlan(v, NOW), 'freshman', 'still degraded, not auto-suspended');
  });

  test('a malformed timestamp is ignored rather than throwing', () => {
    assert.equal(daysPastDue(vendor({ past_due_since: 'not a date' }), NOW), null);
    assert.equal(effectivePlan(vendor({ past_due_since: 'not a date' }), NOW), 'discovery');
  });
});

describe('grandfathered vendors', () => {
  test('are never past due, however stale the stamp', () => {
    const v = vendor({ plan: 'goto', grandfathered: true, past_due_since: daysAgo(400) });
    assert.equal(daysPastDue(v, NOW), null);
    assert.equal(effectivePlan(v, NOW), 'goto', 'the sixteen keep everything, always');
    assert.equal(planAllows(v, 'goto', NOW), true);
  });

  test('are not gated out of anything', () => {
    const v = vendor({ plan: 'goto', grandfathered: true });
    assert.equal(planRejection(v, 'discovery', NOW), null);
    assert.equal(planRejection(v, 'goto', NOW), null);
  });
});

describe('item caps', () => {
  test('freshman is capped at three, paid plans are not capped', () => {
    assert.equal(itemCap(vendor({ plan: 'freshman' }), NOW), 3);
    assert.equal(itemCap(vendor({ plan: 'discovery' }), NOW), null);
    assert.equal(itemCap(vendor({ plan: 'goto' }), NOW), null);
    assert.equal(ITEM_CAP.freshman, 3);
  });

  test('a degraded vendor is capped as a freshman is', () => {
    // Note this caps NEW items; it does not delete the ones they already have.
    // Enforcement is on create, so a vendor who falls behind keeps their menu.
    assert.equal(itemCap(vendor({ past_due_since: daysAgo(35) }), NOW), 3);
  });
});

describe('the rejection body', () => {
  test('an allowed request produces no rejection', () => {
    assert.equal(planRejection(vendor(), 'discovery', NOW), null);
  });

  test('never having had it says upgrade, and is a 402', () => {
    const r = planRejection(vendor({ plan: 'freshman' }), 'discovery', NOW);
    assert.equal(r.status, 402, '402 means "this costs money", which is an Upgrade button');
    assert.equal(r.body.error, 'PLAN_REQUIRED');
    assert.match(r.body.message, /Discovery/, 'names the plan in words a vendor reads, not the slug');
    assert.equal(r.body.requiredPlan, 'discovery');
  });

  test('having lost it to a failed card says so, with the day count', () => {
    const r = planRejection(vendor({ past_due_since: daysAgo(33) }), 'discovery', NOW);
    assert.equal(r.status, 402);
    assert.equal(r.body.error, 'PLAN_PAST_DUE', 'a different code: the fix is a card, not an upgrade');
    assert.equal(r.body.daysPastDue, 33);
    assert.match(r.body.message, /33 days/);
  });

  test('the two cases are distinguishable by the client', () => {
    // The terminal shows a different screen for each, so they must never
    // collapse into one code.
    const upgrade = planRejection(vendor({ plan: 'freshman' }), 'discovery', NOW);
    const pastDue = planRejection(vendor({ past_due_since: daysAgo(31) }), 'discovery', NOW);
    assert.notEqual(upgrade.body.error, pastDue.body.error);
  });
});

describe('requirePlan refuses to mount a gate that is not a gate', () => {
  test('a typo in the plan name throws at import time, not at request time', () => {
    // Routes are declared at module scope, so this throw happens when the
    // route file is imported: the server does not boot and the test suite
    // fails, instead of shipping a paywall that silently is not there.
    for (const typo of ['Discovery', 'discovry', 'pro', undefined]) {
      assert.throws(() => requirePlan(typo), /unknown plan/i, `"${typo}" must not mount`);
    }
    for (const real of ['freshman', 'discovery', 'goto']) {
      assert.equal(typeof requirePlan(real), 'function');
    }
  });

  test('a gated route rejects a freshman vendor with a 402, not a 403', () => {
    const gate = requirePlan('discovery');
    let status = null; let body = null;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
    gate({ vendor: { plan: 'freshman' } }, res, () => { status = 'CALLED_NEXT'; });
    assert.equal(status, 402);
    assert.equal(body.error, 'PLAN_REQUIRED');
  });

  test('the operator impersonating a vendor is never gated', () => {
    // Same reasoning as requirePin: a spot the operator cannot open is a spot
    // they cannot diagnose.
    let called = false;
    requirePlan('goto')({ terminalAdmin: true, vendor: { plan: 'freshman' } }, null, () => { called = true; });
    assert.equal(called, true);
  });
});
