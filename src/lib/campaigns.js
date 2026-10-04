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
// TWO TRANSPORTS SINCE MIGRATION-047, one queue. Push is tried first; a student
// it could not reach — no endpoint, or the browser cannot do web push at all,
// which is most of iOS — gets the same bundle as an email instead. Email is
// strictly a fallback, so nobody is told twice about one deal, and it needs no
// throttling of its own: it rides the same claim, so the cooldown, the caps and
// quiet hours already cover it. The claim says which transports are open for
// each student in out_reach.
//
// Best-effort throughout: a failed tick leaves rows queued and the next tick
// retries. Nothing here is on a request path.

import { supabaseAdmin } from './supabase.js';
import { pushEnabled, sendToSubscriptionsDetailed, studentSubscriptions } from './push.js';
import { visibleUserIds } from './realtime.js';
import { emailEnabled, sendEmail, emailUrl, unsubscribeUrl } from './email.js';
import { dealDigest } from './email-templates.js';
import { logNotification } from './notification-log.js';

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

/* ---------- worker status (for /admin) ---------- */

// What a claim RPC answers when the function, or something its body touches,
// does not exist yet: PostgREST's "no such function" (PGRST202), Postgres's
// (42883), a missing relation (42P01 / PGRST205) or column (42703).
const RPC_MISSING_CODES = new Set(['PGRST202', '42883', '42P01', 'PGRST205', '42703']);

/**
 * In-memory tick bookkeeping for one background worker, read by /admin's
 * notification health strip. Shared by the campaign, reminder and broadcast
 * workers (the latter two already import CAMPAIGN_CONFIG from here), so the
 * three status objects cannot drift apart in shape.
 *
 * lastTickAt is the last tick that finished WITHOUT a tick-level error, and
 * lastErrorAt the last one that did. That pairing is what lets the admin API
 * say "down" as `lastErrorAt > lastTickAt` with no extra flag: a worker that
 * failed once and has ticked cleanly since is healthy, and its lastError stays
 * visible as history. A per-student failure (one dead endpoint) is NOT a tick
 * error, or a single bad device would paint the whole worker red.
 *
 * Single dyno, so module memory is the whole truth; a restart forgets it,
 * which reads as "no ticks yet" rather than as a fault.
 */
export function createWorkerStatus() {
  const s = {
    ticks: 0,
    lastTickAt: null,
    lastTickMs: null,
    lastResult: null,
    lastError: null,
    lastErrorAt: null,
    rpcMissing: false,
  };
  return {
    tickDone(startedMs, result) {
      s.ticks += 1;
      s.lastTickMs = Date.now() - startedMs;
      s.lastTickAt = new Date().toISOString();
      s.lastResult = result && typeof result === 'object' ? { ...result } : null;
    },
    tickFailed(startedMs, err) {
      s.ticks += 1;
      s.lastTickMs = Date.now() - startedMs;
      s.lastError = String(err?.message ?? err ?? 'unknown error').slice(0, 300);
      s.lastErrorAt = new Date().toISOString();
    },
    claimFailed(error) {
      if (RPC_MISSING_CODES.has(String(error?.code ?? ''))) s.rpcMissing = true;
    },
    claimOk() {
      s.rpcMissing = false;
    },
    snapshot({ configured, running, intervalSeconds }) {
      return {
        configured: Boolean(configured),
        running: Boolean(running),
        intervalSeconds,
        ...s,
        lastResult: s.lastResult ? { ...s.lastResult } : null,
      };
    },
  };
}

/* ---------- the tick ---------- */

let timer = null;
let running = false;   // one tick at a time, whatever the interval does
const workerStatus = createWorkerStatus();

/** The interval startCampaignWorker arms, floor included. */
const periodSeconds = () => Math.max(CAMPAIGN_CONFIG.tickSeconds, 5);

/**
 * Contract §3.5 status for /admin. `running` means the loop is armed (a
 * configured deployment that never started it, or stopped it, is "down"), not
 * that a tick is in flight right now.
 */
export function campaignWorkerStatus() {
  return workerStatus.snapshot({
    configured: pushEnabled || emailEnabled,
    running: timer !== null,
    intervalSeconds: periodSeconds(),
  });
}

