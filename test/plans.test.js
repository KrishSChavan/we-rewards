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
  PLAN_RANK, DEGRADE_DAYS, SUSPEND_DAYS, ITEM_CAP, PLAN_LABELS,
  daysPastDue, effectivePlan, planAllows, itemCap, planRejection, planLocks,
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

describe('the locked-feature list the terminal renders', () => {
  // planLocks is what the DEALS, VISITS and STATS panels and the Settings
  // billing card are all drawn from (GET /api/vendor/config and
  // GET /api/vendor/billing send the identical value). Two failure modes are
  // being protected here and they cost different things:
  //
  //   * OVERSELLING. Every key in the list must be a gate that really refuses a
  //     request. List something ungated and the first vendor who pays for it
  //     asks for a refund, having bought what they already had.
  //   * CONFLATING THE TWO STATES. A vendor whose card just failed must never
  //     read the word "upgrade": they already pay for this. planRejection draws
  //     the same line for the same reason.
  const keys = (locks) => locks.items.map((i) => i.key);

  test('a paying discovery vendor has nothing locked', () => {
    // Everything gated in routes/vendor.js today is gated at discovery, so
    // reaching discovery clears the list entirely — null, not an empty array,
    // so the client has one thing to test.
    assert.equal(planLocks(vendor({ plan: 'discovery' }), NOW), null);
  });

  test('a goto vendor has nothing locked', () => {
    assert.equal(planLocks(vendor({ plan: 'goto' }), NOW), null);
  });

  test('a few days late locks nothing — the plan has not degraded yet', () => {
    // Matches effectivePlan: nothing is taken away before DEGRADE_DAYS, so
    // nothing may be ADVERTISED as taken away either.
    assert.equal(planLocks(vendor({ past_due_since: daysAgo(3) }), NOW), null);
    assert.equal(planLocks(vendor({ past_due_since: daysAgo(DEGRADE_DAYS - 1) }), NOW), null);
  });

  test('a freshman vendor is told about all four gates, and told to upgrade', () => {
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    assert.equal(l.reason, 'upgrade');
    assert.equal(l.plan, 'freshman');
    assert.equal(l.nominalPlan, 'freshman');
    assert.equal(l.requiredPlan, 'discovery');
    assert.equal(l.daysPastDue, null, 'no day count: there is no debt to describe');
    assert.deepEqual(keys(l), ['deals', 'visits', 'stats30', 'itemCap']);
    for (const item of l.items) {
      assert.ok(item.label && item.label.length < 60, `${item.key} needs a short label`);
      assert.ok(/\S\.\s*$|\.\s*$/.test(item.detail), `${item.key}'s detail should read as sentences`);
    }
  });

  test('the four keys are exactly the gates that exist, and no more', () => {
    // The client switches on these strings (#deals-lock, #punch-lock,
    // #stats-lock, #items-cap-note), and each one names a real refusal:
    //   deals    → POST/PATCH /campaigns + /campaigns/reach, requirePlan('discovery')
    //   visits   → GET /punch-token, requirePlan('discovery')
    //   stats30  → GET /analytics's freshman trim (lockedSections)
    //   itemCap  → the ITEM_CAP counts in POST/PATCH /rewards
    // Nothing else in routes/vendor.js consults the plan, so nothing else
    // belongs in this list. Earning, redeeming, receipts (migration-056 ships
    // them ungated on purpose), settings, the PIN and multi-location are free.
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    assert.equal(new Set(keys(l)).size, 4, 'no duplicate keys');
    for (const forbidden of ['earn', 'redeem', 'receipts', 'settings', 'pin', 'logo', 'locations']) {
      assert.ok(!keys(l).includes(forbidden), `${forbidden} is not gated and must not be listed`);
    }
  });

  test('a freshman vendor is never told a payment is outstanding', () => {
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    for (const item of l.items) {
      assert.doesNotMatch(item.detail, /outstanding|past due|update your card/i,
        `${item.key} must not imply a debt for somebody who never paid`);
    }
  });

  test('ON the degrade line a paid vendor is past_due, not upgrade', () => {
    const l = planLocks(vendor({ plan: 'discovery', past_due_since: daysAgo(DEGRADE_DAYS) }), NOW);
    assert.equal(l.reason, 'past_due');
    assert.equal(l.plan, 'freshman', 'the EFFECTIVE plan right now');
    assert.equal(l.nominalPlan, 'discovery', 'what they still hold, and still pay for');
    assert.equal(l.daysPastDue, DEGRADE_DAYS);
    assert.deepEqual(keys(l), ['deals', 'visits', 'stats30', 'itemCap'],
      'the same four a freshman loses — with different copy');
  });

  test('a degraded vendor is told to fix their card, never to upgrade', () => {
    // The whole reason reason exists. This vendor already pays for Discovery;
    // "upgrade to Discovery" is the sentence that turns a declined card into a
    // support call.
    const l = planLocks(vendor({ plan: 'discovery', past_due_since: daysAgo(34) }), NOW);
    assert.equal(l.daysPastDue, 34);
    for (const item of l.items) {
      assert.doesNotMatch(item.detail, /upgrade/i, `${item.key} must not say upgrade`);
      assert.match(item.detail, /34 days|card/i, `${item.key} should name the debt or the fix`);
    }
  });

  test('a degraded goto vendor still reads as past_due on their own plan', () => {
    const l = planLocks(vendor({ plan: 'goto', past_due_since: daysAgo(60) }), NOW);
    assert.equal(l.reason, 'past_due');
    assert.equal(l.nominalPlan, 'goto');
    assert.equal(l.plan, 'freshman');
    // requiredPlan is what UNLOCKS the list, which is where the gates sit — not
    // the plan they hold. A goto vendor fixing their card gets goto back.
    assert.equal(l.requiredPlan, 'discovery');
  });

  test('a freshman row with a LIVE stamp is past_due, because that row is real', () => {
    // This assertion is the reverse of the one that used to be here, and the
    // reversal is the fix. The old reading called a stamp on a freshman row a data
    // artefact, like the one daysPastDue discounts on a grandfathered row.
    // src/routes/stripe-webhook.js says otherwise: subscriptionPatch's not-paying,
    // NON-terminal branch (`unpaid`/`paused`/`incomplete`) writes plan 'freshman',
    // KEEPS stripe_subscription_id and leaves past_due_since standing — it stamps
    // one for `unpaid` if it is missing — and invoice.payment_failed stamps the
    // column without touching `plan` at all. There is a live subscription and real
    // arrears behind this row, and the rows that ARE artefacts get the column
    // nulled instead (the terminal branch, and customer.subscription.deleted).
    //
    // Calling it 'upgrade' meant planRejection answered PLAN_PAST_DUE for the same
    // request that drew an "upgrade to Discovery" panel: the vendor read a Discovery
    // sales pitch and "a payment is outstanding" on one screen, and the CTA landed
    // on a billing card that hides both Upgrade buttons while an id is set.
    const l = planLocks(vendor({ plan: 'freshman', past_due_since: daysAgo(90) }), NOW);
    assert.equal(l.reason, 'past_due');
    assert.equal(l.daysPastDue, 90);
    assert.equal(l.nominalPlan, 'freshman', 'still what the column says');
    for (const item of l.items) {
      assert.doesNotMatch(item.detail, /upgrade|move to/i,
        `${item.key} must not sell a plan to somebody in arrears`);
    }
  });

  test('planLocks.reason and planRejection.error never disagree — whole matrix', () => {
    // THE REGRESSION FENCE FOR THE BUG ABOVE. planRejection explains a refusal
    // that already happened; planLocks explains the same gate before the vendor
    // touches it. If they read one row differently the vendor gets two
    // contradictory sentences on one screen, so the relationship is a
    // biconditional and it is asserted over the whole input space rather than at a
    // few points — the old bug lived in a corner (nominal freshman + live stamp)
    // that a handful of hand-picked cases walked straight past. 5 plans x 8
    // timestamps x 2 grandfathered flags = 80 rows, and every one must agree.
    const plans = ['freshman', 'discovery', 'goto', undefined, 'bogus'];
    const stamps = [
      ['none', null],
      ['today', daysAgo(0)],
      ['5d', daysAgo(5)],
      ['the day before the line', daysAgo(DEGRADE_DAYS - 1)],
      ['exactly on the line', daysAgo(DEGRADE_DAYS)],
      ['31d', daysAgo(31)],
      ['60d', daysAgo(60)],
      // Not a date at all: daysPastDue answers null for it, so NEITHER function
      // may read a debt out of it.
      ['malformed', 'not a date'],
    ];
    let rows = 0; let agreedPastDue = 0; let agreedAllowed = 0;
    for (const plan of plans) {
      for (const [stampName, past_due_since] of stamps) {
        for (const grandfathered of [false, true]) {
          rows += 1;
          const v = vendor({ plan, past_due_since, grandfathered });
          const where = `plan=${String(plan)} stamp=${stampName} grandfathered=${grandfathered}`;
          const locks = planLocks(v, NOW);
          const rejection = planRejection(v, 'discovery', NOW);
          const locksSayPastDue = locks?.reason === 'past_due';
          const serverSaysPastDue = rejection?.body.error === 'PLAN_PAST_DUE';
          assert.equal(locksSayPastDue, serverSaysPastDue,
            `${where}: planLocks says ${locks?.reason ?? 'nothing locked'} but the 402 `
            + `says ${rejection?.body.error ?? 'allowed'}`);
          if (locksSayPastDue) {
            agreedPastDue += 1;
            // And they quote the SAME number of days, since both end up on screen.
            assert.equal(locks.daysPastDue, rejection.body.daysPastDue, where);
          }
          // The other half of the contract: when the server would ALLOW the
          // discovery-gated request, there is nothing to draw a lock panel about.
          // (The converse does not hold and must not be asserted — a grandfathered
          // freshman row is refused by requirePlan while planLocks stays null on
          // purpose, because that vendor has no billing region to point at.)
          if (rejection === null) {
            agreedAllowed += 1;
            assert.equal(locks, null, `${where}: allowed, so nothing may be advertised as locked`);
          }
        }
      }
    }
    assert.equal(rows, 80, 'the matrix itself changed — check the lists above');
    assert.ok(agreedPastDue > 0 && agreedAllowed > 0, 'the matrix must exercise both outcomes');
  });

  test('a grandfathered vendor is never locked out of anything', () => {
    // Consistent with daysPastDue (never late), with /checkout and /portal (both
    // 409 GRANDFATHERED), and with terminal.js hiding the whole billing region:
    // a locked list would point at an Upgrade button that is not on the screen.
    for (const plan of ['goto', 'discovery', 'freshman']) {
      const v = vendor({ plan, grandfathered: true, past_due_since: daysAgo(400) });
      assert.equal(planLocks(v, NOW), null, `grandfathered ${plan} must have no locks`);
    }
  });

  test('the item-cap sentence tracks ITEM_CAP instead of a hardcoded 3', () => {
    // The number a vendor reads and the number POST /rewards enforces are the
    // same value, so raising the free tier's cap cannot leave a stale sentence
    // on the screen. Asserted by substituting the constant, not by matching /3/.
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    const cap = l.items.find((i) => i.key === 'itemCap');
    assert.ok(cap.detail.includes(String(ITEM_CAP.freshman)), cap.detail);
    assert.equal(itemCap(vendor({ plan: 'freshman' }), NOW), ITEM_CAP.freshman);
    const pastDue = planLocks(vendor({ past_due_since: daysAgo(31) }), NOW)
      .items.find((i) => i.key === 'itemCap');
    assert.ok(pastDue.detail.includes(String(ITEM_CAP.freshman)), pastDue.detail);
  });

  test('the item-cap copy is true for a vendor ALREADY OVER the cap', () => {
    // The vendor this note exists for is usually over the cap, not at it: nothing
    // deactivates rewards when a plan drops (POST /rewards says so itself — "a
    // vendor who drops to freshman (or falls 30 days past due) keeps the menu they
    // already built"), so somebody who built nine rewards on Discovery and
    // cancelled reads this sentence above nine switched-on rows.
    //
    // Two claims are therefore banned in BOTH variants:
    //   * that their menu "can keep 3 active" / "keeps 3 active" — it demonstrably
    //     keeps nine, and the sentence is sitting next to the proof;
    //   * "turn one off to make room" — the gate is `(count ?? 0) >= cap` over
    //     active rewards (src/routes/vendor.js), so 9 -> 8 is still refused. That
    //     vendor needs seven toggles, and following the advice teaches them the
    //     terminal lies.
    // What is allowed is the RULE, which is true at every count.
    for (const v of [
      vendor({ plan: 'freshman' }),
      vendor({ plan: 'discovery', past_due_since: daysAgo(34) }),
    ]) {
      const { detail } = planLocks(v, NOW).items.find((i) => i.key === 'itemCap');
      assert.doesNotMatch(detail, /(can|may|menu) keeps?\b|keep \d+ rewards/i,
        `must not describe the vendor's menu as holding the cap: ${detail}`);
      assert.doesNotMatch(detail, /turn one off|switch one off|make room/i,
        `advice that only works AT the cap: ${detail}`);
      assert.match(detail, /refused/, `state the gate: ${detail}`);
    }
    // And the free way out, when there is one, has to be reachable: "come under 3"
    // is what POST /rewards actually requires, not "one off".
    const upgrade = planLocks(vendor({ plan: 'freshman' }), NOW)
      .items.find((i) => i.key === 'itemCap');
    assert.match(upgrade.detail, new RegExp(`under ${ITEM_CAP.freshman}\\b`));
  });

  test('the upgrade copy names the plan in words, not the slug', () => {
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    const named = l.items.filter((i) => i.detail.includes(PLAN_LABELS.discovery));
    assert.ok(named.length >= 3, 'the sell should say "Discovery", never "discovery"');
    for (const item of l.items) {
      assert.doesNotMatch(item.detail, /\bdiscovery\b/, `${item.key} leaks the slug`);
    }
  });

  test('an unknown plan slug is listed as a freshman, never waved through', () => {
    // Same fail-closed reading as effectivePlan and planAllows: a row that
    // escaped vendors_plan_check must not come back with nothing locked.
    for (const weird of ['platinum', 'constructor', undefined]) {
      const l = planLocks(vendor({ plan: weird }), NOW);
      assert.equal(l.reason, 'upgrade', `${weird} should read as freshman`);
      assert.equal(l.nominalPlan, 'freshman');
      assert.equal(l.items.length, 4);
    }
    assert.equal(planLocks({}, NOW).reason, 'upgrade');
  });

  test('every item is a plain {key,label,detail} the client can render blind', () => {
    // CONTRACT: the renderer switches on key and prints label + detail verbatim.
    // An extra or missing field means a half-drawn panel on a live terminal.
    const l = planLocks(vendor({ plan: 'freshman' }), NOW);
    for (const item of l.items) {
      assert.deepEqual(Object.keys(item), ['key', 'label', 'detail']);
      assert.equal(typeof item.label, 'string');
      assert.equal(typeof item.detail, 'string');
      assert.ok(item.detail.length > 20, `${item.key}'s detail must be a usable sentence`);
    }
  });

  test('a null or missing vendor is locked, not crashed', () => {
    // requireVendor guarantees req.vendor, but every other function in this file
    // survives a missing one and this is called from two response bodies.
    assert.equal(planLocks(null, NOW).reason, 'upgrade');
    assert.equal(planLocks(undefined, NOW).items.length, 4);
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
