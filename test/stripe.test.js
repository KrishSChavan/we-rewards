// Unit tests for the Stripe layer: the wire encoding, the signature scheme, the
// two API-version shapes, and the decision table that turns a subscription into
// a vendors-row patch (src/lib/stripe.js, src/routes/stripe-webhook.js).
//
// WHAT IS BEING PROTECTED HERE, each failing in its own direction (the list has
// outgrown the "four" it used to claim, so it no longer counts itself):
//
//   * THE SECRET IS USED VERBATIM. Stripe HMACs the whole `whsec_...` string and
//     hex-encodes; verifySvix() in routes/webhooks.js strips that same-looking
//     prefix, base64-DECODES it, and base64-encodes the digest. The signature
//     tests below compute the expected digest INDEPENDENTLY rather than calling
//     the function under test, so a "tidy-up" that unifies the two schemes fails
//     here instead of silently rejecting every real event in production.
//
//   * A VENDOR MUST NEVER BE DOWNGRADED BY AN UNFAMILIAR PRICE. If the operator
//     creates a Price whose lookup key this deploy has not heard of, the plan is
//     left exactly where it was. Reading it as 'freshman' would take the paid
//     product away from someone at the moment they paid more for it.
//
//   * `past_due` STILL ENTITLES. Stripe's status is not the dunning ladder —
//     src/lib/plans.js's 30-day count from `past_due_since` is. If statusIsPaying
//     ever stops including past_due, every vendor whose card fails loses their
//     deals the same morning and the whole ladder becomes dead code.
//
//   * NULL AND UNDEFINED ARE NOT THE STRINGS "null"/"undefined". formEncode
//     skips them. Sending one writes the literal text into Stripe's metadata,
//     where it is then permanent.
//
//   * A DEAD SUBSCRIPTION ID MUST NOT STAY ON THE ROW. POST /api/vendor/checkout
//     answers 409 ALREADY_SUBSCRIBED whenever vendors.stripe_subscription_id is
//     set, and Stripe emits nothing further for a subscription it has finished
//     with — so a `canceled` status that left the id behind locks the vendor out
//     of ever buying a plan again, permanently and silently. `past_due` and
//     `unpaid` are the opposite case and must KEEP it: that subscription is still
//     theirs, still recoverable in the portal, and still what plans.js measures
//     the dunning ladder from — which is why they must keep the `past_due_since`
//     stamp too. Nulling the stamp while keeping the id is the contradiction that
//     made `unpaid` invisible: entitlement gone, id kept so no Upgrade button, and
//     billing_state 'ok' on a vendor weeks in arrears.
//
//   * A 404 FROM A CANCEL IS NOT PROOF THE THING IS DEAD. Stripe answers the same
//     404 `resource_missing` for "already cancelled" and for "exists, but not
//     under the key this process holds" (rotated key, test key against live
//     events). Only a follow-up read separates them, and believing the 404 on its
//     own is how a vendor who really is billed twice becomes the one case nobody
//     is told about. cancel404Verdict is that decision.
//
//   * A 2xx WHOSE BODY WE COULD NOT READ IS NOT AN ANSWER. stripeRequest used to
//     return null there — an aborted or truncated body, or an egress proxy answering
//     200 with HTML — and every caller invented a different wrong meaning for that
//     null. The worst of them: getSubscription's null reached subscriptionPatch, which
//     read it as a subscription with no status and CHURNED a paying vendor (plan
//     'freshman', every billing column nulled) while answering 200 and keeping the
//     replay marker, so nothing retried and nobody was told. Two tests below pin the
//     two halves — the throw, and what subscriptionPatch would still do to a
//     non-subscription if the fence in front of it were removed.
//
//   * ONLY 429, 5xx AND NETWORK FAILURES ARE WORTH RETRYING. Everything else a
//     Stripe read can answer — 400 above all — is a configuration fact, and
//     rethrowing it buys three days of silent redeliveries instead of one alert to
//     the one person who can fix it. isRetryableStripeError is that decision, and
//     it is a whitelist of the RETRYABLE side on purpose.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  formEncode, lookupKeyFor, planFromLookupKey, statusIsPaying,
  readSubscription, invoiceSubscriptionId, verifyStripeSignature, INTERVALS,
  cancelSubscription, checkoutExpiresAt, StripeError,
} from '../src/lib/stripe.js';
import {
  subscriptionPatch, cancel404Verdict, isRetryableStripeError, isSubscriptionShape,
} from '../src/routes/stripe-webhook.js';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const SECRET = 'whsec_ZmFrZXNlY3JldGZvcnRlc3Rpbmdvbmx5';

/** Build a real Stripe-Signature header the way Stripe does. */
const sign = (raw, { secret = SECRET, at = Math.floor(NOW / 1000), scheme = 'v1' } = {}) => {
  const mac = crypto.createHmac('sha256', secret).update(`${at}.${raw}`, 'utf8').digest('hex');
  return `t=${at},${scheme}=${mac}`;
};

describe('formEncode', () => {
  test('flat scalars', () => {
    assert.equal(formEncode({ mode: 'subscription', quantity: 1 }), 'mode=subscription&quantity=1');
  });

  test('nests objects with brackets', () => {
    assert.equal(formEncode({ metadata: { vendor_id: 'v1' } }), 'metadata%5Bvendor_id%5D=v1');
  });

  test('indexes arrays of objects — the shape line_items needs', () => {
    const out = formEncode({ line_items: [{ price: 'price_1', quantity: 1 }] });
    assert.equal(decodeURIComponent(out), 'line_items[0][price]=price_1&line_items[0][quantity]=1');
  });

  test('indexes arrays of scalars', () => {
    assert.equal(decodeURIComponent(formEncode({ expand: ['data.product'] })), 'expand[0]=data.product');
  });

  test('SKIPS null and undefined rather than sending their names', () => {
    // The bug this catches writes the four-character string "null" into a
    // Stripe customer's email field, where it stays.
    assert.equal(formEncode({ email: null, name: undefined, id: 'x' }), 'id=x');
  });

  test('keeps false and 0, which are real values', () => {
    assert.equal(formEncode({ active: false, count: 0 }), 'active=false&count=0');
  });

  test('percent-encodes keys and values', () => {
    const out = formEncode({ success_url: 'https://a.test/t?billing=success&x=1' });
    assert.match(out, /%3F/); // the ? is encoded, so it cannot split the body
    assert.ok(!out.includes('?billing'));
  });

  test('an object whose every value is null contributes nothing', () => {
    // Guards the `.filter(Boolean)` — without it this emits a stray '&'.
    assert.equal(formEncode({ a: 'x', sub: { b: null } }), 'a=x');
  });

  test('empty input is the empty string, not "undefined"', () => {
    assert.equal(formEncode({}), '');
    assert.equal(formEncode(null), '');
  });
});

