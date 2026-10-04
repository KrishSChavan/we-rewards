// "Come back and spend what you already have" (migration-060).
//
// Students sign up, earn at a counter once, and then never redeem. Nothing in
// the app is wrong for them; they simply forget it is there. So this is the one
// notification WeRewards sends ON ITS OWN BEHALF — no vendor queued it, no
// student walked past anything. It goes out roughly twice a week and its whole
// job is to say one true, concrete thing about what is waiting for them.
//
// THE BUDGET IS SHARED, NOT PARALLEL, and that is the most important line in
// this file. student_notify_state is one row per student and it is the storm
// budget for EVERY notification feature: vendor deals (campaigns.js,
// migration-032), nearby spot alerts (nearby.js, migration-051), and now these.
// A reminder costs a deal and a deal costs a reminder. The alternative — a
// quota of its own — reads as a smaller number in a config file and arrives on
// a phone as a doubling: a student at their cap for deals would still be
// interrupted by us, which is exactly the storm migration-032 was written to
// prevent, with the house's own name on it. So nothing here re-decides any of
// it. The caps, the four-hour cooldown and quiet hours are CAMPAIGN_CONFIG's
// values, FORWARDED to claim_reminder_pushes and enforced under the same row
// lock the other two features take. See src/lib/nearby.js for the same posture
// at a different seam.
//
// WHY 72 HOURS. The cadence the owner asked for is "about twice a week", and
// the honest way to implement that is a minimum interval rather than a
// schedule: 72h between reminders means at most 2.3 a week, it needs no
// calendar state, and a student the shared budget kept quiet simply becomes due
// again on the next tick instead of losing their turn. The claim orders by who
// has been waiting longest, so a backlog drains fairly.
//
// WHY A CASCADE. A reminder that fires with nothing to say ("open the app!") is
// the kind of notification people turn off, permanently, for every feature at
// once — push permission is one switch and a Block is forever. pickReminder
// therefore walks from the most concrete thing it can truthfully say down to
// the vaguest, and only reaches the generic tier when the first four found
// nothing. Each tier is a fact about THIS student, which is the only reason any
// of this is worth a chirp.
//
// Best-effort throughout, and it never throws upward: a failed tick costs one
// reminder to one student and the next tick picks them up again. Nothing here
// is on a request path.

import { supabaseAdmin } from './supabase.js';
import { CAMPAIGN_CONFIG, createWorkerStatus } from './campaigns.js';
import { pushEnabled, sendToSubscriptionsDetailed, studentSubscriptions } from './push.js';
import { visibleUserIds } from './realtime.js';
import { loadVendorCatalogue, loadRecommendedVendorIds } from './cache.js';
import { readPurses } from './pools.js';
import { logNotification } from './notification-log.js';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * This feature's own knobs, and ONLY its own.
 *
 * Read the absences here as deliberate. cooldownMinutes, dailyCap, weeklyCap,
 * quietStart, quietEnd and timezone are NOT in this object and must never be
 * added to it: they belong to CAMPAIGN_CONFIG and are read from there at call
 * time (see runReminderTick). A second copy of those six numbers would not
 * break anything visibly — it would quietly hand reminders a quota of their own
 * the first time an operator retuned CAMPAIGN_DAILY_CAP and nothing in here
 * moved with it, and the symptom would be a student hearing from us twice as
 * often as the Privacy Policy (§7.4) promises. test/nearby.test.js asserts
 * exactly this property for the nearby claim; this module is written so the
 * same test shape holds here.
 */
export const REMINDER_CONFIG = {
  // The cadence, expressed as a floor rather than a schedule. 72h is "about
  // twice a week" (see the header); raising it is the one safe way to make this
  // feature quieter without touching anything the other two features share.
  minIntervalHours: num('REMINDER_MIN_INTERVAL_HOURS', 72),
  // Students reminded per tick. Small on purpose, like the campaign worker's
  // batch: the claim is ordered by who has waited longest, so a small batch on
  // a short tick drains a backlog fairly instead of blasting the whole campus
  // in one breath — and each student here costs several per-student queries
  // (their purses, their history), which is the real reason not to make this
  // large.
  maxUsers: num('REMINDER_MAX_USERS', 20),
  // Five minutes. Nothing is waiting on a reminder, and with a 72h interval the
  // difference between a 30-second tick and a 5-minute one is invisible to
  // every student while being 10x less load on the claim.
  tickSeconds: num('REMINDER_TICK_SECONDS', 300),
  // How few points short of a reward still counts as "close to one" (tier 2).
  // 25 points is a dollar or two of spending at a typical rate, which is the
  // threshold where "you are nearly there" is a true and actionable statement
  // rather than a nudge to spend forty dollars.
  nearCount: num('REMINDER_NEAR_COUNT', 25),
};

/** The service worker replaces a notification carrying the same tag. */
const REMINDER_TAG = 'wr-reminder';

/* ---------- the cascade (pure, unit-tested) ---------- */

// Notification bodies get truncated by the OS anyway; keep them short enough
// that the truncation is ours and lands on a word.
//
// A near-copy of campaigns.js's clip() rather than an import, because that one
// is module-private there and this file is not allowed to widen its exports.
// If a third copy of this ever appears, that is the moment to promote it.
function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Compare two names for a tie-break. Code-unit order, NOT localeCompare.
 *
 * localeCompare's answer depends on the ICU data the Node build happens to
 * carry, so a tie broken with it can come out one way on a developer's machine
 * and the other way on the dyno — which would make pickReminder's output
 * untestable for exactly the inputs a test would reach for (two vendors, same
 * reward cost). Ugly ordering that is the same everywhere beats pretty ordering
 * that is not.
 */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


