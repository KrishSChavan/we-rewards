// Stripe billing events: POST /api/webhooks/stripe.
//
// This is the ONLY thing that writes a vendor's plan or subscription state.
// Checkout does not (a session that is paid for is not a subscription yet), and
// /admin does not (the operator edits `grandfathered`, never `plan`). One
// writer is what makes "why is this vendor on freshman?" a question with an
// answer.
//
// ---- The six events, and nothing else ----
//
//   checkout.session.completed      a vendor finished paying → attach the
//                                   Customer + Subscription to their row
//   customer.subscription.created   \  the authoritative plan + status + renewal
//   customer.subscription.updated   /  date. Upgrades, downgrades, cancellations
//                                      scheduled for period end, card recovery.
//   customer.subscription.deleted   the subscription is gone → back to freshman
//   invoice.paid                    a payment landed → they are not past due
//   invoice.payment_failed          a payment bounced → stamp the day it started
//
// Every other event type is acknowledged with a 200 and dropped. Stripe sends
// dozens; subscribing to more than these six means more to keep correct with
// no more information.
//
// ---- Idempotency: the insert IS the guard ----
//
// Stripe retries until it sees a 2xx and does NOT promise exactly-once
// delivery, so the same event id can arrive twice. migration-055's
// stripe_events table has `id` as its primary key: the handler inserts FIRST,
// and a unique violation means "another delivery of this already ran" → 200,
// do nothing.
//
// ⚠ AND THE ROW IS DELETED IF THE HANDLER THEN FAILS. Insert-first alone has a
// hole: if the write to `vendors` throws after the marker is in, the event is
// recorded as processed when it was not, and Stripe's retry — the thing that
// exists to fix exactly this — gets deduped away. A vendor's card recovers and
// their plan never comes back, silently, with a row in stripe_events claiming
// it was handled. So a failure removes the marker on the way out and answers
// 500 so Stripe tries again.
//
// ---- Why a grandfathered vendor is a red flag, not a no-op ----
//
// The sixteen founding vendors have no Stripe objects at all (migration-055's
// header, and payment.md). An event that resolves to one of them means either
// a customer id was attached to the wrong row or somebody was charged who was
// promised free access for life. Both are worth waking the operator for, and
// neither is worth writing to the database over — so it alerts and stops.

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { notifyAdmins } from '../lib/push.js';
import {
  verifyStripeSignature, readSubscription, statusIsPaying,
  getSubscription, invoiceSubscriptionId,
} from '../lib/stripe.js';

const router = Router();

/** Postgres unique-violation. The whole replay guard turns on recognising it. */
const UNIQUE_VIOLATION = '23505';

const HANDLED = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** `cus_...` / `sub_...` fields arrive as a bare id or an expanded object. */
const idOf = (value) => (typeof value === 'object' ? value?.id ?? null : value ?? null);

/**
 * Which vendor an event is about.
 *
 * THREE ROUTES IN, IN ORDER OF TRUST:
 *   1. `client_reference_id` — set by us on the Checkout Session, and the only
 *      link that exists before a customer id has ever been stored.
 *   2. `metadata.vendor_id` — set by us on the subscription, so it rides along
 *      on every subscription event for the life of the account.
 *   3. the Stripe customer id, matched against the vendors row.
 *
 * Metadata is preferred over the customer id because a customer id can be
 * reassigned by hand in the dashboard and metadata cannot be reached by
 * accident. Returns null when nothing matches, which is a 200-and-log: an event
 * for a Customer this app has never heard of is someone else's, or a test
 * fixture, and retrying it forever would achieve nothing.
 */