/**
 * Mail one claimed bundle to the student it was claimed for.
 *
 * The FALLBACK half of delivery (migration-047). Reached only when push was
 * unavailable for this student or accepted by not one endpoint, so nobody is
 * ever sent both for the same deal.
 *
 * The bundle is already composed and already throttled — this rides the exact
 * claim push rides, under the same row lock, so it inherits the cooldown, the
 * caps, the per-vendor fence and quiet hours without adding a rule of its own.
 * All that is left here is addressing it.
 *
 * @param {string} userId
 * @param {string} batch   the claim's batch id, reused as the idempotency key
 * @param {Array}  items   out_items, exactly as composeNotification sees them
 * @returns {Promise<boolean>} did a mailbox accept it
 */
async function emailBundle(userId, batch, items) {
  const ref = { campaignIds: campaignIdsOf(items), batch, fallback: true };
  const vendorId = items?.[0]?.vendorId ?? null;
  // Every way out of this function leaves exactly one email row: sendEmail logs
  // its own, and the two bail-outs before it log here. That is what lets the
  // tick treat "emailBundle was called" as "the email side is accounted for".
  const refused = (reason, name) => logNotification({
    channel: 'email',
    kind: 'deal',
    outcome: 'refused',
    reason,
    recipientKind: 'student',
    studentId: userId,
    vendorId,
    recipientLabel: name ?? null,
    template: 'deals',
    ref,
  });

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('email, name')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn(`[campaigns] could not read profile for email user=${userId}: ${error.message}`);
    refused('no_email_address');
    return false;
  }
  if (!profile?.email) {
    refused('no_email_address', profile?.name);
    return false;
  }

  const one = items.length === 1;
  const msg = dealDigest({
    name: profile.name,
    items,
    appUrl: emailUrl(one ? `/?deal=${items[0].campaignId}` : '/?deals=1'),
    unsubscribeUrl: unsubscribeUrl(userId),
  });
  if (!msg) {
    refused('content_empty', profile.name);
    return false;
  }

  const res = await sendEmail({
    to: profile.email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    // Marketing: adds List-Unsubscribe, and is refused for an address
    // suppressed at ANY scope. See src/lib/email.js on why the distinction is
    // load-bearing rather than cosmetic.
    category: 'marketing',
    unsubscribeUrl: unsubscribeUrl(userId),
    // The batch id is the natural idempotency key: it is exactly the unit that
    // gets retried when a settle fails and the row returns to the queue.
    idempotencyKey: `deals:${batch}`,
    tags: ['deals'],
    log: {
      kind: 'deal',
      recipientKind: 'student',
      studentId: userId,
      vendorId,
      recipientLabel: profile.name ?? null,
      ref,
    },
  });
  if (!res.ok && res.reason !== 'suppressed') {
    console.warn(`[campaigns] deal email not accepted user=${userId} reason=${res.reason}${res.status ? ` status=${res.status}` : ''}`);
  }
  return res.ok;
}

function campaignIdsOf(items) {
  return (items ?? []).map((i) => i?.campaignId).filter(Boolean);
}

/**
 * The push row for one claimed bundle (contract §3.1). Called once per batch
 * AFTER the email fallback and the settle, because `refunded` is about the
 * batch as a whole: a push that no device took but an email that landed is a
 * failed push row with refunded:false, and that is the honest pair to show.
 *
 * Not awaited: logNotification never rejects, and a slow or missing log table
 * must not stretch a tick that is spending real students' budgets.
 */
function logDealPush({ b, payload, reach, outcome, reason = null, devices = [], refunded }) {
  logNotification({
    channel: 'push',
    kind: 'deal',
    outcome,
    reason,
    recipientKind: 'student',
    studentId: b.out_user_id,
    vendorId: b.out_items?.[0]?.vendorId ?? null,
    title: payload?.title,
    body: payload?.body,
    url: payload?.url,
    template: payload?.tag ?? null,
    devices,
    ref: refunded === undefined
      ? { campaignIds: campaignIdsOf(b.out_items), batch: b.out_batch }
      : { campaignIds: campaignIdsOf(b.out_items), batch: b.out_batch, reach, refunded },
    // ONLY on a sent row. migration-062's backfill writes `deal:<batch>` for the
    // same bundle, so a re-pasted migration cannot duplicate a live send; and a
    // failed attempt is never deduped, because the requeued retry gets a new
    // batch and both attempts belong in the log.
    dedupeKey: outcome === 'sent' && b.out_batch ? `deal:${b.out_batch}` : undefined,
  });
}