describe('lookupKeyFor / planFromLookupKey', () => {
  test('round-trips every sellable combination', () => {
    for (const plan of ['discovery', 'goto']) {
      for (const interval of INTERVALS) {
        const key = lookupKeyFor(plan, interval);
        assert.equal(key, `${plan}_${interval}`);
        assert.equal(planFromLookupKey(key), plan);
      }
    }
  });

  test('freshman is not sellable — it is free and has no Price', () => {
    assert.equal(lookupKeyFor('freshman', 'monthly'), null);
  });

  test('an unknown interval is refused, not guessed', () => {
    assert.equal(lookupKeyFor('discovery', 'weekly'), null);
    assert.equal(lookupKeyFor('discovery', undefined), null);
  });

  test('an unrecognised lookup key is null, and null is NOT freshman', () => {
    // The distinction the webhook depends on: null means "leave the plan alone
    // and tell the operator", never "downgrade them".
    assert.equal(planFromLookupKey('enterprise_monthly'), null);
    assert.equal(planFromLookupKey('discovery_weekly'), null);
    assert.equal(planFromLookupKey(''), null);
    assert.equal(planFromLookupKey(null), null);
  });
});

describe('statusIsPaying', () => {
  test('past_due STILL entitles — plans.js owns the cut-off, not Stripe', () => {
    assert.equal(statusIsPaying('past_due'), true);
  });

  test('active and trialing entitle', () => {
    assert.equal(statusIsPaying('active'), true);
    assert.equal(statusIsPaying('trialing'), true);
  });

  test('everything else does not', () => {
    for (const s of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', '', null]) {
      assert.equal(statusIsPaying(s), false, `${s} should not entitle`);
    }
  });
});

describe('readSubscription — the two API-version shapes', () => {
  const price = { id: 'price_1', lookup_key: 'discovery_monthly', recurring: { interval: 'month' } };
  const periodEnd = Math.floor(Date.UTC(2026, 9, 12) / 1000);

  test('reads current_period_end from the SUBSCRIPTION (pre-2025 shape)', () => {
    const s = readSubscription({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      current_period_end: periodEnd,
      items: { data: [{ price }] },
    });
    assert.equal(s.currentPeriodEnd, new Date(periodEnd * 1000).toISOString());
    assert.equal(s.plan, 'discovery');
  });

  test('reads it from the ITEM when the subscription has none (2025 shape)', () => {
    // The trap: miss this and every vendor's renewal date is silently null.
    const s = readSubscription({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      items: { data: [{ price, current_period_end: periodEnd }] },
    });
    assert.equal(s.currentPeriodEnd, new Date(periodEnd * 1000).toISOString());
  });

  test('null period end rather than an Invalid Date when neither is present', () => {
    const s = readSubscription({ id: 'sub_1', status: 'active', items: { data: [{ price }] } });
    assert.equal(s.currentPeriodEnd, null);
  });

  test('unwraps an expanded customer object as well as a bare id', () => {
    assert.equal(readSubscription({ customer: 'cus_1' }).customer, 'cus_1');
    assert.equal(readSubscription({ customer: { id: 'cus_1' } }).customer, 'cus_1');
  });

  test('an unfamiliar price leaves plan null but keeps the key for the alert', () => {
    const s = readSubscription({
      id: 'sub_1', status: 'active',
      items: { data: [{ price: { id: 'price_x', lookup_key: 'enterprise_monthly' } }] },
    });
    assert.equal(s.plan, null);
    assert.equal(s.lookupKey, 'enterprise_monthly');
  });

  test('survives a subscription with no items at all', () => {
    const s = readSubscription({ id: 'sub_1', status: 'canceled' });
    assert.equal(s.plan, null);
    assert.equal(s.currentPeriodEnd, null);
    assert.equal(s.id, 'sub_1');
  });
});

describe('invoiceSubscriptionId — the other moved field', () => {
  test('reads the flat field', () => {
    assert.equal(invoiceSubscriptionId({ subscription: 'sub_1' }), 'sub_1');
  });

  test('reads the nested 2025 location', () => {
    assert.equal(
      invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_1' } } }),
      'sub_1',
    );
  });

  test('unwraps an expanded object', () => {
    assert.equal(invoiceSubscriptionId({ subscription: { id: 'sub_1' } }), 'sub_1');
  });

  test('a one-off invoice is null — the webhook uses this to ignore it', () => {
    assert.equal(invoiceSubscriptionId({ id: 'in_1' }), null);
    assert.equal(invoiceSubscriptionId(null), null);
  });
});

