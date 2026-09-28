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
// ---- Events are stale, unordered, and about a subscription that may not be
//      ours any more ----
//
// Two consequences run through every subscription branch below and neither is
// optional:
//
//   * THE EVENT PAYLOAD IS A SNAPSHOT, NOT THE PRESENT. Combined with three days
//     of retries and no ordering guarantee, a delivery that says `active` can
//     arrive after that subscription was cancelled. So every branch that writes
//     a plan re-reads the subscription from the API first and applies THAT.
//   * A VENDOR'S ROW HOLDS EXACTLY ONE SUBSCRIPTION ID (migration-055), so an
//     event about a DIFFERENT subscription is never allowed to quietly take the
//     row over. Either it is a superseded object and is ignored, or it is a real
//     second live subscription — a vendor billed twice — which is cancelled and
//     escalated to the operator rather than swapped in.
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
  getSubscription, cancelSubscription, invoiceSubscriptionId,
  // Thrown by the not-a-subscription fence in readSubscriptionOrEscalate below, so
  // that fence's failure is classified by isRetryableStripeError exactly like every
  // other failure of the same read instead of escaping as a bare Error.
  StripeError,
  // For the operator's push when a subscription cannot be seen at all: "these
  // keys are test mode" is usually the whole diagnosis, and /admin shows the same
  // string. routes/admin.js's vendor-delete refusal names it for the same reason.
  stripeMode,
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

/**
 * Statuses a subscription never comes back from. Stripe will send no further
 * event for one of these, ever — they are the end of that object's life, and
 * that is the entire membership test.
 *
 * This is NOT the complement of PAYING_STATUSES, and each not-paying status kept
 * OUT of it is kept out because Stripe's own semantics say the object is still
 * alive:
 *
 *   * `past_due` — Stripe is still working through its retry schedule on the
 *     card. Fixing the card in the portal puts the SAME subscription back to
 *     `active`.
 *   * `unpaid` — where Stripe parks a subscription once those retries are
 *     exhausted, if the account is configured to mark it unpaid rather than
 *     cancel it. Stripe's own description: the subscription REMAINS IN PLACE,
 *     the latest invoice stays open, invoices go on being generated, payments
 *     simply are not attempted any more. Paying that open invoice moves it back
 *     to `active` and Stripe sends customer.subscription.updated to say so. So
 *     there is a way out, and it runs through the Customer Portal the row's
 *     kept customer id opens.
 *   * `paused` — a trial that ended with no payment method on file
 *     (trial_settings.end_behavior). The subscription is intact and resumes once
 *     a payment method is attached; nothing has bounced and nothing is owed.
 *
 * All three go on being the subscription this vendor's row tracks, which is why
 * the not-paying branch of subscriptionPatch keeps both the id and any
 * past_due_since stamp for them — src/lib/plans.js measures the dunning ladder
 * from that stamp. Only the genuinely dead ones release the id.
 *
 * ⚠ THIS LIST IS DUPLICATED, deliberately and for now, as
 * TERMINAL_SUBSCRIPTION_STATUSES in src/routes/admin.js. Both copies answer the
 * same question — "did a GET prove this subscription is finished?" — and both are
 * read right after a DELETE answered 404 (refuseDuplicateSubscription below; the
 * vendor-delete pre-cancel there). THEY MUST STAY IN STEP: a status added to one
 * and not the other makes one path treat a subscription as dead that the other
 * still pages the operator about. Hoisting them into one export in
 * src/lib/stripe.js, beside PAYING_STATUSES, is the right follow-up — it is left
 * to a change that can touch routes/admin.js as well as this file.
 */
const TERMINAL_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);

/**
 * What a 404 from cancelSubscription ACTUALLY means, once the follow-up read has
 * answered. Pure and exported, like subscriptionPatch, because it is a decision
 * table whose two wrong answers are both expensive and neither is visible in
 * production: believe the 404 too readily and a vendor is billed twice in silence,
 * doubt it always and the operator is paged about subscriptions that are already
 * dead until they stop reading the alerts.
 *
 * Stripe answers the same 404 `resource_missing` to a DELETE whether the
 * subscription is cancelled or merely outside this key's account/livemode, so only
 * a GET can separate them: cancelling does not remove the object, so a cancelled
 * subscription still reads back with a TERMINAL_STATUSES status, while one this key
 * cannot reach 404s again. Anything that is not that proof — a second 404, a read
 * that threw for any other reason, or a read that comes back with a status still
 * alive — means "assume it is live", because that is the half of the mistake that
 * costs the vendor money.
 *
 * ⚠ AND THE THREE WAYS OF NOT BEING PROOF ARE NOT THE SAME DIAGNOSIS, which is why
 * `reason` exists alongside the human string. They were once folded into one push
 * body that asserted, in every case, that "Stripe has no <id> under this server's
 * keys" and sent the operator to "the dashboard of the account these keys belong
 * to". For a probe that merely FAILED — Stripe 500, a timeout — that assertion is
 * established by nothing at all: the DELETE's own 404 in fact makes "already
 * cancelled in THIS account" the likeliest reading, and pointing a human at a
 * different account's dashboard is worse than telling them nothing. Escalating is
 * still right in all three; only the wording and the outcome code differ. See the
 * push bodies in refuseDuplicateSubscription, which switch on this field.
 *
 * @param {string|null} status    the status the probe GET returned, or null
 * @param {unknown} [probeErr]    the error the probe GET threw, or null
 * @returns {{alreadyGone: boolean, unconfirmed: string|null,
 *   reason: 'proved_gone'|'second_404'|'probe_failed'|'still_alive'}} `unconfirmed`
 *   is the reason phrased for the operator's push, and is null exactly when
 *   alreadyGone; `reason` is the same verdict as a tag, for picking that push body.
 */
export function cancel404Verdict(status, probeErr = null) {
  if (!probeErr && TERMINAL_STATUSES.includes(String(status))) {
    return { alreadyGone: true, unconfirmed: null, reason: 'proved_gone' };
  }
  // A 404 on the probe too is the ONE outcome that is evidence about WHICH account
  // holds the subscription (it is not in this one); any other throw is evidence
  // about nothing but the probe.
  const reason = probeErr
    ? ((probeErr?.status === 404 || probeErr?.code === 'resource_missing') ? 'second_404' : 'probe_failed')
    : 'still_alive';
  const unconfirmed = {
    second_404: 'a second 404: it is not in this Stripe account or mode',
    probe_failed: `reading it back failed too (${probeErr?.message ?? probeErr})`,
    still_alive: `it reads back as '${status}', which is not a finished subscription`,
  }[reason];
  return { alreadyGone: false, unconfirmed, reason };
}

