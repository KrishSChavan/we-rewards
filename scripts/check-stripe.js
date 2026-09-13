// Verify the Stripe configuration against the live API before trusting money to
// it.
//
//   npm run check:stripe
//
// Worth running for the same reason check-resend.js and check-gemini.js are:
// the failures here are INVISIBLE, and two of them cost real money.
//
//   • No key at all → the Upgrade button answers 503. Loud, and fine.
//   • A key but no webhook secret → a vendor pays, is charged, and NOTHING
//     writes their plan. They stay on Freshman. No error is raised anywhere,
//     and the first anyone hears of it is a support call.
//   • A key but no Price under `discovery_monthly` → the Upgrade button 503s
//     for a reason that is in the server log and nowhere a vendor can see.
//   • LIVE keys on a staging box → real cards, charged, for test purchases.
//
// This script makes no writes. It reads the account, the prices and the webhook
// endpoints, so it is safe to run against live mode.

import 'dotenv/config';
import {
  stripeEnabled, stripeWebhookConfigured, stripeMode,
  getPriceByLookupKey, lookupKeyFor, INTERVALS, stripeRequest, StripeError,
} from '../src/lib/stripe.js';

let failed = false;

const fail = (msg, hint) => { failed = true; console.error(`\n  FAIL  ${msg}`); if (hint) console.error(`        ${hint}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg, hint) => { console.log(`  warn  ${msg}`); if (hint) console.log(`        ${hint}`); };

const money = (cents, currency) =>
  `${(cents / 100).toLocaleString('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() })}`;

// The six the handler acts on. Anything else subscribed is noise; anything
// MISSING is a silent hole — src/routes/stripe-webhook.js is the only writer of
// vendors.plan, so an unsubscribed event is a state change that never lands.
const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

console.log('\nStripe configuration\n');

// ---- 1. the keys ----
if (!stripeEnabled) {
  fail('STRIPE_SECRET_KEY is not set — billing is off entirely.',
    'Create a Stripe account (test mode needs no company, no EIN and no bank account), '
    + 'then Developers → API keys → Secret key.');
  console.log('\nNothing else can be checked without a key.\n');
  process.exit(1);
}

const mode = stripeMode();
if (mode === 'unknown') {
  warn('STRIPE_SECRET_KEY does not look like an sk_/rk_ key.', 'Check it was copied whole.');
} else {
  ok(`secret key present (${mode} mode)`);
}
if (mode === 'live') {
  warn('These are LIVE keys. Real cards will be charged.',
    'Only correct on production. Staging and a laptop should both carry sk_test_ keys.');
}

// ---- 2. does the key actually work, and whose account is it ----
let account = null;
try {
  account = await stripeRequest('GET', '/account', {});
  const name = account?.settings?.dashboard?.display_name || account?.business_profile?.name || account?.id;
  ok(`key works — account ${name} (${account?.id})`);
  if (account?.charges_enabled === false) {
    warn('This account cannot accept charges yet.',
      mode === 'live'
        ? 'Finish Stripe onboarding (entity, EIN, bank account) before selling.'
        : 'Normal in test mode for a brand-new account; test cards still work.');
  }
} catch (err) {
  if (err instanceof StripeError && err.status === 401) {
    fail('Stripe rejected the key (401).', 'It was revoked, or it belongs to a different account. Re-copy it.');
  } else {
    fail(`Could not reach Stripe: ${err?.message ?? err}`);
  }
}

// ---- 3. the webhook secret ----
//
// Checked separately from the endpoint list below, because they fail
// differently: no secret means every event is REFUSED, and a missing endpoint
// means none is ever SENT. Both leave a paying vendor on the free plan.
if (!stripeWebhookConfigured) {
  fail('STRIPE_WEBHOOK_SECRET is not set — every incoming event will be refused.',
    'A vendor can pay and their plan will never be written. Developers → Webhooks → your endpoint → Signing secret.');
} else if (!String(process.env.STRIPE_WEBHOOK_SECRET).startsWith('whsec_')) {
  warn('STRIPE_WEBHOOK_SECRET does not start with whsec_.',
    'It is used verbatim, prefix included — unlike RESEND_WEBHOOK_SECRET, which is base64 after the prefix.');
} else {
  ok('webhook signing secret present');
}

// ---- 4. the prices, by lookup key ----
//
// Resolved by lookup key rather than id everywhere in the app, so that a price
// change is a dashboard move rather than a deploy. That only works if the keys
// are actually attached to an ACTIVE price.
console.log('');
for (const interval of INTERVALS) {
  const key = lookupKeyFor('discovery', interval);
  try {
    const price = await getPriceByLookupKey(key);
    if (!price) {
      fail(`no active price with lookup key "${key}"`,
        `Create a recurring price on the Discovery product and set its lookup key to "${key}". `
        + 'Until then the Upgrade button answers 503.');
      continue;
    }
    const r = price.recurring ?? {};
    const cadence = r.interval_count > 1 ? `every ${r.interval_count} ${r.interval}s` : `per ${r.interval}`;
    ok(`${key} → ${money(price.unit_amount, price.currency)} ${cadence}`);

    // The decided prices: $29/month, $319/year (one month free). A mismatch is
    // not an error — the operator may have changed them deliberately — but it
    // is worth saying out loud, because it is also what a fat-fingered amount
    // looks like, and Prices are immutable so the fix is a new one.
    const expected = interval === 'monthly' ? 2900 : 31900;
    if (price.unit_amount !== expected) {
      warn(`  ...that is not the ${money(expected, 'usd')} in mds/payment.md.`,
        'Fine if intentional. Stripe prices are immutable, so changing one means a NEW price with the same lookup key.');
    }
    if (r.interval !== (interval === 'monthly' ? 'month' : 'year')) {
      fail(`  ...but its billing interval is "${r.interval}", not ${interval === 'monthly' ? 'month' : 'year'}.`,
        'The lookup key is what the app trusts. A yearly price under discovery_monthly bills a vendor once a year.');
    }
  } catch (err) {
    fail(`could not look up "${key}": ${err?.message ?? err}`);
  }
}

// ---- 5. the webhook endpoint ----
console.log('');
try {
  const list = await stripeRequest('GET', '/webhook_endpoints', { limit: 100 });
  const endpoints = (list?.data ?? []).filter((e) => String(e.url).endsWith('/api/webhooks/stripe'));

  if (!endpoints.length) {
    fail('no webhook endpoint points at /api/webhooks/stripe',
      'Developers → Webhooks → Add endpoint, URL https://<your host>/api/webhooks/stripe. '
      + 'Without it a vendor pays and their plan is never written.');
  }

  for (const e of endpoints) {
    const enabled = e.enabled_events ?? [];
    const all = enabled.includes('*');
    const missing = all ? [] : REQUIRED_EVENTS.filter((t) => !enabled.includes(t));
    const extra = all ? [] : enabled.filter((t) => !REQUIRED_EVENTS.includes(t));

    if (e.status !== 'enabled') {
      fail(`${e.url} is ${e.status}`,
        'Stripe disables an endpoint after enough failed deliveries. Re-enable it and check why they failed.');
    } else if (missing.length) {
      fail(`${e.url} is not subscribed to: ${missing.join(', ')}`,
        'Each missing event is a state change that will never reach the app.');
    } else {
      ok(`${e.url} — all six events subscribed`);
    }
    if (extra.length) {
      warn(`${e.url} also sends ${extra.length} event type(s) the handler ignores.`,
        'Harmless (they are acknowledged and dropped), but they make the delivery log harder to read.');
    }
  }
} catch (err) {
  fail(`could not list webhook endpoints: ${err?.message ?? err}`);
}

// ---- 6. the Customer Portal ----
//
// A configuration has to exist or createBillingPortalSession throws
// `resource_missing` — which surfaces as a 500 on the Manage billing button,
// with a message only the server log carries.
console.log('');
try {
  const list = await stripeRequest('GET', '/billing_portal/configurations', { limit: 10 });
  const active = (list?.data ?? []).filter((c) => c.active);
  if (!active.length) {
    fail('no active Customer Portal configuration',
      'Settings → Billing → Customer portal, then save once. Without it "Manage billing" 500s.');
  } else {
    const def = active.find((c) => c.is_default) ?? active[0];
    const f = def.features ?? {};
    ok('Customer Portal is configured');
    if (!f.payment_method_update?.enabled) {
      fail('  ...but updating the payment method is switched off.',
        'That is the entire point of the portal here: it is where a vendor whose card failed fixes it.');
    }
    if (!f.invoice_history?.enabled) {
      warn('  ...invoice history is off.', 'Vendors will ask you for receipts by hand.');
    }
    if (!f.subscription_cancel?.enabled) {
      warn('  ...self-serve cancellation is off.', 'Cancellations become an email to you.');
    }
  }
} catch (err) {
  fail(`could not read the portal configuration: ${err?.message ?? err}`);
}

// ---- 7. payment methods ----
//
// The decision sheet says card by default with ACH also enabled. The app
// deliberately does NOT name payment_method_types on the Checkout Session, so
// this is entirely a dashboard setting — which means it is worth reporting,
// because nothing in the code would ever reveal it.
console.log('');
if (account) {
  const domestic = account?.settings?.payments?.statement_descriptor;
  if (!domestic && mode === 'live') {
    warn('No statement descriptor set.',
      'This is the text on a vendor\'s card statement. Blank means they see something unrecognisable and dispute it.');
  }
  console.log('  note  Payment methods (card, ACH) come from the account\'s automatic payment methods');
  console.log('        setting, not from this code — Settings → Payments → Payment methods. ACH for');
  console.log('        subscriptions must be switched on there or Checkout will only offer cards.');
}

console.log(failed ? '\nSomething above needs fixing before selling a plan.\n' : '\nStripe is ready.\n');
process.exit(failed ? 1 : 0);
