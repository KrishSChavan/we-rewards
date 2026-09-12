// What each plan may do, and what a failing card takes away.
//
// TWO RULES LIVE HERE AND NOWHERE ELSE:
//
//   1. The plan ladder — freshman < discovery < goto.
//   2. The dunning ladder — 30 days past due degrades a paying vendor to the
//      free tier; 45 days is where the operator suspends them outright.
//
// The SAME 30/45 thresholds are also written in migration-055's
// vendor_billing_overview view, which is what /admin reads to decide who to
// chase. That is a genuine duplication and it is deliberate: the view answers
// "who is in trouble" for a screen, this answers "may this request proceed" on
// a hot path, and making the request path do a second round-trip to a view to
// learn something it already has in req.vendor would be a query per award. The
// constants below and the view's interval literals must be changed together;
// test/plans.test.js asserts the boundaries so a drift shows up as a failure
// rather than as a vendor who kept their deals for an extra fortnight.
//
// WHY DEGRADE INSTEAD OF DISCONNECT. A suspended terminal punishes students
// standing at a counter because a vendor's bank declined a $29 charge. So a
// past-due vendor keeps earning and redeeming — the things a customer is in the
// middle of — and loses deals and the full stats, which are the things they are
// actually paying for. The operator suspends by hand at 45 days, from /admin,
// with the day count in front of them.

/** Ascending capability order. A vendor may do anything their rank reaches. */
export const PLAN_RANK = Object.freeze({
  freshman: 0,
  discovery: 1,
  goto: 2,
});

/** The three plans, in the order a human would list them. */
export const PLANS = Object.freeze(['freshman', 'discovery', 'goto']);

/** Display names. The database stores the slug; people read these. */
export const PLAN_LABELS = Object.freeze({
  freshman: 'Freshman',
  discovery: 'Discovery',
  goto: 'Go-to',
});

/** Past this many days of non-payment a paid plan stops paying out. */
export const DEGRADE_DAYS = 30;
/** Past this many days the operator suspends the account entirely (by hand). */
export const SUSPEND_DAYS = 45;

/** How many reward items a vendor may keep active, by plan. null = no cap. */
export const ITEM_CAP = Object.freeze({
  freshman: 3,
  discovery: null,
  goto: null,
});

const DAY = 86_400_000;

/**
 * The rank of a plan slug, or undefined when it is not one of the three.
 *
 * `Object.hasOwn` rather than a bare `PLAN_RANK[plan]` lookup, because
 * PLAN_RANK inherits from Object.prototype: `PLAN_RANK['constructor']` is a
 * function, not undefined, so every "is this a real plan?" test written as a
 * bare lookup quietly passes for it. That put a function into itemCap's return
 * value and a garbage string into effectivePlan's. Unreachable through the
 * database (vendors_plan_check allows exactly three values) — but this module
 * advertises that it normalises an unknown plan, and it has to actually do it.
 */
const rankOf = (plan) =>
  (typeof plan === 'string' && Object.hasOwn(PLAN_RANK, plan)) ? PLAN_RANK[plan] : undefined;

/** Days a vendor has been past due, or null when they are not. */
export function daysPastDue(vendor, now = Date.now()) {
  if (!vendor?.past_due_since) return null;
  // A grandfathered vendor is never past due, whatever is stamped on the row.
  // They have no Stripe subscription at all, so a stale timestamp here is a
  // data artefact, not a debt — and the operator must never be prompted to
  // chase somebody who was promised free access.
  if (vendor.grandfathered) return null;
  const ms = now - new Date(vendor.past_due_since).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / DAY));
}

/**
 * The plan this vendor may actually use RIGHT NOW — their nominal plan, unless
 * a payment has been failing for long enough to drop them to the free tier.
 *
 * Note it never returns something ABOVE `vendor.plan`: degrading is the only
 * adjustment, so a bug here can cost a vendor a feature but can never hand one
 * out for free.
 */
export function effectivePlan(vendor, now = Date.now()) {
  const nominal = rankOf(vendor?.plan) === undefined ? 'freshman' : vendor.plan;
  const late = daysPastDue(vendor, now);
  if (late !== null && late >= DEGRADE_DAYS) return 'freshman';
  return nominal;
}

/**
 * Does this vendor reach `minimum` right now?
 *
 * AN UNRECOGNISED `minimum` DENIES. This used to read `PLAN_RANK[minimum] ?? 0`,
 * which resolved an unknown requirement to rank 0 — so `requirePlan('Discovery')`,
 * or any other one-character slip in a route, silently waved every request
 * through with no error, no log line and no failing test. The paywall would
 * simply not be there. An unrecognised requirement is a bug, and the safe
 * reading of a bug in a gate is "denied": it costs a feature, loudly, instead
 * of giving the paid product away in silence. requirePlan below refuses to
 * mount at all in that state, so this is the second of two fences.
 */
export function planAllows(vendor, minimum, now = Date.now()) {
  const need = rankOf(minimum);
  if (need === undefined) return false;
  return (rankOf(effectivePlan(vendor, now)) ?? 0) >= need;
}

/** The active-reward-item cap for this vendor, or null for no cap. */
export function itemCap(vendor, now = Date.now()) {
  const plan = effectivePlan(vendor, now);
  // Fails closed to the free tier's cap, matching effectivePlan's own rule.
  return Object.hasOwn(ITEM_CAP, plan) ? ITEM_CAP[plan] : ITEM_CAP.freshman;
}

/**
 * The rejection body for a blocked request, or null to allow. Pure, so every
 * branch is testable without a request.
 *
 * The message distinguishes "you never had this" from "you had this and a
 * payment is failing", because the two need completely different actions from
 * the person reading it and the terminal shows the message verbatim.
 */
export function planRejection(vendor, minimum, now = Date.now()) {
  if (planAllows(vendor, minimum, now)) return null;

  const late = daysPastDue(vendor, now);
  if (late !== null && late >= DEGRADE_DAYS) {
    return {
      status: 402,
      body: {
        error: 'PLAN_PAST_DUE',
        message: `This is paused while a payment is outstanding (${late} days). Update your card in Settings to turn it back on.`,
        plan: vendor?.plan ?? 'freshman',
        requiredPlan: minimum,
        daysPastDue: late,
      },
    };
  }

  return {
    status: 402,
    body: {
      error: 'PLAN_REQUIRED',
      message: `That's part of the ${PLAN_LABELS[minimum] ?? minimum} plan. Upgrade in Settings to use it.`,
      plan: effectivePlan(vendor, now),
      requiredPlan: minimum,
    },
  };
}