/**
 * Is a failed Stripe read worth Stripe's three days of webhook retries?
 *
 * ⚠ THE WHITELIST IS ON THE RETRYABLE SIDE, AND THAT POLARITY IS THE POINT. Only
 * three things can be fixed by trying again:
 *   * `network_error` — status 0, a timeout or DNS/TLS/socket failure.
 *     stripeRequest in src/lib/stripe.js wraps every fetch rejection into that
 *     code, so this covers all of them;
 *   * 429 — Stripe rate-limiting us; and
 *   * any 5xx — Stripe itself being briefly unwell.
 *
 * EVERYTHING ELSE IS A FACT NO RETRY CHANGES and must page a human instead:
 * 'not_configured' (no key at all), 401/403 (invalid, revoked, or not permitted to
 * read subscriptions), 404 / resource_missing (this key's account and mode have no
 * such subscription, or it is genuinely gone) — and, the reason this is written as
 * a retryable-whitelist rather than a permanent-one, 400. A 400 is the most common
 * permanent answer of the lot: a STRIPE_API_VERSION the account will not accept
 * (lib/stripe.js documents that env var as the operator's knob for rolling the
 * account forward) or a rejected `expand` breaks EVERY subscription read in the app
 * with one while every other Stripe call keeps working. Listing the permanent codes
 * instead left 400 falling through as "transient", which rethrew, which is exactly
 * the three-day silent retry storm with no alert that the caller exists to prevent.
 *
 * An error with no status at all is NOT retryable either: getSubscription's only
 * throw path is StripeError, so a bare Error here is a bug in this process, and
 * paging once beats retrying a TypeError for three days.
 */
export function isRetryableStripeError(err) {
  return err?.code === 'network_error'
    || err?.status === 429
    || Number(err?.status) >= 500;
}

/**
 * Is this value actually a subscription, rather than something that merely came back
 * from a request for one?
 *
 * Pure and exported for the same reason subscriptionPatch and cancel404Verdict are:
 * it is a decision whose wrong answer is invisible in production and expensive. An id
 * and a status are the two fields every branch downstream depends on — the id is what
 * the row tracks and what the superseded guards compare, and subscriptionPatch keys
 * EVERYTHING off the status, so a value without one reads to it as "not paying, not
 * terminal" and churns a paying vendor to freshman with every billing column nulled.
 * test/stripe.test.js pins both halves of that: what this refuses, and what
 * subscriptionPatch would do if it were let through.
 *
 * It is a shape test, not a validation: a real Stripe subscription always has both,
 * so anything here that lacks one was produced by something other than Stripe.
 */
