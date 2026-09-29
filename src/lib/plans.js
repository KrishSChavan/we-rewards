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

/* ---------------------------------------------------------------------------
 * WHAT IS LOCKED, AS A LIST — the thing the terminal shows BEFORE a refusal
 * -------------------------------------------------------------------------
 *
 * planRejection above answers a request that already happened. This answers the
 * question a vendor has before they touch anything: "what am I missing, and
 * what do I do about it?" The terminal renders it in three places (the Settings
 * billing card, and an inline panel on the DEALS, VISITS and STATS screens),
 * and every one of them is populated from THIS function via
 * GET /api/vendor/config and GET /api/vendor/billing.
 *
 * THE LIST LIVES HERE, NOT IN THE BROWSER, for the same reason
 * GET /api/vendor/analytics sends `lockedSections` instead of letting the
 * prompt name the three sections itself: public/vendor/terminal.js is a
 * separate bundle that cannot import this module, so a feature list written
 * there drifts the moment a gate moves. A gate added or removed in
 * routes/vendor.js should change exactly one list, and this is it — the LOCKS
 * table below names each gate's file and route so the next person adding a
 * requirePlan() can find the line they also have to edit.
 *
 * TRUTHFUL OR ABSENT. Every entry corresponds to a gate that actually refuses
 * a request today. Earning, redeeming, the till, receipts (migration-056's
 * vendors.receipts_enabled is deliberately ungated), settings, the PIN, the
 * logo and multi-location are NOT gated by plan and must never appear here: a
 * list that oversells is worse than no list, because the first vendor who
 * upgrades to get something they already had will ask for their money back.
 */

/**
 * The gated features, each with the gate that enforces it and the copy a vendor
 * reads. `requires` is the plan the gate itself demands — read from the route,
 * not chosen here.
 *
 * `locked` is asked per vendor rather than derived from `requires` alone because
 * the item cap is not a ladder check: routes/vendor.js counts against
 * itemCap(vendor), which is null (uncapped) for both paid plans, so the cap's
 * presence is the honest test for it.
 *
 * Both copy variants exist for every entry because the two states need opposite
 * actions from the reader — see planRejection above, which draws the same line
 * for the same reason. `upgrade` never appears in past-due copy: a vendor whose
 * card just failed already pays for this, and telling them to buy it again is
 * the one sentence that turns a billing hiccup into a support call.
 */
