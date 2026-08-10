// Referrals (migration-039) — the first incentive kind.
//
// A student shares a link carrying their own six-character code. A friend who
// opens it, signs up and then actually EARNS points somewhere pays the referrer
// a community-point bonus. The friend's own bonus lands at attribution, because
// that is the moment they are looking at the screen.
//
// Two rules shape everything here:
//
//   1. The referrer is paid for a PURCHASE, not a signup. A Google account is
//      free and takes thirty seconds; a purchase at a real counter cannot be
//      manufactured. Every other anti-fraud control in this file is a backstop
//      to that one.
//   2. Payouts never run on a request a cashier is waiting on. Qualification is
//      a sweep (settle_referrals), so a bug, a lock or an exhausted budget in
//      here can delay a bonus but can never fail an award. See the WHY A
//      SWEEPER note at the top of migration-039.sql.
//
// The attribution rules themselves (self-referral, one-per-friend, account age,
// per-referrer cap) are enforced BOTH here and, where it matters most, in the
// database: referrals has a UNIQUE index on friend_id, so no bug in this file
// can produce two attributions for one account.

import { supabaseAdmin } from './supabase.js';

/** The alphabet migration-039's generate_referral_code() draws from. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

/**
 * Defaults the admin form starts from. Every one of these is stored per-deal in
 * incentives.config, so changing them here only changes what a NEW program is
 * pre-filled with — a running program keeps what it was created with.
 */
export const REFERRAL_DEFAULTS = {
  referrerPoints: 10,      // paid when the friend first earns points anywhere
  friendPoints: 10,        // paid to the friend at signup
  maxPerReferrer: 10,      // null = unlimited
  signupWindowDays: 14,    // how long after signup a code can still be claimed
};

/** Ceilings for the admin form. Not business rules — typo stops. */
const POINTS_MAX = 5000;
const MAX_PER_REFERRER_MAX = 1000;
const WINDOW_DAYS_MAX = 365;

const SWEEP_SECONDS = Number(process.env.REFERRAL_SWEEP_SECONDS) || 45;

/**
 * Fold whatever the student typed or pasted into the canonical code, or null.
 * Accepts lowercase and stray punctuation from a hand-copied link; refuses
 * anything that isn't exactly six characters of the code alphabet, so a typo
 * is a clean "no such code" rather than a lookup on garbage.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(code) ? code : null;
}

/**
 * Validate the knobs an operator typed into the Incentives tab. Returns
 * { config } or { error } — never throws, because the caller turns the error
 * into a 400 with the operator's own wording.
 */
export function validReferralConfig(raw) {
  const body = raw ?? {};
  const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  const referrerPoints = intOrNull(body.referrerPoints) ?? REFERRAL_DEFAULTS.referrerPoints;
  const friendPoints = intOrNull(body.friendPoints) ?? REFERRAL_DEFAULTS.friendPoints;
  const maxPerReferrer = intOrNull(body.maxPerReferrer);
  const signupWindowDays = intOrNull(body.signupWindowDays) ?? REFERRAL_DEFAULTS.signupWindowDays;

  const bounded = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

  if (!bounded(referrerPoints, 0, POINTS_MAX)) {
    return { error: `Referrer bonus must be a whole number from 0 to ${POINTS_MAX}.` };
  }
  if (!bounded(friendPoints, 0, POINTS_MAX)) {
    return { error: `Friend bonus must be a whole number from 0 to ${POINTS_MAX}.` };
  }
  // A program that pays nobody anything is almost certainly a mistake, and it
  // would sit in the tab looking live.
  if (referrerPoints === 0 && friendPoints === 0) {
    return { error: 'Set at least one of the two bonuses above zero.' };
  }
  if (maxPerReferrer !== null && !bounded(maxPerReferrer, 1, MAX_PER_REFERRER_MAX)) {
    return { error: `Referrals per student must be blank (unlimited) or from 1 to ${MAX_PER_REFERRER_MAX}.` };
  }
  if (!bounded(signupWindowDays, 1, WINDOW_DAYS_MAX)) {
    return { error: `The signup window must be a whole number of days from 1 to ${WINDOW_DAYS_MAX}.` };
  }

  return { config: { referrerPoints, friendPoints, maxPerReferrer, signupWindowDays } };
}

