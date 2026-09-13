// Unit tests for the Stripe layer: the wire encoding, the signature scheme, the
// two API-version shapes, and the decision table that turns a subscription into
// a vendors-row patch (src/lib/stripe.js, src/routes/stripe-webhook.js).
//
// FOUR THINGS ARE BEING PROTECTED, and they fail in different directions:
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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  formEncode, lookupKeyFor, planFromLookupKey, statusIsPaying,
  readSubscription, invoiceSubscriptionId, verifyStripeSignature, INTERVALS,
} from '../src/lib/stripe.js';
import { subscriptionPatch } from '../src/routes/stripe-webhook.js';

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
});