async function resolveVendor(object) {
  const direct = object?.client_reference_id || object?.metadata?.vendor_id || null;
  if (direct) {
    const { data, error } = await supabaseAdmin
      .from('vendors').select('*').eq('id', direct).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const customerId = idOf(object?.customer);
  if (!customerId) return null;

  const { data, error } = await supabaseAdmin
    .from('vendors').select('*').eq('stripe_customer_id', customerId).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Write a patch onto one vendor row. Nothing else in this file touches the table. */
async function patchVendor(vendorId, patch) {
  const { error } = await supabaseAdmin.from('vendors').update(patch).eq('id', vendorId);
  if (error) throw error;
}

/**
 * Turn a subscription object into the vendors-row patch it implies.
 *
 * Pure and exported, because this is the decision table worth testing and none
 * of it needs a database. `alert` is a message for the operator, or null.
 *
 * THE PLAN ONLY MOVES WHEN STRIPE IS UNAMBIGUOUS:
 *
 *   paying + known lookup key   → that plan
 *   paying + UNKNOWN lookup key → plan untouched, operator alerted. A Price
 *       created in the dashboard that this deploy has never heard of is a new
 *       tier or a negotiated rate, and reading it as 'freshman' would downgrade
 *       somebody the moment they paid more.
 *   not paying                  → freshman, and past_due_since cleared. They no
 *       longer owe anything; the ladder in plans.js has nothing left to measure.
 *
 * `plan_since` moves only on a real change, so "on Discovery since March" does
 * not reset every time Stripe sends a routine renewal update.
 */
export function subscriptionPatch(sub, vendor, now = Date.now()) {
  const s = readSubscription(sub);
  const nowIso = new Date(now).toISOString();

  const patch = {
    stripe_subscription_id: s.id,
    subscription_status: s.status,
    current_period_end: s.currentPeriodEnd,
  };
  let alert = null;

  if (!statusIsPaying(s.status)) {
    if (vendor?.plan !== 'freshman') patch.plan_since = nowIso;
    patch.plan = 'freshman';
    patch.past_due_since = null;
    return { patch, alert };
  }

  if (s.plan) {
    if (vendor?.plan !== s.plan) patch.plan_since = nowIso;
    patch.plan = s.plan;
  } else {
    alert = `Subscription ${s.id} has an unrecognised price (${s.lookupKey ?? 'no lookup key'}). `
          + `${vendor?.name ?? 'The vendor'} was left on ${vendor?.plan ?? 'freshman'}.`;
  }

  // SAFETY NET, not the primary path. past_due_since is stamped by
  // invoice.payment_failed below, which is the event that knows a payment
  // actually bounced. But a webhook delivery can be lost while an endpoint is
  // misconfigured, and a vendor sitting in `past_due` with no stamp would be
  // billed as fully entitled forever — the ladder measures from the stamp, so
  // no stamp means no day count and no degrade, ever.
  if (s.status === 'past_due' && !vendor?.past_due_since) patch.past_due_since = nowIso;
  // The mirror of it, for a recovery whose invoice.paid never arrived.
  if (s.status === 'active' && vendor?.past_due_since) patch.past_due_since = null;

  return { patch, alert };
}

/**
 * Apply a subscription to its vendor. Shared by checkout.session.completed
 * (which fetches the subscription) and the three subscription events (which
 * carry it), so both paths produce identical rows.
 */
async function applySubscription(sub, vendor) {
  const { patch, alert } = subscriptionPatch(sub, vendor);
  await patchVendor(vendor.id, patch);
  if (alert) {
    console.warn(`[stripe] ${alert}`);
    await notifyAdmins({ title: 'Stripe: unrecognised price', body: alert, url: '/admin' });
  }
  return patch;
}

/**
 * Handle one verified event. Throws to signal "retry me" — the caller removes
 * the replay marker and answers 500.
 */
async function handleEvent(event) {
  const object = event?.data?.object ?? {};
  const vendor = await resolveVendor(object);

  if (!vendor) {
    // Not an error. An event for a Customer no vendor row claims is one the
    // operator created by hand, or a leftover from a deleted test vendor.
    console.warn(`[stripe] ${event.type} (${event.id}) matched no vendor — ignoring`);
    return { ignored: 'no_vendor' };
  }

  if (vendor.grandfathered) {
    const msg = `Stripe sent ${event.type} for ${vendor.name}, who is free for life. `
              + 'Nothing was changed. Check whether a customer id is attached to the wrong vendor.';
    console.warn(`[stripe] ${msg}`);
    await notifyAdmins({ title: 'Stripe event for a free-for-life vendor', body: msg, url: '/admin' });
    return { ignored: 'grandfathered' };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // A completed session is not a subscription. It names one, and the
      // subscription is the authoritative object — so attach the ids, then read
      // the real thing. Doing it here rather than waiting for
      // customer.subscription.created means the vendor's plan is live by the
      // time the browser finishes following the success_url redirect, which is
      // the difference between "Upgraded" and a terminal that still says
      // Freshman when they land back on it.
      if (object.mode && object.mode !== 'subscription') return { ignored: 'not_subscription' };

      const customerId = idOf(object.customer);
      const subscriptionId = idOf(object.subscription);
      if (customerId) await patchVendor(vendor.id, { stripe_customer_id: customerId });
      if (!subscriptionId) return { ignored: 'no_subscription_on_session' };

      const sub = await getSubscription(subscriptionId);
      await applySubscription(sub, { ...vendor, stripe_customer_id: customerId ?? vendor.stripe_customer_id });
      return { applied: 'checkout' };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      // The customer id may not be on the row yet if this beat the checkout
      // event in — Stripe does not order deliveries.
      const customerId = idOf(object.customer);
      if (customerId && vendor.stripe_customer_id !== customerId) {
        await patchVendor(vendor.id, { stripe_customer_id: customerId });
      }
      await applySubscription(object, vendor);
      return { applied: event.type };
    }

    case 'customer.subscription.deleted': {
      // Only if it is THE subscription we track. A vendor who cancelled and
      // resubscribed can have a deletion for the old one arrive after the new
      // one is live, and acting on it would cancel a subscription they are
      // paying for right now.
      const goneId = idOf(object.id);
      if (vendor.stripe_subscription_id && goneId && vendor.stripe_subscription_id !== goneId) {
        return { ignored: 'superseded_subscription' };
      }
      await patchVendor(vendor.id, {
        plan: 'freshman',
        plan_since: new Date().toISOString(),
        stripe_subscription_id: null,
        subscription_status: 'canceled',
        current_period_end: null,
        past_due_since: null,
      });
      // The customer id is KEPT. It is how the portal reaches their invoices,
      // and how a vendor who comes back gets the same Customer instead of a
      // second one.
      return { applied: 'canceled' };
    }

    case 'invoice.paid': {
      if (!invoiceSubscriptionId(object)) return { ignored: 'not_subscription_invoice' };
      // Clearing an already-null column is a no-op write, so this does not
      // need to read first.
      await patchVendor(vendor.id, { past_due_since: null });
      return { applied: 'paid' };
    }

    case 'invoice.payment_failed': {
      if (!invoiceSubscriptionId(object)) return { ignored: 'not_subscription_invoice' };

      // FIRST failure only. The stamp is the start of the clock that plans.js
      // and vendor_billing_overview both measure from; re-stamping on Stripe's
      // second and third retry would walk the vendor's day count back to zero
      // each time and they would never reach the 30-day degrade at all.
      const alreadyLate = Boolean(vendor.past_due_since);
      if (!alreadyLate) {
        await patchVendor(vendor.id, { past_due_since: new Date().toISOString() });
      }

      // The operator asked to be told. Every retry notifies, not just the
      // first: the useful fact is "this is still failing on day 12", and the
      // day count is what they act on.
      const days = alreadyLate
        ? Math.max(0, Math.floor((Date.now() - new Date(vendor.past_due_since).getTime()) / 86_400_000))
        : 0;
      const body = alreadyLate
        ? `${vendor.name}'s payment is still failing — ${days} day${days === 1 ? '' : 's'} overdue.`
        : `${vendor.name}'s payment failed. Their card needs updating.`;
      console.warn(`[stripe] payment failed for ${vendor.name} (${vendor.id}), ${days}d`);
      await notifyAdmins({ title: 'Payment failed', body, url: '/admin' });
      return { applied: 'payment_failed' };
    }

    default:
      return { ignored: 'unhandled_type' };
  }
}

/** POST /api/webhooks/stripe — mounted with a raw body parser (see server.js). */
router.post('/stripe', async (req, res, next) => {
  let marked = null;
  try {
    // req.body is a Buffer here, not an object: the signature covers the exact
    // bytes Stripe sent. See trap 2 in lib/stripe.js.
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    const check = verifyStripeSignature(raw, req.headers['stripe-signature']);
    if (!check.ok) {
      if (check.reason === 'unconfigured') {
        console.warn('[stripe] webhook received but STRIPE_WEBHOOK_SECRET is unset — ignoring');
      } else {
        console.warn(`[stripe] webhook rejected: ${check.reason}`);
      }
      // 400, which Stripe does not retry. An unverifiable request should never
      // be retried — it is either an attacker or a secret mismatch, and neither
      // is fixed by sending it again.
      return res.status(400).json({ error: 'BAD_SIGNATURE' });
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'BAD_JSON' });
    }
    if (!event?.id || !event?.type) return res.status(400).json({ error: 'BAD_EVENT' });

    // Unhandled types never reach the table. Recording them would fill it with
    // rows for events nothing acts on, and the table's only job is deduplication.
    if (!HANDLED.includes(event.type)) return res.json({ ok: true, ignored: 'unhandled_type' });

    // ---- the replay guard ----
    const { error: insertErr } = await supabaseAdmin
      .from('stripe_events')
      .insert({ id: event.id, type: event.type });

    if (insertErr) {
      if (insertErr.code === UNIQUE_VIOLATION) {
        // Already processed. 200 so Stripe stops retrying.
        return res.json({ ok: true, duplicate: true });
      }
      throw insertErr;
    }
    marked = event.id;

    const outcome = await handleEvent(event);
    res.json({ ok: true, ...outcome });
  } catch (err) {
    // The marker must not outlive a failed handler — see the header. Deleting
    // it is best-effort: if THIS fails too the event is stuck, which is worth a
    // loud log because no retry will ever un-stick it.
    if (marked) {
      const { error } = await supabaseAdmin.from('stripe_events').delete().eq('id', marked);
      if (error) {
        console.error(`[stripe] event ${marked} failed AND its replay marker could not be removed — `
                    + `Stripe's retries will be deduped away. Delete it by hand from stripe_events.`);
      }
    }
    next(err);
  }
});

export default router;