/**
 * The one live referral program, or null. migration-039's partial unique index
 * guarantees there is at most one row with active = true for this kind, so this
 * can safely take the first row: there is never a second one to choose between.
 * The date window is applied here rather than in SQL so an operator can see an
 * expired program still marked active in the tab (which is the truth) while it
 * quietly stops attributing.
 */
export async function activeReferralProgram() {
  const { data, error } = await supabaseAdmin
    .from('incentives')
    .select('id, name, active, starts_at, ends_at, budget_points, spent_points, config')
    .eq('kind', 'referral')
    .eq('active', true)
    .limit(1);
  if (error) throw error;

  const row = data?.[0];
  if (!row) return null;
  const now = Date.now();
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return null;
  if (row.ends_at && new Date(row.ends_at).getTime() <= now) return null;
  return row;
}

/**
 * Record that `userId` was referred with `rawCode`, and pay the friend's own
 * bonus. Throws an Error whose message is one of the REFERRAL_* codes in
 * server.js's error map.
 *
 * Order matters: the referrals row is written FIRST and the friend's bonus
 * second. The row is the durable thing — it is what pays the referrer later —
 * so a failed bonus must not cost the referrer their referral. An unpaid bonus
 * is picked up by the next sweep instead.
 */
export async function attributeReferral(userId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error('REFERRAL_BAD_CODE');

  const program = await activeReferralProgram();
  if (!program) throw new Error('REFERRAL_INACTIVE');

  const cfg = { ...REFERRAL_DEFAULTS, ...(program.config ?? {}) };

  // The friend's own profile: the code's owner, their account age, and whether
  // they have already been referred are all decided from here.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles')
    .select('user_id, created_at, referral_code')
    .eq('user_id', userId)
    .maybeSingle();
  if (meErr) throw meErr;
  if (!me) throw new Error('REFERRAL_BAD_CODE');

  // Self-referral, checked against the student's OWN code rather than by
  // comparing ids after the lookup, so it reads the same as the rule.
  if (me.referral_code === code) throw new Error('REFERRAL_SELF');

  // A code is claimable for a limited window after signup. Without this, every
  // student who has ever installed the app could claim one at any time, and the
  // program pays for people it did not bring in.
  const ageDays = (Date.now() - new Date(me.created_at).getTime()) / 86_400_000;
  if (ageDays > cfg.signupWindowDays) throw new Error('REFERRAL_TOO_LATE');

  // Already started earning = already a WeRewards user. The bonus is for
  // bringing someone new, and attribution after the fact cannot be verified.
  const { count: earnCount, error: earnErr } = await supabaseAdmin
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('type', 'earn');
  if (earnErr) throw earnErr;
  if ((earnCount ?? 0) > 0) throw new Error('REFERRAL_TOO_LATE');

  const { data: referrer, error: refErr } = await supabaseAdmin
    .from('profiles')
    .select('user_id')
    .eq('referral_code', code)
    .maybeSingle();
  if (refErr) throw refErr;
  if (!referrer) throw new Error('REFERRAL_BAD_CODE');
  // Belt and braces behind the referral_code comparison above: the same account
  // reached by a different route is still the same account.
  if (referrer.user_id === userId) throw new Error('REFERRAL_SELF');

  if (cfg.maxPerReferrer !== null && cfg.maxPerReferrer !== undefined) {
    // Counts pending as well as paid: a cap that only counts payouts lets one
    // student queue up unlimited referrals and collect them all at once.
    const { count, error: capErr } = await supabaseAdmin
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('referrer_id', referrer.user_id)
      .in('status', ['pending', 'paid']);
    if (capErr) throw capErr;
    if ((count ?? 0) >= cfg.maxPerReferrer) throw new Error('REFERRAL_LIMIT');
  }

  const { data: row, error: insErr } = await supabaseAdmin
    .from('referrals')
    .insert({
      referrer_id: referrer.user_id,
      friend_id: userId,
      incentive_id: program.id,
      code,
      friend_points: cfg.friendPoints,
      referrer_points: cfg.referrerPoints,
    })
    .select('id')
    .single();
  if (insErr) {
    // 23505 on idx_referrals_one_per_friend — someone (a double-tap, a second
    // tab) got there first. The database is the authority on one-per-friend.
    if (insErr.code === '23505') throw new Error('REFERRAL_ALREADY_SET');
    throw insErr;
  }

  // The friend's bonus. Best-effort on purpose: a refusal here (an exhausted
  // budget is the realistic one) must not undo the attribution, and the sweep
  // retries it, so raising the budget pays everyone who was waiting.
  let friendPaid = 0;
  if (cfg.friendPoints > 0) {
    friendPaid = await payFriendBonus(row.id, userId, cfg.friendPoints, program.id);
  }

  return { referralId: row.id, friendPoints: friendPaid, referrerPoints: cfg.referrerPoints };
}