/**
 * A reward title as it reads in the middle of a sentence.
 *
 * Vendors type these themselves and they come in two kinds. "Free coffee" and
 * "Half price tacos" are ordinary words that were capitalised only because they
 * sit at the start of a card, and they read badly mid-sentence ("enough for
 * Free coffee"); "Lemont Latte" or "2 for 1" are names and must survive
 * untouched. The regex is the line between them: first letter capital, every
 * other word lowercase, nothing else. Anything with an interior capital, a
 * digit or punctuation is treated as a name and passed through verbatim.
 *
 * NO ARTICLE IS INSERTED, and that is a decision rather than an omission. The
 * owner's example copy read "a free coffee", but there is no reliable way to
 * know from a vendor-typed string whether "a" fits: "Half price tacos" would
 * become "a half price tacos", and reading like a broken mail merge costs more
 * trust than the missing article buys.
 */
function rewardPhrase(title) {
  const t = String(title ?? '').trim();
  if (!t) return 'a reward';
  // QUOTED AND VERBATIM, rather than lowercased and slotted into a sentence as
  // this used to be. The old form produced "That is enough for free slice.",
  // because it dropped the article its own empty-title fallback implies, and
  // the article cannot be restored safely: vendors name rewards freely, so the
  // set includes singulars ("Free coffee" -> a), vowels ("Any entree" -> an),
  // plurals ("Free tacos" -> no article at all) and counted titles ("2 free
  // sides"). Guessing wrong is visible to every student who gets that reward.
  //
  // Quoting sidesteps the grammar entirely and reads as what it is: the name of
  // a thing on their menu. It also keeps the vendor's own capitalisation, which
  // lowercasing was quietly discarding.
  return `“${t}”`;
}

/**
 * Pick the single most concrete true thing we can say to this student.
 *
 * PURE, and deliberately so: everything that needs a database, a clock or a
 * network lives in runReminderTick, and everything that decides what a student
 * is told lives here, where a test can drive it with a literal. No Date.now(),
 * no Math.random(), no I/O — the same ctx always yields the same candidate,
 * ties included.
 *
 * The order is the owner's, and it is a ranking of TRUTHS rather than of
 * features:
 *
 *   1 afford   — "you can have this right now". Nothing beats it, because it is
 *                the only tier where the student needs to do nothing but walk
 *                in. The most EXPENSIVE affordable reward wins: it is the best
 *                thing they can get, and naming the cheapest would undersell a
 *                balance they worked for.
 *   2 close    — "you are nearly there". Ranked above a live deal on purpose:
 *                a shortfall of a few points is about THEIR money, which beats
 *                somebody else's offer. The SMALLEST shortfall wins.
 *   3 deal     — a vendor has something on and they have not opened it yet.
 *   4 discover — somewhere they have never been.
 *   5 generic  — always available, so this function never returns null and the
 *                caller never has to handle "claimed but nothing to say".
 *
 * @param {{
 *   vendors?: Array<{vendorId?:string, name:string, balance:number,
 *                    rewards?:Array<{title:string, cost_in_points:?number, emoji?:string}>}>,
 *   deals?: Array<{dealId?:string, title:string, vendorName?:string, expiresAt?:string}>,
 *   unvisited?: Array<{vendorId?:string, name:string}>,
 *   nearCount?: number
 * }} ctx
 * @returns {{kind:string, vendorName?:string, rewardTitle?:string, points?:number,
 *            shortfall?:number, dealTitle?:string, url:string}}
 */
