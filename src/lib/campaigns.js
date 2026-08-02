// Vendor campaign delivery (migration-032).
//
// Vendors do not send notifications. They enqueue a campaign; this worker is
// the only thing in the system that ever calls web-push on a student, and it
// asks the database — under a per-student row lock — what that student is
// allowed to receive right now. See the header of supabase/migration-032.sql
// for why (short version: every vendor's "top 100" is largely the SAME 100
// students, so five vendors sending at 5pm is five notifications for the
// network's most valuable users, and one Block is permanent).
//
// The tick does three things and nothing else:
//   1. ask Socket.IO which students are looking at the app right now, so their
//      quota is not spent on an interruption they do not need;
//   2. claim_campaign_pushes() -> at most one BUNDLE per student, already
//      filtered by cooldown, daily/weekly caps, per-vendor cooldown and quiet
//      hours;
//   3. render each bundle into one notification, fan it out to that student's
//      devices, and settle the batch.
//
// Best-effort throughout: a failed tick leaves rows queued and the next tick
// retries. Nothing here is on a request path.

import { supabaseAdmin } from './supabase.js';
import { pushEnabled, sendToSubscriptions, studentSubscriptions } from './push.js';
import { visibleUserIds } from './realtime.js';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Every knob, in one place, so an operator can retune the storm defences from
 * the environment without a deploy. The defaults are the pilot's:
 * a student hears from WeRewards at most twice a day, never twice inside four
 * hours, never at night, and never twice from the same vendor in a day.
 */
export const CAMPAIGN_CONFIG = {
  // How long a campaign is held before it may be delivered. This is the
  // coalescing window: the ONLY reason a second vendor's deal can join the
  // first one's notification instead of being deferred four hours.
  coalesceMinutes: num('CAMPAIGN_COALESCE_MINUTES', 5),
  // The hard guarantee. Two notifications to one student can never be closer
  // together than this, whatever any number of vendors do.
  cooldownMinutes: num('CAMPAIGN_COOLDOWN_MINUTES', 240),
  dailyCap: num('CAMPAIGN_DAILY_CAP', 2),
  weeklyCap: num('CAMPAIGN_WEEKLY_CAP', 5),
  // One vendor may not spend a student's whole quota, and may not appear twice
  // in one bundle.
  vendorCooldownHours: num('CAMPAIGN_VENDOR_COOLDOWN_HOURS', 20),
  // Vendors named in a single digest before it collapses to "and N more".
  bundleMax: num('CAMPAIGN_BUNDLE_MAX', 4),
  // Campus-local quiet hours [start, end). start === end disables them.
  quietStart: num('CAMPAIGN_QUIET_START', 22),
  quietEnd: num('CAMPAIGN_QUIET_END', 9),
  timezone: process.env.CAMPAIGN_TIMEZONE || process.env.PUNCH_TIMEZONE || 'America/New_York',
  // How many sends a vendor gets per rolling week. Scarcity is the cheapest
  // storm defence there is: it fixes the problem at the source.
  vendorWeeklySends: num('CAMPAIGN_VENDOR_WEEKLY_SENDS', 2),
  // How long a deal stays live (push window AND how long it is listed in-app).
  defaultDurationHours: num('CAMPAIGN_DURATION_HOURS', 48),
  // Students settled per tick. Small on purpose: the claim is ordered by how
  // long each student has been waiting, so a backlog drains fairly instead of
  // being blasted out in one breath.
  batchUsers: num('CAMPAIGN_BATCH_USERS', 40),
  tickSeconds: num('CAMPAIGN_TICK_SECONDS', 30),
};

/** Durations the terminal offers, in hours. Keep in sync with terminal.js. */
export const CAMPAIGN_DURATIONS = [24, 72, 168];

/* ---------- payload composition (pure, unit-tested) ---------- */

