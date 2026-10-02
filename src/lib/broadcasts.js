// "One thing we want every student to hear" (migration-061).
//
// Every other notification this system sends is composed by somebody who is not
// WeRewards, or by nobody at all: a vendor writes a deal (campaigns.js,
// migration-032), proximity writes a nearby alert (nearby.js, migration-051),
// and the ABSENCE of activity writes a reminder (reminders.js, migration-060).
// This is the one path where the house speaks for itself -- "six new spots just
// joined", "the terminal is down this evening", "redeem by Friday" -- and it is
// driven by hand from the /admin Broadcast tab rather than by a rule.
//
// THE BUDGET IS SHARED, NOT PARALLEL, and that is the most important paragraph
// in this file for exactly the reason it is the most important one in
// reminders.js. student_notify_state is ONE row per student and it is the storm
// budget for all four features at once: a broadcast costs a deal alert, a
// nearby alert and a reminder, and each of those costs a broadcast. An
// exemption for our own announcements was the obvious alternative and it is
// wrong in a way a student can quote back at us, because
// legal/student-privacy-policy.html section 7.4 says, in these words: "Two per
// day is the total number of times WeRewards will interrupt you, whatever the
// reason." "Whatever the reason" includes our reasons. So nothing here
// re-decides any of it: the caps, the four-hour cooldown and quiet hours are
// CAMPAIGN_CONFIG's values, FORWARDED to claim_admin_broadcast_pushes and
// enforced under the same per-student row lock the other three features take.
// See the absences in BROADCAST_CONFIG below, which are the whole mechanism.
//
// WHY THIS FILE IS A WORKER AND NOT A SEND. The operator presses one button and
// may be addressing the entire student body, and three things follow from that.
// A web request cannot hold a few thousand sequential pushes open; a dyno
// restart mid-send (Heroku cycles them daily, and every deploy is one) must not
// lose or duplicate the back half; and a push service will rate-limit a
// parallel burst from one origin, which is a spent budget with nothing
// delivered. So the route materialises admin_broadcast_recipients in full and
// answers the operator with a count of what was QUEUED, and everything after
// that is this file draining that queue a few students at a time.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DECIDE. Who is in an audience
// (admin_broadcast_audience), whether a given student may be interrupted right
// now (the claim, under FOR UPDATE SKIP LOCKED on their budget row), when an
// announcement has gone stale (expires_at, 48 hours, because a student whose
// cooldown kept them out of the queue for a week does not want last week's
// news) and what a failed send costs (finish_admin_broadcast's refund) all live
// in migration-061. What is left on this side is the seam between the two:
// forward the shared knobs, compose the payload, send it, and settle every
// single claimed row.
//
// Best-effort throughout, and it never throws upward: a failed tick costs one
// broadcast to one student and the next tick picks that recipient row straight
// back up. Nothing here is on a request path.

import { supabaseAdmin } from './supabase.js';
import { CAMPAIGN_CONFIG } from './campaigns.js';
import { pushEnabled, sendToSubscriptions, studentSubscriptions } from './push.js';
import { visibleUserIds } from './realtime.js';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * This feature's own knobs, and ONLY its own.
 *
 * Read the absences here as deliberate, and as the single defence this module
 * has. cooldownMinutes, dailyCap, weeklyCap, quietStart, quietEnd and timezone
 * are NOT in this object and must never be added to it: they belong to
 * CAMPAIGN_CONFIG, they are read from there at call time (see
 * runBroadcastTick) and they are promised to students in
 * legal/student-privacy-policy.html section 7.4. A second copy of those six
 * numbers would not break anything visibly -- it would quietly hand broadcasts
 * a quota of their OWN the first time an operator retuned CAMPAIGN_DAILY_CAP
 * and nothing in here moved with it, and the symptom would be a student hearing
 * from us twice as often as that document promises, with the house's name on
 * the extra one. test/nearby.test.js and test/reminders.test.js each pin this
 * property for their feature (the assertion that matters is the one that
 * RETUNES the environment, because only that one can tell a forward apart from
 * a copy that happens to agree today); this module is written so the same test
 * shape holds here.
 */
