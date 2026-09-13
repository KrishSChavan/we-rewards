// Stripe, over raw HTTP. No SDK.
//
// WHY NO SDK. src/routes/webhooks.js already hand-rolls Svix HMAC verification
// rather than pulling in the svix package, and gemini-receipt.js / lib/jwt.js
// talk to Google and GoTrue the same way. The whole Stripe surface this app
// needs is five calls and one signature check, all of them documented and
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
 * @param {string} method  'GET' or 'POST' — this integration never DELETEs
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
    // answer. Fall through to the status check with a null payload.
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
// The five API calls
// ---------------------------------------------------------------------------

/**
 * The active Price carrying this lookup key, or null if the operator has not
 * created it yet.
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

/** Exported for tests that need to drive an arbitrary call through the same plumbing. */
export { stripeRequest };