/**
 * Credit a friend's signup bonus. Returns the points actually paid (0 if the
 * grant was refused). grant_community_points is idempotent on (ref_id, kind),
 * so calling this twice for one referral credits once — which is what makes it
 * safe for the sweep to retry blindly.
 */
async function payFriendBonus(referralId, userId, points, incentiveId) {
  const { error } = await supabaseAdmin.rpc('grant_community_points', {
    p_user_id: userId,
    p_points: points,
    p_kind: 'referral_friend',
    p_reason: 'Referral signup bonus',
    p_incentive_id: incentiveId,
    p_ref_id: referralId,
    p_granted_by: 'system',
  });
  if (!error) return points;
  // ALREADY_PAID means a concurrent call won; the student has the points.
  if (String(error.message ?? '').includes('GRANT_ALREADY_PAID')) return points;
  console.warn(`[referrals] friend bonus unpaid for ${referralId}: ${error.message}`);
  return 0;
}

/**
 * One sweep: pay every referrer whose friend has now earned, then retry any
 * friend bonus that never landed. Returns counts for the log and for the
 * admin tab's "Settle now" button.
 */
export async function runReferralSweep(limit = 50) {
  const { data, error } = await supabaseAdmin.rpc('settle_referrals', { p_limit: limit });
  if (error) throw error;

  // Both halves are separate scans on purpose: a friend bonus can still be owed
  // on a referral whose referrer has ALREADY been settled (the bonus is paid
  // inline at attribution, the referrer payout happens later), so one loop over
  // pending rows would never find it.
  const { data: bonus, error: bErr } = await supabaseAdmin.rpc('settle_friend_bonuses', { p_limit: limit });
  if (bErr) throw bErr;

  return {
    settled: data?.[0]?.settled ?? 0,
    skipped: data?.[0]?.skipped ?? 0,
    friendsPaid: bonus?.[0]?.paid ?? 0,
  };
}

/* ---------- the worker ---------- */

let timer = null;
let running = false;

/**
 * Start the sweep loop. Unref'd so it can't hold the process open during
 * shutdown, and guarded by `running` so a slow sweep is never overlapped by the
 * next tick. Everything it does is idempotent, so a missed tick costs a minute
 * and nothing else.
 */
export function startReferralWorker() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReferralSweep();
      if (r.settled || r.friendsPaid || r.skipped) {
        console.log(`[referrals] sweep settled=${r.settled} skipped=${r.skipped} friends=${r.friendsPaid}`);
      }
    } catch (err) {
      console.error(`[referrals] sweep failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  }, Math.max(SWEEP_SECONDS, 10) * 1000);
  timer.unref();
}

export function stopReferralWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
