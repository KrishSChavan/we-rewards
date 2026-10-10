// The bonus window (migration-063) — incentive kind #3.
//
// "Between Friday 5pm and Sunday midnight, everything earned at every spot is
// worth 2x." The operator creates one in /admin → Incentives, turns it on, and
// every award at every active vendor is multiplied until it ends.
//
// ⚠ THIS KIND SPENDS VENDOR POINTS, NOT COMMUNITY POINTS. Every other incentive
// pays out of the cross-vendor community pool precisely so the platform is
// never handing away a vendor's product on their behalf (migration-039's
// header). This one scales the balance a student spends AT THE SHOP, at every
// active shop, with no vendor opt-in. The thin guard rails are: the window is
// created switched off, both dates are REQUIRED (see validIncentive in
// src/routes/admin.js), and maxMultiplier caps the combined multiplier.
// bonus_window_credits is what lets the operator answer a vendor who asks what
// it cost them.
//
// WHERE THIS IS CALLED FROM, and the one rule both call sites share. Two earn
// paths exist and both compute points in JavaScript before handing an integer
// to the database: POST /api/vendor/award (a terminal) and POST /api/me/receipt
// (a claimed paper receipt). Both call bonusBoost() in place of reading
// tierProfile.multiplier directly, and both then log through
// logBonusWindowCredit(). award_points is NOT touched — see migration-063 on
// why that is worth protecting.
//
// ⚠ A FAILURE HERE PAYS THE BASE RATE, IT NEVER FAILS THE SALE. Every function
// below returns rather than throwing, and a bonusBoost() that cannot read the
// incentives table resolves to "no window" — the student earns what they would
// have earned on an ordinary day, and a cashier sees a successful award. That
// direction is not arbitrary: 039's header states the rule this file inherits,
// that nothing a cashier does can ever fail because of the incentives system.
// The cost of the other direction is a customer told their points didn't go
// through, at a counter, in front of them.

import { supabaseAdmin } from './supabase.js';
import { bonusWindowCache } from './cache.js';
import { pushEnabled } from './push.js';
import { punchTimezone } from './punch.js';

/** What the admin form starts from. Only a pre-fill; a saved window keeps its own. */
export const BONUS_WINDOW_DEFAULTS = {
  multiplier: 2,
  maxMultiplier: 3,
  // Announce it to every student the moment it goes live. ON by default because
  // a promotion nobody is told about is a discount, not a promotion — but it is
  // a per-window switch so a quiet window (a test, a single slow Tuesday) does
  // not require a code change. See runBonusWindowAnnounceTick.
  announce: true,
};

/**
 * ⚠ HALF STEPS ONLY, AND IT IS NOT A STYLE CHOICE. Both award paths carry the
 * same comment about why they use pointsFor() instead of `Math.floor(dollars *
 * ratio)`: the inputs are decimal money, doubles are binary, and the naive
 * product lands a hair below the whole number for many ordinary amounts, so the
 * floor pays the customer one point less than the rate on their receipt
 * promised. src/lib/tiers.js then gets away with a plain float multiply for the
 * tier, and says exactly why: "every multiplier in src/lib/tiers.js is 1, 1.5
 * or 2 — all exact in binary, so there is no dust for the floor to eat."
 *
 * A window multiplier of 1.1 or 2.3 would end that. It is not representable, so
 * `basePoints * applied` would land fractionally low on some amounts and the
 * floor would eat a point — the bug the whole award path is written to avoid,
 * reintroduced from the one direction nobody would look. Multiples of 0.5 are
 * exact, their products with the tier multipliers (1, 1.5, 2) are multiples of
 * 0.25 and also exact, and nothing a promotion wants to say — double points,
 * triple points, 1.5x — needs finer than half steps.
 *
 * Changing STEP to anything that is not a negative power of two reopens this.
 */