describe('verifyStripeSignature', () => {
  const raw = '{"id":"evt_1","type":"invoice.paid"}';

  test('accepts a signature Stripe would have produced', () => {
    assert.deepEqual(verifyStripeSignature(raw, sign(raw), SECRET, NOW), { ok: true });
  });

  test('THE SECRET IS USED VERBATIM — prefix kept, no base64 decode, hex digest', () => {
    // Computed here from first principles. If someone rewrites the verifier to
    // match verifySvix (strip `whsec_`, base64-decode the key, base64 digest)
    // this fails, rather than production rejecting every event.
    const t = Math.floor(NOW / 1000);
    const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
    assert.deepEqual(verifyStripeSignature(raw, `t=${t},v1=${expected}`, SECRET, NOW), { ok: true });

    // ...and the Svix construction of the SAME secret must NOT verify.
    const svixStyle = crypto
      .createHmac('sha256', Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64'))
      .update(`${t}.${raw}`, 'utf8').digest('hex');
    assert.notEqual(svixStyle, expected);
    assert.equal(verifyStripeSignature(raw, `t=${t},v1=${svixStyle}`, SECRET, NOW).ok, false);
  });

  test('rejects a body that changed by one byte', () => {
    const header = sign(raw);
    const tampered = raw.replace('invoice.paid', 'invoice.pai2');
    assert.equal(verifyStripeSignature(tampered, header, SECRET, NOW).reason, 'bad_signature');
  });

  test('rejects a signature made with a different secret', () => {
    const header = sign(raw, { secret: 'whsec_other' });
    assert.equal(verifyStripeSignature(raw, header, SECRET, NOW).reason, 'bad_signature');
  });

  test('accepts when ANY v1 matches — secret rotation sends two', () => {
    const t = Math.floor(NOW / 1000);
    const good = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
    assert.deepEqual(verifyStripeSignature(raw, header, SECRET, NOW), { ok: true });
  });

  test('ignores the v0 scheme Connect uses', () => {
    assert.equal(verifyStripeSignature(raw, sign(raw, { scheme: 'v0' }), SECRET, NOW).reason, 'malformed_header');
  });

  test('rejects a replay older than the 5-minute tolerance', () => {
    const old = Math.floor(NOW / 1000) - 301;
    assert.equal(verifyStripeSignature(raw, sign(raw, { at: old }), SECRET, NOW).reason, 'stale');
  });

  test('accepts one inside the tolerance', () => {
    const recent = Math.floor(NOW / 1000) - 299;
    assert.equal(verifyStripeSignature(raw, sign(raw, { at: recent }), SECRET, NOW).ok, true);
  });

  test('a FUTURE timestamp is accepted — the window is one-sided on purpose', () => {
    // Deliberately unlike verifySvix's symmetric window. Only a captured request
    // can be replayed and a captured request is always in the past, so rejecting
    // the future would turn our own clock skew into total webhook failure.
    const future = Math.floor(NOW / 1000) + 600;
    assert.equal(verifyStripeSignature(raw, sign(raw, { at: future }), SECRET, NOW).ok, true);
  });

  test('a truncated signature is rejected, not a crash', () => {
    // timingSafeEqual THROWS on a length mismatch. Without the length guard this
    // is a 500 that Stripe retries forever.
    const t = Math.floor(NOW / 1000);
    assert.equal(verifyStripeSignature(raw, `t=${t},v1=abcd`, SECRET, NOW).reason, 'bad_signature');
  });

  test('non-hex garbage is rejected, not a crash', () => {
    const t = Math.floor(NOW / 1000);
    assert.equal(verifyStripeSignature(raw, `t=${t},v1=zzzz`, SECRET, NOW).reason, 'bad_signature');
  });

  test('missing, malformed and unconfigured are distinguishable', () => {
    assert.equal(verifyStripeSignature(raw, '', SECRET, NOW).reason, 'missing_header');
    assert.equal(verifyStripeSignature(raw, 'garbage', SECRET, NOW).reason, 'malformed_header');
    assert.equal(verifyStripeSignature(raw, 't=abc,v1=ff', SECRET, NOW).reason, 'malformed_header');
    assert.equal(verifyStripeSignature(raw, sign(raw), '', NOW).reason, 'unconfigured');
  });
});

describe('subscriptionPatch — what a subscription does to a vendors row', () => {
  const PERIOD_END = Math.floor(Date.UTC(2026, 9, 12) / 1000);
  const subWith = (over = {}) => ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    current_period_end: PERIOD_END,
    items: { data: [{ price: { id: 'price_1', lookup_key: 'discovery_monthly' } }] },
    ...over,
  });
  const vendor = (over = {}) => ({ id: 'v1', name: 'Cafe', plan: 'freshman', ...over });

  test('a paying subscription grants the plan its price names', () => {
    const { patch, alert } = subscriptionPatch(subWith(), vendor(), NOW);
    assert.equal(patch.plan, 'discovery');
    assert.equal(patch.subscription_status, 'active');
    assert.equal(patch.stripe_subscription_id, 'sub_1');
    assert.equal(patch.current_period_end, new Date(PERIOD_END * 1000).toISOString());
    assert.equal(alert, null);
  });

  test('plan_since moves on a real change', () => {
    const { patch } = subscriptionPatch(subWith(), vendor({ plan: 'freshman' }), NOW);
    assert.equal(patch.plan_since, new Date(NOW).toISOString());
  });

  test('plan_since does NOT move on a routine renewal of the same plan', () => {
    // Otherwise "on Discovery since March" resets every billing cycle.
    const { patch } = subscriptionPatch(subWith(), vendor({ plan: 'discovery' }), NOW);
    assert.equal(patch.plan_since, undefined);
    assert.equal(patch.plan, 'discovery');
  });

  test('AN UNFAMILIAR PRICE LEAVES THE PLAN ALONE and alerts the operator', () => {
    // The one that would take the paid product away at the moment they paid more.
    const sub = subWith({ items: { data: [{ price: { lookup_key: 'enterprise_monthly' } }] } });
    const { patch, alert } = subscriptionPatch(sub, vendor({ plan: 'discovery' }), NOW);
    assert.equal('plan' in patch, false);
    assert.equal('plan_since' in patch, false);
    assert.match(alert, /unrecognised price/i);
    assert.match(alert, /enterprise_monthly/);
    // The status and renewal date are still recorded — only the PLAN is held.
    assert.equal(patch.subscription_status, 'active');
  });

  test('a cancelled subscription drops to freshman and clears the debt', () => {
    const { patch } = subscriptionPatch(subWith({ status: 'canceled' }), vendor({ plan: 'discovery', past_due_since: '2026-08-01T00:00:00Z' }), NOW);
    assert.equal(patch.plan, 'freshman');
    assert.equal(patch.past_due_since, null);
    assert.equal(patch.plan_since, new Date(NOW).toISOString());
  });

  test('incomplete and unpaid also drop to freshman', () => {
    for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
      const { patch } = subscriptionPatch(subWith({ status }), vendor({ plan: 'discovery' }), NOW);
      assert.equal(patch.plan, 'freshman', `${status} should not entitle`);
    }
  });

  test('past_due KEEPS the plan — the ladder in plans.js decides, not Stripe', () => {
    const { patch } = subscriptionPatch(subWith({ status: 'past_due' }), vendor({ plan: 'discovery' }), NOW);
    assert.equal(patch.plan, 'discovery');
  });

  test('past_due stamps past_due_since when the invoice event was missed', () => {
    const { patch } = subscriptionPatch(subWith({ status: 'past_due' }), vendor({ plan: 'discovery' }), NOW);
    assert.equal(patch.past_due_since, new Date(NOW).toISOString());
  });

  test('...but does NOT re-stamp an existing one, which would reset the day count', () => {
    const v = vendor({ plan: 'discovery', past_due_since: '2026-08-20T00:00:00Z' });
    const { patch } = subscriptionPatch(subWith({ status: 'past_due' }), v, NOW);
    assert.equal('past_due_since' in patch, false);
  });

  test('returning to active clears a stale past_due_since', () => {
    const v = vendor({ plan: 'discovery', past_due_since: '2026-08-20T00:00:00Z' });
    const { patch } = subscriptionPatch(subWith({ status: 'active' }), v, NOW);
    assert.equal(patch.past_due_since, null);
  });

  test('an active vendor with no debt gets no past_due_since key at all', () => {
    const { patch } = subscriptionPatch(subWith(), vendor({ plan: 'discovery' }), NOW);
    assert.equal('past_due_since' in patch, false);
  });

  test('A TERMINAL STATUS RELEASES THE SUBSCRIPTION ID, or /checkout 409s forever', () => {
    // Stripe sends nothing more about a subscription it has finished with, so an
    // id left on the row after `canceled` is never cleared by anything — and
    // POST /api/vendor/checkout refuses to sell a plan while one is set. The
    // vendor would be stuck on freshman with no way to pay.
    for (const status of ['canceled', 'incomplete_expired']) {
      const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
      const { patch } = subscriptionPatch(subWith({ status }), v, NOW);
      assert.equal(patch.plan, 'freshman', `${status} should not entitle`);
      assert.equal(patch.stripe_subscription_id, null, `${status} should release the id`);
    }
  });

  test('A TERMINAL STATUS ALSO RELEASES current_period_end — ONE churned shape', () => {
    // There must be exactly one row shape that means "churned", because two
    // readers disagree about which column proves it. The
    // customer.subscription.deleted branch of src/routes/stripe-webhook.js
    // writes {stripe_subscription_id: null, current_period_end: null, plan:
    // 'freshman', past_due_since: null}; this path has to write the same four.
    // (subscription_status and plan_since are the TWO fields that deliberately differ
    // — see the assertion below, and the test after this one.) A
    // version that nulled only the id left the renewal date behind, and
    // public/vendor/terminal.js's fallback (`subscribed = hasSubscription ??
    // Boolean(currentPeriodEnd)`) then reads a churned vendor as still
    // subscribed, hides both Upgrade buttons, and offers only "Manage billing" —
    // permanently, since Stripe emits nothing further about a dead subscription.
    // test/vendor-billing.test.js's CHURNED fixture asserts both columns null.
    for (const status of ['canceled', 'incomplete_expired']) {
      const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
      const { patch } = subscriptionPatch(subWith({ status }), v, NOW);
      assert.equal(patch.stripe_subscription_id, null, `${status} should release the id`);
      assert.equal(patch.current_period_end, null, `${status} should release the period end`);
      // ...and the rest of the churned shape the deleted branch writes.
      assert.equal(patch.plan, 'freshman');
      assert.equal(patch.past_due_since, null);
      // THE ONE DELIBERATE DIFFERENCE, asserted so it stays deliberate: the
      // deleted branch writes 'canceled' because that is what happened, while this
      // one records whichever terminal status Stripe reported — so an
      // 'incomplete_expired' row still says "the first invoice was never paid"
      // rather than "they cancelled". Nothing branches on it for a churned row
      // (public/vendor/terminal.js only compares it to 'canceled' inside its
      // `hasBilling && subscribed` branch, which the two nulls above make
      // unreachable), so it is a diagnostic for the operator, not part of the shape.
      assert.equal(patch.subscription_status, status);
    }
  });

  test('plan_since is the SECOND deliberate difference from the deleted branch', () => {
    // The docstring on subscriptionPatch used to claim subscription_status was the ONE
    // field in which the two churn paths differ. plan_since differs too, and it is
    // surfaced — supabase/migrations/20260909120000_migration-055.sql exposes
    // v.plan_since in vendor_billing_overview. HERE it moves only on a real change
    // (the `vendor?.plan !== 'freshman'` guard), so a vendor ALREADY on freshman keeps
    // the date their plan actually changed on; the customer.subscription.deleted
    // branch of src/routes/stripe-webhook.js stamps it unconditionally, so the same
    // vendor's date is bumped to the cancellation. Both are defensible and nothing
    // branches on either; the claim that only subscription_status differed was not.
    // This test exists so the docstring and the code cannot drift apart again.
    const alreadyFree = vendor({ plan: 'freshman', stripe_subscription_id: 'sub_1' });
    const { patch } = subscriptionPatch(subWith({ status: 'canceled' }), alreadyFree, NOW);
    assert.equal('plan_since' in patch, false, 'no plan change, so no new plan_since');
    assert.equal(patch.plan, 'freshman');
    // ...while a vendor who WAS paying does get the stamp, because their plan moved.
    const wasPaying = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
    assert.equal(
      subscriptionPatch(subWith({ status: 'canceled' }), wasPaying, NOW).patch.plan_since,
      new Date(NOW).toISOString(),
    );
  });

  test('a NON-terminal lapse keeps the period end — it is still their subscription', () => {
    // The other half of the rule. `unpaid` and `past_due` are recoverable in the
    // portal, the row goes on tracking that subscription, and the date they have
    // paid through is still true — so releasing it here would tell the billing
    // screen a live subscription has no renewal date.
    for (const status of ['past_due', 'unpaid']) {
      const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
      const { patch } = subscriptionPatch(subWith({ status }), v, NOW);
      assert.equal(patch.current_period_end, new Date(PERIOD_END * 1000).toISOString(),
        `${status} must keep the period end`);
    }
  });

  test('a NON-terminal lapse KEEPS past_due_since — the ladder is still measuring', () => {
    // The contradiction this closes: the branch kept the subscription id BECAUSE
    // plans.js measures the dunning ladder from the row, and then nulled the stamp
    // the ladder measures. An `unpaid` vendor came out of it with entitlement gone
    // (plan 'freshman'), the id kept (so POST /api/vendor/checkout 409s and the
    // terminal hides both Upgrade buttons), and days_past_due null — so
    // vendor_billing_overview said billing_state 'ok', they were absent from the
    // /admin trouble list, and the terminal drew no past-due banner. Nobody was
    // told about a vendor weeks in arrears and the vendor could not buy their way
    // out. Only a TERMINAL status clears the debt, because only then is there
    // nothing left to collect against.
    for (const status of ['unpaid', 'paused', 'incomplete']) {
      const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1', past_due_since: '2026-08-01T00:00:00Z' });
      const { patch } = subscriptionPatch(subWith({ status }), v, NOW);
      assert.equal(patch.plan, 'freshman', `${status} should not entitle`);
      assert.equal('past_due_since' in patch, false,
        `${status} must not touch the stamp the ladder measures`);
    }
  });

  test('unpaid with NO stamp gets one — or it is a debt nothing can see', () => {
    // The safety net, mirroring the one the past_due branch has. Stripe only moves
    // a subscription to `unpaid` once its retry schedule is exhausted, so money is
    // certainly owed — but every invoice.payment_failed that would have stamped it
    // can have been lost to a misconfigured endpoint, and Stripe attempts no
    // further payments on an unpaid subscription, so no later event stamps it
    // either. With no stamp the vendor is invisible to the whole dunning ladder.
    const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
    const { patch } = subscriptionPatch(subWith({ status: 'unpaid' }), v, NOW);
    assert.equal(patch.past_due_since, new Date(NOW).toISOString());
  });

  test('...but `paused` is NOT stamped — nothing bounced and nothing is owed', () => {
    // `paused` is a trial that ended with no payment method
    // (trial_settings.end_behavior), not a failed payment. Inventing a debt for it
    // would put a vendor who owes nothing on the operator's suspend list.
    const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
    const { patch } = subscriptionPatch(subWith({ status: 'paused' }), v, NOW);
    assert.equal('past_due_since' in patch, false);
  });

  test('...but past_due and unpaid KEEP it — that subscription is still theirs', () => {
    // past_due is recoverable by fixing a card in the portal, and unpaid is what
    // Stripe moves to after its own retries; in both cases the row must go on
    // pointing at the subscription, because plans.js counts the dunning days
    // against it and the portal is reached through it.
    for (const status of ['past_due', 'unpaid']) {
      const v = vendor({ plan: 'discovery', stripe_subscription_id: 'sub_1' });
      const { patch } = subscriptionPatch(subWith({ status }), v, NOW);
      assert.equal(patch.stripe_subscription_id, 'sub_1', `${status} must keep the id`);
    }
  });
});

