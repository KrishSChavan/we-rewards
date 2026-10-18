// Spot reviews (migration-066): a student rates a location in the app, and
// their FIRST review of it pays that location's review_points.
//
// THE GOOGLE RULE, which shapes everything here. Google's contribution policy
// forbids merchants to "offer incentives — such as payment, discounts, free
// goods and/or services" for reviews, and forbids "selectively soliciting
// positive reviews". Points are free goods, and the penalty (removed reviews,
// a restricted or suspended listing) lands on the VENDOR's Google profile. So:
//
//   • the points pay for the review WE hold, never for a Google one — there is
//     no Google-side check anywhere in this file, and there must never be one;
//   • the "Share on Google too?" link is offered after EVERY review, whatever
//     the rating. Offering it only to four- and five-star reviewers is review
//     gating, and it is exactly what a well-meaning tweak would add later.
//
// PRESENCE. A FIRST review needs the student to have been at the spot: either
// an earn, redeem or punch-card visit there in the last 24 hours ('visit'), or
// their phone placing them within the radius right now ('onsite'). Edits need
// neither: they pay nothing. The coordinates for an 'onsite' check are compared
// here and dropped; they are never stored, and the error logger reduces a
// nested object to a field count, so they cannot reach error_logs either.
//
// TOLERATES THE MIGRATION BEING ABSENT. Every read here maps a missing table,
// view, column or function to "reviews are not available" rather than to a
// 500, so the server can ship before migration-066 is pasted without taking
// anything that works today down with it.

import { supabaseAdmin } from './supabase.js';
import { reviewSummaryCache } from './cache.js';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const REVIEW_CONFIG = {
  // Same default as NEARBY_CONFIG.radiusMeters (src/lib/nearby.js): about a
  // block and a half, wide enough for phone GPS error between buildings.
  radiusMeters: num('REVIEW_RADIUS_METERS', 150),
  // A fix is allowed to miss by up to this much of its own reported accuracy,
  // so a student standing at the door with a 40m fix is not told they are
  // "too far" by 20m. Capped, so a vague fix cannot widen the circle much.
  accuracySlackMeters: 50,
  // A fix vaguer than this cannot say which side of the street anyone is on,
  // let alone which shop. Desktop browsers geolocating off wifi land here.
  maxAccuracyMeters: num('REVIEW_MAX_ACCURACY_METERS', 250),
  // How long an earn/redeem/visit at the spot counts as "you were just there".
  // Long enough to cover a receipt scanned that evening, short enough that last
  // month's coffee does not unlock a review from the couch.
  recentVisitHours: 24,
};

export const REVIEW_BODY_MAX = 500;      // = the CHECK on vendor_reviews.body
export const REVIEW_POINTS_MAX = 500;    // = vendors_review_points_range
export const GOOGLE_REVIEW_URL_MAX = 500; // = vendors_google_review_url_shape
export const HIDE_REASONS = ['abuse', 'spam', 'off_topic', 'personal_info', 'not_genuine'];

// A missing relation (42P01 / PGRST205), column (42703 / PGRST204) or function
// (42883 / PGRST202): migration-066 has not been applied to this database.
const MISSING_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204', '42883', 'PGRST202']);
export const isReviewsSchemaMissing = (error) => MISSING_CODES.has(String(error?.code ?? ''));

export const REVIEWS_UNAVAILABLE = {
  error: 'REVIEWS_UNAVAILABLE',
  message: 'Reviews are not switched on yet. Try again soon.',
};

/* ---------- the operator's two settings ---------- */

// Hosts a Google review link legitimately lives on. The Business Profile's own
// "Ask for reviews" button hands out g.page/r/<id>/review; the Place ID form is
// search.google.com/local/writereview?placeid=<id>; a Maps share is
// maps.app.goo.gl/<id>. Anything else is not a Google link and would put some
// other site behind a button labelled "Review on Google".
const GOOGLE_HOSTS = new Set(['google.com', 'g.page', 'maps.app.goo.gl', 'g.co']);