const MULTIPLIER_STEP = 0.5;
const MULTIPLIER_MIN = 1.5;      // below this it is not a promotion
const MULTIPLIER_MAX = 5;
const CAP_MAX = 10;

/** The tier multipliers a window combines with, for the admin form's preview. */
const TIER_MULTIPLIERS = [1, 1.5, 2];

/** Is this a clean multiple of MULTIPLIER_STEP? See the note above. */
const onStep = (n) => Number.isFinite(n) && Math.abs(n / MULTIPLIER_STEP - Math.round(n / MULTIPLIER_STEP)) < 1e-9;

const fmt = (n) => String(Number(n));

/**
 * Validate the admin form's knobs. Never throws; the caller turns error into a
 * 400. Mirrors validSignupConfig's contract exactly.
 */
export function validBonusWindowConfig(raw) {
  const body = raw ?? {};

  const blank = (v) => v === '' || v == null;
  const multiplier = blank(body.multiplier) ? BONUS_WINDOW_DEFAULTS.multiplier : Number(body.multiplier);
  if (!onStep(multiplier) || multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) {
    return {
      error: `The multiplier must be between ${fmt(MULTIPLIER_MIN)} and ${fmt(MULTIPLIER_MAX)}, `
        + `in steps of ${fmt(MULTIPLIER_STEP)} — so 1.5, 2, 2.5 and so on.`,
    };
  }

  const maxMultiplier = blank(body.maxMultiplier)
    ? BONUS_WINDOW_DEFAULTS.maxMultiplier
    : Number(body.maxMultiplier);
  if (!onStep(maxMultiplier) || maxMultiplier < MULTIPLIER_MIN || maxMultiplier > CAP_MAX) {
    return {
      error: `The cap must be between ${fmt(MULTIPLIER_MIN)} and ${fmt(CAP_MAX)}, `
        + `in steps of ${fmt(MULTIPLIER_STEP)}.`,
    };
  }

  // A cap below the window's own multiplier is always an operator mistake: it
  // silently makes the headline number unreachable, so a "2x weekend" capped at
  // 1.5 would pay 1.5x to everybody and nothing on screen would explain why.
  if (maxMultiplier < multiplier) {
    return { error: `The cap can’t be lower than the multiplier itself (${fmt(multiplier)}x).` };
  }

  // A checkbox, so there is nothing to get wrong and nothing to refuse — but it
  // is read defensively rather than with Boolean(), because this value decides
  // whether the entire student body is interrupted. Boolean('false') is true,
  // and a form that ever serialises its checkbox as a string would silently
  // turn every "don't announce" into an announcement. Only an explicit false
  // marker is false; anything missing falls back to the default.
  const raw_announce = body.announce;
  const announce = (raw_announce === undefined || raw_announce === null || raw_announce === '')
    ? BONUS_WINDOW_DEFAULTS.announce
    : !(raw_announce === false || raw_announce === 'false' || raw_announce === 0 || raw_announce === '0');

  return { config: { multiplier, maxMultiplier, announce } };
}

/**
 * The combined multiplier, and whether the cap bit. PURE — this is the half
 * worth testing hard, because it decides what every award during a window pays.
 *
 * The two multipliers MULTIPLY rather than taking the higher or adding: a
 * student who has earned 2x through thirty days of visiting should get more out
 * of a double-points weekend than one who just joined, which is what the tier
 * system is for. The cap is what keeps that from running away — 2x tier times
 * 2x window is 4x, and four times the usual product off one ticket is not a
 * promotion, it is a mistake with a multiplication sign in it.
 *
 * ⚠ THE CAP FLATTENS THE TOP TIERS, by construction. With a 2x window capped at
 * 3x, a tier-2 student (1.5x) and a tier-3 student (2x) both land on exactly 3x
 * and the tier-3 student's extra loyalty buys nothing that weekend. That is
 * inherent to capping a product, not a bug, and it is why the admin panel draws
 * the effective multiplier for all three tiers next to the form instead of
 * leaving the operator to work it out.
 */