describe('checkoutExpiresAt — margin against Stripe\'s 30-minute floor', () => {
  // Stripe refuses a Checkout Session whose expires_at is less than 30 minutes
  // ahead, with a 400 "Invalid expires_at" — and it measures that against the
  // instant the API RECEIVES the request, not the instant we computed the number.
  // A 400 there is a StripeError, which routes/vendor.js's checkout handler hands
  // straight to next(err): a 500 on POST /api/vendor/checkout, the ONLY
  // self-serve upgrade path in the app. So the margin is not a style question.
  const AT = 1790000000850; // deliberately mid-second: .850 of a second in

  test('is always at least 1860s ahead — never 1800, at any sub-second offset', () => {
    for (let ms = 0; ms < 1000; ms += 1) {
      const now = AT - 850 + ms;
      const ahead = checkoutExpiresAt(now) - now / 1000;
      assert.ok(ahead >= 1860, `+${ms}ms: only ${ahead}s ahead`);
      assert.ok(ahead <= 1861, `+${ms}ms: ${ahead}s is more margin than intended`);
    }
  });

  test('THE OLD ARITHMETIC FAILS THE SAME CHECK — which is the whole point', () => {
    // Math.floor(now/1000) + 1800 discards up to 999ms before the request even
    // leaves, so as soon as the fraction of the current second plus the network
    // latency crosses 1.0, Stripe stamps its own `created` a second later and
    // sees a 1799s window. 200ms of TLS + HTTP is enough.
    const created = Math.floor((AT + 200) / 1000); // what Stripe would stamp
    assert.ok(Math.floor(AT / 1000) + 1800 - created < 1800, 'the old value had negative margin');
    assert.ok(checkoutExpiresAt(AT) - created >= 1800, 'the new one clears the floor');
  });

  test('still clears the floor after 5 whole seconds of latency and clock skew', () => {
    for (const lagMs of [0, 1, 200, 999, 1000, 1500, 5000]) {
      const created = Math.floor((AT + lagMs) / 1000);
      const window = checkoutExpiresAt(AT) - created;
      assert.ok(window >= 1800, `${lagMs}ms of lag left only a ${window}s window`);
    }
  });

  test('and stays far inside the 24-hour ceiling Stripe also enforces', () => {
    // The other side of the range check: 1860s, not 1860 minutes.
    const ahead = checkoutExpiresAt(NOW) - NOW / 1000;
    assert.ok(ahead < 86_400, `${ahead}s would exceed Stripe's 24-hour maximum`);
  });

  test('whole seconds only — Stripe rejects a fractional unix timestamp', () => {
    assert.equal(checkoutExpiresAt(AT) % 1, 0);
    assert.equal(Number.isInteger(checkoutExpiresAt(AT + 0.4)), true);
  });
});

