// Stripe, over raw HTTP. No SDK.
//
// WHY NO SDK. src/routes/webhooks.js already hand-rolls Svix HMAC verification
// rather than pulling in the svix package, and gemini-receipt.js / lib/jwt.js
// talk to Google and GoTrue the same way. The whole Stripe surface this app
// needs is six calls and one signature check, all of them documented and
// stable, against an SDK that would be the largest dependency in package.json.
//
// WHAT THIS MODULE IS AND IS NOT. It is the NETWORK layer plus the pure
// decisions that can be tested without one. It NEVER touches the database:
// deciding which vendor an event belongs to, and writing to the vendors row,
// belongs to the caller (src/routes/webhooks.js), because those are the parts
// with an ordering and an idempotency story and they need to be readable in
// one place. Everything exported here is either a fetch or a pure function.
//
// ---- The three traps, up front ----
//
// 1. THE WEBHOOK SECRET IS USED VERBATIM. Stripe HMACs with the whole
//    `whsec_...` string, prefix included, and hex-encodes the digest. Svix —
//    thirty lines away in webhooks.js — strips the identical-looking prefix,
//    base64-DECODES the rest, and base64-encodes the digest. Copying that
//    function and changing the header names produces something that verifies
//    nothing and rejects every real event. They are different schemes that
//    happen to share a prefix.
//
// 2. THE SIGNATURE COVERS THE EXACT BYTES. server.js mounts a raw parser on
//    /api/webhooks/stripe ABOVE the global express.json(). Re-serialising a
//    parsed body changes key order and whitespace, and it can then never
//    verify again. This is a mount-ORDER constraint, not a content-type one.
//
// 3. STRIPE MOVED `current_period_end`. It used to sit on the subscription;
//    in the 2025 API versions it lives on each subscription ITEM. The same
//    happened to `invoice.subscription`, which moved under
//    `invoice.parent.subscription_details`. Every read of those three fields
//    in this file checks both locations, because the account's API version is
//    set in a dashboard this code cannot see, and a silently-null renewal date
//    is exactly the kind of thing nobody notices until a vendor asks when they
//    are next charged.
//
// ---- Prices are resolved by lookup key, never by id ----
//
// `discovery_monthly`, `discovery_annual`, and later `goto_monthly` /
// `goto_annual`. Stripe Price objects are IMMUTABLE, so changing $29 to $34
// means creating a new Price — if the id lived in an env var, every price
// change would be a config edit and a restart on two Heroku apps. A lookup key
// can be moved from the old Price to the new one in the dashboard, and this
// code does not know it happened. That is the whole reason for the indirection
// and it should not be optimised away into a cached id.

import crypto from 'node:crypto';
import { createCache } from './cache.js';

const API_BASE = 'https://api.stripe.com/v1';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// DELIBERATELY UNSET BY DEFAULT. Sending no Stripe-Version means "use whatever
// this account is pinned to", which for a newly created account is the current
// one. Hardcoding a version string here would pin the integration to a release
// nobody on this project has read the changelog for, and the two shapes that
// actually differ between versions are already read defensively below. The env
// var exists so that if Stripe ever rolls the account forward in a way that
// breaks something, the fix is a config var rather than a deploy.
const API_VERSION = process.env.STRIPE_API_VERSION || '';

// Generous compared with gemini-receipt.js's 9s, because nothing is racing it:
// a vendor pressing "Upgrade" is waiting on one redirect, and the webhook
// handler is not on anyone's critical path. Still well inside Heroku's 30s H12.
const TIMEOUT_MS = Number(process.env.STRIPE_TIMEOUT_MS) || 12_000;

// Stripe's own default. A captured-and-replayed request is the only thing this
// bounds: forging a signature is not possible, so the timestamp exists purely
// so an old valid request cannot be sent again forever.
const TOLERANCE_SECONDS = 300;

/** Config gate. Without a key every billing route answers 503 rather than 500. */
export const stripeEnabled = Boolean(SECRET_KEY);

/** Whether the webhook can verify anything. Separate: one can be set without the other. */
export const stripeWebhookConfigured = Boolean(WEBHOOK_SECRET);

/**
 * 'test' | 'live' | null — read off the key prefix, for the boot line and for
 * /admin. Worth printing at startup: the failure this catches is a staging box
 * carrying live keys, which is silent, and which charges real cards.
 */