/** '' or null clears it. Returns { value } (a normalised https URL or null) or { error }. */
export function validGoogleReviewUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  if (s.length > GOOGLE_REVIEW_URL_MAX) {
    return { error: `The link must be ${GOOGLE_REVIEW_URL_MAX} characters or fewer.` };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'Paste the whole link, starting with https://.' };
  }
  if (u.protocol !== 'https:') return { error: 'Use the https:// link.' };
  if (u.username || u.password) return { error: 'That link has a login in it. Paste the plain review link.' };
  const host = u.hostname.toLowerCase();
  if (!GOOGLE_HOSTS.has(host) && !host.endsWith('.google.com') && !host.endsWith('.g.page')) {
    return {
      error: 'That is not a Google link. Use the link from the Business Profile’s “Ask for reviews” button (g.page/r/…/review) or a search.google.com/local/writereview?placeid=… link.',
    };
  }
  const value = u.toString();
  // Normalising can lengthen a URL (percent-encoding); hold the stored form to
  // the same cap the CHECK does, or the update would 23514 into a logged 500.
  if (value.length > GOOGLE_REVIEW_URL_MAX) {
    return { error: `The link must be ${GOOGLE_REVIEW_URL_MAX} characters or fewer.` };
  }
  return { value };
}

/** '' / null / 0 = reviews here pay nothing. Returns { value } (an integer) or { error }. */
export function validReviewPoints(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > REVIEW_POINTS_MAX) {
    return { error: `Points per review must be a whole number from 0 to ${REVIEW_POINTS_MAX}.` };
  }
  return { value: n };
}

/* ---------- what a student sends ---------- */

const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/g;   // everything but \n

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * The POST body: { rating, body?, anonymous?, location?: { lat, lng, accuracy } }.
 * Returns { rating, body, anonymous, location } or { code, error }.
 * A malformed location is treated as no location, not as a 400: the presence
 * check that needs it answers with a message a student can act on.
 */
export function parseReviewInput(input) {
  const b = input && typeof input === 'object' ? input : {};
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { code: 'REVIEW_RATING_INVALID', error: 'Pick from one to five stars.' };
  }
  let text = null;
  if (b.body != null) {
    if (typeof b.body !== 'string') return { code: 'BAD_REQUEST', error: 'The review text must be text.' };
    text = b.body.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').replace(/\n{3,}/g, '\n\n').trim();
    if ([...text].length > REVIEW_BODY_MAX) {
      return { code: 'REVIEW_TOO_LONG', error: `Keep it to ${REVIEW_BODY_MAX} characters.` };
    }
    if (!text) text = null;
  }
  let location = null;
  const l = b.location;
  if (l && typeof l === 'object' && finite(l.lat) && finite(l.lng)
      && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180) {
    location = { lat: l.lat, lng: l.lng, accuracy: finite(l.accuracy) && l.accuracy >= 0 ? l.accuracy : null };
  }
  return { rating, body: text, anonymous: b.anonymous === true, location };
}

/**
 * How a review is signed in public: "Krish C.", or null (shown as anonymous).
 *
 * profiles.name comes from the identity provider's full name, and when the
 * provider gave none, POST /api/me/accept-terms writes the email's local part
 * instead (src/routes/student.js; schema.sql's handle_new_user did the same
 * until migration-022 dropped it, so older rows carry it too). Publishing that
 * would publish most of an email address, so a name that IS the local part
 * signs as anonymous. The student sees exactly this string before posting
 * (GET /api/me/reviews/:vendorId, appearAs).
 */