export function pickReminder(ctx) {
  const vendors = Array.isArray(ctx?.vendors) ? ctx.vendors : [];
  // Overridable so a test can exercise the boundary without reaching into the
  // environment; the default is the shipped knob.
  const near = Number.isFinite(ctx?.nearCount) ? ctx.nearCount : REMINDER_CONFIG.nearCount;

  let afford = null;   // best affordable reward seen so far
  let close = null;    // smallest shortfall seen so far

  for (const v of vendors) {
    const vendorName = String(v?.name ?? '').trim();
    // Carried through the ranking so the winner can be deep-linked to its own
    // screen; stripped back out before the candidate is returned, because the
    // candidate is COPY and an id is not part of it.
    const vendorId = v?.vendorId ?? v?.id ?? null;
    const balance = Number(v?.balance);
    // A vendor we cannot name is a vendor we cannot write a sentence about, and
    // a balance we cannot read is one we must not make a claim about: saying
    // "you have 0 pts" to someone holding 400 is worse than saying nothing.
    if (!vendorName || !Number.isFinite(balance)) continue;

    for (const r of v?.rewards ?? []) {
      if (r?.active === false) continue;
      const rewardTitle = String(r?.title ?? '').trim();
      if (!rewardTitle) continue;
      const cost = Number(r?.cost_in_points);
      // cost_in_points null means this reward is bought with VISITS, not points
      // (migration-029): a punch card. Points can never afford it and a
      // shortfall in points is meaningless for it, so it is not a candidate for
      // either tier. `<= 0` is the same guard for bad data — a zero-cost reward
      // would make every student in the catalogue "able to afford something"
      // and turn this feature into a nightly broadcast about nothing.
      if (r?.cost_in_points == null || !Number.isFinite(cost) || cost <= 0) continue;

      if (balance >= cost) {
        // Most expensive first; then vendor name, then reward title, so two
        // rewards at the same price at the same spot still resolve the same way
        // on every run.
        if (!afford
          || cost > afford.cost
          || (cost === afford.cost && byName(vendorName, afford.vendorName) < 0)
          || (cost === afford.cost && vendorName === afford.vendorName
              && byName(rewardTitle, afford.rewardTitle) < 0)) {
          afford = { kind: 'afford', vendorName, rewardTitle, points: balance, cost, vendorId };
        }
        continue;
      }

      const shortfall = cost - balance;
      if (shortfall > near) continue;
      // THEY MUST ACTUALLY HAVE SOMETHING AT THIS SPOT. Without this line the
      // tier is not "you are nearly there", it is the price list: buildContext
      // maps the WHOLE catalogue, and purses.of() returns 0 for every spot a
      // student has never earned at -- so one vendor anywhere on campus with a
      // reward costing <= nearCount would make EVERY student with no points a
      // permanent tier-2 candidate. That is every new signup, told they are
      // nearly there by a balance of nothing; and because this tier outranks a
      // live deal, it would suppress a real offer in order to say it. A
      // shortfall measured against zero is not progress, it is a price tag.
      if (balance <= 0) continue;
      if (!close
        || shortfall < close.shortfall
        || (shortfall === close.shortfall && byName(vendorName, close.vendorName) < 0)
        || (shortfall === close.shortfall && vendorName === close.vendorName
            && byName(rewardTitle, close.rewardTitle) < 0)) {
        close = { kind: 'close', vendorName, rewardTitle, points: balance, shortfall, vendorId };
      }
    }
  }

  // `cost` and `vendorId` were the ranking key and the link source; neither is
  // copy, so neither survives into the candidate the composer sees.
  if (afford) {
    const { cost: _cost, vendorId, ...out } = afford;
    return { ...out, url: spotUrl(vendorId) };
  }
  if (close) {
    const { vendorId, ...out } = close;
    return { ...out, url: spotUrl(vendorId) };
  }

  // Tier 3. Soonest to expire wins, because urgency is the only thing that
  // distinguishes two offers we did not write. Parsed to epoch ms rather than
  // compared as strings: Postgres hands timestamptz back as '…+00:00' while
  // toISOString() produces '…Z', so a lexicographic compare of the two is wrong
  // in a way that only shows up at certain times of day (the same trap
  // GET /api/me/balances documents). An unparseable date sorts last rather than
  // winning by accident.
  const deals = (Array.isArray(ctx?.deals) ? ctx.deals : [])
    .filter((d) => String(d?.title ?? '').trim());
  if (deals.length) {
    const expiry = (d) => {
      const t = Date.parse(d?.expiresAt ?? '');
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    };
    const best = deals.reduce((a, b) => {
      const ea = expiry(a);
      const eb = expiry(b);
      if (eb < ea) return b;
      if (eb > ea) return a;
      // Ties break toward the alphabetically FIRST, the same direction tiers 1
      // and 2 resolve theirs. Both directions are deterministic, so this is
      // consistency rather than correctness -- but one function that broke the
      // same kind of tie two different ways would be read as a bug by whoever
      // next touched it, and they would be right to wonder.
      const t = byName(String(a.title).trim(), String(b.title).trim());
      if (t < 0) return a;
      if (t > 0) return b;
      return byName(String(a.vendorName ?? ''), String(b.vendorName ?? '')) <= 0 ? a : b;
    });
    return {
      kind: 'deal',
      dealTitle: String(best.title).trim(),
      vendorName: String(best.vendorName ?? '').trim() || undefined,
      // The deep link the student app already understands: ?deal=<id> opens the
      // list with that campaign pulled to the top, ?deals=1 just opens the list.
      url: best.dealId ? `/?deal=${encodeURIComponent(best.dealId)}` : '/?deals=1',
    };
  }

  // Tier 4. The caller hands these over ALREADY RANKED (most-visited campus
  // spots first, see unvisitedFor), so the first one is the most popular place
  // this student has never walked into. Taking [0] keeps the function pure and
  // keeps the ranking decision where the data is.
  const unvisited = (Array.isArray(ctx?.unvisited) ? ctx.unvisited : [])
    .filter((v) => String(v?.name ?? '').trim());
  if (unvisited.length) {
    const spot = unvisited[0];
    return {
      kind: 'discover',
      vendorName: String(spot.name).trim(),
      url: spotUrl(spot.vendorId),
    };
  }

  // Tier 5. Reached when we know nothing specific — a brand-new student whose
  // catalogue read failed, or a regular who has been everywhere and can afford
  // nothing. It says something true about the app instead of a false thing
  // about them.
  return { kind: 'generic', url: '/' };
}

/** ?spot=<vendorId> opens that spot's own screen (migration-051's deep link). */
function spotUrl(vendorId) {
  return vendorId ? `/?spot=${encodeURIComponent(vendorId)}` : '/';
}