export const BROADCAST_CONFIG = {
  // Students pushed per tick. 40 matches the campaign worker's batch rather
  // than the reminder worker's 20, because a broadcast row is cheap on this
  // side: the claim already returned the copy, so each student here is one
  // subscription read and one send, with none of the per-student purse and
  // history queries that keep REMINDER_CONFIG.maxUsers small.
  maxUsers: num('BROADCAST_MAX_USERS', 40),
  // Thirty seconds, not the reminder worker's five minutes, and the difference
  // is the operator rather than the student. Somebody is standing in front of
  // /admin having just pressed Send on a message to the whole campus, and a
  // queue that visibly starts moving is the only feedback that tells them it
  // worked. It costs nothing to be impatient here: what actually paces delivery
  // is the SHARED four-hour cooldown inside the claim, not this timer, so a
  // tick that runs ten times more often simply finds nobody eligible ten times
  // more often and returns no rows.
  tickSeconds: num('BROADCAST_TICK_SECONDS', 30),
};

/**
 * The tag this feature's notifications carry, and it is its own value on
 * purpose.
 *
 * A notification whose tag is already in the shade REPLACES the one that is
 * there rather than stacking beside it, and the service worker sets
 * renotify:false, so the replacement is silent. That is the belt-and-braces
 * half of the throttle when a feature collides with itself -- and it is exactly
 * why this must not be 'wr-deals' or 'wr-reminder': an operator announcement
 * arriving under the deals tag would silently swallow an unread notification
 * about a vendor's live deal, which is the message the student would rather
 * have had, and neither of us would ever know it happened.
 */
const BROADCAST_TAG = 'wr-broadcast';

/* ---------- payload composition (pure, unit-tested) ---------- */

// Notification bodies get truncated by the OS anyway; keep them short enough
// that the truncation is ours and lands on a word.
//
// THE THIRD COPY of campaigns.js's clip(), and the comment on the second one
// (in reminders.js) says that a third is the moment to promote it to a shared
// module. That is still the right call, but promoting it means editing
// campaigns.js and reminders.js, and this change may only add this file -- so
// the duplication is left standing and named here instead of being quietly
// repeated for a third time. Any of the three may be the one that moves.
function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Turn one claimed broadcast row into the notification the student sees. PURE.
 *
 * Same clipping discipline as composeNotification in campaigns.js (60 for a
 * title, 140 for a body) and the same reasoning: both get truncated by the OS
 * regardless, so the only question is whether the cut is ours and lands on a
 * word rather than mid-syllable.
 *
 * THE WORDS ARE PASSED THROUGH VERBATIM, which is a decision rather than an
 * oversight. The repo copy rule (no em dash in anything a student reads,
 * enforced by "no em dashes reach a student" in test/campaigns.test.js) binds
 * the strings WE write, and this composer writes none: every character of the
 * title and body was typed by a human in /admin. Rewriting an operator's
 * punctuation on its way to a lock screen would change a message its author
 * already approved, and composeNotification sets the precedent by passing a
 * vendor's own deal copy through untouched. The copy rule belongs in the
 * composer UI, where the person who typed the character can see the warning and
 * decide.
 *
 * The url is likewise trusted: migration-061's comment on admin_broadcasts.url
 * says it is validated as a same-origin path by the route and deliberately NOT
 * by a check constraint, since URL shapes are exactly the thing that changes.
 * All that is left here is the default.
 *
 * NULL FOR AN UNUSABLE ROW rather than a blank chirp. create_admin_broadcast
 * raises TITLE_REQUIRED and BODY_REQUIRED so this should be unreachable, but a
 * notification with no words is the single worst thing this feature could
 * deliver: a student who is interrupted by an empty bubble has no idea what it
 * was and one of the few reasons to turn push off permanently, for every
 * feature at once, because permission is one switch. The caller treats null as
 * a failed send, so the row is requeued and the slot refunded instead.
 *
 * @param {{title?:string, body?:string, url?:string}} row  the claim's copy
 * @returns {{title:string, body:string, url:string, tag:string}|null}
 */