export function reviewAuthorName({ name, email } = {}) {
  const lettersOnly = (s) => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{M}'’\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
  // The fallback itself, verbatim ("krish.chavan" from krish.chavan@…): never
  // a name the person gave, so never one to publish, however it splits.
  const rawName = String(name ?? '').trim().toLowerCase();
  const localRaw = String(email ?? '').split('@')[0].trim().toLowerCase();
  if (localRaw && rawName === localRaw) return null;
  // Anything email-shaped is never a name, whatever profiles.email says (it can
  // be null, and a name can be the WHOLE address: "krish@gmail.com" would
  // otherwise split into "Krish G."). Nor is a bare handle with digits in it,
  // which is what a local-part fallback looks like when the email is unknown.
  if (rawName.includes('@') || /\d/.test(rawName)) return null;
  const clean = lettersOnly(name);
  if (!clean) return null;
  const words = clean.split(' ').filter((w) => /\p{L}/u.test(w));
  if (!words.length) return null;
  const first = [...words[0]].slice(0, 20).join('');
  const firstOut = first.charAt(0).toUpperCase() + first.slice(1);
  if (words.length === 1) {
    // A one-word name is shown as that word, capped at 20 characters: it is the
    // whole name the person gave, so there is no last name to shorten. The
    // Privacy Policy (2.16) says so, and the student sees it before posting
    // and can post anonymously instead.
    const local = lettersOnly(String(email ?? '').split('@')[0]).replace(/\s+/g, '').toLowerCase();
    if (local && words[0].toLowerCase() === local) return null;
    return firstOut;
  }
  const lastInitial = [...words[words.length - 1]][0].toUpperCase();
  return `${firstOut} ${lastInitial}.`;
}

/* ---------- presence ---------- */

/** Great-circle distance in metres (haversine). Same formula as the app's metersBetween. */
export function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Is this phone at this spot? `vendor` needs latitude/longitude (a catalogue
 * row). Returns { ok: true, distance } or { ok: false, status, code, message }.
 */
export function checkOnsite(vendor, location, config = REVIEW_CONFIG) {
  if (vendor?.latitude == null || vendor?.longitude == null) {
    return {
      ok: false, status: 409, code: 'REVIEW_SPOT_NOT_MAPPED',
      message: 'You can review this spot right after you earn or redeem there.',
    };
  }
  if (!location) {
    return {
      ok: false, status: 400, code: 'REVIEW_NEEDS_LOCATION',
      message: 'Turn on location so we can see you’re at this spot, or review it right after your next visit.',
    };
  }
  if (location.accuracy != null && location.accuracy > config.maxAccuracyMeters) {
    return {
      ok: false, status: 409, code: 'REVIEW_LOCATION_IMPRECISE',
      message: 'Your location is too rough to tell where you are. Try again outside, or review right after your next visit.',
    };
  }
  const distance = metersBetween(location.lat, location.lng, Number(vendor.latitude), Number(vendor.longitude));
  const slack = Math.min(location.accuracy ?? 0, config.accuracySlackMeters);
  if (distance > config.radiusMeters + slack) {
    return {
      ok: false, status: 403, code: 'REVIEW_TOO_FAR', distance,
      message: 'You need to be at this spot to review it, or review it within a day of earning or redeeming there.',
    };
  }
  return { ok: true, distance };
}

/**
 * An earn, a redeem (points or visits) or a punch-card visit at this location
 * in the last recentVisitHours. transactions.vendor_id is the true location
 * even for a pooled purse (migration-045), so a sale at a sibling does not
 * count here. Throws on a Supabase error: the caller is deciding whether to
 * pay points, and "could not tell" must not read as yes.
 */
export async function hadRecentVisit(userId, vendorId, { now = Date.now(), config = REVIEW_CONFIG } = {}) {
  const since = new Date(now - config.recentVisitHours * 60 * 60 * 1000).toISOString();
  const [tx, punch] = await Promise.all([
    supabaseAdmin.from('transactions').select('id')
      .eq('user_id', userId).eq('vendor_id', vendorId)
      .in('type', ['earn', 'redeem'])
      .gte('created_at', since)
      .limit(1),
    supabaseAdmin.from('punches').select('id')
      .eq('user_id', userId).eq('vendor_id', vendorId)
      .gte('created_at', since)
      .limit(1),
  ]);
  if (tx.error) throw tx.error;
  if (punch.error) throw punch.error;
  return (tx.data ?? []).length > 0 || (punch.data ?? []).length > 0;
}

/* ---------- reads ---------- */