export function stripeMode() {
  if (!SECRET_KEY) return null;
  if (SECRET_KEY.startsWith('sk_live_') || SECRET_KEY.startsWith('rk_live_')) return 'live';
  if (SECRET_KEY.startsWith('sk_test_') || SECRET_KEY.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

/**
 * An error carrying Stripe's own classification, so a caller can tell "your
 * account has no such price" (operator misconfiguration, 500) from "that card
 * was declined" (the vendor's problem, shown to them).
 */
export class StripeError extends Error {
  constructor(message, { status, code, type, param, requestId } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status ?? 0;
    this.code = code ?? null;
    this.type = type ?? null;
    this.param = param ?? null;
    this.requestId = requestId ?? null;
  }
}

/**
 * Stripe's form encoding, which is not URLSearchParams' and not JSON's.
 *
 * Nested objects are `metadata[vendor_id]=x`; arrays are INDEXED,
 * `line_items[0][price]=x`. The bracket-only form (`items[]=`) also works for
 * scalars but not for arrays of objects, so everything is indexed uniformly
 * rather than having two rules.
 *
 * null and undefined are SKIPPED, not sent as the strings "null"/"undefined" —
 * which is what a bare template literal would do, and Stripe would store it.
 * `false` and `0` are sent: they are real values.
 *
 * Exported for test/stripe.test.js, which is the only way to cover this without
 * a network.
 */
export function formEncode(params, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item === null || item === undefined) return;
        if (typeof item === 'object') pairs.push(formEncode(item, `${name}[${i}]`));
        else pairs.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      pairs.push(formEncode(value, name));
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  // Nested calls can return '' for an object whose every value was null.
  return pairs.filter(Boolean).join('&');
}

/**
 * One request to the Stripe API.
 *
 * @param {string} method  'GET', 'POST', or the one 'DELETE' — cancelSubscription.
 *   Stripe's DELETE verbs take no parameters, so the empty body a DELETE sends
 *   here is deliberate rather than an oversight.
 * @param {string} path    e.g. '/checkout/sessions'
 * @param {object} params  form parameters (query string for GET)
 * @param {string} [idempotencyKey]  makes a retried POST return the FIRST
 *   result instead of creating a second object. Set it on anything that
 *   creates something a duplicate of which would be a real problem — see
 *   createCustomer, where two customers for one vendor would collide with
 *   migration-055's unique index and leave an orphan in the dashboard.
 * @throws {StripeError} on any non-2xx, timeout or network failure.
 */
async function stripeRequest(method, path, params = {}, { idempotencyKey } = {}) {
  if (!SECRET_KEY) {
    throw new StripeError('STRIPE_SECRET_KEY is not set', { status: 0, code: 'not_configured' });
  }

  const body = formEncode(params);
  const url = method === 'GET' && body ? `${API_BASE}${path}?${body}` : `${API_BASE}${path}`;

  const headers = {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Stripe-Version': API_VERSION || undefined,
    'Idempotency-Key': idempotencyKey || undefined,
    'Content-Type': method === 'GET' ? undefined : 'application/x-www-form-urlencoded',
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with TimeoutError; DNS/TLS/socket land here too.
    const reason = err?.name === 'TimeoutError' ? 'timed out' : `failed (${err?.message ?? err})`;
    throw new StripeError(`Stripe request ${reason}`, { status: 0, code: 'network_error' });
  }

  const requestId = res.headers.get('request-id');
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // A non-JSON body from Stripe means a proxy or an outage, never a real API
    // answer. Fall through to the status check with a null payload — and, for a
    // 2xx, to the throw below.
  }

  if (!res.ok) {
    const e = payload?.error ?? {};
    throw new StripeError(e.message || `Stripe returned ${res.status}`, {
      status: res.status,
      code: e.code ?? null,
      type: e.type ?? null,
      param: e.param ?? null,
      requestId,
    });
  }

  // ⚠ A 2xx WHOSE BODY WE COULD NOT READ IS A FAILURE, NOT AN EMPTY ANSWER, AND
  // EVERY CALLER HERE IS WRONG IF IT IS HANDED null. Three real shapes reach this
  // line: AbortSignal.timeout above fires while the body is still streaming (the
  // headers arrived inside TIMEOUT_MS, the body did not), the connection is reset
  // mid-body, or an egress proxy / captive gateway answers 200 with an HTML page.
  // In all three `res.ok` is true and the catch above has already swallowed the
  // parse error, so without this the function returns null and each caller invents
  // its own wrong meaning for it: getPriceByLookupKey reads it as "the operator
  // never created this Price" (a 503 and a log telling them to create a Price that
  // exists), createCustomer / createCheckoutSession / createBillingPortalSession
  // blow up on `.id` / `.url` with a TypeError, and — the reason this throw is here
  // rather than in each caller — getSubscription's null reached subscriptionPatch
  // in routes/stripe-webhook.js, which read it as a subscription with no status and
  // churned a PAYING vendor to freshman with every billing column nulled, answered
  // 200, and kept the replay marker.
  //
  // code 'network_error' is deliberate and is the load-bearing half: that is what
  // isRetryableStripeError (routes/stripe-webhook.js) classifies as TRANSIENT, so
  // the webhook rethrows, drops the replay marker and lets Stripe's redelivery
  // settle it — which is the right answer for a truncated or proxied body, none of
  // which says anything about the subscription itself. It is the same code the
  // fetch-rejection catch above uses, for the same reason: the request did not
  // complete.
  //
  // `=== null`, not a falsy test: `res.json()` can legitimately yield `false`, `0`
  // or `''` in general, and Stripe answers every one of these calls with a JSON
  // object (DELETE included — see cancelSubscription: it returns the cancelled
  // subscription, not a 204), so null here only ever means "parse failed".
  if (payload === null) {
    throw new StripeError(`Stripe answered ${res.status} with a body that could not be read as JSON`, {
      status: res.status,
      code: 'network_error',
      requestId,
    });
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Pure helpers — the plan/price mapping. No network, no database.
// ---------------------------------------------------------------------------

/** The two billing intervals that are sold. Annual is one month free ($319). */
export const INTERVALS = Object.freeze(['monthly', 'annual']);

/**
 * The lookup key for a plan at an interval: `discovery_monthly`.
 *
 * Returns null for anything not sellable through this endpoint. `freshman` is
 * free and has no Price at all, so asking for one is a bug rather than a
 * missing dashboard object — and this returning null is what makes the route
 * answer 400 instead of Stripe answering "no such price".
 */
export function lookupKeyFor(plan, interval) {
  if (plan !== 'discovery' && plan !== 'goto') return null;
  if (!INTERVALS.includes(interval)) return null;
  return `${plan}_${interval}`;
}

/**
 * Which plan a lookup key sells, or null if we do not recognise it.
 *
 * NULL IS NOT "FRESHMAN". A subscription whose price carries an unfamiliar
 * lookup key means the operator created a Price in the dashboard that this
 * deploy has never heard of — a new tier, a renamed key, a one-off negotiated
 * rate. Reading that as the free plan would DOWNGRADE a vendor who just paid,
 * which is the one direction this system is built never to move in silently.
 * The webhook leaves the plan alone and alerts the operator instead.
 */
export function planFromLookupKey(lookupKey) {
  const key = String(lookupKey ?? '');
  const [plan, interval] = key.split('_');
  if (!INTERVALS.includes(interval)) return null;
  return plan === 'discovery' || plan === 'goto' ? plan : null;
}

/**
 * Stripe subscription statuses that mean "this vendor is entitled to their
 * plan right now".
 *
 * `past_due` IS IN THIS LIST, and that is deliberate. Entitlement does not end
 * when a card fails — src/lib/plans.js's 30-day ladder is what ends it, from
 * the `past_due_since` stamp, so a vendor whose card failed this morning keeps
 * their deals while the operator's dunning emails go out. Removing past_due
 * here would cut them off the same day and make the whole ladder dead code.
 *
 * `unpaid` is not: Stripe only moves a subscription there after its own retry
 * schedule is exhausted, which is weeks later.
 *
 * ⚠ KNOWN GAP, NOT YET A DECISION: A PAUSED SUBSCRIPTION READS AS PAYING. Stripe
 * has two different ways to stop collecting money that are NOT the `paused`
 * status:
 *
 *   * `pause_collection` set on an otherwise live subscription — the status stays
 *     `active` (or `past_due`) and Stripe collects nothing. The Customer Portal
 *     offers this as "pause payments" when the operator enables it in the portal
 *     configuration, which is a dashboard toggle no deploy here controls — the
 *     same class of setting createCheckoutSession's docstring relies on for ACH.
 *   * a discount or credit balance covering the whole invoice, which is billed as
 *     $0 and is genuinely fine.
 *
 * readSubscription below does not read pause_collection and nothing in src/ or
 * public/ mentions it, so a vendor who pauses collection in the portal keeps
 * `active`, keeps statusIsPaying, and keeps their full Discovery entitlement —
 * deals, the 30-day stats, the raised reward-item cap — indefinitely, while Stripe
 * bills them nothing and no alert fires. This is PRE-EXISTING behaviour, not a
 * consequence of the subscription-lifecycle work in stripe-webhook.js, and it is
 * left alone deliberately: the two possible answers ("pausing is a courtesy we
 * grant" vs "a paused vendor drops to freshman until they resume") are a product
 * decision about what the operator has promised people, not a bug with one correct
 * repair. Whoever takes that decision: reading it is one line here
 * (`pauseCollection: sub?.pause_collection?.behavior ?? null` in readSubscription)
 * plus a test of it in subscriptionPatch (src/routes/stripe-webhook.js), and
 * checking whether "pause payments" is actually enabled in the portal
 * configuration tells you whether any vendor can reach the state at all today.
 */
const PAYING_STATUSES = Object.freeze(['active', 'trialing', 'past_due']);

/** Does this Stripe status entitle the vendor to their plan? */
export const statusIsPaying = (status) => PAYING_STATUSES.includes(String(status ?? ''));

/**
 * Read a subscription object into the four fields migration-055 stores.
 *
 * Pure, and the only place the two API-version shapes are reconciled. Returns
 * `plan: null` when the price's lookup key is unrecognised — see
 * planFromLookupKey for why that is not the same as 'freshman'.
 *
 * `pause_collection` is NOT among the fields it reads, and that is a KNOWN GAP
 * rather than a settled decision — see the note on PAYING_STATUSES above.
 *
 * @returns {{id, customer, status, plan, lookupKey, currentPeriodEnd, cancelAtPeriodEnd}}
 */
export function readSubscription(sub) {
  const item = sub?.items?.data?.[0] ?? null;
  const price = item?.price ?? null;
  const lookupKey = price?.lookup_key ?? null;

  // Pre-2025 versions put this on the subscription; current ones put it on the
  // item. Read both — see trap 3 in the header.
  const periodEnd = sub?.current_period_end ?? item?.current_period_end ?? null;

  return {
    id: sub?.id ?? null,
    // Expanded to an object when we asked for it, a bare id string otherwise.
    customer: typeof sub?.customer === 'object' ? sub?.customer?.id ?? null : sub?.customer ?? null,
    status: sub?.status ?? null,
    plan: planFromLookupKey(lookupKey),
    lookupKey,
    currentPeriodEnd: Number.isFinite(periodEnd) ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
  };
}

/**
 * The subscription id an invoice belongs to, or null for a one-off.
 *
 * Same two-shape problem as readSubscription: `invoice.subscription` moved to
 * `invoice.parent.subscription_details.subscription`. A null here is how the
 * webhook knows to ignore an invoice that has nothing to do with a plan.
 */
export function invoiceSubscriptionId(invoice) {
  const direct = invoice?.subscription;
  const nested = invoice?.parent?.subscription_details?.subscription;
  const value = direct ?? nested ?? null;
  return typeof value === 'object' ? value?.id ?? null : value;
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * The header is `t=<unix>,v1=<hex>[,v1=<hex>]`, and the signed payload is
 * `${t}.${raw}`. Multiple v1 entries appear while a secret is being rotated,
 * so ANY match passes.
 *
 * ⚠ THE SECRET IS THE WHOLE `whsec_...` STRING. No prefix stripping, no base64
 * decode, and the digest is hex. verifySvix() in routes/webhooks.js does the
 * exact opposite with an identical-looking secret. See trap 1 in the header.
 *
 * The freshness check is ONE-SIDED — too old is rejected, too far in the future
 * is not — which is Stripe's own semantics and differs from verifySvix's
 * symmetric window on purpose. Only a captured request can be replayed, and a
 * captured request is always in the past; rejecting future timestamps would
 * turn a few seconds of clock skew on our side into every event failing.
 *
 * @param {string} raw     the exact bytes that were signed
 * @param {string} header  req.headers['stripe-signature']
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyStripeSignature(raw, header, secret = WEBHOOK_SECRET, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (!header) return { ok: false, reason: 'missing_header' };

  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const scheme = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (scheme === 't') timestamp = value;
    else if (scheme === 'v1') signatures.push(value);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: 'malformed_header' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'malformed_header' };
  if (now / 1000 - sentAt > TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`, 'utf8')
    .digest();

  for (const candidate of signatures) {
    let got;
    try {
      got = Buffer.from(candidate, 'hex');
    } catch {
      continue;
    }
    // Length-guard first: timingSafeEqual THROWS on a size mismatch rather than
    // returning false, so a truncated signature would crash the handler and
    // become a 500 that Stripe retries forever.
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

// ---------------------------------------------------------------------------
// The six API calls
// ---------------------------------------------------------------------------

/**
 * The active Price carrying this lookup key, or null if the operator has not
 * created it yet.
 *
 * NULL MEANS ABSENT, NEVER "THE READ FAILED". Stripe answers a search that matches
 * nothing with 200 and `data: []`, which is what produces the null here — while a
 * read that did not complete now THROWS out of stripeRequest (see the unreadable-2xx
 * throw there), instead of arriving as the same null. That distinction is what
 * routes/vendor.js's POST /checkout depends on: its 503 PRICE_UNAVAILABLE and its
 * "create it in the dashboard" log are only true for a Price that really is missing.
 *
 * `active: true` is part of the query, so archiving the old $29 Price and
 * moving its lookup key to a new one is a two-click operation in the dashboard
 * with no deploy. Returns the whole Price so the caller can show the amount.
 */
export async function getPriceByLookupKey(lookupKey) {
  const out = await stripeRequest('GET', '/prices', {
    lookup_keys: [lookupKey],
    active: 'true',
    limit: 1,
    expand: ['data.product'],
  });
  return out?.data?.[0] ?? null;
}

/**
 * Create a Customer for a vendor.
 *
 * IDEMPOTENT ON THE VENDOR ID, forever. Two terminals in one shop pressing
 * Upgrade at the same second is a real scenario — one account can be signed in
 * on the till and the owner's phone — and without this key that is two Customer
 * objects, two subscriptions, and a unique-index violation on
 * vendors.stripe_customer_id that leaves one of them orphaned and billing.
 * Stripe keeps idempotency keys for 24 hours, which covers the double-click
 * case; the vendors row covers it after that, since the caller only reaches
 * here when stripe_customer_id is null.
 */
export async function createCustomer({ vendorId, email, name }) {
  return stripeRequest('POST', '/customers', {
    email: email || null,
    name: name || null,
    // Stripe's dashboard search reads metadata, so this is how the operator
    // answers "which shop is cus_123?" without opening the app.
    metadata: { vendor_id: vendorId },
  }, { idempotencyKey: `vendor-customer-${vendorId}` });
}

/**
 * The `expires_at` a new Checkout Session gets: 31 minutes out, rounded UP.
 *
 * ⚠ THIS MUST NOT SIT ON STRIPE'S 30-MINUTE FLOOR. Stripe refuses an expires_at
 * less than 30 minutes ahead with a 400 "Invalid expires_at", and it compares
 * against the instant the API RECEIVES the request, not the instant we computed
 * the number — so form-encoding, the TLS handshake, the round trip and any clock
 * skew between this dyno and Stripe all come out of the budget.
 *
 * The version this replaces was `Math.floor(Date.now() / 1000) + 1800`, which
 * had NEGATIVE margin: the floor throws away up to 999ms before the request even
 * leaves, so the moment the fraction of the current second plus the latency
 * crossed 1.0, Stripe stamped its own `created` a second later and saw a 1799s
 * window. That is a 400 → StripeError (stripeRequest above) → next(err) in
 * routes/vendor.js's checkout handler, which has no fallback → a 500 on POST
 * /api/vendor/checkout, the ONLY self-serve upgrade path in the app, on roughly
 * the fraction of attempts equal to the latency in seconds.
 *
 * Math.ceil never lands behind `now`, so ceil(now / 1000) + 1860 guarantees at
 * least 1860s of real window: ~60s of slack over the floor, far more than any
 * plausible latency plus skew, and nowhere near the 24-hour ceiling.
 *
 * Exported and pure so test/stripe.test.js can assert that margin without a
 * network call. Nothing else should need to call it — it sits here, in the API
 * section rather than with the pure helpers above, because its only caller is the
 * next function and the two must be read together.
 */
export function checkoutExpiresAt(now = Date.now()) {
  return Math.ceil(now / 1000) + 1860;
}

/**
 * A Checkout Session for one vendor buying one plan.
 *
 * NO `payment_method_types`. Omitting it hands the choice to the account's
 * automatic-payment-methods setting, which is where ACH gets enabled — the
 * decision sheet says card by default with ACH also on, and that is a dashboard
 * toggle the operator can flip without a deploy. Naming the methods here would
 * override that setting and quietly turn ACH back off.
 *
 * `client_reference_id` carries the vendor id through the redirect, and the
 * subscription metadata carries it onto every later subscription and invoice
 * event — the webhook needs an answer to "which vendor?" for events that
 * arrive months after this session is gone.
 *
 * ⚠ THE SESSION EXPIRES IN HALF AN HOUR, AND THAT IS A CORRECTNESS FIX, NOT
 * TIDINESS. Stripe's default is 24 hours, and nothing here reserves the right
 * to buy: POST /api/vendor/checkout refuses a SECOND session only while
 * vendors.stripe_subscription_id is set, which stays null until a session is
 * actually completed. So a vendor who opened Checkout, wandered off, and tapped
 * Upgrade again tomorrow could hold two live sessions, and completing both
 * creates two real subscriptions. migration-055 stores exactly ONE subscription
 * id, so the second completion overwrites the first (subscriptionPatch) and the
 * older subscription then exists nowhere in this app while billing $29 a month
 * forever — and the webhook's superseded guard correctly ignores its eventual
 * cancellation, because as far as the row is concerned it was never ours.
 * THIRTY-ONE MINUTES, NOT THIRTY. Stripe requires expires_at between 30 minutes
 * and 24 hours from now, and it measures that against the instant IT receives
 * the request — so a value sitting exactly on the 30-minute floor has already
 * lost the race by the time it is form-encoded. checkoutExpiresAt() above owns
 * that arithmetic and explains it. Thirty-one minutes is still far more than a
 * card entry needs, and still shrinks the window rather than closing it — which
 * is why stripe-webhook.js ALSO refuses to overwrite a still-paying subscription
 * with a different one and cancels the duplicate instead.
 */
export async function createCheckoutSession({
  customerId, priceId, vendorId, successUrl, cancelUrl, trialDays = null,
}) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: vendorId,
    // Seconds since the epoch, Stripe's unit for every timestamp. See the note
    // above for why this is not left at the 24-hour default, and
    // checkoutExpiresAt for why it is 31 minutes rather than exactly 30.
    expires_at: checkoutExpiresAt(),
    // Vendors are sold by hand over the phone; a founding-rate or first-month
    // code is the obvious next ask and costs nothing to allow now.
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { vendor_id: vendorId },
      trial_period_days: trialDays,
    },
    // Collected once, here, so the operator has it for the PA sales-tax
    // registration without chasing sixteen people for an address.
    billing_address_collection: 'auto',
  });
}

/**
 * A Customer Portal session: change card, download invoices, cancel.
 *
 * Stripe hosts every one of those screens. Building them here would mean
 * handling card data, dunning copy and proration in an app that has no reason
 * to know what any of those are.
 */
export async function createBillingPortalSession({ customerId, returnUrl }) {
  return stripeRequest('POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

/**
 * The published Discovery prices, shaped for the terminal's SETTINGS card.
 *
 * CACHED, because this is read on every open of the Settings tab and the answer
 * changes when the operator edits a Price in the dashboard — which is roughly
 * never. The stale window matters more than the TTL: if Stripe is unreachable
 * the loader throws and cache.js serves the last known prices rather than
 * blanking the card, so a Stripe outage costs a vendor nothing.
 *
 * A missing Price is `null`, not an error. Before the operator has created
 * them — which is the state this repo is in today — the card says "contact us"
 * instead of offering a button that would 500.
 */
// Exported so the price a vendor is quoted can be flushed the moment the
// operator changes one in the dashboard, rather than five minutes later.
// NOT added to cache.js's `allCaches` — that would mean cache.js importing this
// module, which imports cache.js.
export const priceCache = createCache({ name: 'stripe-prices', ttlMs: 300_000, staleMs: 3_600_000 });

const priceView = (price) => (price ? {
  priceId: price.id,
  lookupKey: price.lookup_key ?? null,
  amountCents: price.unit_amount ?? null,
  currency: price.currency ?? 'usd',
  interval: price.recurring?.interval ?? null,
  intervalCount: price.recurring?.interval_count ?? 1,
} : null);

export async function publishedPrices(plan = 'discovery') {
  return priceCache.get(plan, async () => {
    const keys = INTERVALS.map((i) => lookupKeyFor(plan, i)).filter(Boolean);
    const found = await Promise.all(keys.map((k) => getPriceByLookupKey(k)));
    return Object.fromEntries(INTERVALS.map((interval, i) => [interval, priceView(found[i])]));
  });
}

/** One subscription, with its price expanded so readSubscription can see the lookup key. */
export async function getSubscription(subscriptionId) {
  return stripeRequest('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    expand: ['items.data.price'],
  });
}

/**
 * End a subscription NOW, and return the updated subscription object.
 *
 * ⚠ DELETE ON A SUBSCRIPTION MEANS "CANCEL IMMEDIATELY" in Stripe's API — the
 * object is not removed, it comes back with status 'canceled'. The other way to
 * cancel is POST with `cancel_at_period_end: true`, which keeps the vendor
 * entitled until the date they have already paid through. Both callers here want
 * the immediate form and neither wants the polite one:
 *
 *   * the duplicate-subscription cleanup in routes/stripe-webhook.js — the
 *     vendor never meant to buy a second plan, so leaving it running to the end
 *     of a period they never agreed to bills them twice for a month; and
 *   * deleting a vendor from /admin, where the shop is gone and nobody will be
 *     around to notice a charge that keeps landing.
 *
 * Cancelling is itself idempotent-ish: a second DELETE for an already-cancelled
 * subscription answers 404, which arrives here as a StripeError with status 404
 * and code 'resource_missing'.
 *
 * ⚠ BUT THAT 404 IS AMBIGUOUS, AND A CALLER MUST NOT READ IT AS SUCCESS ON ITS
 * OWN. Stripe answers the identical 404 `resource_missing` for a subscription that
 * exists but not under the key this process holds — another account after a
 * STRIPE_SECRET_KEY rotation, or the other livemode (an sk_test_ key on a box whose
 * vendors were signed up live, the failure stripeMode() is printed at boot to
 * catch). In that state the card IS still being charged. The only way to tell the
 * two apart is a follow-up getSubscription: cancelling does not REMOVE the object,
 * so a genuinely cancelled subscription still reads back 200 with a terminal status
 * ('canceled' / 'incomplete_expired'), while one outside this key's reach 404s
 * again. Both callers do exactly that — cancel404Verdict in
 * routes/stripe-webhook.js, and the pre-delete probe in routes/admin.js — and each
 * escalates to the operator when the read cannot prove the thing is finished.
 *
 * ⚠ AND A 2xx WHOSE BODY IS UNREADABLE NOW THROWS — carrying the HTTP status it
 * actually saw (a 200, normally) with code `network_error`, NOT status 0; the code is
 * the load-bearing half, because that is what isRetryableStripeError reads (see
 * stripeRequest) — even though it means the cancel very likely WORKED. Neither caller
 * uses the returned object, so the only effect is that both treat it as "the cancel
 * failed": refuseDuplicateSubscription in routes/stripe-webhook.js pages the operator
 * about a duplicate that is probably already dead, and routes/admin.js refuses the
 * vendor delete with VENDOR_BILLING_CANCEL_FAILED. That is the safe direction of the
 * mistake — one extra push, and a delete the operator can simply retry (the second
 * DELETE 404s, and the probe then proves it) — and it is not worth a per-caller
 * exception to the rule that an unread response is not an answer.
 */
export async function cancelSubscription(subscriptionId) {
  return stripeRequest('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/** Exported for tests that need to drive an arbitrary call through the same plumbing. */
export { stripeRequest };
