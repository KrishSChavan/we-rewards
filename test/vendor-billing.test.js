// The SETTINGS billing card's data contract (GET /api/vendor/billing in
// src/routes/vendor.js), plus two things about that file the type system cannot
// hold us to.
//
// WHY THIS FILE EXISTS. The card used to decide between "Upgrade" and "Manage
// billing" from ONE flag, hasBilling, which is Boolean(stripe_customer_id) — and
// there are three states, not two. customer.subscription.deleted in
// routes/stripe-webhook.js deliberately KEEPS the customer id while nulling the
// subscription id (invoice history stays in one place, and a vendor who comes
// back reuses the same Customer), so a churned vendor answered hasBilling=true,
// the card hid both Upgrade buttons, and Stripe's Customer Portal cannot START a
// subscription. POST /checkout would have taken them — its 409 keys on the
// subscription id — but no button on any screen reached it, so cancelling was a
// one-way door. The three assertions below are that door, from the inside.
//
// HOW IT CALLS THE ROUTE. server.js is not importable from a test (it clears
// .build/ at import), and the real gates in front of this handler read Supabase.
// So it reaches into the router's own stack for the LAST handle registered on
// GET /billing — the route function itself — and calls it with a synthetic req.
// That is the whole point: the vendors row goes in, the JSON the terminal parses
// comes out, and nothing in between is mocked. The route is safe to call this
// way because with Stripe unconfigured it makes no outbound request at all (see
// the `useStripe` guard on both halves of its Promise.all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vendorRouter from '../src/routes/vendor.js';
import { stripeEnabled } from '../src/lib/stripe.js';
import { pointsFor } from '../src/lib/rewards.js';

// A developer with real Stripe keys exported would make the handler call
// publishedPrices() for real, which is a network round trip in a unit test. Skip
// rather than fail, the same bargain test/setup.js strikes for the DB-backed
// suites — CI has no keys, so these run there.
const needsStripeOff = stripeEnabled
  ? 'STRIPE_SECRET_KEY is set in this environment; /billing would call Stripe for real'
  : false;

const billingHandler = (() => {
  const layer = vendorRouter.stack.find((l) => l.route?.path === '/billing' && l.route.methods.get);
  assert.ok(layer, 'GET /billing is no longer registered on the vendor router');
  // [requirePin, the route]. Taking the last handle rather than index 1 means
  // adding another gate in front does not silently make this test exercise the
  // gate instead of the route.
  return layer.route.stack.at(-1).handle;
})();

/** One vendors row → the JSON body GET /api/vendor/billing answers with. */
async function billingFor(vendor) {
  let body;
  const res = {
    json(payload) { body = payload; return res; },
    status() { throw new Error('the happy path must not set a status'); },
  };
  await billingHandler(
    // req.user is the LOGIN, not the shop — present here so that a future read
    // of it cannot be blamed on the fixture being thin.
    { vendor, user: { id: 'user-1', email: 'owner@shop.test' }, headers: {} },
    res,
    (err) => { throw err ?? new Error('next() called with no error'); },
  );
  assert.ok(body, 'the route answered without a JSON body');
  return body;
}

// The three rows, written the way the system actually writes them.
const NEVER_MET = {
  id: 'v-never', name: 'New Spot', plan: 'freshman',
  stripe_customer_id: null, stripe_subscription_id: null,
  subscription_status: null, current_period_end: null, past_due_since: null,
};
const SUBSCRIBED = {
  id: 'v-live', name: 'Paying Spot', plan: 'discovery',
  stripe_customer_id: 'cus_live', stripe_subscription_id: 'sub_live',
  subscription_status: 'active', current_period_end: '2026-10-12T00:00:00.000Z',
  past_due_since: null,
};
// Exactly the patch customer.subscription.deleted applies (routes/stripe-webhook.js):
// plan back to freshman, subscription id and period end nulled, status canceled,
// customer id KEPT.
const CHURNED = {
  id: 'v-churned', name: 'Lapsed Spot', plan: 'freshman',
  stripe_customer_id: 'cus_live', stripe_subscription_id: null,
  subscription_status: 'canceled', current_period_end: null, past_due_since: null,
};

/* ---------- the three states the card has to tell apart ---------- */

test('a vendor Stripe has never met has neither a Customer nor a subscription', { skip: needsStripeOff }, async () => {
  const body = await billingFor(NEVER_MET);
  assert.equal(body.hasBilling, false);
  assert.equal(body.hasSubscription, false);
});