export function composeBroadcast(row) {
  // Both spellings accepted. claim_admin_broadcast_pushes returns its columns
  // out_-prefixed (out_title, out_body, out_url), and PostgREST hands them back
  // under exactly those names -- so accepting either shape means a test, or an
  // operator debugging in a REPL, can pass a raw claim row without having to
  // know which end of the seam renamed what.
  const title = clip(row?.title ?? row?.out_title, 60);
  const body = clip(row?.body ?? row?.out_body, 140);
  // Checked AFTER clipping, because clip() trims: a title of three spaces is
  // not a title, and it is the kind of thing a copy-paste produces.
  if (!title || !body) return null;

  const url = String(row?.url ?? row?.out_url ?? '').trim() || '/';

  return { title, body, url, tag: BROADCAST_TAG };
}

/* ---------- the tick ---------- */

let timer = null;
let running = false;   // one tick at a time, whatever the interval does

const ZERO = { claimed: 0, delivered: 0, failed: 0 };

/**
 * Students a recent tick claimed and could not reach, with the ms it happened,
 * so the next tick does not pick the same ones straight back up.
 *
 * THE SAME MECHANISM src/lib/reminders.js CARRIES, and it is not optional here
 * either -- it is worse here, because this queue has an order. A failed settle
 * calls finish_admin_broadcast(false), which sets last_push_at = null to give
 * the budget back and requeues the recipient; the claim then sorts candidates
 * `order by b.created_at, r2.user_id` (migration-061). That order is STABLE, so
 * a student whose endpoint fails with a code push.js does not prune (it deletes
 * only on 401/403/404/410, so a 500, a dropped socket or a malformed p256dh
 * survives) is re-claimed on the very next tick, and on every tick after it.
 *
 * Below p_max_users such students that is merely wasted sends. At or above it --
 * forty, by default -- they fill every batch for the whole 48-hour expires_at
 * window and NOBODY ELSE IN THE AUDIENCE EVER RECEIVES THE BROADCAST. The
 * operator watches sent_count sit far below queued_count with no error anywhere,
 * having already told the campus something.
 *
 * In memory rather than a column, for the same reason reminders.js chose that: it
 * is a scheduling hint, not a fact about the student. Losing it on deploy costs
 * one extra attempt, and a dyno that has forgotten is a dyno that correctly
 * retries after a push service's bad afternoon.
 */
const recentlyFailed = new Map();

/** How long a failed student is passed over. Shorter than the reminder worker's
 *  day, because a broadcast expires in 48 hours and a student skipped for 24 of
 *  them has lost half their chance of hearing it at all. */
const FAILED_BACKOFF_MS = 2 * 60 * 60 * 1000;

/** The still-live entries, pruned as they are read so the map cannot grow without bound. */
function backedOffUserIds(now) {
  for (const [id, at] of recentlyFailed) {
    if (now - at >= FAILED_BACKOFF_MS) recentlyFailed.delete(id);
  }
  return [...recentlyFailed.keys()];
}

/**
 * Settle one claimed recipient, whatever became of the send.
 *
 * EVERY row the claim returns must come through here exactly once. The claim
 * SPENDS that student's cooldown and both counters before anything is
 * delivered -- it has to, or two workers both get a slot -- so a row that is
 * never settled costs twice over: the student is silenced for four hours
 * (deals, nearby alerts and reminders included) in exchange for nothing, and
 * their recipient row sits in 'sending' until the claim's own ten-minute sweep
 * notices and requeues it.
 *
 * `delivered` false is therefore not an error path, it is the REFUND:
 * finish_admin_broadcast requeues the recipient and gives the shared slot back
 * (migration-061 section 6, the same reversal migration-033 opened for
 * finish_campaign_batch).
 *
 * Never throws, and safe to call twice. The updates key on status = 'sending',
 * so a second call finds nothing, refunds nothing and returns false -- which is
 * what lets the per-row catch below attempt a last-resort requeue without any
 * risk of refunding a slot twice.
 *
 * @returns {Promise<boolean>} whether the database actually moved the row
 */