/**
 * Turn a candidate into the notification the student actually sees. PURE.
 *
 * Same clipping discipline as composeNotification in campaigns.js (60 for a
 * title, 140 for a body) and the same reason: the OS truncates both anyway, so
 * the only question is whether the cut is ours and lands on a word.
 *
 * THE REPO COPY RULE applies to every string below: no em dashes in anything a
 * student can read (test/campaigns.test.js enforces it for the campaign
 * payloads and the same rule holds here). Full stops and plain words only.
 *
 * The tone is the owner's: warm, and concrete about one thing. Every body names
 * either a number that is theirs or a place they can walk to, because a
 * reminder that could have been sent to anybody is one people turn off.
 *
 * @param {ReturnType<typeof pickReminder>} candidate
 * @returns {{title:string, body:string, url:string, tag:string}|null}
 */
export function composeReminder(candidate) {
  const kind = candidate?.kind;
  if (!kind) return null;
  const url = candidate.url || '/';
  const vendor = String(candidate.vendorName ?? '').trim();

  const out = (title, body) => ({
    title: clip(title, 60),
    body: clip(body, 140),
    url,
    // The belt-and-braces half of the throttle: a notification carrying a tag
    // already in the shade REPLACES it rather than stacking, and the service
    // worker's renotify:false means the replacement is silent. A tag of its own
    // (not 'wr-deals') so a reminder never silently swallows a vendor's live
    // deal, which is the message the student would rather have.
    tag: REMINDER_TAG,
  });

  // THE VOICE. Warm, specific, and at most one exclamation mark per LINE (so a
  // notification carries two: the title and the body).
  //
  // One each, not three, and that restraint is the product decision rather than a
  // style preference: browser push permission is one-shot, and migration-032's
  // header spells out that once a student taps Block, requestPermission() no-ops
  // forever and the deal alerts die with it. A reminder is the least welcome of
  // the four things that can reach them (it is the only one with no news in it),
  // so it has to read like a friend pointing something out, not like marketing.
  // Cheerful earns its place; shouty costs the other three features.
  //
  // Every line also stays CONCRETE. "Your points are waiting!" on its own is the
  // kind of notification people mute; the same sentence with the spot, the number
  // and the reward named is one they act on. The happiness is in the framing, not
  // in replacing the facts with enthusiasm.
  //
  // No em dashes anywhere (the repo copy rule, asserted per tier in
  // test/reminders.test.js), and deliberately no randomised variants: this
  // function is pure and a test pins that equal inputs produce equal output, so
  // the same student never sees a different sentence for the same situation.
  switch (kind) {
    case 'afford':
      return out(
        // DERIVED, never asserted. Reward titles are typed by vendors and include
        // discounts ("Half price tacos", "$2 off any sub"), so a hardcoded
        // "Free food is waiting!" would sit above a body quoting a reward that
        // costs money and contradict itself. The free framing is kept where the
        // vendor's own words earn it and dropped everywhere else.
        /^free\b/i.test(String(candidate.rewardTitle ?? '').trim())
          ? 'Free food is waiting!'
          : 'Treat yourself!',
        `You have ${candidate.points} pts at ${vendor}, enough for ${rewardPhrase(candidate.rewardTitle)}. Go claim it!`
      );
    case 'close':
      return out(
        'So close!',
        `Just ${candidate.shortfall} pts to go and ${rewardPhrase(candidate.rewardTitle)} at ${vendor} is yours!`
      );
    case 'deal':
      return out(
        'Something good is on!',
        vendor
          ? `${vendor} has something on: ${candidate.dealTitle}. Have a look!`
          : `${candidate.dealTitle}. Have a look!`
      );
    case 'discover':
      return out(
        'A new spot to try!',
        `You have not been to ${vendor} yet. It could be your new go-to!`
      );
    default:
      // The generic tier, and anything a future tier forgets to handle. The one
      // line here with no number in it, so it is the one that has to work
      // hardest: it promises a look rather than a reward, because this tier
      // fires precisely when we have nothing specific to offer.
      return out(
        'Your points are waiting!',
        'Take a look at what your points can get you today. Free food might be closer than you think!'
      );
  }
}

/* ---------- the tick ---------- */

let timer = null;
let running = false;   // one tick at a time, whatever the interval does

const ZERO = { claimed: 0, delivered: 0, refunded: 0 };

/**
 * Students a recent tick claimed and then could not reach, with the ms it
 * happened, so the next tick does not pick them straight back up.
 *
 * WHY A REFUND IS NOT ENOUGH. refund_reminder_push correctly gives the BUDGET
 * back, and to do that it nulls last_reminder_at -- which is also the claim's
 * queue key, ordered `nulls first`. So a refund hands the student their slot
 * back AND returns them to the very head of the queue. For a transient failure
 * that is exactly right. For an endpoint that fails with a code push.js does
 * not prune (it deletes only on 401/403/404/410, so a 500, a network drop, or a
 * malformed p256dh survives) it is a loop: claimed, failed, refunded,
 * re-claimed thirty seconds later, forever, holding a queue slot the migration's
 * own p_skip_users comment says the caller is meant to release.
 *
 * In memory rather than a column, deliberately. It is a scheduling hint, not a
 * fact about the student: losing it on deploy just means one extra attempt, and
 * a dyno that has forgotten is a dyno that correctly retries after an outage.
 */
const recentlyFailed = new Map();