const LOCKS = Object.freeze([
  Object.freeze({
    key: 'deals',
    requires: 'discovery',
    // GATES: POST /api/vendor/campaigns and PATCH /api/vendor/campaigns/:id,
    // plus GET /api/vendor/campaigns/reach (the audience size the composer
    // shows) — all three requirePlan('discovery') in src/routes/vendor.js.
    // GET /campaigns is deliberately NOT gated, so the copy says what they can
    // still do rather than implying the tab is dead.
    locked: (vendor, now) => !planAllows(vendor, 'discovery', now),
    label: 'Sending deals and offers',
    upgrade: ({ planName }) =>
      `Writing a deal and pushing it to your own customers is part of the ${planName} plan. `
      + 'Deals you have already sent stay visible and keep running.',
    pastDue: ({ late }) =>
      `Sending new deals is paused while a payment is outstanding (${late} days). `
      + 'Deals already out there keep running. Update your card in Settings and sending comes straight back.',
  }),
  Object.freeze({
    key: 'visits',
    requires: 'discovery',
    // GATE: GET /api/vendor/punch-token — requirePlan('discovery') in
    // src/routes/vendor.js. That token IS the punch card: it mints the rotating
    // 30-second URL a student scans, and there is no other way to hand out a
    // visit. The vendors.punch_enabled SETTING is not gated (PATCH /settings
    // accepts it on any plan), which is exactly why this has to be said out
    // loud — switching visits on and finding the code screen refused is
    // otherwise a wall with no explanation.
    locked: (vendor, now) => !planAllows(vendor, 'discovery', now),
    label: 'Visit punch cards',
    upgrade: ({ planName }) =>
      `The punch-in code students scan to collect a visit is part of the ${planName} plan. `
      + 'You can switch visits on in Settings, but the code screen stays locked until then.',
    pastDue: ({ late }) =>
      `The punch-in code is paused while a payment is outstanding (${late} days), so visits cannot be collected. `
      + 'Visits students already earned are untouched. Update your card in Settings to start the code again.',
  }),
  Object.freeze({
    key: 'stats30',
    requires: 'discovery',
    // GATE: GET /api/vendor/analytics (NOT /stats — there is no such route)
    // trims its own response for an effective freshman rather than answering
    // 402, dropping last30, daily and topRewards and flagging the response
    // `limited: true, lockedSections: ['last30','daily','topRewards']`. The
    // three names below are the same three, in the same order, said in words.
    locked: (vendor, now) => !planAllows(vendor, 'discovery', now),
    label: 'The 30-day numbers',
    upgrade: ({ planName }) =>
      `Today and the last seven days are free forever. The 30-day totals, the two-week chart and your `
      + `top rewards are part of the ${planName} plan.`,
    pastDue: ({ late }) =>
      `The 30-day totals, the two-week chart and your top rewards are paused while a payment is outstanding `
      + `(${late} days). Today and the last seven days keep working. Update your card in Settings to get the rest back.`,
  }),
  Object.freeze({
    key: 'itemCap',
    requires: 'discovery',
    // GATE: the ITEM_CAP count in POST /api/vendor/rewards and in
    // PATCH /api/vendor/rewards/:id (the switch-back-on door), both answering
    // 402 ITEM_CAP_REACHED in src/routes/vendor.js. Counted on ACTIVE items at
    // create time only — nothing is ever deleted to enforce a plan change —
    // so the copy tells them the way out that does not cost money first.
    locked: (vendor, now) => itemCap(vendor, now) !== null,
    label: 'More than a handful of active rewards',
    // `cap` comes from itemCap(vendor), so ITEM_CAP.freshman is the only place
    // the number 3 is written. A test asserts this sentence tracks the constant
    // rather than a literal.
    //
    // BOTH SENTENCES STATE THE GATE'S RULE, NOT THE VENDOR'S CURRENT COUNT, and
    // that is deliberate: the vendor this note exists for is usually OVER the
    // cap, not at it. routes/vendor.js refuses on `(count ?? 0) >= cap` counted
    // over `.eq('active', true)` and nothing anywhere deactivates rewards when a
    // plan drops (the route says so itself: "a vendor who drops to freshman (or
    // falls 30 days past due) keeps the menu they already built"), so somebody
    // who built a nine-item menu on Discovery and cancelled is sitting in front
    // of nine switched-on rows with a cap of three. The old wording — "your menu
    // can keep 3 rewards active at a time. Turn one off to make room for
    // another" — was false twice over for exactly that vendor: their menu
    // demonstrably keeps nine, and turning one off takes 9 to 8 and the next add
    // is still refused. They have to come UNDER the cap, which is seven toggles,
    // not one. "Come under ${cap}" is the gate restated precisely (it refuses at
    // >= cap, so adding needs cap-1 or fewer active) and it stays true at the cap
    // as well, where it means the same single toggle the old sentence promised.
    // planLocks has no active count to work from: it is pure and built from the
    // vendor row alone, and GET /api/vendor/config does not count rewards. Naming
    // the vendor's real position ("9 on, the limit is 3") would need the routes to
    // send that count into the payload — worth doing if this note keeps confusing
    // people, but it is a route change, and stating the rule is already true for
    // every count.
    upgrade: ({ planName, cap }) =>
      `A new reward is refused while ${cap} are already switched on, which is the cap on your plan — `
      + 'a longer menu you built earlier stays put and keeps working. '
      + `Switch off enough to come under ${cap}, or move to ${planName} for as many as you like.`,
    pastDue: ({ late, cap }) =>
      `A new reward is refused while ${cap} are already switched on: the cap is back while a payment `
      + `is outstanding (${late} days). Nothing was deleted — update your card in Settings and the cap lifts again.`,
  }),
]);