/**
 * Every active spot's public roll-up and review settings, cached:
 * { available, byVendor: Map(id -> { count, avg, points, googleReviewUrl }) }.
 * available=false when migration-066 is not in this database. Any other error
 * throws, so the cache can serve its stale copy.
 */
export function loadReviewSummaries() {
  return reviewSummaryCache.get('all', async () => {
    const [stats, settings] = await Promise.all([
      supabaseAdmin.from('vendor_review_stats').select('vendor_id, review_count, avg_rating'),
      supabaseAdmin.from('vendors').select('id, review_points, google_review_url').eq('active', true),
    ]);
    if (isReviewsSchemaMissing(stats.error) || isReviewsSchemaMissing(settings.error)) {
      return { available: false, byVendor: new Map() };
    }
    if (stats.error) throw stats.error;
    if (settings.error) throw settings.error;
    const byVendor = new Map();
    for (const v of settings.data ?? []) {
      byVendor.set(v.id, { count: 0, avg: null, points: v.review_points ?? 0, googleReviewUrl: v.google_review_url ?? null });
    }
    for (const s of stats.data ?? []) {
      const row = byVendor.get(s.vendor_id);
      if (!row) continue;   // an inactive spot: not shown anywhere, so not summarised
      row.count = s.review_count ?? 0;
      row.avg = s.avg_rating == null ? null : Number(s.avg_rating);
    }
    return { available: true, byVendor };
  });
}

/** loadReviewSummaries for a caller that must never fail (the home screen, a public page). */
export async function reviewSummariesOrEmpty() {
  try {
    return await loadReviewSummaries();
  } catch (err) {
    console.error('review summaries unavailable:', err?.message ?? err);
    return { available: false, byVendor: new Map() };
  }
}

export function invalidateReviewSummaries() {
  reviewSummaryCache.invalidate();
}

/**
 * One spot's live review settings, straight off its vendors row (a primary-key
 * read). Used wherever the student is told what a review pays, because the
 * Terms promise the amount shown is the amount paid, and submit_review pays
 * the LIVE review_points: the 30-second summary cache could show a stale one.
 * Returns { available, points, googleReviewUrl }; throws on a real error.
 */
export async function readReviewSettings(vendorId) {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('review_points, google_review_url')
    .eq('id', vendorId)
    .maybeSingle();
  if (isReviewsSchemaMissing(error)) return { available: false, points: 0, googleReviewUrl: null };
  if (error) throw error;
  return { available: true, points: data?.review_points ?? 0, googleReviewUrl: data?.google_review_url ?? null };
}

/** The visible reviews of one spot, newest first. Returns the raw { data, error }. */
export function listSpotReviews(vendorId, limit = 20) {
  return supabaseAdmin
    .from('vendor_reviews')
    .select('id, user_id, rating, body, author_name, created_at, updated_at')
    .eq('vendor_id', vendorId)
    .is('hidden_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// An edit within a minute of posting is a fix-up, not an edit worth labelling.
const EDIT_GRACE_MS = 60_000;

/** What anyone may see of a review. Never the user id. */
export function publicReview(r) {
  const created = Date.parse(r.created_at);
  const updated = Date.parse(r.updated_at ?? r.created_at);
  return {
    id: r.id,
    rating: r.rating,
    body: r.body ?? null,
    authorName: r.author_name ?? null,
    createdAt: r.created_at,
    edited: Number.isFinite(created) && Number.isFinite(updated) && updated - created > EDIT_GRACE_MS,
  };
}

/** Up to `limit` public reviews of a spot for the /spots page. Never throws. */
export async function publicSpotReviews(vendorId, limit = 5) {
  try {
    const { data, error } = await listSpotReviews(vendorId, limit);
    if (error) {
      if (!isReviewsSchemaMissing(error)) console.error('spot reviews unavailable:', error.message);
      return [];
    }
    return (data ?? []).map(publicReview);
  } catch (err) {
    console.error('spot reviews unavailable:', err?.message ?? err);
    return [];
  }
}