export function effectiveMultiplier({ tierMultiplier, windowMultiplier, maxMultiplier }) {
  const tier = Number(tierMultiplier) || 1;
  // No window, or a nonsense one: the tier's own multiplier, untouched. Never a
  // throw and never a 0 — this runs inside an award.
  if (!Number.isFinite(Number(windowMultiplier)) || Number(windowMultiplier) <= 1) {
    return { applied: tier, capped: false };
  }
  const cap = Number.isFinite(Number(maxMultiplier)) && Number(maxMultiplier) >= 1
    ? Number(maxMultiplier)
    : Infinity;

  const product = tier * Number(windowMultiplier);
  const applied = Math.min(product, cap);
  // Both are exact in binary (see MULTIPLIER_STEP), so this comparison is
  // meaningful rather than a float coin toss.
  return { applied, capped: applied < product };
}

/** What the three tiers would actually earn under these knobs. Admin preview. */
export function tierPreview({ multiplier, maxMultiplier }) {
  return TIER_MULTIPLIERS.map((tierMultiplier) => {
    const { applied, capped } = effectiveMultiplier({
      tierMultiplier, windowMultiplier: multiplier, maxMultiplier,
    });
    return { tierMultiplier, applied, capped };
  });
}

/** The columns the window is read with. Shared so no caller invents its own. */
const WINDOW_COLS = 'id, name, active, starts_at, ends_at, config';

/**
 * The one live bonus window, or null.
 *
 * migration-039's partial unique index guarantees at most one active row per
 * kind, so the first match is the only one there could be. The date window is
 * applied HERE rather than in SQL for the same reason activeSignupProgram does
 * it: the admin tab shows a finished window still marked active — which is the
 * truth — while it quietly stops multiplying.
 *
 * ⚠ NEVER THROWS, and returns null on any failure. See the header: a window
 * that cannot be read has to degrade to an ordinary day, not to a failed award.
 * The cache's stale-on-error window (10 minutes, src/lib/cache.js) means a
 * Supabase blip keeps serving the last known answer long before this catch is
 * reached; the catch is the floor under that.
 */
export async function activeBonusWindow() {
  try {
    const row = await bonusWindowCache.get('active', async () => {
      const { data, error } = await supabaseAdmin
        .from('incentives')
        .select(WINDOW_COLS)
        .eq('kind', 'bonus_window')
        .eq('active', true)
        .limit(1);
      // Thrown so the cache's stale-on-error path can see it — a loader that
      // returned null here would CACHE "there is no window" for the whole TTL
      // on one bad read, which during a live weekend is 30 seconds of awards
      // quietly paying the base rate.
      if (error) throw error;
      return data?.[0] ?? null;
    });

    if (!row) return null;
    const now = Date.now();
    if (row.starts_at && new Date(row.starts_at).getTime() > now) return null;
    if (row.ends_at && new Date(row.ends_at).getTime() <= now) return null;
    return row;
  } catch (err) {
    // One line, not silence: a window an operator has turned on and students
    // have been pushed about, quietly paying base rate, is worth finding in the
    // logs. Not a throw, for the reason in the header.
    console.warn(`[bonus-window] read failed, awarding base rate: ${err?.message ?? err}`);
    return null;
  }
}

/** Drop the cached window. Called by every admin write to an incentive. */
export function invalidateBonusWindow() {
  bonusWindowCache.invalidate();
}

/**
 * THE AWARD-PATH HELPER. Both earn paths call this instead of reading
 * tierProfile.multiplier, and use `applied` as their multiplier.
 *
 * @param {number} tierMultiplier the student's tier multiplier (src/lib/tiers.js)
 * @returns {Promise<{applied:number, tierMultiplier:number, windowMultiplier:number|null,
 *                    capped:boolean, window:object|null}>}
 *          `applied` is always a usable multiplier, window or not.
 */