describe('cancel404Verdict — what a 404 from DELETE actually proves', () => {
  // Stripe answers the SAME 404 `resource_missing` to a subscription DELETE in two
  // opposite situations, and src/routes/admin.js's vendor-delete path documents the
  // pair at length: the subscription is already cancelled (harmless), or it exists
  // but not under the key this process holds — a rotated STRIPE_SECRET_KEY, or an
  // sk_test_ key on a box whose vendors were signed up live — in which case a card
  // is still being charged every month. Only a follow-up GET separates them, because
  // cancelling does not REMOVE a subscription: a cancelled one still reads back with
  // a terminal status, while one outside this key's reach 404s a second time.
  const notFound = () => new StripeError('No such subscription: sub_B', { status: 404, code: 'resource_missing' });

  test('a read that shows a terminal status PROVES it — this is the common case', () => {
    // The ordinary duplicate episode: Stripe announces one new subscription with
    // TWO events, the first delivery cancels sub_B, the second DELETEs it again and
    // gets a 404. Alerting there told the operator a vendor was billed twice about a
    // subscription that no longer existed.
    for (const status of ['canceled', 'incomplete_expired']) {
      const v = cancel404Verdict(status, null);
      assert.equal(v.alreadyGone, true, `'${status}' reads back as finished`);
      assert.equal(v.unconfirmed, null);
    }
  });

  test('A SECOND 404 IS NOT PROOF — and this is the double-billing case', () => {
    // THE FAILING INPUT THE GATE FOUND, and the reason this function exists: live
    // webhook secret, but STRIPE_SECRET_KEY rotated to another account or to test
    // mode. A genuinely live sub_B is invisible to this key, so the DELETE 404s and
    // the read 404s again. Round 2 read that as "already cancelled" and returned
    // before notifyAdmins — so the one deploy state where the duplicate really is
    // billing the vendor's card was the one state nobody was told about. alreadyGone
    // MUST be false here: it is the flag refuseDuplicateSubscription returns on
    // before it pages anyone.
    const v = cancel404Verdict(null, notFound());
    assert.equal(v.alreadyGone, false);
    assert.match(v.unconfirmed, /second 404/);
    assert.match(v.unconfirmed, /not in this Stripe account or mode/);
  });

  test('a read that comes back ALIVE is not proof either', () => {
    // Contradictory (the DELETE 404'd, the GET answered), which is a state to
    // escalate rather than to reason about — and 'past_due'/'unpaid' are the ones
    // that would go on billing.
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', null]) {
      const v = cancel404Verdict(status, null);
      assert.equal(v.alreadyGone, false, `'${status}' is not a finished subscription`);
      assert.match(v.unconfirmed, /not a finished subscription/);
    }
  });

  test('a probe that fails for any OTHER reason is not proof, and says why', () => {
    // A 403 from a restricted key, a timeout, Stripe 500ing: none of them says the
    // duplicate is dead, and the operator needs the actual reason in the push.
    const v = cancel404Verdict(null, new StripeError('Stripe request timed out', { status: 0, code: 'network_error' }));
    assert.equal(v.alreadyGone, false);
    assert.match(v.unconfirmed, /reading it back failed too/);
    assert.match(v.unconfirmed, /timed out/);
  });

  test('a terminal status is never believed over a probe error', () => {
    // Defensive: a caller that passed both must not get "already gone" out of it.
    assert.equal(cancel404Verdict('canceled', notFound()).alreadyGone, false);
  });

  test('THE THREE NON-PROOFS ARE TAGGED, because they are three different diagnoses', () => {
    // The failing input: the DELETE 404s and the follow-up GET throws a Stripe 500.
    // The single push body this used to feed asserted, as fact, that "Stripe has no
    // sub_B under this server's keys" and sent the operator to "the dashboard of the
    // account these keys belong to" — established by nothing at all. A transient 500
    // says nothing about which account holds sub_B, and the DELETE's own 404 in fact
    // makes "already cancelled in THIS account" the likeliest reading. Escalating is
    // right in all three cases; the wording and the outcome code are not the same, so
    // refuseDuplicateSubscription switches on this tag.
    assert.equal(cancel404Verdict(null, notFound()).reason, 'second_404');
    assert.equal(
      cancel404Verdict(null, new StripeError('Stripe returned 500', { status: 500 })).reason,
      'probe_failed',
    );
    assert.equal(cancel404Verdict('active', null).reason, 'still_alive');
    assert.equal(cancel404Verdict('canceled', null).reason, 'proved_gone');
    // A 404 recognised by code alone (no status on the error) is still the account one.
    assert.equal(cancel404Verdict(null, new StripeError('x', { code: 'resource_missing' })).reason, 'second_404');
  });

  test('the same list admin.js probes against — the two must stay in step', () => {
    // src/routes/admin.js's TERMINAL_SUBSCRIPTION_STATUSES is a second literal of
    // this list, read after the same kind of 404 in the vendor-delete pre-cancel.
    // If one gains a status and the other does not, one path treats a subscription
    // as dead that the other still pages about. Asserted here because the constant
    // itself is private to each module.
    assert.equal(cancel404Verdict('canceled').alreadyGone, true);
    assert.equal(cancel404Verdict('incomplete_expired').alreadyGone, true);
    assert.equal(cancel404Verdict('unpaid').alreadyGone, false);
  });
});