test('a paying vendor has both', { skip: needsStripeOff }, async () => {
  const body = await billingFor(SUBSCRIBED);
  assert.equal(body.hasBilling, true);
  assert.equal(body.hasSubscription, true);
});

test('a CHURNED vendor is distinguishable: known to Stripe, subscribed to nothing', { skip: needsStripeOff }, async () => {
  // The regression. hasBilling alone said "true" here and "true" for the paying
  // vendor above, so the card could not offer Upgrade to the one vendor who
  // needs it — and the portal it offered instead has no way to start a plan.
  const body = await billingFor(CHURNED);
  assert.equal(body.hasBilling, true, 'the customer id is kept on purpose, so this stays true');
  assert.equal(body.hasSubscription, false, 'this is the flag that makes Upgrade reachable again');

  const live = await billingFor(SUBSCRIBED);
  assert.notEqual(
    body.hasSubscription, live.hasSubscription,
    'a churned vendor and a paying vendor must not answer identically',
  );
});

test('hasBilling still means exactly "there is a Customer to open the portal for"', { skip: needsStripeOff }, async () => {
  // public/vendor/terminal.js reads BOTH flags, and it still gates the Manage
  // billing button on this one — a subscription id is not what the portal needs.
  const body = await billingFor({ ...NEVER_MET, stripe_customer_id: 'cus_only' });
  assert.equal(body.hasBilling, true);
  assert.equal(body.hasSubscription, false);
});

test('neither Stripe id is in the response', { skip: needsStripeOff }, async () => {
  // They are account identifiers and the card has no use for them; the flags
  // exist so the ids never have to leave the server.
  const serialised = JSON.stringify(await billingFor(SUBSCRIBED));
  assert.ok(!serialised.includes('cus_live'), 'the customer id must not be sent');
  assert.ok(!serialised.includes('sub_live'), 'the subscription id must not be sent');
});

test('the rest of the card is unchanged by the new flag', { skip: needsStripeOff }, async () => {
  const body = await billingFor(CHURNED);
  assert.equal(body.plan, 'freshman');
  assert.equal(body.subscriptionStatus, 'canceled');
  assert.equal(body.currentPeriodEnd, null);
  assert.equal(body.grandfathered, false);
  // Stripe unconfigured, so neither round trip happened: no prices to show, and
  // "we could not ask" for the cancellation flag, which the terminal must read
  // as "not cancelling".
  assert.equal(body.prices, null);
  assert.equal(body.cancelAtPeriodEnd, null);
  assert.equal(body.billingAvailable, false);
});

/* ---------- two properties of the SOURCE ----------

   Both of these live inside handlers that cannot be called from a unit test:
   POST /checkout needs Stripe configured (it 503s before reaching the line in
   question), and POST /award needs the award_points RPC. Asserting the source
   text is weaker than asserting behaviour and it is chosen with that known —
   the alternative is no test at all on two one-line fixes that are invisible
   when they regress. test/logo.test.js exists because the same "keep in sync"
   comments drifted unnoticed. */

const SOURCE = readFileSync(fileURLToPath(new URL('../src/routes/vendor.js', import.meta.url)), 'utf8');

test('the award path floors integer cents, not a binary float product', () => {
  // 1.16 * 25 === 28.999999999999996, so the old form paid 28 points where the
  // rate on the receipt promises 29 — hundreds of cent amounts per ratio, and
  // never at the default 10, which is why nobody reported it.
  assert.equal(pointsFor(1.16, 25), 29);
  assert.equal(Math.floor(1.16 * 25), 28, 'the bug this replaced, kept here so the reason is legible');

  assert.match(SOURCE, /const basePoints = pointsFor\(dollarAmount, ratio\)/);
  assert.doesNotMatch(
    SOURCE, /Math\.floor\(\s*dollarAmount\s*\*\s*ratio\s*\)/,
    'the naive float product must not come back',
  );
});

test('an operator-driven checkout never stamps the operator on the vendor Customer', () => {
  // requirePin returns next() immediately for req.terminalAdmin (see
  // middleware/auth.js), so the operator reaches POST /checkout by design —
  // operator-run upgrades are a real flow. But req.user is then the
  // TERMINAL_ADMIN account, createCustomer is idempotent on the vendor id
  // forever, and nothing ever updates a Customer's email: one operator-run
  // upgrade would send that shop's invoices and dunning mail to the operator's
  // inbox permanently. null lets Checkout collect the payer's own address.
  assert.match(SOURCE, /email: req\.terminalAdmin \? null : \(req\.user\?\.email \?\? null\)/);
});