export async function bonusBoost(tierMultiplier) {
  const tier = Number(tierMultiplier) || 1;
  const window = await activeBonusWindow();
  if (!window) {
    return { applied: tier, tierMultiplier: tier, windowMultiplier: null, capped: false, window: null };
  }
  const cfg = { ...BONUS_WINDOW_DEFAULTS, ...(window.config ?? {}) };
  const { applied, capped } = effectiveMultiplier({
    tierMultiplier: tier,
    windowMultiplier: cfg.multiplier,
    maxMultiplier: cfg.maxMultiplier,
  });
  return {
    applied,
    tierMultiplier: tier,
    windowMultiplier: cfg.multiplier,
    capped,
    window,
  };
}

/**
 * Record what a window added to one award. BEST EFFORT, ALWAYS — see the header
 * and migration-063's note on why this table is a report and not a ledger. The
 * points have already moved and `transactions` is their record; this row only
 * answers "what did the promotion cost, and at which spots".
 *
 * Writes NOTHING when the window added nothing. That is the cap-clamped case —
 * a 2x window capped at 2x pays a tier-3 student exactly their tier's 2x — and
 * a row claiming zero exposure would make the awards count wrong while adding
 * no information. The CHECK in migration-063 says the same thing.
 *
 * @param {object} a
 * @param {object} a.boost        what bonusBoost() returned
 * @param {number} a.basePoints   pre-multiplier points
 * @param {number} a.awarded      what was actually awarded (post-floor)
 * @param {'counter'|'receipt'} a.source which earn path
 */
export async function logBonusWindowCredit({
  boost, userId, vendorId, basePoints, awarded, source, clientToken = null,
}) {
  try {
    if (!boost?.window) return;
    // What the tier alone would have paid, floored the same way the award path
    // floors — so bonusPoints is the true marginal difference between the two
    // worlds and not an estimate that drifts by a point.
    const withoutWindow = Math.floor(basePoints * boost.tierMultiplier);
    const bonusPoints = awarded - withoutWindow;
    if (!(bonusPoints > 0)) return;

    const { error } = await supabaseAdmin.from('bonus_window_credits').insert({
      incentive_id: boost.window.id,
      user_id: userId,
      vendor_id: vendorId,
      base_points: basePoints,
      bonus_points: bonusPoints,
      tier_multiplier: boost.tierMultiplier,
      window_multiplier: boost.windowMultiplier,
      applied_multiplier: boost.applied,
      source,
      client_token: clientToken,
    });
    if (error) {
      // 23505 is the retry landing on idx_bonus_credits_once, which is the index
      // doing its job rather than a fault: the original award already logged
      // this exposure and counting it twice is the thing being prevented.
      if (error.code !== '23505') {
        console.warn(`[bonus-window] credit not logged for ${userId}: ${error.message}`);
      }
    }
  } catch (err) {
    console.warn(`[bonus-window] credit log threw: ${err?.message ?? err}`);
  }
}

/**
 * What a signed-in student's app needs to draw the window, or null. Served on
 * GET /api/me/tier — the endpoint the home screen already polls for its
 * multiplier chip, so this is one field on an existing call rather than a new
 * round trip, the same trick publicSignupBonus plays on /api/public-config.
 *
 * Deliberately says nothing about the cap or the per-tier maths: the student is
 * told the multiplier THEY get (`applied`, computed against their own tier) and
 * when it ends. "Capped at 3x" is an operator's concern and would read as a
 * limit being imposed on them.
 */
export async function studentBonusWindow(tierMultiplier) {
  const boost = await bonusBoost(tierMultiplier);
  if (!boost.window) return null;
  return {
    name: boost.window.name,
    multiplier: boost.applied,        // what THIS student earns
    windowMultiplier: boost.windowMultiplier,
    endsAt: boost.window.ends_at,
  };
}

