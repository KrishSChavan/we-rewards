// "You're walking past somewhere you've never been" (migration-051).
//
// The odd one out among this codebase's notifications, and worth understanding
// before changing anything here: NOTHING IS PUSHED. Vendor deals (campaigns.js)
// and operator alerts (push.js) are delivered BY the server to a subscription it
// holds; this one is shown by the student's own page, via
// registration.showNotification() on a service worker their browser already has.
//
// That is not a shortcut, it is forced. There is no background geolocation on
// the web — navigator.geolocation does not exist in a service worker, the
// Geofencing API was withdrawn from Chrome in 2018 and shipped nowhere else,
// and Periodic Background Sync cannot read a position even where it runs. So
// the only moment a proximity test can happen at all is while the page is
// alive, and at that moment the page can show its own notification. A server
// round trip to deliver it would add nothing but a failure mode.
//
// What the server IS for is the two facts a phone cannot hold:
//
//   • "have I already told them about this spot?" — must survive a reinstall
//     and must agree across their devices;
//   • "may they be interrupted at all right now?" — which is a question about
//     the STUDENT, not about this feature, and campaigns.js is already asking
//     it. claim_nearby_notification spends from the very same daily/weekly
//     budget, so a nearby alert costs a deal alert and vice versa. See
//     migration-051's header for why that is shared rather than parallel.
//
// The client sends a vendor id and no coordinates. That is coarse location all
// the same — "this student was within radiusMeters of that shop just now" — and
// legal/student-privacy-policy.html §2.9 says so plainly rather than claiming
// location never reaches us.

import { supabaseAdmin } from './supabase.js';
import { CAMPAIGN_CONFIG } from './campaigns.js';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The two knobs the CLIENT needs, served through GET /api/public-config so they
 * can be retuned from the environment without a rebuild of the bundles.
 *
 * Everything else this feature throttles on is deliberately absent: the caps,
 * the cooldown and quiet hours are CAMPAIGN_CONFIG's, they are enforced in the
 * database, and shipping them to the browser would invite a client to believe
 * it already knows the answer and skip the claim.
 */
export const NEARBY_CONFIG = {
  // How close counts as "passing by". 150m is about a block and a half — wide
  // enough to survive ordinary phone GPS error (which is routinely 20-50m in a
  // street with buildings on both sides), tight enough that it means the spot
  // they can see rather than the next street over.
  radiusMeters: num('NEARBY_RADIUS_METERS', 150),
  // How long they must STAY inside it. This is what separates walking past from
  // driving past: at 30mph the 150m circle is crossed in about eleven seconds,
  // so a car never qualifies and someone on foot always does. It is also the
  // cheapest false-positive filter available, because a single bad GPS fix
  // rarely persists for half a minute.
  dwellSeconds: num('NEARBY_DWELL_SECONDS', 30),
};

/**
 * May this student be shown a nearby notification for this vendor, right now?
 *
 * Every rule lives in the database function, under a row lock on the student —
 * opt-in, once-ever, the vendor still being real, the student not having been
 * there, quiet hours, and the shared cooldown and caps. Nothing is re-decided
 * here, deliberately: this feature and campaigns.js must never be able to
 * disagree about how much quota a student has left, and the only way to
 * guarantee that is for both to ask the same locked row.
 *
 * A granted claim SPENDS the slot before the notification is shown. If the
 * browser then fails to render it, that slot is gone — the same asymmetry
 * finish_campaign_batch documents, chosen the same way: showing a student two
 * notifications is worse than showing them none.
 *
 * Never throws. A database that cannot answer means no notification, which is
 * the correct failure direction for something whose entire job is to interrupt
 * someone in the street.
 *
 * @param {string} userId
 * @param {string} vendorId
 * @returns {Promise<boolean>} whether the notification may be shown
 */
export async function claimNearby(userId, vendorId) {
  if (!userId || !vendorId) return false;
  try {
    const { data, error } = await supabaseAdmin.rpc('claim_nearby_notification', {
      p_user_id: userId,
      p_vendor_id: vendorId,
      // CAMPAIGN_CONFIG's own values, passed rather than copied. One place to
      // retune the storm defences, and no way for the two features to drift
      // into disagreeing about what a student's daily cap is.
      p_cooldown_minutes: CAMPAIGN_CONFIG.cooldownMinutes,
      p_daily_cap: CAMPAIGN_CONFIG.dailyCap,
      p_weekly_cap: CAMPAIGN_CONFIG.weeklyCap,
      p_quiet_start: CAMPAIGN_CONFIG.quietStart,
      p_quiet_end: CAMPAIGN_CONFIG.quietEnd,
      p_timezone: CAMPAIGN_CONFIG.timezone,
    });
    if (error) {
      // The one failure worth naming: without migration-051 applied the RPC is
      // simply absent, and the feature is then silently off forever with no
      // other symptom. Same shape as the migration-048 warning in
      // src/routes/student.js.
      console.warn(`[nearby] claim unavailable (run migration-051?): ${error.message}`);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn(`[nearby] claim failed: ${err?.message ?? err}`);
    return false;
  }
}