describe('isRetryableStripeError — what is worth three days of Stripe retries', () => {
  // The created/updated branch re-reads the subscription before writing a plan, so
  // every failure of that read has to be classified: rethrow (Stripe redelivers for
  // three days) or answer 200 and page the operator once. Getting the polarity
  // backwards is silent in both directions — a retry storm nobody sees, or an alert
  // for something that would have healed itself.
  const err = (over) => Object.assign(new StripeError('x', over), {});

  test('400 IS PERMANENT — the failing input the whitelist polarity was got wrong for', () => {
    // A STRIPE_API_VERSION the account will not accept (lib/stripe.js documents that
    // env var as the operator's knob) makes Stripe answer 400 "Invalid Stripe
    // version" to EVERY subscription read while every other call keeps working. The
    // old whitelist listed the PERMANENT codes, 400 matched none of them, so it
    // rethrew: three days of redeliveries for every subscription event in the
    // account, no vendor plan updated, and no alert at all.
    assert.equal(isRetryableStripeError(err({ status: 400, code: 'invalid_request_error' })), false);
    assert.equal(isRetryableStripeError(err({ status: 402, code: 'card_declined' })), false);
    assert.equal(isRetryableStripeError(err({ status: 410 })), false);
  });

  test('the configuration failures stay permanent', () => {
    assert.equal(isRetryableStripeError(err({ status: 0, code: 'not_configured' })), false);
    assert.equal(isRetryableStripeError(err({ status: 401 })), false);
    assert.equal(isRetryableStripeError(err({ status: 403 })), false);
    assert.equal(isRetryableStripeError(err({ status: 404, code: 'resource_missing' })), false);
  });

  test('A GENUINE TRANSIENT STILL RETRIES — the other half of the change', () => {
    // If this regressed, a five-second Stripe outage would permanently drop every
    // plan change that arrived during it: 200, marker kept, event consumed.
    assert.equal(isRetryableStripeError(err({ status: 0, code: 'network_error' })), true, 'timeout / DNS / TLS');
    assert.equal(isRetryableStripeError(err({ status: 429, code: 'rate_limit' })), true, 'rate limited');
    for (const status of [500, 502, 503, 504, 599]) {
      assert.equal(isRetryableStripeError(err({ status })), true, `${status} is Stripe, not us`);
    }
  });

  test('an error with no status at all is NOT retried', () => {
    // getSubscription's only throw path is StripeError (stripeRequest wraps even a
    // socket failure into code 'network_error'), so a bare Error here is a bug in
    // this process. Paging once beats retrying a TypeError for three days.
    assert.equal(isRetryableStripeError(new TypeError('sub.items is undefined')), false);
    assert.equal(isRetryableStripeError(undefined), false);
    assert.equal(isRetryableStripeError({}), false);
  });

  test('499 is permanent and 500 is not — the boundary is where it is written', () => {
    assert.equal(isRetryableStripeError(err({ status: 499 })), false);
    assert.equal(isRetryableStripeError(err({ status: 500 })), true);
  });
});