/* ============================================================
 * The announcement (migration-061's broadcast rail).
 *
 * Turning a window on changes what points are worth and, by itself, tells
 * nobody. This is what tells them: one push to every student the moment the
 * window is live, through create_admin_broadcast — so it inherits push_opt_in,
 * quiet hours and the shared two-a-day cap that Privacy Policy §7.4 promises,
 * rather than inventing a second way to interrupt people.
 *
 * ⚠ EXACTLY ONCE PER WINDOW, AND THE DATABASE IS WHAT GUARANTEES IT. This runs
 * on a timer, on every dyno, forever — so "have we already announced this one?"
 * cannot be a variable. migration-061 put a unique index on
 * (created_by, client_token) and made create_admin_broadcast return the FIRST
 * broadcast for a repeated token instead of erroring, which is precisely the
 * primitive this needs: a fixed created_by plus a token derived from the
 * window's id means the second, hundredth and ten-thousandth tick all resolve
 * to the row the first one wrote. Two dynos racing, a deploy mid-window, a
 * restart loop, an operator toggling the window off and on again - none of them
 * can produce a second push.
 *
 * ⚠ WHICH IS ALSO WHY `created_by` MUST NOT BE NULL. A unique index treats
 * NULLs as distinct, so (null, 'bonus-window-open:x') would collide with
 * nothing and every tick would queue the student body again. SYSTEM_ACTOR below
 * is the whole reason that cannot happen.
 * ============================================================ */

/**
 * The nil UUID, standing for "WeRewards itself, on a timer" in
 * admin_broadcasts.created_by.
 *
 * That column is documented as the operator who sent it and deliberately
 * carries NO foreign key ("a record of who addressed the student body must
 * outlive the account that did it"), so a sentinel is already within what it
 * models. A real operator's id is a random v4 and can never be this. Nothing
 * reads created_by back - GET /api/admin/broadcasts does not even select it -
 * so this is invisible in the dashboard, which lists the push next to the
 * hand-written ones exactly as it should.
 */
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/** Per window, not per send. This string IS the once-only guarantee. */
const announceToken = (incentiveId) => `bonus-window-open:${incentiveId}`;

// Mirrors BROADCAST_TITLE_MAX / BROADCAST_BODY_MAX in src/routes/admin.js. The
// route enforces them on a hand-typed broadcast; this path does not go through
// the route, so it has to respect the same shade-sized limits itself.
const TITLE_MAX = 60;
const BODY_MAX = 140;