async function settle(broadcastId, userId, delivered) {
  try {
    const { data, error } = await supabaseAdmin.rpc('finish_admin_broadcast', {
      p_broadcast_id: broadcastId,
      p_user_id: userId,
      p_delivered: delivered,
    });
    if (error) {
      // .rpc() RESOLVES with an error rather than throwing, so without this a
      // failing settle looked exactly like a successful one -- the bug
      // campaigns.js's settle() documents at the same seam.
      console.warn(`[broadcasts] settle failed broadcast=${broadcastId} user=${userId} (run migration-061?): ${error.message}`);
      return false;
    }
    if (data !== true) {
      // Something moved the row between the claim and here: the claim's own
      // sweep requeueing a 'sending' row this tick took more than ten minutes
      // over, or its housekeeping pass expiring the broadcast under us. Worth a
      // line, because this is also what a double settle looks like.
      console.warn(`[broadcasts] nothing to settle broadcast=${broadcastId} user=${userId} delivered=${delivered}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[broadcasts] settle threw broadcast=${broadcastId} user=${userId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * One pass: claim a few recipients, send to each, settle every one of them.
 *
 * Exported so a test or an operator can drive a single pass by hand, exactly as
 * campaigns.js exports runCampaignTick and reminders.js exports
 * runReminderTick. Resolves rather than throwing in every failure mode,
 * including a missing migration.
 *
 * @returns {Promise<{claimed:number, delivered:number, failed:number}>}
 */
export async function runBroadcastTick() {
  // NO DATABASE CALL AT ALL when push is unconfigured, and this is the single
  // most important line in the function. The claim is what spends a student's
  // cooldown and both caps, so a tick that could not possibly deliver must
  // never reach it: claiming here would silence a student for four hours --
  // deals, nearby alerts and reminders included -- over a notification that was
  // never going to be sent, and the recipient row would come back round as
  // 'queued' having achieved exactly nothing. Unlike campaigns.js there is no
  // second transport to fall back to (migration-061 has no email path on
  // purpose: an announcement that missed its push has usually missed its
  // moment), so push alone decides whether this tick has any business running.
  // test/campaigns.test.js and test/reminders.test.js both assert this shape by
  // proving the tick touches no socket; the same reasoning is why this check
  // sits above everything else rather than inside the loop.
  if (!pushEnabled) return { ...ZERO };

  // Outside the try so the catch can still read it. Once the claim returns, this
  // many students have had their shared budget spent and their recipient rows
  // moved to 'sending', whatever happens next.
  let claimedCount = 0;

  try {
    const { data: rows, error } = await supabaseAdmin.rpc('claim_admin_broadcast_pushes', {
      p_max_users: BROADCAST_CONFIG.maxUsers,
      // Do not interrupt someone who is already looking at the app: the chirp
      // achieves nothing and spending their shared quota to send it is actively
      // harmful. Same exclusion the campaign worker makes, from the same
      // source. (Single-instance, like the rate limiter: on a multi-dyno deploy
      // this degrades to "some foreground students still get a push", never to
      // a double send -- the recipient row's primary key is what guarantees
      // that second part.)
      // Two exclusions, one argument. visibleUserIds() is "do not interrupt
      // someone already looking at the app"; backedOffUserIds() is "do not
      // re-claim whoever we just failed to reach", which is what stops a handful
      // of dead endpoints starving the rest of an audience -- see recentlyFailed.
      // Deduped, because the two sets can overlap.
      p_skip_users: [...new Set([...visibleUserIds(), ...backedOffUserIds(Date.now())])],
      // CAMPAIGN_CONFIG's own values, FORWARDED rather than copied -- see
      // BROADCAST_CONFIG's comment. One place to retune the storm defences, and
      // no way for a fourth feature to drift into believing a student has a
      // bigger budget than the other three think they do.
      p_cooldown_minutes: CAMPAIGN_CONFIG.cooldownMinutes,
      p_daily_cap: CAMPAIGN_CONFIG.dailyCap,
      p_weekly_cap: CAMPAIGN_CONFIG.weeklyCap,
      p_quiet_start: CAMPAIGN_CONFIG.quietStart,
      p_quiet_end: CAMPAIGN_CONFIG.quietEnd,
      p_timezone: CAMPAIGN_CONFIG.timezone,
    });
    if (error) {
      // The one failure worth naming. Without migration-061 applied the RPC is
      // simply absent, and the feature is then silently off forever with no
      // other symptom: the /admin tab queues broadcasts that nothing ever
      // drains. So the log line says which migration to run -- the same shape
      // as the migration-051 warning in claimNearby (src/lib/nearby.js) and the
      // migration-060 one in reminders.js.
      console.warn(`[broadcasts] claim unavailable (run migration-061?): ${error.message}`);
      return { ...ZERO };
    }

    const claimedRows = (rows ?? []).filter(Boolean);
    claimedCount = claimedRows.length;
    if (!claimedRows.length) return { ...ZERO };

    let delivered = 0;
    let failed = 0;

    // SEQUENTIAL ON PURPOSE, the same way the campaign and reminder workers
    // are: a push service will happily rate-limit a burst of parallel sends
    // from one origin, and a rate-limited send is a spent budget with nothing
    // delivered -- the precise failure migration-061's header gives as a reason
    // for having a queue at all. Nobody is waiting on a broadcast, and the tick
    // comes round every thirty seconds, so a steady trickle costs nothing.
    //
    // No deduplication by user, unlike the reminder worker: the claim spends
    // the student's budget row as it goes, so the four-hour cooldown it has
    // just written stops that same student being returned for a second
    // recipient row inside one batch. One student, at most one broadcast, per
    // claim.
    for (const row of claimedRows) {
      // Declared here and READ inside the try below, not assigned here. Reading
      // a property is the first thing in this body that can throw, so it has to
      // be the first thing the per-row catch covers -- outside it, one malformed
      // row escapes to the outer catch and defeats the very guard the rest of
      // this block depends on, abandoning every row after it with its budget
      // already spent. The catch still needs the names in scope to settle with,
      // which is why they are `let` out here rather than `const` in there.
      let userId = null;
      let broadcastId = null;
      let accepted = 0;
      // Set immediately BEFORE the settle call rather than after it, so the
      // catch below can tell "we never got that far" from "the database has
      // already been asked". settle() swallows its own failures, so asking and
      // failing is not a reason to ask again.
      let settleAsked = false;

      // Each row's work is wrapped on its own, and the outer catch is NOT a
      // substitute for it. Every row in this list has already had its cooldown
      // and both counters spent by the claim, and the settle for each is issued
      // inside this body -- so an exception that escaped to the outer catch
      // would leave every row AFTER the throwing one unsettled, with its
      // student silenced for four hours and no refund, because by then those
      // ids are out of scope. One bad row must cost one send.
      try {
        userId = row.out_user_id ?? null;
        broadcastId = row.out_broadcast_id ?? null;

        if (!userId || !broadcastId) {
          // Unsettlable: finish_admin_broadcast keys on both ids and returns
          // false for a null either side. Nothing to do but say so loudly and
          // let the claim's ten-minute sweep recover the row, because we cannot
          // name it.
          console.error(`[broadcasts] claimed row with no ids, cannot settle: ${JSON.stringify(row)}`);
          failed += 1;
          continue;
        }

        // The claim returned the copy along with the ids (migration-061 section
        // 5), so there is no second read here: a broadcast carries its own
        // words, unlike a reminder which has to be worked out per student.
        const payload = composeBroadcast({
          title: row.out_title,
          body: row.out_body,
          url: row.out_url,
        });

        if (payload) {
          try {
            const subs = await studentSubscriptions(userId);
            accepted = await sendToSubscriptions(subs, payload);
            if (accepted === 0) {
              // The claim has ALREADY spent this student's cooldown and both
              // counts, so a silent zero here is four hours of silence that
              // bought nothing. The endpoint count is in the line because it is
              // the one thing the requeue cannot tell you afterwards: zero
              // endpoints points at the claim's reachability test racing a
              // revoked permission, while several endpoints that all refused
              // points at push.js and its prune codes.
              console.warn(`[broadcasts] nothing accepted broadcast=${broadcastId} user=${userId} endpoints=${subs.length} — requeueing`);
            }
          } catch (err) {
            console.error(`[broadcasts] send threw broadcast=${broadcastId} user=${userId}: ${err?.message ?? err}`);
            accepted = 0;
          }
        } else {
          // create_admin_broadcast raises TITLE_REQUIRED and BODY_REQUIRED, so
          // this is unreachable today. Handled anyway, because the alternative
          // is a student silenced for four hours by a row that could not be
          // turned into words -- and the requeue is harmless: the next tick
          // will fail to compose it again and the broadcast's own expires_at
          // retires the row within 48 hours.
          console.warn(`[broadcasts] unusable copy broadcast=${broadcastId} user=${userId} — requeueing`);
        }

        // Recorded BEFORE the settle, not after: the settle is what makes this
        // student immediately re-claimable (it nulls last_push_at), so the thing
        // that keeps them out of the next batch has to be written whether or not
        // the settle itself succeeds.
        if (accepted > 0) recentlyFailed.delete(userId);
        else recentlyFailed.set(userId, Date.now());

        settleAsked = true;
        await settle(broadcastId, userId, accepted > 0);
        if (accepted > 0) delivered += 1;
        else failed += 1;
      } catch (err) {
        console.error(`[broadcasts] row failed broadcast=${broadcastId} user=${userId}: ${err?.message ?? err}`);
        failed += 1;
        // Last resort, and reachable only if something above threw BEFORE the
        // settle (composeBroadcast is pure but reads properties, and a row from
        // the wire is not a type guarantee). A requeue is the right direction:
        // the student's slot goes back and the row is picked up next tick.
        // Repeating a settle that already ran is safe -- see settle() -- but
        // the flag keeps the log honest about what happened.
        if (userId && broadcastId && !settleAsked) await settle(broadcastId, userId, false);
      }
    }

    // claimed === delivered + failed, always, and every claimed row has had
    // exactly one settle asked of it. That invariant is the whole contract this
    // function owes the migration; it is worth checking against any change to
    // the loop above.
    return { claimed: claimedRows.length, delivered, failed };
  } catch (err) {
    // Never throws upward: this is a background sweep with nothing downstream
    // of it, and the next tick retries from scratch. Same posture as
    // runReminderTick and claimNearby.
    // claimedRows is deliberately in the message. If the throw happened AFTER
    // the claim, the database has already spent N students' budgets and moved
    // their recipient rows to 'sending' -- reporting a bare failure with
    // claimed:0 would tell the operator nothing was touched, which is the
    // opposite of true. The ten-minute 'sending' sweep in the claim recovers
    // those rows; this line is how anyone knows to expect it.
    console.error(`[broadcasts] tick failed after claiming ${claimedCount} row(s): ${err?.message ?? err}`);
    return { ...ZERO };
  }
}

/**
 * Start the broadcast loop.
 *
 * No-op when push is unconfigured, which matters because push is this worker's
 * ONLY job: migration-061 gives broadcasts no in-app list (a deal has
 * #deals-modal; this has nowhere) and no email fallback, so with no VAPID keys
 * there is literally nothing for a tick to do but spend budgets. That is also
 * why runBroadcastTick repeats the guard as its own first line: this one can be
 * bypassed by calling the tick directly, and the check that protects a student
 * cannot live only in the caller.
 *
 * `running` guards against overlap, so a slow tick is never joined by the next
 * one claiming more students while the first is still sending, and the timer is
 * unref'd so it cannot hold the process open during shutdown. Both mirror
 * startReminderWorker and startCampaignWorker.
 */
export function startBroadcastWorker() {
  if (timer || !pushEnabled) return;
  // A floor, so a mistyped BROADCAST_TICK_SECONDS (0, or a negative, or a
  // string) cannot turn this into a hot loop against the claim. Ten seconds
  // rather than the reminder worker's thirty, because the intended cadence here
  // IS thirty: a floor at the default would leave no room to tune downwards at
  // all, and the claim is cheap when it finds nobody eligible.
  const period = Math.max(BROADCAST_CONFIG.tickSeconds, 10) * 1000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runBroadcastTick();
      // Only when something happened. This tick runs twice a minute forever and
      // will find nobody eligible for most of them, so logging every pass would
      // bury the lines that matter in a log an operator reads by eye.
      if (r.claimed) {
        console.log(`[broadcasts] tick claimed=${r.claimed} delivered=${r.delivered} failed=${r.failed}`);
      }
    } catch (err) {
      // runBroadcastTick already swallows everything; this is the belt under it.
      console.error(`[broadcasts] tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  }, period);
  timer.unref();
}

export function stopBroadcastWorker() {
  // Safe to call having never started, and safe to call twice: server.js runs
  // the shutdown path regardless of what was ever armed.
  if (timer) clearInterval(timer);
  timer = null;
}