describe('cancelSubscription — the primitive an operator delete and the duplicate cleanup need', () => {
  test('exists and is async, so callers can await it', () => {
    // Shape only: exercising it means a network call. The contract other code is
    // written against is "one function, one subscription id, returns a promise" —
    // src/routes/stripe-webhook.js's duplicate handling and the vendor-delete
    // path both import it by this name.
    assert.equal(typeof cancelSubscription, 'function');
    assert.equal(cancelSubscription.constructor.name, 'AsyncFunction');
    assert.equal(cancelSubscription.length, 1);
  });
});

describe('isSubscriptionShape — the fence in front of subscriptionPatch', () => {
  // src/routes/stripe-webhook.js's readSubscriptionOrEscalate refuses a re-read that
  // is not a subscription instead of handing it on. The test below this one is why.
  test('an id AND a status are both required', () => {
    assert.equal(isSubscriptionShape({ id: 'sub_1', status: 'active' }), true);
    assert.equal(isSubscriptionShape({ id: 'sub_1', status: 'canceled' }), true);
    assert.equal(isSubscriptionShape(null), false);
    assert.equal(isSubscriptionShape(undefined), false);
    assert.equal(isSubscriptionShape({}), false);
    assert.equal(isSubscriptionShape({ id: 'sub_1' }), false, 'no status — nothing to decide from');
    assert.equal(isSubscriptionShape({ status: 'active' }), false, 'no id — nothing to track');
    // The shapes a gateway or WAF answering for Stripe in JSON produces.
    assert.equal(isSubscriptionShape({ error: 'blocked' }), false);
    assert.equal(isSubscriptionShape([]), false);
    assert.equal(isSubscriptionShape('sub_1'), false);
  });

  test('WHAT THE FENCE PREVENTS: a non-subscription churns a PAYING vendor', () => {
    // THE BLOCKING FAILING INPUT, as a pure assertion. A vendor on 'discovery' paying
    // on sub_A; the re-read comes back null (a 2xx whose body could not be parsed —
    // lib/stripe.js now throws for that, and this is the second fence) or `{}`. Fed to
    // subscriptionPatch, both read as "not paying, not terminal": plan 'freshman',
    // stripe_subscription_id / subscription_status / current_period_end all null, and
    // NO alert — the webhook would answer 200 and keep the replay marker, so nothing
    // retries and nobody is told. The vendor keeps being charged while the app shows
    // them as free, isDuplicateSubscription can no longer fire (the row's id is now
    // null) so they can buy a SECOND subscription, and it self-heals only at the next
    // update for sub_A — up to a year away on the annual plan.
    const paying = {
      id: 'v1', name: 'Cafe', plan: 'discovery',
      stripe_subscription_id: 'sub_A', subscription_status: 'active',
    };
    for (const notASubscription of [null, {}, { id: 'sub_A' }]) {
      const { patch, alert } = subscriptionPatch(notASubscription, paying, NOW);
      assert.equal(patch.plan, 'freshman', 'entitlement gone');
      assert.equal(patch.subscription_status, null);
      assert.equal(patch.current_period_end, null);
      assert.equal(alert, null, 'and it does not even alert — hence the fence, not a patch here');
      // ...and the fence is what stops that patch ever being computed.
      assert.equal(isSubscriptionShape(notASubscription), false);
    }
    // The two id-less shapes also null the id, which is how the row stops being able
    // to recognise a duplicate (isDuplicateSubscription needs it) — while a shape that
    // carries an id but no status is worse in the other direction: freshman, and the
    // id KEPT, so POST /api/vendor/checkout answers 409 ALREADY_SUBSCRIBED and the
    // vendor cannot even buy their way back.
    assert.equal(subscriptionPatch(null, paying, NOW).patch.stripe_subscription_id, null);
    assert.equal(subscriptionPatch({}, paying, NOW).patch.stripe_subscription_id, null);
    assert.equal(subscriptionPatch({ id: 'sub_A' }, paying, NOW).patch.stripe_subscription_id, 'sub_A');
  });
});