/** How often to check whether a window has just opened. */
const tickSeconds = () => {
  const n = Number(process.env.BONUS_WINDOW_TICK_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

/**
 * "Sunday 11:59 PM", IN CAMPUS TIME.
 *
 * ⚠ The timezone is not cosmetic. A dyno runs in UTC, so a window ending at
 * 11:59 PM Sunday on campus formats as 3:59 AM Monday without this, and the
 * push would name a day and an hour that are simply wrong to every single
 * person reading it. punchTimezone() is the same campus clock the receipt path
 * already trusts for "was this receipt printed today".
 */
function endsLabel(endsAt) {
  const d = new Date(endsAt ?? NaN);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString('en-US', {
      timeZone: punchTimezone(),
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    // An unparseable PUNCH_TIMEZONE must not cost the whole announcement; a
    // push with no deadline still says the thing that matters.
    return null;
  }
}

/**
 * The push, generated from the window. PURE and exported so it can be asserted.
 *
 * ⚠ NO EM DASHES. The repo copy rule covers everything a student reads, and the
 * hand-typed path refuses them outright in POST /api/admin/broadcasts ("Use a
 * comma or a full stop instead"). This path bypasses that route entirely, so
 * the rule has to be kept here on purpose rather than caught downstream - and a
 * generated string is the one that would put an em dash in front of the whole
 * campus at once. test/bonus-window.test.js pins it, the same way
 * broadcasts.test.js and campaigns.test.js pin their composers.
 *
 * THE HEADLINE IS THE WINDOW'S MULTIPLIER, NOT ANY ONE STUDENT'S. One push goes
 * to everybody, their tiers differ, and the banner in the app shows each of
 * them what they personally earn (studentBonusWindow). So this promises the
 * floor and the app pays more; the reverse would be a lie to most of them.
 */
export function announceCopy(window) {
  const cfg = { ...BONUS_WINDOW_DEFAULTS, ...(window?.config ?? {}) };
  const x = `${Number(cfg.multiplier)}x`;
  const until = endsLabel(window?.ends_at);

  const title = (until ? `${x} points until ${until}` : `${x} points right now`).slice(0, TITLE_MAX);
  // The name is operator-written and could be anything, so it is not spliced
  // into the body: the sentence has to still read correctly, and the name is
  // already the heading of the card in the app.
  const body = (until
    ? `Every purchase at every spot earns ${x} points until ${until}. Your tier multiplier still stacks on top.`
    : `Every purchase at every spot earns ${x} points right now. Your tier multiplier still stacks on top.`
  ).slice(0, BODY_MAX);

  return { title, body, url: '/' };
}

/**
 * Has this window's announcement been queued, and how is it getting on?
 * Returns null when it has not been sent.
 *
 * Exported so GET /api/admin/incentives can answer "did the push actually go
 * out?" without knowing about SYSTEM_ACTOR or the token shape — those stay
 * private to this file, which is the only thing that may mint them. One indexed
 * read for one row, on a panel one person opens.
 *
 * `sent` lags `queued` by design and is not a fault: the worker drains the queue
 * under the shared two-a-day cap and quiet hours, so a window announced at 2am
 * legitimately shows 0 sent until morning. The panel says as much.
 */
export async function announceBroadcastFor(incentiveId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('admin_broadcasts')
      .select('id, status, queued_count, sent_count, created_at')
      .eq('created_by', SYSTEM_ACTOR)
      .eq('client_token', announceToken(incentiveId))
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      at: data.created_at,
      status: data.status,
      queued: data.queued_count ?? 0,
      sent: data.sent_count ?? 0,
    };
  } catch (err) {
    // A panel that cannot say whether the push went out is a worse panel, not a
    // broken one. Null reads as "not announced yet", which is the safe way to
    // be wrong here: it never claims a push happened that did not.
    console.warn(`[bonus-window] announce lookup failed for ${incentiveId}: ${err?.message ?? err}`);
    return null;
  }
}

/* ---------- the worker ---------- */

let timer = null;
let running = false;

/**
 * Announce the live window if it has not been announced yet. Idempotent, cheap
 * when there is nothing to do, and it never throws.
 *
 * THE CHEAP PATH IS THE NORMAL PATH. There is no live window on almost every
 * tick of almost every day, and activeBonusWindow() answers that from a 30
 * second cache, so the overwhelming majority of ticks do no I/O at all.
 *
 * @returns {Promise<{announced: number, queued: number, skipped: string|null}>}
 */
export async function runBonusWindowAnnounceTick() {
  const none = { announced: 0, queued: 0, skipped: null };
  // Same load-bearing no-op as the broadcast worker's: create_admin_broadcast
  // materialises a recipient row per student, and queueing the entire student
  // body for a worker that cannot deliver would leave those rows to sit until
  // they expire. With no VAPID keys there is nothing to announce with.
  if (!pushEnabled) return { ...none, skipped: 'push-disabled' };

  try {
    const window = await activeBonusWindow();
    if (!window) return none;                       // nothing live: the usual answer

    const cfg = { ...BONUS_WINDOW_DEFAULTS, ...(window.config ?? {}) };
    if (!cfg.announce) return { ...none, skipped: 'announce-off' };

    const token = announceToken(window.id);

    // Asked BEFORE creating, so a window that has already been announced costs
    // one indexed read rather than an RPC that materialises and discards an
    // audience. It is an optimisation and not the correctness story: two dynos
    // can both get past this line, and create_admin_broadcast's token index is
    // what makes the loser harmless.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('admin_broadcasts')
      .select('id')
      .eq('created_by', SYSTEM_ACTOR)
      .eq('client_token', token)
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) return none;

    const copy = announceCopy(window);
    const { data, error } = await supabaseAdmin.rpc('create_admin_broadcast', {
      p_created_by: SYSTEM_ACTOR,
      p_title: copy.title,
      p_body: copy.body,
      p_url: copy.url,
      p_audience: 'all',
      p_vendor_id: null,
      p_client_token: token,
    });
    if (error) throw error;

    const row = data?.[0] ?? {};
    const queued = row.out_queued ?? 0;

    // ⚠ EXPIRE IT WITH THE WINDOW, not at migration-061's default 48 hours.
    // A student whose four-hour cooldown or daily cap kept them out of the
    // queue would otherwise be told "2x points until Sunday" on Tuesday, for a
    // promotion that ended. 061 reasoned exactly this way about stale news; it
    // just had no way to know when a given announcement went stale. This one
    // does: the window's own end.
    //
    // Best effort and deliberately AFTER the create: the announcement going out
    // matters more than its expiry being tidy, and a failure here leaves the
    // 48-hour default rather than nothing. Not a parameter of
    // create_admin_broadcast, so it cannot be set in the same call.
    if (row.out_id && window.ends_at) {
      const { error: expErr } = await supabaseAdmin
        .from('admin_broadcasts')
        .update({ expires_at: window.ends_at })
        .eq('id', row.out_id);
      if (expErr) {
        console.warn(`[bonus-window] could not shorten expiry on ${row.out_id}: ${expErr.message}`);
      }
    }

    console.log(`[bonus-window] announced "${window.name}" to ${queued} student(s)`);
    return { announced: 1, queued, skipped: null };
  } catch (err) {
    // Never throws upward: this is a background tick, and the next one retries
    // from scratch because every decision above is re-derived from the database.
    // The window keeps multiplying points either way - the announcement is how
    // students hear about it, not what makes it work.
    console.error(`[bonus-window] announce tick failed: ${err?.message ?? err}`);
    return { ...none, skipped: 'error' };
  }
}