/** How long a failed student is passed over. One day: long enough that a dead
 *  endpoint stops hogging the head of the queue, short enough that a push
 *  service having a bad afternoon costs one reminder rather than a week of them. */
const FAILED_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** The still-live entries, pruned as we read them so the map cannot grow without bound. */
function backedOffUserIds(now) {
  for (const [id, at] of recentlyFailed) {
    if (now - at >= FAILED_BACKOFF_MS) recentlyFailed.delete(id);
  }
  return [...recentlyFailed.keys()];
}

/**
 * Who the worker is currently passing over, and until when, for /admin's queue
 * view (it marks those students "backing off"). A copy: the admin API reads
 * it, it never steers the worker.
 * @returns {Array<{userId: string, until: string}>}
 */
export function reminderBackoff() {
  const now = Date.now();
  backedOffUserIds(now);
  return [...recentlyFailed].map(([userId, at]) => ({
    userId,
    until: new Date(at + FAILED_BACKOFF_MS).toISOString(),
  }));
}

const workerStatus = createWorkerStatus();

/** The interval startReminderWorker arms, floor included. */
const periodSeconds = () => Math.max(REMINDER_CONFIG.tickSeconds, 30);

/** Contract §3.5 status for /admin; see createWorkerStatus in campaigns.js. */
export function reminderWorkerStatus() {
  return workerStatus.snapshot({
    configured: pushEnabled,
    running: timer !== null,
    intervalSeconds: periodSeconds(),
  });
}

/**
 * Every live, unopened deal for a whole batch of students, as
 * userId -> [{dealId, title, vendorName, expiresAt}].
 *
 * ONE query for the batch rather than one per student, which is the only reason
 * tier 3 is cheap enough to have at all: twenty students would otherwise be
 * twenty round trips for a tier that usually loses to tiers 1 and 2 anyway.
 *
 * Unopened only (`read_at is null`): a deal the student has already seen in
 * their in-app list is not news, and spending a reminder to tell them about it
 * again is the kind of notification that teaches people to ignore the next one.
 *
 * Never throws. Tier 3 simply does not fire if this fails; the cascade below it
 * still has somewhere to go.
 */
async function liveDealsFor(userIds) {
  const byUser = new Map();
  if (!userIds.length) return byUser;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('campaign_recipients')
      .select('user_id, campaign_id, read_at, vendor_campaigns!inner(title, expires_at, vendor_id, vendors!inner(name, active))')
      .in('user_id', userIds)
      .is('read_at', null)
      .gt('vendor_campaigns.expires_at', nowIso)
      // A ceiling well under supabase/config.toml's PostgREST max_rows = 1000,
      // so this can never be the query that truncates in silence. At maxUsers
      // students this is ten live deals each, which is already far more than the
      // one we are going to name.
      .limit(200);
    if (error) throw error;
    for (const r of data ?? []) {
      // The active-vendor filter is done here rather than in the query for the
      // same reason GET /api/me/deals does it here: filtering across two levels
      // of PostgREST embedding is the sort of syntax that breaks quietly on a
      // client upgrade, and this list is a handful of rows.
      if (!r.vendor_campaigns?.vendors?.active) continue;
      const list = byUser.get(r.user_id) ?? [];
      list.push({
        dealId: r.campaign_id,
        title: r.vendor_campaigns.title,
        vendorName: r.vendor_campaigns.vendors.name,
        expiresAt: r.vendor_campaigns.expires_at,
        // Not read by pickReminder (a deal candidate is copy, not ids); kept so
        // the notification log can link the spot a tier-3 reminder named.
        vendorId: r.vendor_campaigns.vendor_id ?? null,
      });
      byUser.set(r.user_id, list);
    }
  } catch (err) {
    console.warn(`[reminders] live deals unavailable, skipping that tier: ${err?.message ?? err}`);
  }
  return byUser;
}

/**
 * Popular spots this student has never been to, best first.
 *
 * `null` back from student_visited_vendor_ids (migration-048) means "could not
 * find out", NOT "has been nowhere", and the difference decides whether tier 4
 * may run at all. "You have never been to X" is a CLAIM about a student's whole
 * history, said out loud, on their lock screen — and on the fallback it would be
 * said about the spot they go to every day. So a doubt here returns an empty
 * list and the cascade drops to the generic tier, which is the same choice
 * GET /api/me/balances makes with its `visitedKnown` flag and for the same
 * reason.
 */
async function unvisitedFor(userId, catalogue, recommendedIds) {
  if (!recommendedIds.length) return [];
  const { data, error } = await supabaseAdmin.rpc('student_visited_vendor_ids', { p_user_id: userId });
  if (error) {
    console.warn(`[reminders] visited history unavailable (run migration-048?): ${error.message}`);
    return [];
  }
  const visited = new Set((data ?? []).map((r) => r.vendor_id));
  const names = new Map((catalogue ?? []).map((v) => [v.id, v.name]));
  // recommendedIds is already ranked by visits over the last 30 days
  // (top_vendors_by_visits), so this preserves "most popular first" for free.
  // An id missing from the catalogue is a vendor deactivated since the ranking
  // was cached, and is dropped rather than named.
  return recommendedIds
    .filter((id) => !visited.has(id) && names.has(id))
    .map((id) => ({ vendorId: id, name: names.get(id) }));
}