/**
 * Claim, deliver, settle. Exported so a test (or an operator debugging a
 * delivery) can drive one pass by hand.
 *
 * Every pass is recorded for campaignWorkerStatus(). The throw is preserved
 * (startCampaignWorker's catch and any operator REPL rely on it); the status
 * just notes it on the way through.
 * @returns {Promise<{claimed:number, delivered:number, emailed:number}>}
 */
export async function runCampaignTick() {
  // Either transport is enough to be worth a tick. Before migration-047 this
  // was push alone, which is also why the claim is told which transports exist:
  // claiming a student the server cannot actually reach spends their quota on
  // nothing (the hole migration-033 was written to close).
  if (!pushEnabled && !emailEnabled) return { claimed: 0, delivered: 0, emailed: 0 };
  const started = Date.now();
  try {
    const result = await campaignTick();
    workerStatus.tickDone(started, result);
    return result;
  } catch (err) {
    workerStatus.tickFailed(started, err);
    throw err;
  }
}

async function campaignTick() {
  const claimArgs = {
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
    p_email_enabled: emailEnabled,
  };
  let { data: batches, error } = await supabaseAdmin.rpc('claim_campaign_pushes', claimArgs);
  if (error && error.code === 'PGRST202') {
    // Deploys and migrations do not land in lockstep, and this is the claim:
    // stranding it strands EVERY campaign. A server running ahead of its
    // database falls back to the migration-032 signature and delivers by push
    // only until migration-047 is applied. Same reasoning as settle() below.
    const { p_email_enabled: _drop, ...legacy } = claimArgs;
    ({ data: batches, error } = await supabaseAdmin.rpc('claim_campaign_pushes', legacy));
    if (!error) console.warn('[campaigns] claim_campaign_pushes has no p_email_enabled — apply migration-047 to enable deal emails');
  }
  if (error) {
    workerStatus.claimFailed(error);
    throw error;
  }
  workerStatus.claimOk();
  if (!batches?.length) return { claimed: 0, delivered: 0, emailed: 0 };

  let delivered = 0;
  let emailed = 0;
  // Sequential on purpose. The claim is already capped at batchUsers, and a
  // push service will happily rate-limit a burst of parallel sends from one
  // origin; a steady trickle costs nothing here (nobody is waiting on it).
  for (const b of batches) {
    const payload = composeNotification(b.out_items);
    if (!payload) {
      logDealPush({ b, payload: null, outcome: 'refused', reason: 'content_empty' });
      await settle(b.out_batch, false);
      continue;
    }
    // Which transports the claim found open for this student, decided under the
    // row lock so it cannot disagree with the quota that was just spent.
    // Absent on a pre-047 database, where push was the only answer there was.
    const reach = b.out_reach ?? 'push';
    let accepted = 0;
    let channel = 'push';
    let subs = [];
    // What the push half did, for the log row written once the batch's fate is
    // known. `pushThrew` counts as an attempt: we do not know how many devices
    // it reached, only that it did not finish.
    let pushResult = null;
    let pushThrew = false;
    let emailTried = false;

    if (reach === 'push' || reach === 'both') {
      try {
        subs = await studentSubscriptions(b.out_user_id);
        pushResult = await sendToSubscriptionsDetailed(subs, payload);
        accepted = pushResult.accepted;
      } catch (err) {
        console.error(`[campaigns] send threw for user=${b.out_user_id}: ${err?.message ?? err}`);
        accepted = 0;
        pushThrew = true;
      }
    }

    // FALLBACK, never a second copy. Email runs only where push had no chance
    // (no endpoint, or the student's browser cannot do web push at all) or
    // where not one endpoint accepted — so no student is told twice about the
    // same deal by two different means.
    if (accepted === 0 && (reach === 'email' || reach === 'both')) {
      emailTried = true;
      const sent = await emailBundle(b.out_user_id, b.out_batch, b.out_items);
      if (sent) {
        accepted = 1;
        channel = 'email';
        emailed += 1;
      }
    }

    // The claim has ALREADY spent this student's cooldown and daily cap, so a
    // silent zero here is a notification that will never be retried inside the
    // next four hours and never explains itself. Say so.
    if (accepted === 0) {
      console.warn(`[campaigns] nothing accepted user=${b.out_user_id} batch=${b.out_batch} reach=${reach} endpoints=${subs.length} — requeued`);
    }

    // accepted === 0 means neither a push endpoint nor a mailbox took it, so the
    // quota this claim spent bought nothing — refund it (migration-033) rather
    // than silencing the student for four hours over a delivery that never
    // happened.
    const settled = await settle(b.out_batch, accepted > 0, accepted === 0, channel);

    // Logged after the settle so `refunded` reports what finish_campaign_batch
    // did, not what we asked of it: a settle that failed every signature left
    // the batch in 'sending' with the quota still spent.
    const refunded = accepted === 0 && settled;
    if (pushThrew || pushResult?.tried > 0) {
      const pushOk = !pushThrew && pushResult.accepted > 0;
      logDealPush({
        b, payload, reach, refunded,
        outcome: pushOk ? 'sent' : 'failed',
        reason: pushOk ? null : (pushThrew ? 'send_error' : 'no_device_accepted'),
        devices: pushResult?.devices ?? [],
      });
    } else if (!emailTried) {
      // Neither transport was even tried, yet the claim spent the budget: the
      // student's only endpoint vanished between the claim's `exists` check and
      // here, or this server has no VAPID keys while the claim (which cannot
      // know that) still counted push as open. The second is a config fault,
      // not a student fault, so it gets its own reason.
      logDealPush({
        b, payload, reach, refunded,
        outcome: 'refused',
        reason: pushEnabled ? 'no_devices' : 'push_disabled',
      });
    }
    if (accepted > 0) delivered += 1;
  }
  return { claimed: batches.length, delivered, emailed };
}