/**
 * Start the announce loop. Same posture as the four workers beside it in
 * server.js: only when the server is run directly, so importing `app` in a test
 * never spins up a background loop, and a complete no-op without VAPID keys.
 *
 * THE TIMER IS NOT THE SCHEDULE, for the same reason startReminderWorker's
 * isn't. A single web dyno restarts on every deploy and cycles daily, so a
 * timer that tried to fire AT the window's start would miss it outright if the
 * dyno happened to be restarting. Instead every tick asks the database "is a
 * window live, and has it been announced?" - so any tick that happens to run
 * does the right thing and the rest are free.
 *
 * 60 seconds, so a window opens and students hear within the minute.
 */
export function startBonusWindowWorker() {
  if (timer || !pushEnabled) return;
  timer = setInterval(async () => {
    if (running) return;      // a slow tick is never joined by the next one
    running = true;
    try {
      await runBonusWindowAnnounceTick();
    } catch (err) {
      // runBonusWindowAnnounceTick already swallows everything; belt under it.
      console.error(`[bonus-window] announce tick threw: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
    // A floor, so a mistyped BONUS_WINDOW_TICK_SECONDS cannot turn this into a
    // hot loop against the broadcasts table.
  }, Math.max(tickSeconds(), 15) * 1000);
  timer.unref();              // must not hold the process open during shutdown
}

export function stopBonusWindowWorker() {
  // Safe having never started, and safe twice: server.js runs the shutdown path
  // regardless of what was ever armed.
  if (timer) clearInterval(timer);
  timer = null;
}