/**
 * Everything pickReminder needs about one student. Never throws.
 *
 * A FAILED PURSE READ DROPS THE VENDOR LIST ENTIRELY, rather than falling back
 * to zeros. readPurses' own `?? 0` is correct for a student with no row (no row
 * really is no points), but a read that FAILED is a different thing: with
 * balances defaulted to zero, tier 2 would tell a student holding 400 points
 * that they are 20 points short of a coffee. Dropping the tiers that depend on
 * money leaves the deal and discover tiers intact and says nothing false.
 */
async function buildContext(userId, catalogue, recommendedIds, deals) {
  let vendors = [];
  try {
    const purses = await readPurses(userId);
    vendors = (catalogue ?? []).map((v) => ({
      vendorId: v.id,
      name: v.name,
      // The PURSE, not point_balances (migration-044): a pooled spot the student
      // has never walked into still holds the chain's balance, and reading the
      // wrong table would tell them they have nothing where they have plenty.
      balance: purses.of(v),
      // Switched-off rewards are still on the catalogue row; naming one would
      // send a student in for something the counter will refuse.
      rewards: (v.rewards ?? []).filter((r) => r.active !== false),
    }));
  } catch (err) {
    console.warn(`[reminders] balances unavailable for user=${userId}, skipping the points tiers: ${err?.message ?? err}`);
  }

  let unvisited = [];
  try {
    unvisited = await unvisitedFor(userId, catalogue, recommendedIds);
  } catch (err) {
    console.warn(`[reminders] discover tier unavailable for user=${userId}: ${err?.message ?? err}`);
  }

  return { vendors, deals, unvisited };
}

/**
 * Give one student's spent budget back, because the send bought nothing.
 *
 * The claim SPENDS the cooldown, the daily count and the weekly count before
 * anything is delivered (it has to: the decision and the spend must happen
 * under one row lock, or two workers both get a slot). So a claim that reached
 * no endpoint has silenced that student for four hours — for deals and nearby
 * alerts too, since the budget is shared — in exchange for nothing. That is the
 * hole migration-033 opened finish_campaign_batch's refund for, and this is the
 * same reversal for this feature.
 *
 * Never throws. A refund that fails costs one student one quiet afternoon,
 * which is not worth taking the tick down over.
 */