// Never throws. Resolves true when one of the finish_campaign_batch signatures
// accepted the call, so the caller can log what the settle actually did.
async function settle(batch, ok, refund = false, channel = 'push') {
  try {
    // p_refund arrived in migration-033, p_channel in migration-047. Deploys and
    // migrations do not land in lockstep, so a server running ahead of its
    // database must not strand every batch it settles: walk back one parameter
    // at a time to the migration-032 signature. Losing the channel label costs a
    // stat; losing the refund is a bad four hours for one student; losing the
    // settle re-sends to everyone.
    let { error } = await supabaseAdmin.rpc('finish_campaign_batch', { p_batch: batch, p_ok: ok, p_refund: refund, p_channel: channel });
    if (error) {
      ({ error } = await supabaseAdmin.rpc('finish_campaign_batch', { p_batch: batch, p_ok: ok, p_refund: refund }));
      if (!error) console.warn('[campaigns] finish_campaign_batch has no p_channel — apply migration-047');
    }
    if (error) {
      ({ error } = await supabaseAdmin.rpc('finish_campaign_batch', { p_batch: batch, p_ok: ok }));
      if (!error) console.warn('[campaigns] finish_campaign_batch has no p_refund — apply migration-033');
    }
    // .rpc() RESOLVES with an error rather than throwing, so this was silent
    // before: a failing settle looked identical to a successful one.
    if (error) console.error(`[campaigns] settle failed batch=${batch}: ${error.message}`);
    return !error;
  } catch (err) {
    // Left in 'sending'; claim_campaign_pushes returns it to the queue after
    // ten minutes rather than stranding it.
    console.error(`[campaigns] settle threw batch=${batch}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Start the delivery loop. No-op when NEITHER transport is configured —
 * campaigns still queue and still show up in every student's in-app list, they
 * just never interrupt anyone. Unref'd so it can't hold the process open during
 * shutdown.
 */
export function startCampaignWorker() {
  if (timer || (!pushEnabled && !emailEnabled)) return;
  const period = periodSeconds() * 1000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runCampaignTick();
      if (r.claimed) console.log(`[campaigns] tick claimed=${r.claimed} delivered=${r.delivered} byEmail=${r.emailed}`);
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