describe('stripeRequest — a 2xx whose body cannot be read is a FAILURE, not an empty answer', () => {
  // THE FAILING INPUT, at the source. Three real shapes answer 200 and then fail to
  // produce a body: AbortSignal.timeout(TIMEOUT_MS) firing while the body is still
  // streaming, the connection being reset mid-body, and an egress proxy or captive
  // gateway answering 200 with an HTML page. `res.ok` is true in all three and the
  // try/catch around res.json() swallows the parse error, so stripeRequest used to
  // RETURN null — not throw. What each caller then did with that null is in the
  // header of this file; the worst was getSubscription's, one branch away from
  // subscriptionPatch (see the isSubscriptionShape tests above).
  //
  // Driven against a stubbed global fetch. SECRET_KEY is captured at module load, so
  // this uses a SECOND instance of the module (a distinct specifier) loaded after the
  // env var is set — test/setup.js deliberately sets no Stripe key, and the other
  // tests in this file must go on seeing the unconfigured module.
  const loadWithKey = async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test_only';
    return import('../src/lib/stripe.js?stripe-request-body-tests');
  };
  const withFetch = async (impl, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  const json = (body, status = 200) => new Response(body, {
    status, headers: { 'content-type': 'application/json' },
  });

  test('a 200 with an HTML body THROWS, and as a transient', () => {
    // The egress-proxy case. 'network_error' is the load-bearing part: it is what
    // isRetryableStripeError classifies as retryable, so the webhook rethrows, drops
    // the replay marker and lets Stripe's redelivery settle it.
    return withFetch(
      async () => new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => {
        const { stripeRequest } = await loadWithKey();
        await assert.rejects(stripeRequest('GET', '/subscriptions/sub_A'), (err) => {
          assert.equal(err.name, 'StripeError');
          assert.equal(err.code, 'network_error');
          assert.equal(isRetryableStripeError(err), true, 'must be retried, not applied');
          return true;
        });
      },
    );
  });

  test('a 200 whose body dies mid-stream THROWS too', () => {
    // The aborted / reset body. The bytes that did arrive are a prefix of a
    // subscription, which is exactly why "parse it or give up" must not be "or null".
    const dying = () => new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"id":"sub_A","stat'));
        c.error(new Error('socket hang up'));
      },
    });
    return withFetch(
      async () => new Response(dying(), { status: 200, headers: { 'content-type': 'application/json' } }),
      async () => {
        const { stripeRequest } = await loadWithKey();
        await assert.rejects(stripeRequest('GET', '/subscriptions/sub_A'),
          (err) => err.name === 'StripeError' && err.code === 'network_error');
      },
    );
  });

  test('a real 2xx JSON body is returned unchanged — the regression guard', () => {
    return withFetch(
      async () => json('{"id":"sub_A","status":"active"}'),
      async () => {
        const { stripeRequest } = await loadWithKey();
        assert.deepEqual(await stripeRequest('GET', '/subscriptions/sub_A'),
          { id: 'sub_A', status: 'active' });
      },
    );
  });

  test('an EMPTY list is still an answer — this is not "the Price is missing" territory', () => {
    // getPriceByLookupKey's null must go on meaning "the operator has not created
    // this Price": Stripe answers a search that matches nothing with 200 and
    // `data: []`, which parses fine and must not throw. routes/vendor.js's 503
    // PRICE_UNAVAILABLE and its "create it in the dashboard" log depend on it.
    return withFetch(
      async () => json('{"object":"list","data":[]}'),
      async () => {
        const { getPriceByLookupKey } = await loadWithKey();
        assert.equal(await getPriceByLookupKey('discovery_monthly'), null);
      },
    );
  });

  test('a non-2xx still carries Stripe\'s own code, not the new one', () => {
    return withFetch(
      async () => json('{"error":{"message":"No such subscription","code":"resource_missing"}}', 404),
      async () => {
        const { stripeRequest } = await loadWithKey();
        await assert.rejects(stripeRequest('GET', '/subscriptions/sub_A'), (err) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, 'resource_missing');
          assert.equal(isRetryableStripeError(err), false, 'a 404 is a fact no retry changes');
          return true;
        });
      },
    );
  });

  test('a non-2xx with an unreadable body keeps the STATUS, which is the diagnosis', () => {
    // Order matters: the !res.ok check runs first, so a 500 behind a proxy that ate
    // the body is still a 500 (retryable) rather than the new network_error.
    return withFetch(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      async () => {
        const { stripeRequest } = await loadWithKey();
        await assert.rejects(stripeRequest('GET', '/subscriptions/sub_A'), (err) => {
          assert.equal(err.status, 502);
          assert.equal(isRetryableStripeError(err), true);
          return true;
        });
      },
    );
  });
});