async function refundReminder(userId) {
  try {
    const { data, error } = await supabaseAdmin.rpc('refund_reminder_push', { p_user_id: userId });
    if (error) {
      console.warn(`[reminders] refund failed user=${userId} (run migration-060?): ${error.message}`);
      return false;
    }
    if (data !== true) {
      // The row is created by the claim's own backfill, so there should always
      // be one. "No row updated" means something else deleted it between the
      // claim and here (an account deletion, in practice).
      console.warn(`[reminders] nothing to refund for user=${userId}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[reminders] refund threw user=${userId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * The spot a candidate is about, as an id, for the log's vendor link.
 *
 * pickReminder strips ids out of the candidate on purpose (it is copy), so the
 * id is recovered from what it left behind rather than by matching on the
 * vendor's NAME: names are not unique (chains share one), and a wrong link in
 * the admin log is worse than none. Tiers 1, 2 and 4 deep-link to ?spot=<id>;
 * tier 3 links ?deal=<campaignId>, whose vendor is on the deal row.
 */
function candidateVendorId(candidate, deals) {
  const url = String(candidate?.url ?? '');
  const spot = /^\/\?spot=([^&]+)/.exec(url);
  if (spot) {
    try { return decodeURIComponent(spot[1]); } catch { return null; }
  }
  const deal = /^\/\?deal=([^&]+)/.exec(url);
  if (deal) {
    let id = null;
    try { id = decodeURIComponent(deal[1]); } catch { return null; }
    return (deals ?? []).find((d) => d?.dealId === id)?.vendorId ?? null;
  }
  return null;
}

/**
 * The log row for one claimed student (contract §3.2), written after the
 * refund so `refunded` reports what refund_reminder_push actually answered,
 * not what was intended: "refunded" on a row whose refund failed would tell
 * the operator the student's budget is intact when it is not.
 */
function logReminder({ userId, candidate, payload, deals, outcome, reason = null, devices = [], refunded }) {
  const ref = { tier: candidate?.kind ?? null };
  if (candidate?.vendorName) ref.vendorName = candidate.vendorName;
  if (candidate?.rewardTitle) ref.rewardTitle = candidate.rewardTitle;
  if (refunded !== undefined) ref.refunded = refunded;
  logNotification({
    channel: 'push',
    kind: 'reminder',
    outcome,
    reason,
    recipientKind: 'student',
    studentId: userId,
    vendorId: candidateVendorId(candidate, deals),
    title: payload?.title,
    body: payload?.body,
    url: payload?.url,
    template: payload?.tag ?? null,
    devices,
    ref,
  });
}

/**
 * What a reminder to this student would say right now, without sending it.
 *
 * For /admin's queue view ("Preview" on a reminder row). The SAME reads, the
 * same cascade and the same composer the tick runs, so the preview cannot
 * drift from the real thing; and NOTHING else. It never calls
 * claim_reminder_pushes (that spends the shared budget), never calls
 * refund_reminder_push, never sends, never logs, and does not consult
 * pushEnabled: an operator debugging a server with no VAPID keys still wants
 * to see what the copy would be.
 *
 * @param {string} userId
 * @returns {Promise<{candidate: object|null, composed: object|null}>}
 *   both null when there is nothing to say (or no student to say it to)
 */
export async function previewReminder(userId) {
  if (typeof userId !== 'string' || !userId.trim()) return { candidate: null, composed: null };
  let catalogue = [];
  let recommendedIds = [];
  try {
    [catalogue, recommendedIds] = await Promise.all([loadVendorCatalogue(), loadRecommendedVendorIds()]);
  } catch (err) {
    console.warn(`[reminders] preview: catalogue unavailable, cascade degraded: ${err?.message ?? err}`);
  }
  const dealsByUser = await liveDealsFor([userId]);
  const ctx = await buildContext(userId, catalogue, recommendedIds, dealsByUser.get(userId) ?? []);
  const candidate = pickReminder(ctx);
  const composed = composeReminder(candidate);
  if (!composed) return { candidate: null, composed: null };
  return { candidate, composed };
}

/**
 * One pass: claim, compose, send, refund what did not land.
 *
 * Exported so a test or an operator can drive a single pass by hand, exactly as
 * campaigns.js exports runCampaignTick. Resolves rather than throwing in every
 * failure mode, including a missing migration.
 *
 * @returns {Promise<{claimed:number, delivered:number, refunded:number}>}
 */
export async function runReminderTick() {
  // NO DATABASE CALL AT ALL when push is unconfigured, and this is the single
  // most important line in the function. The claim is what spends a student's
  // cooldown and caps, so a tick that could not possibly deliver must never
  // reach it: claiming here would silence a student for four hours — deals and
  // nearby alerts included — over a notification that was never going to be
  // sent. test/campaigns.test.js asserts this shape for the campaign worker by
  // proving it touches no socket; the same reasoning is the whole reason this
  // check sits above everything else rather than inside the loop.
  if (!pushEnabled) return { ...ZERO };

  // The tick swallows its own failures (it resolves ZERO), so it reports them
  // to the status through `t` rather than by throwing.
  const started = Date.now();
  const t = { error: null };
  const result = await reminderTick(t);
  if (t.error) workerStatus.tickFailed(started, t.error);
  else workerStatus.tickDone(started, result);
  return result;
}

async function reminderTick(t) {
  try {
    const { data: rows, error } = await supabaseAdmin.rpc('claim_reminder_pushes', {
      p_max_users: REMINDER_CONFIG.maxUsers,
      // Do not interrupt someone who is already looking at the app: the chirp
      // achieves nothing and spending their shared quota to send it is actively
      // harmful. Same exclusion the campaign worker makes, from the same source.
      // Two exclusions, one argument. visibleUserIds() is "do not interrupt
      // someone already looking at the app"; backedOffUserIds() is "do not
      // re-claim whoever we just failed to reach" -- see recentlyFailed, and the
      // p_skip_users comment in migration-060 which asks the caller for exactly
      // this. Deduped because the two can overlap.
      p_skip_users: [...new Set([...visibleUserIds(), ...backedOffUserIds(Date.now())])],
      p_min_interval_hours: REMINDER_CONFIG.minIntervalHours,
      // CAMPAIGN_CONFIG's own values, FORWARDED rather than copied — see
      // REMINDER_CONFIG's comment. One place to retune the storm defences, and
      // no way for a third feature to drift into believing a student has a
      // bigger budget than the other two think they do.
      p_cooldown_minutes: CAMPAIGN_CONFIG.cooldownMinutes,
      p_daily_cap: CAMPAIGN_CONFIG.dailyCap,
      p_weekly_cap: CAMPAIGN_CONFIG.weeklyCap,
      p_quiet_start: CAMPAIGN_CONFIG.quietStart,
      p_quiet_end: CAMPAIGN_CONFIG.quietEnd,
      p_timezone: CAMPAIGN_CONFIG.timezone,
    });
    if (error) {
      // The one failure worth naming. Without migration-060 applied the RPC is
      // simply absent and the feature is silently off forever with no other
      // symptom, so the log line says which migration to run — the same shape
      // as the migration-051 warning in src/lib/nearby.js.
      console.warn(`[reminders] claim unavailable (run migration-060?): ${error.message}`);
      workerStatus.claimFailed(error);
      t.error = error;
      return { ...ZERO };
    }
    workerStatus.claimOk();

    const userIds = [...new Set((rows ?? []).map((r) => r.out_user_id).filter(Boolean))];
    if (!userIds.length) return { ...ZERO };

    // Three reads for the whole batch, before the loop. The catalogue and the
    // Recommended ranking are identical for every student and both are cached
    // (src/lib/cache.js), so this is usually zero round trips; the deals read is
    // one query for everybody. Everything per-student stays inside the loop
    // because it has to.
    let catalogue = [];
    let recommendedIds = [];
    try {
      [catalogue, recommendedIds] = await Promise.all([loadVendorCatalogue(), loadRecommendedVendorIds()]);
    } catch (err) {
      // The cascade degrades rather than stopping: with no catalogue there are
      // no points tiers and no discover tier, and a claimed student still gets
      // a deal or the generic reminder instead of a refund.
      console.warn(`[reminders] catalogue unavailable, cascade degraded: ${err?.message ?? err}`);
    }
    const dealsByUser = await liveDealsFor(userIds);

    let delivered = 0;
    let refunded = 0;
    // SEQUENTIAL ON PURPOSE, the same way the campaign worker is: a push
    // service will happily rate-limit a burst of parallel sends from one origin,
    // and a rate-limited send is a spent budget with nothing delivered. Nobody
    // is waiting on a reminder, so a steady trickle costs nothing — and each
    // student here is several queries, which a parallel loop would multiply into
    // a spike on the database as well.
    for (const userId of userIds) {
      // Each student's work is wrapped on its own, and the outer catch is not a
      // substitute for it. Every id in this list has ALREADY had its cooldown
      // and both counters spent by the claim, and the refund for each is issued
      // down at the foot of this body -- so an exception that escaped to the
      // outer catch would leave every student after the throwing one silenced
      // for four hours with no refund and no record, because by then their ids
      // are out of scope. Nothing here is expected to throw (buildContext
      // catches its own awaits, the send has its own try, refundReminder
      // catches); this is so that one bad student costs one reminder.
      let accepted = 0;
      let candidate = null;
      let payload = null;
      // For the log row at the foot of this body: what the send did, if it ran.
      let sendResult = null;
      let sendThrew = false;
      const deals = dealsByUser.get(userId) ?? [];
      try {
        const ctx = await buildContext(userId, catalogue, recommendedIds, deals);
        candidate = pickReminder(ctx);
        payload = composeReminder(candidate);
      } catch (err) {
        console.error(`[reminders] could not build a reminder for user=${userId}: ${err?.message ?? err}`);
        payload = null;                // falls through to the refund below
      }

      if (payload) {
        try {
          const subs = await studentSubscriptions(userId);
          sendResult = await sendToSubscriptionsDetailed(subs, payload);
          accepted = sendResult.accepted;
          // The claim has ALREADY spent this student's cooldown and both counts,
          // so a silent zero here is four hours of silence that bought nothing.
          // The tier is in the line because it is the one thing the refund
          // cannot tell you afterwards: a tier that never lands points at the
          // cascade, not at the endpoint.
          if (accepted === 0) {
            console.warn(`[reminders] nothing accepted user=${userId} tier=${candidate?.kind} endpoints=${subs.length} — refunding`);
          }
        } catch (err) {
          console.error(`[reminders] send threw for user=${userId}: ${err?.message ?? err}`);
          accepted = 0;
          sendThrew = true;
        }
      } else {
        // pickReminder's generic tier means this cannot happen today. It is
        // handled anyway because the alternative is a student silenced for four
        // hours by a future tier that forgot to compose anything.
        console.warn(`[reminders] nothing to say to user=${userId} — refunding`);
      }

      if (accepted > 0) {
        delivered += 1;
        // Reached them, so whatever went wrong before is over.
        recentlyFailed.delete(userId);
        logReminder({ userId, candidate, payload, deals, outcome: 'sent', devices: sendResult?.devices ?? [] });
      } else {
        // Before the refund, not after: the refund is what puts them back at the
        // head of the queue, so the thing that keeps them out of the next claim
        // has to be recorded whether or not the refund itself succeeds.
        recentlyFailed.set(userId, Date.now());
        const didRefund = await refundReminder(userId);
        if (didRefund) refunded += 1;
        let outcome = 'failed';
        let reason = 'no_device_accepted';
        if (!payload) { outcome = 'refused'; reason = 'content_empty'; }
        else if (sendThrew) reason = 'send_error';
        else if (!sendResult?.tried) reason = 'no_devices';
        logReminder({
          userId, candidate, payload, deals, outcome, reason,
          devices: sendResult?.devices ?? [],
          refunded: didRefund,
        });
      }
    }
    return { claimed: userIds.length, delivered, refunded };
  } catch (err) {
    // Never throws upward: this is a background sweep with nothing downstream of
    // it, and the next tick retries from scratch. Same posture as claimNearby.
    console.error(`[reminders] tick failed: ${err?.message ?? err}`);
    t.error = err;
    return { ...ZERO };
  }
}

/**
 * Start the reminder loop.
 *
 * No-op when push is unconfigured — no timer, nothing armed, which matters
 * because this worker's only job is to send push: unlike campaigns there is no
 * in-app list that still fills up and no email fallback, so with no VAPID keys
 * there is literally nothing for a tick to do but spend budgets. (That is also
 * why the tick's own guard is the first line in it: this one can be bypassed by
 * calling runReminderTick directly, and the one that protects a student cannot
 * live only in the caller.)
 *
 * `running` guards against overlap, so a slow tick is never joined by the next
 * one claiming the same students again, and the timer is unref'd so it cannot
 * hold the process open during shutdown. Both mirror startReferralWorker.
 */
export function startReminderWorker() {
  if (timer || !pushEnabled) return;
  // A floor, so a mistyped REMINDER_TICK_SECONDS (0, or a negative) cannot turn
  // this into a hot loop against the claim. 30s is already absurdly often for a
  // feature whose interval is three days.
  const period = periodSeconds() * 1000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReminderTick();
      if (r.claimed) {
        console.log(`[reminders] tick claimed=${r.claimed} delivered=${r.delivered} refunded=${r.refunded}`);
      }
    } catch (err) {
      // runReminderTick already swallows everything; this is the belt under it.
      console.error(`[reminders] tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  }, period);
  timer.unref();
}

export function stopReminderWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