// Notification bodies get truncated by the OS anyway; keep them short enough
// that the truncation is ours and lands on a word.
function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// English list, no em dashes (the repo's copy rule). `andMore` replaces the
// final name with a count, so every NAMED vendor stays named — the point of the
// digest is that a coalesced vendor is still visible, not that it is tidy.
function nameList(names, andMore) {
  if (andMore) return `${names.join(', ')} and ${andMore} more`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Turn one claimed bundle into the single notification the student sees.
 *
 * ONE campaign: the vendor's own words, verbatim, with their logo as the icon.
 * That is the case worth optimising, and holding for a few minutes is what
 * makes it the common case rather than the lucky one.
 *
 * TWO OR MORE: a digest. This is the part that makes throttling honest. The
 * cooldown alone would silently defer vendors 2..5 for hours; instead they ride
 * along, the student gets one chirp, and the tap opens the in-app list where
 * every vendor gets its own row.
 *
 * @param {Array<{campaignId,vendorId,vendor,title,body,kind,hasLogo}>} items
 * @returns {{title:string, body:string, url:string, icon?:string, tag:string, count:number}}
 */
export function composeNotification(items) {
  const list = (items ?? []).filter(Boolean);
  if (!list.length) return null;

  // `tag` is the last line of defence: if anything ever did slip past the
  // server-side throttle, a matching tag REPLACES the previous notification in
  // the shade instead of stacking a second one, and renotify:false (set in the
  // service worker) means the replacement does not chirp again.
  const tag = 'wr-deals';

  if (list.length === 1) {
    const c = list[0];
    return {
      title: clip(c.title, 60),
      body: clip(`${c.vendor}: ${c.body}`, 140),
      url: `/?deal=${c.campaignId}`,
      icon: c.hasLogo ? `/api/vendor-logo/${c.vendorId}` : undefined,
      tag,
      count: 1,
    };
  }

  const names = list.map((c) => c.vendor);
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return {
    title: `${list.length} spots have something on`,
    body: clip(`${nameList(shown, extra || null)}. Tap to see what's on.`, 140),
    url: '/?deals=1',
    tag,
    count: list.length,
  };
}

/* ---------- the tick ---------- */

let timer = null;
let running = false;   // one tick at a time, whatever the interval does

/**
 * Claim, deliver, settle. Exported so a test (or an operator debugging a
 * delivery) can drive one pass by hand.
 * @returns {Promise<{claimed:number, delivered:number}>}
 */
export async function runCampaignTick() {
  if (!pushEnabled) return { claimed: 0, delivered: 0 };

  const { data: batches, error } = await supabaseAdmin.rpc('claim_campaign_pushes', {
    p_max_users: CAMPAIGN_CONFIG.batchUsers,
    // Foreground students keep their quota; the socket already told them.
    p_skip_users: visibleUserIds(),
    p_cooldown_minutes: CAMPAIGN_CONFIG.cooldownMinutes,
    p_daily_cap: CAMPAIGN_CONFIG.dailyCap,
    p_weekly_cap: CAMPAIGN_CONFIG.weeklyCap,
    p_vendor_cooldown_hours: CAMPAIGN_CONFIG.vendorCooldownHours,
    p_bundle_max: CAMPAIGN_CONFIG.bundleMax,
    p_quiet_start: CAMPAIGN_CONFIG.quietStart,
    p_quiet_end: CAMPAIGN_CONFIG.quietEnd,
    p_timezone: CAMPAIGN_CONFIG.timezone,
  });
  if (error) throw error;
  if (!batches?.length) return { claimed: 0, delivered: 0 };

  let delivered = 0;
  // Sequential on purpose. The claim is already capped at batchUsers, and a
  // push service will happily rate-limit a burst of parallel sends from one
  // origin; a steady trickle costs nothing here (nobody is waiting on it).
  for (const b of batches) {
    const payload = composeNotification(b.out_items);
    if (!payload) {
      await settle(b.out_batch, false);
      continue;
    }
    let accepted = 0;
    let subs = [];
    try {
      subs = await studentSubscriptions(b.out_user_id);
      accepted = await sendToSubscriptions(subs, payload);
    } catch (err) {
      console.error(`[campaigns] send threw for user=${b.out_user_id}: ${err?.message ?? err}`);
      accepted = 0;
    }
    // The claim has ALREADY spent this student's cooldown and daily cap, so a
    // silent zero here is a notification that will never be retried inside the
    // next four hours and never explains itself. Say so.
    if (accepted === 0) {
      console.warn(`[campaigns] 0/${subs.length} endpoints accepted user=${b.out_user_id} batch=${b.out_batch} — requeued`);
    }
    // accepted === 0 means not one endpoint took it, so the quota this claim
    // spent bought nothing — refund it (migration-033) rather than silencing the
    // student for four hours over a delivery that never happened.
    await settle(b.out_batch, accepted > 0, accepted === 0);
    if (accepted > 0) delivered += 1;
  }
  return { claimed: batches.length, delivered };
}

async function settle(batch, ok, refund = false) {
  try {
    // p_refund arrived in migration-033. Deploys and migrations do not land in
    // lockstep, so a server running ahead of its database must not strand every
    // batch it settles: if the three-argument overload isn't there yet, fall
    // back to the migration-032 signature. Losing the refund is a bad four
    // hours for one student; losing the settle re-sends to everyone.
    let { error } = await supabaseAdmin.rpc('finish_campaign_batch', { p_batch: batch, p_ok: ok, p_refund: refund });
    if (error) {
      ({ error } = await supabaseAdmin.rpc('finish_campaign_batch', { p_batch: batch, p_ok: ok }));
      if (!error) console.warn('[campaigns] finish_campaign_batch has no p_refund — apply migration-033');
    }
    // .rpc() RESOLVES with an error rather than throwing, so this was silent
    // before: a failing settle looked identical to a successful one.
    if (error) console.error(`[campaigns] settle failed batch=${batch}: ${error.message}`);
  } catch (err) {
    // Left in 'sending'; claim_campaign_pushes returns it to the queue after
    // ten minutes rather than stranding it.
    console.error(`[campaigns] settle threw batch=${batch}: ${err?.message ?? err}`);
  }
}

/**
 * Start the delivery loop. No-op when push is unconfigured — campaigns still
 * queue and still show up in every student's in-app list, they just never
 * interrupt anyone. Unref'd so it can't hold the process open during shutdown.
 */
export function startCampaignWorker() {
  if (timer || !pushEnabled) return;
  const period = Math.max(CAMPAIGN_CONFIG.tickSeconds, 5) * 1000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runCampaignTick();
      if (r.claimed) console.log(`[campaigns] tick claimed=${r.claimed} delivered=${r.delivered}`);
    } catch (err) {
      console.error(`[campaigns] delivery tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  }, period);
  timer.unref();
}

export function stopCampaignWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