export const isSubscriptionShape = (sub) => Boolean(sub?.id && sub?.status);

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
 *   not paying, TERMINAL        → freshman, and the debt cleared along with the
 *       subscription: there is nothing left for plans.js's ladder to measure
 *       against, and a stamp left behind would keep a churned vendor on the
 *       operator's 30-day degrade / 45-day suspend list for ever.
 *   not paying, STILL THEIRS    → freshman, and past_due_since is NOT cleared
 *       (`unpaid`, `paused`, `incomplete` — see TERMINAL_STATUSES for why none of
 *       them is the end of the object's life). The row goes on tracking that
 *       subscription, so the ladder must go on measuring it: an existing stamp is
 *       left exactly as it is, and `unpaid` with no stamp at all GETS one, for the
 *       reason the branch itself sets out. Clearing the stamp here is what made
 *       `unpaid` a silent dead end: daysPastDue (src/lib/plans.js) went null,
 *       vendor_billing_overview reported billing_state 'ok' for somebody weeks in
 *       arrears, they vanished from the /admin trouble list, and
 *       public/vendor/terminal.js drew no past-due banner — on a screen that also
 *       hides both Upgrade buttons, because a non-terminal status keeps the id.
 *       Nobody was told and nobody could act.
 *
 * `plan_since` moves only on a real change, so "on Discovery since March" does
 * not reset every time Stripe sends a routine renewal update.
 *
 * AND A TERMINAL STATUS RELEASES THE SUBSCRIPTION ID *AND* THE PERIOD END. A row
 * left pointing at a dead `sub_...` is not merely untidy: POST /api/vendor/checkout
 * answers 409 ALREADY_SUBSCRIBED whenever stripe_subscription_id is set
 * (routes/vendor.js), so a vendor whose subscription Stripe has finished with
 * could never buy another one — and since Stripe emits nothing further for a dead
 * subscription, nothing would ever clear it. The deleted branch below already
 * nulls BOTH columns for the cancellation path; this covers the other way the
 * same state arrives, which is a 'canceled' or 'incomplete_expired' subscription
 * read back off the API by the created/updated branch. See the release itself for
 * what a leftover current_period_end does to the terminal.
 *
 * "CHURNED" MEANS ONE THING IN EVERY COLUMN A READER KEYS OFF: this branch and
 * the customer.subscription.deleted branch both write stripe_subscription_id
 * null, current_period_end null, plan 'freshman' and past_due_since null.
 *
 * TWO fields deliberately differ, and both are diagnostics rather than part of that
 * shape — nothing branches on either for a churned row:
 *
 *   * subscription_status — deleted writes 'canceled' because that is what happened,
 *     while this branch records whichever terminal status Stripe reported, so an
 *     'incomplete_expired' row still says "the first invoice was never paid" instead
 *     of "they cancelled". (public/vendor/terminal.js compares it to 'canceled' only
 *     inside its `hasBilling && subscribed` branch, which the id-and-period-end
 *     release above makes unreachable here, and /admin forwards the string without
 *     rendering it.)
 *   * plan_since — this branch moves it only on a REAL change (the
 *     `vendor?.plan !== 'freshman'` guard at the top of the not-paying branch), so a
 *     vendor ALREADY on freshman keeps the date their plan actually changed on. The
 *     deleted branch stamps it unconditionally, because for a cancellation "freshman
 *     since the day they cancelled" is the answer the operator is looking for and
 *     that branch has no subscription object to reason from. The two therefore
 *     disagree on exactly one row: a vendor an earlier non-paying update had already
 *     dropped to freshman while the subscription lived on, who is then cancelled —
 *     this path preserves the earlier, more accurate date, the deleted path bumps it
 *     to now. It is surfaced (migration-055 exposes v.plan_since in
 *     vendor_billing_overview) but only to a human reading the overview; no
 *     entitlement, ladder or screen keys off it. Making the deleted branch use the
 *     same guard is the tidier follow-up and is NOT taken here: it would change a
 *     write on the deploy's only billing path for a cosmetic date, and the claim this
 *     paragraph replaced — that subscription_status was the ONLY difference — was
 *     itself the defect.
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
    // Dead for good → let go of the id, so /checkout will sell them a new plan,
    // and let go of the debt with it: nothing can be collected against a
    // subscription that no longer exists, and a stamp left on a churned row would
    // sit in the operator's dunning list until somebody edited Supabase by hand.
    if (TERMINAL_STATUSES.includes(String(s.status ?? ''))) {
      patch.stripe_subscription_id = null;
      patch.past_due_since = null;
      // AND THE RENEWAL DATE WITH IT, so this row matches the one the
      // customer.subscription.deleted branch writes in every column a reader
      // keys off — the docstring above names the two fields (subscription_status and
      // plan_since) that deliberately differ, and why nothing branches on either.
      // Nulling only the id
      // invented a THIRD row shape — churned, but still carrying a date —
      // which breaks the invariant public/vendor/terminal.js states outright:
      // "the row only carries a current_period_end while a subscription is
      // live". A terminal bundle older than the two-boolean billing change
      // falls back to `subscribed = hasSubscription ?? Boolean(currentPeriodEnd)`,
      // so a leftover date reads as STILL SUBSCRIBED: both Upgrade buttons
      // hidden, only "Manage billing" offered — exactly the churned dead end
      // that change existed to remove. And it is permanent, because Stripe
      // emits nothing further about a dead subscription, so nothing re-clears
      // it. test/vendor-billing.test.js encodes the same shape (churned = both
      // columns null).
      patch.current_period_end = null;
    } else if (s.status === 'unpaid' && !vendor?.past_due_since) {
      // THE SAME SAFETY NET THE past_due BRANCH BELOW HAS, for the state that
      // needs it more. `unpaid` is where Stripe puts a subscription once its own
      // retry schedule is exhausted, so money is definitely owed — but every
      // invoice.payment_failed delivery that would have stamped the debt can have
      // been lost while an endpoint was misconfigured, and Stripe attempts no
      // further payments on an unpaid subscription, so no later event stamps it
      // either. With no stamp, daysPastDue (src/lib/plans.js) is null,
      // vendor_billing_overview reports billing_state 'ok', the vendor is absent
      // from the /admin trouble list and the terminal draws no past-due banner —
      // while the kept id hides both Upgrade buttons. Nobody is told and nobody
      // can act. Stamping now starts the count late, which understates the debt,
      // but "at least this long" is the honest floor and it is what puts them back
      // in front of the operator.
      patch.past_due_since = nowIso;
    }
    // Any OTHER not-paying status leaves past_due_since exactly as it stands —
    // see the decision table above. It is still this subscription's debt, and the
    // ladder is still measuring it.
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
 * Apply a subscription to its vendor. Shared by checkout.session.completed and
 * by customer.subscription.created/updated, so both paths produce identical
 * rows.
 *
 * BOTH CALLERS HAND IN A FRESHLY FETCHED SUBSCRIPTION, never the object off the
 * event. The subscription events do carry one, but it is a snapshot from when
 * the event was created and Stripe retries for three days — see the
 * created/updated branch for what trusting that snapshot cost.
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
 * Is this a SECOND live subscription for a vendor who is already paying for one?
 *
 * migration-055 stores exactly one subscription id per vendor, so whichever
 * subscription is applied last owns the row and the other one disappears from
 * this app entirely — no billing screen shows it, no cancellation reaches it
 * (the deleted branch's superseded guard correctly ignores an id the row does
 * not track), and it keeps charging the vendor's card every month until somebody
 * opens the Stripe dashboard and notices. Stripe's own Checkout does not prevent
 * it: two sessions opened before either was completed are both valid, which is
 * why lib/stripe.js now expires sessions in half an hour (checkoutExpiresAt)
 * and why this exists for the case that still slips through.
 *
 * Three conditions, all required:
 *   * the row already tracks a subscription — otherwise this is the vendor's
 *     first one and there is nothing to protect;
 *   * the incoming id is a different one — the same id arriving again is
 *     ordinary traffic, not a duplicate; and
 *   * the tracked one is still PAYING. If it has lapsed or been cancelled, the
 *     new subscription is the vendor deliberately buying again and must win.
 */
function isDuplicateSubscription(vendor, incomingId) {
  return Boolean(
    incomingId
    && vendor.stripe_subscription_id
    && vendor.stripe_subscription_id !== incomingId
    && statusIsPaying(vendor.subscription_status),
  );
}

/**
 * Refuse a duplicate: cancel the one that just arrived, leave the row pointing
 * at the subscription the vendor is actually paying for, and wake a human.
 *
 * The incoming one is cancelled rather than the tracked one because the tracked
 * one is the plan the vendor has been receiving service on — its period end and
 * its dunning state are what plans.js has been measuring, and the app's own
 * screens have been showing it. Cancelling immediately (lib/stripe.js
 * cancelSubscription) rather than at period end is the point: a plan nobody
 * asked for should not bill for a month first.
 *
 * ⚠ A STRIPE FAILURE HERE MUST NOT THROW. Throwing would delete the replay
 * marker and answer 500, and Stripe would redeliver the same event for three
 * days. So the cancel is best-effort, and when it REALLY failed the operator is
 * notified; that notification is the part that must not be skipped, because a
 * duplicate we could not cancel is a card being charged twice until someone
 * intervenes by hand.
 *
 * ⚠ AND A 404 FROM THE CANCEL IS ONLY SUCCESS ONCE A READ SAYS SO. DELETE on a
 * subscription Stripe no longer has answers 404 (cancelSubscription's own
 * docstring in lib/stripe.js says so), and that is the ORDINARY answer here
 * rather than an edge case — see the catch below. But it is NOT the only thing a
 * 404 means: Stripe answers the identical 404 `resource_missing` for a
 * subscription that exists under a different account or the other livemode from
 * the key this process holds, and in THAT state the duplicate is very much alive
 * and billing the vendor's card. routes/admin.js's vendor-delete path spells the
 * same two meanings out at length for the same primitive and settles them the only
 * way the API allows — with a follow-up GET, since cancelling does not remove the
 * object, so a genuinely cancelled subscription still reads back 200 with a
 * terminal status while one this key cannot see 404s again. This function does the
 * same, and trusts the 404 only when the read PROVES the thing is finished.
 *
 * Both halves of that matter, and each was got wrong once:
 *   * treating every 404 as failure paged the operator about a subscription that
 *     was already cancelled, telling them a vendor was being billed twice when
 *     they were not (the common case — the second of the two deliveries below);
 *   * treating every 404 as success returned before the alert in the one state
 *     where the vendor really is billed twice, which is the state nobody could
 *     otherwise find out about.
 */
async function refuseDuplicateSubscription(vendor, incomingId, eventType) {
  let cancelled = true;
  let alreadyGone = false;
  // Set only on a 404 the follow-up read could NOT confirm: why it could not, in
  // words fit for the operator's push. Non-null means "cancelled is false AND we
  // cannot even see the thing", which is a different instruction from "the DELETE
  // failed" — see the alert bodies below.
  let unconfirmed = null;
  // WHICH of the three non-proofs it was — 'second_404' | 'probe_failed' |
  // 'still_alive'. The push bodies below say something different for each, because
  // only one of the three establishes anything about which account holds the
  // subscription. See cancel404Verdict.
  let unconfirmedReason = null;
  try {
    await cancelSubscription(incomingId);
    console.warn(`[stripe] ${eventType}: cancelled duplicate subscription ${incomingId} for `
               + `${vendor.name} (${vendor.id}), who already pays on ${vendor.stripe_subscription_id}`);
  } catch (err) {
    // ONE DUPLICATE EPISODE REACHES THIS FUNCTION TWICE, AND THE SECOND PASS
    // ALWAYS 404s. Stripe announces one new subscription with TWO events —
    // checkout.session.completed (subscription: sub_B) and
    // customer.subscription.created (id: sub_B). They carry different event ids,
    // so the stripe_events replay guard cannot collapse them, and neither
    // duplicate branch writes the vendors row, so the second delivery sees the
    // identical state, decides "duplicate" again, and DELETEs a sub_B the first
    // delivery already cancelled. Stripe answers 404 to that.
    //
    // Reading the 404 as "cancel failed" produced the worst possible alert: the
    // operator was told the vendor "has TWO live subscriptions ... They are being
    // billed twice. Cancel it by hand in the Stripe dashboard", about a
    // subscription that no longer exists, and sent into the dashboard next to the
    // LIVE one they could plausibly kill by mistake. Both halves were false — the
    // duplicate is cancelled and the vendor is billed once.
    if (err?.status === 404 || err?.code === 'resource_missing') {
      // ...BUT THE OTHER 404 IS THE DANGEROUS ONE, so prove it before believing
      // it. A subscription that exists in another Stripe account or the other
      // livemode answers the SAME 404 to this DELETE (see the docstring, and the
      // matching block in routes/admin.js's vendor delete), and there the vendor
      // IS being charged twice. A GET tells them apart: cancelling does not remove
      // the object, so an already-cancelled subscription still reads back with a
      // terminal status, while one outside this key's reach 404s again.
      let status = null;
      let probeErr = null;
      try {
        status = (await getSubscription(incomingId))?.status ?? null;
      } catch (e) {
        probeErr = e;
      }

      const verdict = cancel404Verdict(status, probeErr);
      if (verdict.alreadyGone) {
        alreadyGone = true;
        console.warn(`[stripe] ${eventType}: duplicate subscription ${incomingId} for ${vendor.name} `
                   + `(${vendor.id}) was already cancelled (404, and it reads back as '${status}') — `
                   + `nothing left to do; they go on paying on ${vendor.stripe_subscription_id}`);
      } else {
        // The read did not prove it is finished, so treat it as live. Escalating a
        // duplicate that turns out to be dead costs one push; staying quiet about a
        // live one costs the vendor $29 a month for as long as nobody notices.
        cancelled = false;
        unconfirmed = verdict.unconfirmed;
        unconfirmedReason = verdict.reason;
        console.error(`[stripe] ${eventType}: Stripe answered 404 when cancelling duplicate `
                    + `subscription ${incomingId} for ${vendor.name} (${vendor.id}), and ${unconfirmed}. `
                    + 'It may still be billing their card while they also pay on '
                    + `${vendor.stripe_subscription_id}. These keys are ${stripeMode() ?? 'unset'} mode.`);
      }
    } else {
      cancelled = false;
      console.error(`[stripe] ${eventType}: could not cancel duplicate subscription ${incomingId} for `
                  + `${vendor.name} (${vendor.id}): ${err?.message ?? err}`);
    }
  }

  // AND NO SECOND ALERT FOR AN EPISODE ALREADY REPORTED. `alreadyGone` now means a
  // READ proved this exact subscription is finished — in practice the first of the
  // two deliveries above cancelled it and sent the alert below, with the right
  // wording and the "check whether they should be refunded" ask. There is nothing
  // new to tell the operator and nothing left to fix: the row still tracks the
  // subscription the vendor pays on, and the duplicate is provably dead. (If
  // instead the operator cancelled it by hand in the dashboard before we ever saw
  // it, the same holds — the read says so.) Paging twice per episode is how an
  // alert becomes one people ignore.
  if (alreadyGone) return { ignored: 'duplicate_subscription_already_cancelled' };

  // ⚠ THE FAILURE PATHS DELIBERATELY DO PAGE TWICE, once per delivery, with the
  // same body — and that is the intended trade, not an oversight. Both alerts are
  // TRUE there: the duplicate really is live (or cannot be proved dead, which is
  // the same instruction to a human), and the retry on the second delivery is
  // WANTED — a 500 from Stripe a second ago may succeed now, and a key fixed in
  // between turns the second push into the reassuring "cancelled" wording instead.
  // De-duplicating would mean looking for an earlier stripe_events row
  // for the same subscription, which is guesswork — the two deliveries carry
  // unrelated event ids and the table stores no subscription id (migration-055) —
  // and the cost of getting that guess wrong is silence about a double charge. Two
  // pushes about money leaving a vendor's account twice is the cheap failure.
  //
  // ⚠ AND EACH BODY MAY ONLY CLAIM WHAT ITS OWN PATH ESTABLISHED. The pair
  // (tracked, incoming) is the same in all four, but what is KNOWN about the
  // incoming one is not, and the instruction changes with it — an operator sent to
  // "the dashboard of the account these keys belong to" on the strength of a Stripe
  // 500 is being sent to the wrong screen, next to a live subscription they could
  // kill by mistake, about a subscription the DELETE's own 404 suggests is already
  // dead in THIS account.
  let body;
  let ignored;
  if (cancelled) {
    body = `${vendor.name} ended up with a second subscription (${incomingId}) while already paying on `
      + `${vendor.stripe_subscription_id}. The duplicate was cancelled immediately and their plan is `
      + 'unchanged. Check whether they should be refunded for anything already charged.';
    ignored = 'duplicate_subscription';
  } else if (unconfirmedReason === 'second_404') {
    // The only one of the three that IS evidence about the account: two 404s in a
    // row, from a DELETE and a GET, is what "this key cannot see it" looks like.
    body = `${vendor.name} may be paying TWICE — ${vendor.stripe_subscription_id} (the one this app tracks) `
      + `and ${incomingId} — and Stripe has no ${incomingId} under this server's keys (${unconfirmed}), `
      + 'so it could neither be cancelled nor confirmed dead. If it is live in another Stripe account '
      + `or the other mode, their card is being charged for both. Look ${incomingId} up in the `
      + `dashboard of the account these keys belong to (these keys are ${stripeMode() ?? 'not set'} `
      + 'mode) and cancel it there.';
    ignored = 'duplicate_subscription_unconfirmed';
  } else if (unconfirmedReason === 'probe_failed') {
    // Nothing is known about WHERE it is. The cancel 404'd, which on its own most
    // often means "already cancelled here", and the read that would have proved that
    // failed for a reason of its own (Stripe 5xx, a timeout, a restricted key). So:
    // name the subscription, say the check failed, point at THIS account, and say
    // that the next delivery may settle it — the duplicate episode reaches this
    // function twice (see the note above), and a Stripe blip a second ago may be
    // over by then.
    body = `${vendor.name} may be paying TWICE — ${vendor.stripe_subscription_id} (the one this app tracks) `
      + `and ${incomingId}. Stripe answered 404 when cancelling ${incomingId}, which usually means it was `
      + `already cancelled, but checking that failed: ${unconfirmed}. So this is UNCONFIRMED rather than `
      + `known bad, and nothing here says which account holds it. Look ${incomingId} up in this account's `
      + `own dashboard (these keys are ${stripeMode() ?? 'not set'} mode) and cancel it if it is live; the `
      + 'next delivery of this event may confirm it on its own.';
    ignored = 'duplicate_subscription_unverified';
  } else if (unconfirmedReason === 'still_alive') {
    // The contradictory one: the DELETE 404'd, yet a GET under the SAME key answered
    // with a status that is not finished. Whatever the cause, the subscription is
    // visible from here, so "this account's dashboard" is the right screen and the
    // status is worth quoting.
    body = `${vendor.name} is being billed TWICE — ${vendor.stripe_subscription_id} (the one this app `
      + `tracks) and ${incomingId}. Cancelling ${incomingId} answered 404, but reading it back under the `
      + `same keys says ${unconfirmed} — so it is visible from this server and is not finished. Cancel it `
      + `by hand in this account's Stripe dashboard (these keys are ${stripeMode() ?? 'not set'} mode).`;
    ignored = 'duplicate_subscription_still_live';
  } else {
    // The DELETE failed for something that was not a 404 at all, so no probe ran.
    body = `${vendor.name} has TWO live subscriptions — ${vendor.stripe_subscription_id} (the one this app `
      + `tracks) and ${incomingId} — and cancelling the duplicate failed. They are being billed twice. `
      + 'Cancel it by hand in the Stripe dashboard.';
    ignored = 'duplicate_subscription_cancel_failed';
  }
  await notifyAdmins({ title: 'Stripe: duplicate subscription', body, url: '/admin' });

  // FIVE distinct outcomes, because they need five different things from the
  // operator: it is cancelled; these keys cannot see it, go to the other account;
  // the check itself failed, look here and expect the next delivery to help; it
  // reads back live here; or the cancel call failed outright and may work on retry.
  // They are also the strings /admin and any later log grep key off, so each stays
  // one-to-one with a body above.
  return { ignored };
}

/**
 * Re-read a subscription from the API, and decide what happens when that read
 * cannot be trusted. BOTH branches that write a plan go through here —
 * checkout.session.completed and customer.subscription.created/updated — so there
 * is ONE transient/permanent split rather than one per branch.
 *
 * @returns the subscription object; or null once the operator has been paged and
 *   the replay marker dropped, meaning "answer 200 and change nothing".
 * @throws the StripeError for a TRANSIENT failure, which the route turns into a 500
 *   so Stripe's own redelivery fixes it.
 *
 * ⚠ A READ THAT CAN NEVER SUCCEED MUST NOT BE RETRIED FOR THREE DAYS. Re-reading
 * the subscription makes every one of these events depend on STRIPE_SECRET_KEY being
 * a key that can see this object, and there are real deploys where it is not: the
 * key unset while the webhook secret is set (this route gates on the webhook secret
 * alone, never on stripeEnabled), a test key receiving live-mode events after a
 * rotation, or a restricted key with no subscription read. Letting that throw
 * deletes the replay marker and answers 500, so Stripe redelivers every subscription
 * event in the account for three days, then drops them, and no vendor's plan is ever
 * written.
 *
 * TRANSIENT vs PERMANENT is isRetryableStripeError above — read its docstring for
 * why the whitelist is on the RETRYABLE side and what a 400 used to do here.
 * Retryable throws, which deletes the replay marker and answers 500, and Stripe's
 * redelivery fixes it. Everything else gets a 200, a loud log and a push — and it is
 * the 200 that makes this one page per EVENT rather than one per retry for three
 * days, since Stripe stops redelivering the moment it sees one.
 *
 * ⚠ AND THE CHECKOUT BRANCH USES IT TOO, WHICH IS A DECISION THAT WAS TAKEN THE
 * OTHER WAY ONCE. That branch's read was left bare on the argument that a vendor who
 * has just PAID must never be silently dropped — but a bare throw there is not a
 * gentler failure, it is the same three-day 500 storm with NO alert at all, and after
 * three days Stripe gives up and the payment is still not reflected. Routing it
 * through here is strictly louder: the operator is paged once, by name, with the
 * subscription id and the "they have just paid" wording below, and the marker drop
 * makes a dashboard resend work the moment the key is fixed. Nothing about it is
 * silent; the only thing given up is Stripe retrying a call that cannot succeed.
 *
 * The event payload is deliberately NOT applied as a fallback. It is the stale
 * snapshot whose use in the created/updated branch is what let a replayed 'active'
 * update resurrect a cancelled plan; a row overwritten from a three-hour-old
 * snapshot is worse than a row left alone. But "left alone" is NOT self-healing —
 * see the marker delete below for what makes the dropped change recoverable at all.
 */
async function readSubscriptionOrEscalate(subscriptionId, vendor, event) {
  try {
    const sub = await getSubscription(subscriptionId);

    // ⚠ AND A 2xx IS NOT AUTOMATICALLY A SUBSCRIPTION. lib/stripe.js's stripeRequest
    // now throws on a 2xx whose body could not be parsed (an aborted or truncated
    // body, or a proxy answering 200 with HTML), which is what used to arrive here as
    // a bare `null` — and null fed to subscriptionPatch reads as a subscription with
    // no id and no status, i.e. it CHURNS a paying vendor: plan 'freshman',
    // stripe_subscription_id, subscription_status and current_period_end all nulled,
    // a 200 answered and the replay marker kept, so nothing retries and nothing
    // alerts. This is the second fence on that hole, for anything that parses as JSON
    // but is not a subscription (a gateway or WAF answering for Stripe in JSON, a
    // mocked client in a misassembled deploy).
    //
    // It is deliberately classified PERMANENT — status 0 with a code that is not in
    // isRetryableStripeError's whitelist — and not as 'network_error' like the
    // unreadable body it backs up. The genuinely transient shapes are already
    // retried at the source; what reaches HERE parsed fine and still is not a
    // subscription, which no amount of redelivery turns into one. Permanent means one
    // page naming the vendor, the marker dropped so a resend works, and no silent
    // three-day storm — which is the trade this whole function exists to make.
    if (!isSubscriptionShape(sub)) {
      throw new StripeError(
        `Stripe answered for ${subscriptionId} with something that is not a subscription `
        + '(no id or no status) — something between this server and Stripe is answering for it',
        { status: 0, code: 'not_a_subscription' },
      );
    }
    return sub;
  } catch (err) {
    if (isRetryableStripeError(err)) throw err;

    // A vendor who just completed Checkout is a different kind of urgent from a
    // routine update: their money has moved and their plan has not, so the push says
    // so rather than making the operator infer it from the event type.
    const justPaid = event.type === 'checkout.session.completed';
    const msg = `Stripe sent ${event.type} for ${vendor.name}, but subscription `
              + `${subscriptionId} could not be read back: ${err?.message ?? err}. `
              + (justPaid
                ? `THEY HAVE JUST PAID and are still on ${vendor.plan ?? 'freshman'} — the Stripe `
                  + 'customer id is attached to their row but no plan was switched on. '
                : 'Their plan was NOT changed. ')
              + 'THIS EVENT IS GONE — whatever plan change it carried has to '
              + `be re-synced by hand: fix the cause, then resend event ${event.id} from the Stripe `
              + `dashboard (Developers → Events) or check ${subscriptionId} there and set the `
              + `vendor's plan to match. Retrying on its own will not fix it. Likely causes: a `
              + 'missing or wrong STRIPE_SECRET_KEY, a test key against live-mode events, a '
              + 'restricted key without subscription read, an unaccepted STRIPE_API_VERSION — or '
              + 'the subscription is genuinely gone from this account. While it lasts, no vendor '
              + `plan will update at all (keys are ${stripeMode() ?? 'unset'} mode).`;
    console.error(`[stripe] ${msg}`);
    await notifyAdmins({ title: 'Stripe: subscription unreadable', body: msg, url: '/admin' });

    // AND DROP THE REPLAY MARKER, so "resend it from the dashboard" is real
    // advice. Answering 200 means Stripe never redelivers this event of its own
    // accord, and with the marker in place a manual resend would be deduped to
    // `{ok:true, duplicate:true}` and do nothing — the operator would fix the
    // key, press Resend, see a 200, and the plan change would STILL be lost,
    // with nothing in the repo that ever re-reads a subscription to repair a row
    // (no reconcile job, no cron; the other getSubscription callers are a
    // read-only billing screen and a pre-delete probe). Deleting it costs
    // nothing: NEITHER caller has written a plan by this point, so re-running the
    // event is exactly the work that needs doing. (The checkout branch has written
    // stripe_customer_id, which is the same value the resend writes again — it is
    // idempotent, and it is what the Customer Portal needs either way.) Best-effort
    // and never thrown from — throwing here would turn a permanent configuration
    // fault back into the 500 retry storm this function exists to avoid.
    const { error: unmarkErr } = await supabaseAdmin
      .from('stripe_events').delete().eq('id', event.id);
    if (unmarkErr) {
      console.error(`[stripe] event ${event.id} could not be unmarked after an unreadable `
                  + `subscription (${unmarkErr.message ?? unmarkErr}) — a dashboard resend of it `
                  + 'will be deduped away, so re-sync that vendor by hand instead.');
    }
    return null;
  }
}

/**
 * A superseded event about a subscription the row does NOT track is usually a stale
 * replay — and is usually right to drop. But it is the ONLY signal this app ever
 * gets for a vendor who is ALREADY carrying two live subscriptions, with the row
 * tracking one of them: isDuplicateSubscription fires only as a second subscription
 * is BORN (checkout.session.completed / customer.subscription.created), so a pair
 * that predates this code — production's un-fixed code could create one, and so
 * could a cancel that failed — is outside its reach for ever. Every later event about
 * the older, still-billing subscription then hit a console.warn nobody reads, and the
 * double charge stayed invisible.
 *
 * WHAT SEPARATES THE TWO, and it is the only thing that can: re-read the untracked
 * subscription. A stale replay is about an object Stripe has since finished with, so
 * it reads back terminal (or 404s, or reads back not-paying); a second LIVE
 * subscription reads back with a statusIsPaying status, which means Stripe is
 * charging that card on a schedule nothing in this app can see. The EVENT's own
 * status cannot be used for this — it is the stale snapshot the whole file is written
 * around.
 *
 * Deliberately NOT called from the customer.subscription.deleted branch: a deletion
 * for an untracked subscription is the double charge ENDING, which is the one case
 * needing no human.
 *
 * Best-effort and never throws: the caller has already decided to answer 200 and
 * write nothing, and turning a failed diagnostic into a 500 would buy three days of
 * redeliveries for an event we mean to drop.
 */
async function escalateIfSecondLiveSubscription(vendor, otherId, eventType) {
  try {
    const status = (await getSubscription(otherId))?.status ?? null;
    // Not paying → an ordinary stale replay about a dead object. Silence is right:
    // these arrive for days after a cancellation and pushing on each would train the
    // operator to ignore the title that also carries the real double charge.
    if (!statusIsPaying(status)) return;

    const body = `${vendor.name} looks like they are paying TWICE. This app tracks `
               + `${vendor.stripe_subscription_id}, but Stripe just sent ${eventType} about `
               + `${otherId}, and reading that one back says it is '${status}' — still billing. `
               + 'Only the tracked subscription is visible anywhere in the app, so the other one goes '
               + `on charging their card until it is cancelled by hand in the Stripe dashboard (these `
               + `keys are ${stripeMode() ?? 'not set'} mode). Cancel whichever is the duplicate and `
               + 'check whether they should be refunded.';
    console.error(`[stripe] ${body}`);
    await notifyAdmins({ title: 'Stripe: duplicate subscription', body, url: '/admin' });
  } catch (err) {
    // Could not tell a replay from a double charge. Worth a line, not a page: the
    // next delivery about the same subscription tries again, and invoices for a live
    // subscription keep coming.
    console.warn(`[stripe] ${eventType}: could not read superseded subscription ${otherId} for `
               + `${vendor.name} (${vendor.id}), so a stale replay and a second live subscription `
               + `cannot be told apart here: ${err?.message ?? err}`);
  }
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

      // A completed session for a vendor who is ALREADY paying on a different
      // subscription is the two-open-sessions case — see
      // isDuplicateSubscription. Applying it would hide the subscription they
      // have been paying on all along, so the new one is cancelled instead.
      if (isDuplicateSubscription(vendor, subscriptionId)) {
        return refuseDuplicateSubscription(vendor, subscriptionId, event.type);
      }

      // THE SAME GUARDED RE-READ THE created/updated BRANCH USES. This call was
      // once left bare, on the argument that a vendor who has just paid must not be
      // silently dropped; readSubscriptionOrEscalate's docstring sets out why that
      // was backwards — an unguarded throw here is a three-day 500 storm with no
      // alert, where the helper pages the operator once, says they have just paid,
      // and drops the replay marker so a dashboard resend actually re-runs this.
      const sub = await readSubscriptionOrEscalate(subscriptionId, vendor, event);
      if (!sub) return { ignored: 'subscription_unreadable' };
      await applySubscription(sub, { ...vendor, stripe_customer_id: customerId ?? vendor.stripe_customer_id });
      return { applied: 'checkout' };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      // The customer id may not be on the row yet if this beat the checkout
      // event in — Stripe does not order deliveries. This runs FIRST and
      // unconditionally for that reason, before any of the guards below decide
      // the subscription itself is not ours to act on.
      const customerId = idOf(object.customer);
      if (customerId && vendor.stripe_customer_id !== customerId) {
        await patchVendor(vendor.id, { stripe_customer_id: customerId });
      }

      const subscriptionId = idOf(object.id);
      if (!subscriptionId) {
        // Cannot happen for a real subscription event, and there is nothing
        // sensible to do with one: with no id we can neither re-read the live
        // object nor tell whether it is the subscription this row tracks. The
        // old code applied the payload anyway, which WROTE A NULL subscription
        // id over a live one. A 200 and a log is the safe answer.
        console.warn(`[stripe] ${event.type} (${event.id}) carried no subscription id — ignoring`);
        return { ignored: 'no_subscription_id' };
      }

      // A NEW subscription arriving for a vendor who is already paying on a
      // different one is the duplicate case, not an upgrade: changing plans in
      // the portal UPDATES the existing subscription and keeps its id, so a
      // second id being born means two Checkout Sessions were completed. Cancel
      // the newcomer and keep the one they have been receiving service on.
      //
      // Only for 'created'. An 'updated' for an unknown id is handled by the
      // superseded guard below instead — by then the duplicate has either
      // already been cancelled here or is being reported to the operator, and
      // cancelling again on every routine update would be noise.
      if (event.type === 'customer.subscription.created'
          && isDuplicateSubscription(vendor, subscriptionId)) {
        return refuseDuplicateSubscription(vendor, subscriptionId, event.type);
      }

      // ⚠ THE SAME GUARD THE DELETED BRANCH HAS, AND FOR A WORSE FAILURE.
      // Stripe redelivers for up to three days and does not order deliveries, so
      // an 'active' update for a subscription this row no longer tracks can land
      // after that subscription was cancelled (the deleted branch nulls the id,
      // but resolveVendor still finds the vendor through metadata.vendor_id,
      // which rides on the subscription forever). Applying it rewrote the plan to
      // a paid tier attached to a dead subscription id — and because Stripe then
      // emits nothing further for a dead subscription, nothing would ever undo
      // it: free service, plus a 409 ALREADY_SUBSCRIBED from POST /checkout that
      // stops the vendor buying a real plan.
      //
      // Not applied to 'created': there, a differing id is either the duplicate
      // handled above or a vendor whose tracked subscription has lapsed
      // deliberately buying again, and ignoring THAT would take payment for a
      // plan this app never records.
      if (event.type === 'customer.subscription.updated'
          && vendor.stripe_subscription_id
          && vendor.stripe_subscription_id !== subscriptionId) {
        // Logged, like every other drop that is a JUDGEMENT rather than a shape
        // check: this is the line that answers "Stripe says they are active, why
        // is the row not?" months later, and without it the drop is invisible.
        console.warn(`[stripe] ${event.type} (${event.id}) is about ${subscriptionId}, but `
                   + `${vendor.name} (${vendor.id}) tracks ${vendor.stripe_subscription_id} — `
                   + 'superseded, ignoring');
        // ...but an 'updated' about an untracked subscription that is STILL PAYING is
        // not a stale replay, it is a second live subscription billing this vendor,
        // and dropping it silently is how an already-existing double charge stays
        // invisible for ever. See escalateIfSecondLiveSubscription.
        await escalateIfSecondLiveSubscription(vendor, subscriptionId, event.type);
        return { ignored: 'superseded_subscription' };
      }

      // AND APPLY LIVE STATE, NOT THE PAYLOAD. An event describes the
      // subscription as it was when the event was created, which — after a retry
      // or an out-of-order delivery — can be hours stale and can say 'active'
      // about something since cancelled. The checkout branch above has always
      // re-read the subscription for exactly this reason; this branch used to
      // trust `event.data.object` instead, which is what made a replayed update
      // able to resurrect a cancelled plan. One extra GET per subscription event
      // is a price worth paying for the row always describing the present.
      const sub = await readSubscriptionOrEscalate(subscriptionId, vendor, event);
      if (!sub) return { ignored: 'subscription_unreadable' };
      await applySubscription(sub, vendor);
      return { applied: event.type };
    }

    case 'customer.subscription.deleted': {
      // Only if it is THE subscription we track. A vendor who cancelled and
      // resubscribed can have a deletion for the old one arrive after the new
      // one is live, and acting on it would cancel a subscription they are
      // paying for right now.
      //
      // And NO second-live-subscription escalation on this drop, unlike the
      // 'updated' and invoice branches: a deletion for an untracked subscription is
      // a double charge ENDING, which needs no human. See
      // escalateIfSecondLiveSubscription.
      const goneId = idOf(object.id);
      if (vendor.stripe_subscription_id && goneId && vendor.stripe_subscription_id !== goneId) {
        return { ignored: 'superseded_subscription' };
      }
      // The churned row shape subscriptionPatch's terminal branch also writes — see
      // its docstring for the two columns that deliberately differ between the two
      // paths, of which plan_since is one: UNCONDITIONAL here, because a cancellation
      // has no subscription object to compare a plan against and "freshman since the
      // day they cancelled" is what the operator's overview should say. The only row
      // where that disagrees with the other path is a vendor already sitting on
      // freshman when the cancellation lands, whose date is bumped forward; nothing
      // keys off it.
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
      // ⚠ THE SAME SUPERSEDED GUARD EVERY OTHER BRANCH HAS, and here it protects
      // the stamp the whole dunning ladder is measured from. An invoice event
      // names its own subscription (invoiceSubscriptionId), and that need not be
      // the one this row tracks: a duplicate the cleanup above could not cancel
      // goes on issuing invoices, and a vendor who resubscribed has a superseded
      // subscription still settling old invoices. Clearing past_due_since for one
      // of THOSE handed a vendor whose tracked subscription was 31 days delinquent
      // their full paid entitlement back — daysPastDue null, effectivePlan back to
      // 'discovery', vendor_billing_overview.billing_state back to 'ok', gone from
      // the /admin trouble list, and the 45-day suspend clock restarted at zero.
      const paidSub = invoiceSubscriptionId(object);
      if (!paidSub) return { ignored: 'not_subscription_invoice' };
      if (vendor.stripe_subscription_id && vendor.stripe_subscription_id !== paidSub) {
        console.warn(`[stripe] ${event.type} (${event.id}) is about ${paidSub}, but `
                   + `${vendor.name} (${vendor.id}) tracks ${vendor.stripe_subscription_id} — `
                   + 'superseded, ignoring');
        // AN INVOICE THAT WAS PAID IS MONEY THAT LEFT THIS VENDOR'S CARD, and if the
        // subscription that issued it is still live, it is money leaving for a plan
        // no screen in this app shows. Same narrow test as the 'updated' branch — a
        // re-read that still says paying — so a stale invoice for a cancelled
        // subscription stays the quiet drop it should be.
        await escalateIfSecondLiveSubscription(vendor, paidSub, event.type);
        return { ignored: 'superseded_subscription' };
      }
      // Clearing an already-null column is a no-op write, so this does not
      // need to read first.
      await patchVendor(vendor.id, { past_due_since: null });
      return { applied: 'paid' };
    }

    case 'invoice.payment_failed': {
      // The mirror-image of the guard above, and just as necessary: a failed
      // invoice for a subscription this row does NOT track would stamp a debt on a
      // vendor who owes nothing on the one it does — starting the 30-day degrade
      // clock on somebody whose own card is fine.
      const failedSub = invoiceSubscriptionId(object);
      if (!failedSub) return { ignored: 'not_subscription_invoice' };
      if (vendor.stripe_subscription_id && vendor.stripe_subscription_id !== failedSub) {
        console.warn(`[stripe] ${event.type} (${event.id}) is about ${failedSub}, but `
                   + `${vendor.name} (${vendor.id}) tracks ${vendor.stripe_subscription_id} — `
                   + 'superseded, ignoring');
        // A FAILED invoice for an untracked subscription that is still live is the
        // same second-subscription evidence as a paid one: Stripe is trying to
        // collect for a plan this app cannot see, and the vendor is about to be
        // dunned for it by Stripe alone. Still narrow — a re-read that says paying
        // ('past_due' counts, and is exactly what a failed invoice produces).
        await escalateIfSecondLiveSubscription(vendor, failedSub, event.type);
        return { ignored: 'superseded_subscription' };
      }

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