/**
 * Everything this vendor's EFFECTIVE plan blocks right now, or null when
 * nothing is blocked. Pure, with an injectable `now` like every other decision
 * in this file, so the copy is testable without a request.
 *
 * Shape (see test/plans.test.js, and the two routes that send it):
 *
 *   { reason: 'upgrade' | 'past_due',
 *     plan, nominalPlan, requiredPlan, daysPastDue,
 *     items: [{ key, label, detail }, …] }
 *
 * `reason` is the whole point of the return value and it is NOT a restatement
 * of `plan`:
 *
 *   'upgrade'  — they never had these. The fix is a purchase.
 *   'past_due' — they hold a paid plan and effectivePlan has degraded them for
 *                non-payment. The fix is a card, and the word "upgrade" must
 *                not appear anywhere on the screen.
 *
 * `reason` IS planRejection's `error`, BY CONSTRUCTION. The two functions answer
 * the same question at different moments — planRejection after a request was
 * refused, this one before the vendor touches anything — and a gate that
 * disagrees with its own explanation is a vendor reading two contradictory
 * sentences on one screen. So the past-due test below is planRejection's test,
 * character for character, and test/plans.test.js walks the whole
 * plan x past_due_since x grandfathered matrix asserting
 * `planLocks(v)?.reason === 'past_due'` if and only if
 * `planRejection(v, 'discovery')?.body.error === 'PLAN_PAST_DUE'`.
 *
 * A NOMINAL FRESHMAN WITH A LIVE past_due_since IS 'past_due', NOT 'upgrade' —
 * this used to read the other way, on the theory that a stamp on a freshman row
 * is a data artefact like the one daysPastDue ignores on a grandfathered row.
 * That theory is wrong, and src/routes/stripe-webhook.js is where it breaks:
 * subscriptionPatch's not-paying, NON-TERMINAL branch (`unpaid`, `paused`,
 * `incomplete` — TERMINAL_STATUSES is only ['canceled','incomplete_expired'])
 * writes plan 'freshman' while KEEPING stripe_subscription_id and deliberately
 * leaving past_due_since alone, and for `unpaid` with no stamp it goes and
 * stamps one. Its own comment spells out why: "The row goes on tracking that
 * subscription, so the ladder must go on measuring it." invoice.payment_failed
 * is the second door — it stamps past_due_since and never touches `plan`, so it
 * lands the same shape on any row already sitting on freshman. Neither row is an
 * artefact: there is a live subscription behind it and real money owed. The
 * genuine artefact cases both clear the column instead of relying on a reader to
 * discount it — the terminal branch and customer.subscription.deleted both write
 * past_due_since null — and grandfathered rows, which have no subscription at
 * all, are still discounted one layer down in daysPastDue.
 *
 * "You are ${late} days in arrears, this is paused" is also the truthful framing
 * for that row whatever the plan column says, and it is the framing the vendor
 * is already getting from every 402 on the same request, because planRejection
 * has always keyed on the day count alone.
 *
 * GRANDFATHERED VENDORS GET null. The sixteen are on `goto` (migration-055
 * backfills plan AND the flag together), so the plan ladder already locks them
 * out of nothing and this is only belt-and-braces — but it is the consistent
 * reading of the flag everywhere else in the stack: daysPastDue refuses to call
 * them late, routes/vendor.js refuses to sell them anything (GRANDFATHERED_BODY
 * on /checkout and /portal), and terminal.js hides the whole billing region for
 * them. A locked list would be pointing at an Upgrade button that is not on
 * their screen. If a grandfathered row is ever hand-edited down to freshman, the
 * server-side gates still refuse the request — requirePlan does not exempt
 * grandfathered — and planRejection's message is what that vendor sees, which
 * is the right outcome for a row that should not exist.
 */
export function planLocks(vendor, now = Date.now()) {
  if (vendor?.grandfathered) return null;

  const locked = LOCKS.filter((f) => f.locked(vendor, now));
  if (!locked.length) return null;

  const plan = effectivePlan(vendor, now);
  const nominalPlan = rankOf(vendor?.plan) === undefined ? 'freshman' : vendor.plan;
  const late = daysPastDue(vendor, now);

  // Degraded = there is a debt and it has passed the line. THIS EXPRESSION IS
  // COPIED FROM planRejection ABOVE (`late !== null && late >= DEGRADE_DAYS`, at
  // its PLAN_PAST_DUE branch) and must stay identical to it: reason is the
  // explanation of the very refusal planRejection produces, and the two reading
  // one row differently is how a vendor ends up being sold a plan on the DEALS
  // panel while the error line under the composer tells them a payment is
  // outstanding. It previously ALSO required a paid nominal plan, which split the
  // two on every `unpaid`/`paused` row stripe-webhook.js writes — see the
  // docstring above for the two webhook branches that produce plan 'freshman'
  // with a live stamp and a live subscription behind it.
  //
  // Deliberately NOT `plan !== nominalPlan`: that reads as "effectivePlan took
  // something away", which is false for the freshman row that had nothing to
  // take, and it would resurrect the same disagreement by another route.
  // Grandfathered rows never get here (daysPastDue answers null for them, and the
  // early return above already left).
  const pastDue = late !== null && late >= DEGRADE_DAYS;

  // The plan that unlocks the list. Every gate in the repo is discovery today,
  // so this is the highest `requires` among the locked entries and nothing is
  // lost by collapsing them into one number. IF A goto GATE IS EVER ADDED, one
  // requiredPlan can no longer describe a mixed list honestly — the payload
  // needs a per-item plan then, and the client's single "See plans" line with
  // it. Stated here because that is the change that would quietly start lying.
  const requiredPlan = locked.reduce(
    (highest, f) => ((rankOf(f.requires) ?? 0) > (rankOf(highest) ?? 0) ? f.requires : highest),
    locked[0].requires,
  );

  const context = {
    planName: PLAN_LABELS[requiredPlan] ?? requiredPlan,
    late,
    // null for an uncapped vendor, but itemCap is only IN the list when it is a
    // number, so the copy that reads this always gets one.
    cap: itemCap(vendor, now),
  };

  return {
    reason: pastDue ? 'past_due' : 'upgrade',
    plan,
    nominalPlan,
    requiredPlan,
    // A number in the past_due case and null otherwise. `late` can be non-null
    // while this is null — a vendor 5 days late has a count but has lost nothing
    // yet — and putting that number on a lock panel would describe the debt as
    // the reason for a lock the debt did not cause. It is the same number
    // planRejection puts in `daysPastDue` on its PLAN_PAST_DUE body, so the panel
    // and the 402 quote one figure.
    daysPastDue: pastDue ? late : null,
    items: locked.map((f) => ({
      key: f.key,
      label: f.label,
      detail: (pastDue ? f.pastDue : f.upgrade)(context),
    })),
  };
}
