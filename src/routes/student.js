import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile, persistTierSnapshot } from '../lib/tiers.js';
import { requireUser, requireConsent } from '../middleware/auth.js';
import { emitBalance, emitPunch } from '../lib/realtime.js';
import { ocrBusy, recognizeReceipt } from '../lib/ocr.js';
import { geminiReady, readReceiptWithGemini } from '../lib/gemini-receipt.js';
import { matchVendor, extractTotal, extractDateTime, parseIsoDateTime } from '../lib/receipt.js';
import { TERMS_VERSION, TERMS_DOCUMENTS } from '../lib/terms.js';
import { isUuid } from '../lib/ids.js';
import { getVapidPublicKey } from '../lib/push.js';
import { verifyPunchToken, punchBindingHash, punchTimezone, PUNCH_BINDING_COOKIE } from '../lib/punch.js';
import { attributeReferral, activeReferralProgram, REFERRAL_DEFAULTS } from '../lib/referrals.js';
import { maybeAwardSignupBonus } from '../lib/signup-bonus.js';
import { loadVendorCatalogue, loadRecommendedVendorIds } from '../lib/cache.js';

const router = Router();

/**
 * How far back "Recent spots" looks. Any activity inside this window — a
 * purchase, a redemption, a receipt claim (which writes an 'earn'), or a
 * scanned visit — puts a spot on the Home carousel.
 *
 * Seven days is a week of habit rather than a month of history: the row is
 * meant to answer "where have I been lately", and at a 30-day window a student
 * who tried somewhere once in week one would still be looking at it in week
 * four. Students with nothing in the window get the Recommended list instead,
 * so a short window never leaves the carousel empty.
 */
const RECENT_WINDOW_DAYS = 7;

// Every route here needs a valid session.
router.use(requireUser);

// ============================================================
// Consent + exit rights — reachable WITHOUT current consent.
//
// A student who hasn't agreed (or who declines a revision) can still get their
// data out and delete their account. Making export/delete conditional on
// accepting new terms would hold someone's own data hostage to their agreement,
// which is exactly backwards, and the Privacy Policy promises export "at any
// time." Everything below the requireConsent line is the actual service.
// ============================================================

/**
 * GET /api/me/consent
 * What the app asks right after sign-in to decide whether to show the modal.
 * `accepted: false` means: never agreed, or agreed to a superseded version.
 */
router.get('/consent', async (req, res, next) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('terms_accepted_at, terms_version, is_vendor')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;

    const accepted = Boolean(profile?.terms_accepted_at) && profile.terms_version === TERMS_VERSION;
    res.json({
      accepted,
      // True when they previously agreed to an older version — the modal says
      // "our terms have changed" rather than greeting them as a new user.
      isRevision: Boolean(profile?.terms_accepted_at) && !accepted,
      // Dual-role flag (migration-035): this student account also runs a vendor.
      isVendor: Boolean(profile?.is_vendor),
      termsVersion: TERMS_VERSION,
      documents: TERMS_DOCUMENTS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/accept-terms  { agreedToTerms }
 *
 * Creates the profile — this is where a WeRewards account actually begins.
 * Before migration-022 a DB trigger did it at OAuth time; now nothing exists
 * until this call succeeds, so declining leaves no account behind.
 *
 * One flag, matching the modal's single checkbox. Accepting the Terms carries
 * the 18+ representation with it (ToS §2), so age isn't collected separately.
 */
router.post('/accept-terms', async (req, res, next) => {
  try {
    const { agreedToTerms } = req.body ?? {};
    if (agreedToTerms !== true) {
      return res.status(400).json({
        error: 'CONSENT_INCOMPLETE',
        message: 'You must agree to the Terms and Privacy Policy to continue.',
      });
    }

    const now = new Date().toISOString();
    // Identity comes from the verified token, never the request body — a client
    // must not be able to name someone else's account or spoof a display name.
    const { id: userId, email } = req.user;
    const name = req.user.name ?? (email ? email.split('@')[0] : null);

    // Upsert, not insert: re-accepting after a terms revision hits an existing
    // row, and a double-submit (double-tap, retry) must not 500.
    const { data: profile, error: upsertErr } = await supabaseAdmin
      .from('profiles')
      .upsert(
        { user_id: userId, email, name, terms_accepted_at: now, terms_version: TERMS_VERSION },
        { onConflict: 'user_id' }
      )
      // created_at decides whether a signup bonus applies: it is the signup
      // moment, since this upsert is what creates the profile (migration-022).
      .select('created_at')
      .single();
    if (upsertErr) throw upsertErr;

    // Append-only evidence trail. Best-effort: if this insert fails we do NOT
    // fail the request — the student has consented and blocking them on an audit
    // write would be worse than a gap. The failure surfaces in error_logs.
    const { error: logErr } = await supabaseAdmin.from('terms_acceptances').insert({
      user_id: userId,
      terms_version: TERMS_VERSION,
      ip: req.ip ?? null,
      user_agent: (req.get('user-agent') ?? '').slice(0, 500) || null,
    });
    if (logErr) console.error('terms_acceptances insert failed:', logErr.message);

    // Signup bonus (migration-040). This is the signup moment, so it is where
    // the bonus is decided. maybeAwardSignupBonus never throws — consent must
    // succeed whether or not a bonus does — and is idempotent per account, so a
    // student re-accepting a revised TERMS_VERSION is not paid a second time.
    const signupBonus = await maybeAwardSignupBonus({
      userId,
      email,
      profileCreatedAt: profile?.created_at,
    });

    res.json({ ok: true, termsVersion: TERMS_VERSION, acceptedAt: now, signupBonus });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/decline
 * The student read the terms and said no. Deletes the auth user, which is all
 * that exists for a first-time signup — no profile was ever created.
 *
 * For someone who HAD accepted and is declining a revision, this is a real
 * account deletion, so the client must confirm before calling it. Same
 * underlying operation as /delete; kept separate so the two intents are
 * distinguishable in logs and so the client can word each one properly.
 *
 * Dual-role guard (migration-035): if this login is ALSO vendor staff (a
 * vendor exploring the student side and saying no thanks), deleting the auth
 * user would cascade vendor_staff away and destroy their terminal login.
 * Instead, remove only the student side: the profiles row if one exists.
 */
router.post('/decline', async (req, res, next) => {
  try {
    const { count, error: staffErr } = await supabaseAdmin
      .from('vendor_staff')
      .select('vendor_id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    if (staffErr) throw staffErr;

    if (count) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .delete()
        .eq('user_id', req.user.id);
      if (error) throw error;
      return res.json({ ok: true, keptVendorLogin: true });
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// The service itself. Every route below carries requireConsent: using
// WeRewards — earning, redeeming, browsing — requires current agreement.
// ============================================================

/**
 * GET /api/me/balances
 * All vendors + this student's balance at each (0 if never visited),
 * plus each vendor's active rewards so the app can show "1 punch away" style progress.
 */
router.get('/balances', requireConsent, async (req, res, next) => {
  try {
    const recentSince = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const [
      vendors,
      { data: balances, error: bErr },
      { data: cards, error: cErr },
      { data: favorites, error: fErr },
      { data: recentTxns, error: rErr },
      { data: recentPunches, error: pErr },
      recommended,
    ] = await Promise.all([
      // The catalogue half of this payload is IDENTICAL for every student, and
      // `vendors` has no index beyond its primary key — so filtering on `active`
      // and sorting by `created_at` is a sequential scan plus a sort. Uncached,
      // that ran once per student per home open, per socket reconnect, and on
      // every back-out of a vendor screen. See src/lib/cache.js; the per-student
      // reads below are deliberately NOT cached.
      loadVendorCatalogue(),
      supabaseAdmin.from('point_balances').select('vendor_id, balance').eq('user_id', req.user.id),
      // Visit counters (migration-029): exactly one row per (student, vendor).
      supabaseAdmin.from('punch_cards').select('vendor_id, punches').eq('user_id', req.user.id),
      // Saved spots (migration-041) — the heart on each Spots row. PK-prefixed
      // on user_id, so this is an index scan bounded by how many the student saved.
      supabaseAdmin.from('vendor_favorites').select('vendor_id').eq('user_id', req.user.id),
      // "Recent spots" part 1: anything bought or redeemed in the window. Uses
      // idx_tx_user_vendor_time (user_id leading), so it is a prefix scan.
      // `community_transfer` is excluded on purpose — moving pooled points into
      // a vendor happens inside the app, not at a counter, so it is not a visit.
      supabaseAdmin
        .from('transactions')
        .select('vendor_id')
        .eq('user_id', req.user.id)
        .in('type', ['earn', 'redeem'])
        .gte('created_at', recentSince),
      // "Recent spots" part 2: a scanned visit with no purchase attached. A
      // punch is the one kind of activity that writes no transaction row, so
      // without this a student who only ever punches would have no recent spots.
      supabaseAdmin
        .from('punches')
        .select('vendor_id')
        .eq('user_id', req.user.id)
        .gte('created_at', recentSince),
      // The Recommended fallback for a student with no recent activity. Global
      // rather than per-student, so it is cached like the catalogue.
      loadRecommendedVendorIds(),
    ]);
    if (bErr) throw bErr;
    if (cErr) throw cErr;
    if (fErr) throw fErr;
    if (rErr) throw rErr;
    if (pErr) throw pErr;

    const balanceMap = Object.fromEntries((balances ?? []).map((b) => [b.vendor_id, b.balance]));
    const visitMap = Object.fromEntries((cards ?? []).map((c) => [c.vendor_id, c.punches ?? 0]));
    const favoriteSet = new Set((favorites ?? []).map((f) => f.vendor_id));
    // Both feeds collapse to the same question — "was I here lately?" — so they
    // merge into one set rather than being ranked. The client orders the Recent
    // row itself; the server only says which spots qualify.
    const recentSet = new Set([
      ...(recentTxns ?? []).map((t) => t.vendor_id),
      ...(recentPunches ?? []).map((p) => p.vendor_id),
    ]);
    // Position in the top-N list, so the client can keep the ranking. A vendor
    // that has since been deactivated is already absent from `vendors`, so it
    // simply never gets read back out.
    const recommendedRank = new Map(recommended.map((id, i) => [id, i]));
    res.json(
      (vendors ?? []).map((v) => {
        return {
          vendorId: v.id,
          name: v.name,
          slug: v.slug,
          address: v.address ?? null,
          latitude: v.latitude ?? null,
          longitude: v.longitude ?? null,
          hasLogo: Boolean(v.has_logo),
          balance: balanceMap[v.id] ?? 0,
          // Earn rate (vendors.points_per_dollar, numeric(6,2) not null default
          // 10), so the app can tell a student what a dollar is worth here
          // instead of leaving them to infer it from a balance. Number() matches
          // how the vendor API hands the same column out (src/routes/vendor.js).
          pointsPerDollar: Number(v.points_per_dollar),
          // Feeds the Move-points picker (community-points.md step 5). Advisory
          // only — the transfer RPC re-checks eligibility server-side.
          acceptsCommunity: Boolean(v.accepts_community_points),
          rewards: (v.rewards ?? []).filter((r) => r.active),
          // Visits (migration-029): `enabled` drives the counter + scan button
          // and gates the visits price on every reward row. Each reward carries
          // its own cost_in_visits; there is no vendor-level card any more.
          punch: {
            enabled: Boolean(v.punch_enabled),
            visits: visitMap[v.id] ?? 0,
          },
          // ---- what the Spots tab and the Recent row are built from ----
          // The heart's state (migration-041).
          favorite: favoriteSet.has(v.id),
          // Any activity in the last RECENT_WINDOW_DAYS: bought, redeemed, or
          // scanned a visit. Drives the Home carousel's "Recent spots" row.
          recent: recentSet.has(v.id),
          // Rank in the most-visited list, or null. Only read when the student
          // has no recent spots at all, where the carousel shows these instead
          // under a "Recommended" heading rather than opening empty.
          recommendedRank: recommendedRank.has(v.id) ? recommendedRank.get(v.id) : null,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * Saved spots — the heart on each row of the Spots tab (migration-041).
 *
 * PUT and DELETE rather than one toggle endpoint, and both IDEMPOTENT: the
 * client sends the state it wants, not a flip. A heart is exactly the control
 * that gets double-tapped, and a toggle would turn a duplicate tap (or a retry
 * after a dropped response) into the opposite of what the student saw. Sending
 * the desired state means the same request twice is the same outcome.
 *
 * Both return the full saved list, so the client never has to guess what the
 * server now believes — one response repaints every heart on screen.
 * ============================================================ */

/** The student's saved vendor ids. Shared by both handlers below. */
async function favoriteIds(userId) {
  const { data, error } = await supabaseAdmin
    .from('vendor_favorites')
    .select('vendor_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((r) => r.vendor_id);
}

/** PUT /api/me/favorites/:vendorId — save a spot. Idempotent. */
router.put('/favorites/:vendorId', requireConsent, async (req, res, next) => {
  try {
    const vendorId = req.params.vendorId;
    if (!isUuid(vendorId)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Spot not found.' });
    }

    // Only an ACTIVE vendor may be saved. Read from the cached catalogue rather
    // than issuing a lookup: it is the same list the client just rendered from,
    // so a vendor that isn't in it is one the student could not have seen.
    const catalogue = await loadVendorCatalogue();
    if (!catalogue.some((v) => v.id === vendorId)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Spot not found.' });
    }

    // `ignoreDuplicates` makes this ON CONFLICT DO NOTHING against the (user_id,
    // vendor_id) primary key, so saving twice is a no-op rather than a 409.
    const { error } = await supabaseAdmin
      .from('vendor_favorites')
      .upsert({ user_id: req.user.id, vendor_id: vendorId }, { onConflict: 'user_id,vendor_id', ignoreDuplicates: true });
    if (error) throw error;

    res.json({ favorites: await favoriteIds(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/me/favorites/:vendorId — un-save a spot. Idempotent.
 *
 * No existence check on the vendor: un-saving must keep working for a spot that
 * has since been deactivated, or a student would be stuck with a saved row they
 * can no longer remove. Deleting something that isn't there is a no-op anyway.
 */
router.delete('/favorites/:vendorId', requireConsent, async (req, res, next) => {
  try {
    const vendorId = req.params.vendorId;
    if (!isUuid(vendorId)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Spot not found.' });
    }

    const { error } = await supabaseAdmin
      .from('vendor_favorites')
      .delete()
      .eq('user_id', req.user.id)
      .eq('vendor_id', vendorId);
    if (error) throw error;

    res.json({ favorites: await favoriteIds(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/punch  { token }  or  { holdId }
 * Claim a punch. `token` is the rotating QR payload scanned in-app (verified
 * here: HMAC + freshness); `holdId` is the camera-scan handoff minted by
 * POST /api/punch/hold before sign-in, which only counts alongside the
 * httpOnly binding cookie from that same browser.
 *
 * ONE RPC call does everything: consuming the hold, deriving the business
 * night from the scanned slot, and applying the once-per-night + card-lifecycle
 * rules — all in a single transaction, so a transient failure rolls the hold's
 * consumption back instead of stranding a student who just signed in.
 * Identity always comes from the verified session, never the request body.
 */
router.post('/punch', requireConsent, async (req, res, next) => {
  try {
    const { token, holdId } = req.body ?? {};
    const args = {
      p_user_id: req.user.id,
      p_vendor_id: null,
      p_token_window: null,
      p_hold_id: null,
      p_binding_hash: null,
      p_timezone: punchTimezone(),
    };

    if (holdId != null) {
      if (!isUuid(String(holdId))) throw new Error('HOLD_INVALID');
      args.p_hold_id = holdId;
      // The vendor and the slot come out of the hold row itself, so a caller
      // can't pair someone else's holdId with a vendor of their choosing.
      args.p_binding_hash = punchBindingHash(req);
    } else {
      const parsed = verifyPunchToken(token);
      if (!parsed) throw new Error('PUNCH_INVALID');
      args.p_vendor_id = parsed.vendorId;
      args.p_token_window = parsed.windowIndex;
    }

    const { data, error } = await supabaseAdmin.rpc('punch_in', args);
    if (error) throw error;
    if (!data?.length) throw new Error('PUNCH_INVALID');

    const row = data[0];
    const vendorId = row.vendor_id;
    // The hold is spent; the cookie has nothing left to authorize.
    if (args.p_hold_id) res.clearCookie(PUNCH_BINDING_COOKIE, { path: '/' });

    const payload = { vendorId, visits: row.new_punches };
    // Other devices this student has open re-sync their visit counter. No
    // `redeemed` flag: that one is the vendor's redemption push, which toasts.
    emitPunch(req.user.id, payload);

    const { data: vendorRow } = await supabaseAdmin.from('vendors').select('name').eq('id', vendorId).maybeSingle();
    res.json({ ...payload, vendorName: vendorRow?.name ?? 'this spot' });
  } catch (err) {
    next(err);
  }
});

// ---- Receipt scanning (migration-038) ----
// The photo arrives as a base64 data-URL in JSON (house style — vendor logos
// travel the same way) and is gone when this request ends: never written to
// disk, the DB, or a log line. Everything the claim depends on (vendor, total,
// printed time) is decided server-side — a client-supplied value would be
// minted points for anyone with curl.
//
// Two readers, in order:
//   1. lib/gemini-receipt.js (Google Gemini) when GEMINI_API_KEY is set. It
//      both judges whether the photo is a genuine printed receipt and returns
//      the fields directly. This is the ONLY forgery check in the system.
//   2. lib/ocr.js (tesseract, in-process) when that call couldn't be made at
//      all. Text only, no authenticity judgement.
// A fraud verdict from (1) is final and never retried through (2) — tesseract
// would happily read a photographed screen and pay out on it.
//
// PRIVACY: with a key set, the image is POSTed to Google for the life of this
// request (Privacy Policy §4). It is still never persisted by us, and the
// transcription is never logged.
const RECEIPT_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const RECEIPT_MAX_CHARS = 6_000_000; // ~4.5MB decoded; the client sends ~0.3-1MB
const RECEIPT_MAX_DOLLARS = 200;     // mirror of MAX_AWARD_DOLLARS (routes/vendor.js)
// Whole-request budget, kept under Heroku's 30s H12 cutoff so a slow AI call
// followed by a tesseract fallback still answers the student instead of dying
// mid-connection. Whatever the AI pass doesn't spend, tesseract gets.
const RECEIPT_DEADLINE_MS = 27_000;
// Only reject as fake when the model is actually sure. Below this a "false"
// verdict is treated as "couldn't tell" and the claim proceeds on its merits:
// a creased, badly-lit, genuine receipt must not be called a forgery, and the
// $200 cap plus the (vendor, time, total) dedup key still bound the damage.
const RECEIPT_FAKE_MIN_CONFIDENCE = 0.7;

/**
 * POST /api/me/receipt  { image }
 * Claim points for a paper receipt. claim_receipt() is one atomic transaction:
 * freshness window, 3/day cap, the counter double-dip check, the UNIQUE
 * (vendor, printed time, total) insert — first scanner wins — and the award
 * itself via award_points (same tier math as a terminal award).
 */
router.post('/receipt', requireConsent, async (req, res, next) => {
  try {
    const startedAt = Date.now();
    // Saturation first: 503 before decoding a single byte of base64. Only when
    // tesseract is the primary reader, though — with the AI reader up, the wasm
    // worker is the fallback, and 503-ing a scan because IT is busy would
    // refuse a request that was never going to touch it.
    if (!geminiReady() && ocrBusy()) throw new Error('RECEIPT_BUSY');

    const image = req.body?.image;
    const m = (typeof image === 'string' && image.length <= RECEIPT_MAX_CHARS)
      ? RECEIPT_DATA_URL.exec(image)
      : null;
    if (!m) throw new Error('RECEIPT_IMAGE_INVALID');
    const [, mimeType, base64] = m;

    // Reader 1. Resolves null on any infrastructure failure — no key, quota
    // gone, timeout, outage — which is the cue to fall through to tesseract.
    const ai = await readReceiptWithGemini(base64, mimeType);

    // A confident forgery verdict ends the claim here. Note what is NOT done:
    // no retry through tesseract, which cannot see a screen bezel or a cloned
    // total and would simply pay out.
    if (ai && !ai.isReceipt && ai.confidence >= RECEIPT_FAKE_MIN_CONFIDENCE) {
      throw new Error('RECEIPT_NOT_GENUINE');
    }

    // Reader 2, only if reader 1 never got an answer. It gets whatever is left
    // of the request budget, since the AI attempt already spent some of it.
    let text = ai?.rawText ?? '';
    if (!ai) {
      const buf = Buffer.from(base64, 'base64');
      try {
        text = await recognizeReceipt(buf, RECEIPT_DEADLINE_MS - (Date.now() - startedAt));
      } finally {
        buf.fill(0); // the image's only server-side copy dies with this request
      }
      if (!text || text.trim().length < 12) throw new Error('RECEIPT_UNREADABLE');
    }
    // The AI answered but read nothing off the image (out of focus, thumb over
    // the header). Say "unreadable" rather than letting an empty transcription
    // fall through to the vendor matcher and come back as "no such spot".
    if (ai && !ai.vendorName && ai.total == null && text.trim().length < 12) {
      throw new Error('RECEIPT_UNREADABLE');
    }

    const { data: vendors, error: vErr } = await supabaseAdmin
      .from('vendors')
      .select('id, name, points_per_dollar')
      .eq('active', true);
    if (vErr) throw vErr;

    // The AI's vendor_name is a HINT, never an identity: the vendor id still
    // comes from matchVendor against the active-vendor table, so a hallucinated
    // or attacker-planted name can only fail to match — it can't mint one.
    let hit = ai?.vendorName ? matchVendor(ai.vendorName, vendors ?? []) : null;
    if (!hit) hit = matchVendor(text, vendors ?? []);
    if (!hit) throw new Error('RECEIPT_VENDOR_UNKNOWN');

    // Per field: take the AI's structured value, else parse the transcription.
    // A model that reads four fields and fluffs the fifth still gets the claim
    // through, instead of costing the student a retake.
    let total = Number.isFinite(ai?.total) ? ai.total : extractTotal(text);
    if (total == null || total <= 0) throw new Error('RECEIPT_TOTAL_MISSING');
    total = Math.round(total * 100) / 100; // cents, not float dust
    if (total > RECEIPT_MAX_DOLLARS) throw new Error('RECEIPT_TOTAL_TOO_LARGE');

    const dt = (ai ? parseIsoDateTime(ai.date, ai.time) : null) ?? extractDateTime(text);
    if (!dt) throw new Error('RECEIPT_DATETIME_MISSING');
    // Impossible calendar dates (an OCR'd "02/31") map to a clean error here;
    // the SQL timestamp cast would turn them into a 500 instead.
    const probe = new Date(dt.y, dt.m - 1, dt.d);
    if (probe.getMonth() !== dt.m - 1 || probe.getDate() !== dt.d) {
      throw new Error('RECEIPT_DATETIME_MISSING');
    }

    // Same formula as POST /api/vendor/award: ratio → floor, then the tier
    // multiplier (computed BEFORE this award lands) → floor.
    const basePoints = Math.floor(total * Number(hit.vendor.points_per_dollar));
    if (basePoints < 1) throw new Error('RECEIPT_TOTAL_MISSING');
    const tierProfile = await computeTierProfile(req.user.id);
    const points = Math.floor(basePoints * tierProfile.multiplier);

    const pad = (n) => String(n).padStart(2, '0');
    const receiptLocal = `${dt.y}-${pad(dt.m)}-${pad(dt.d)} ${pad(dt.hh)}:${pad(dt.mm)}:00`;

    const { data, error } = await supabaseAdmin.rpc('claim_receipt', {
      p_user_id: req.user.id,
      p_vendor_id: hit.vendor.id,
      p_receipt_local: receiptLocal,
      p_timezone: punchTimezone(),
      p_total: total,
      p_points: points,
    });
    if (error) throw error;

    const row = data?.[0] ?? {};
    // Same live push as a terminal award — an open app updates its card,
    // meter, tier, and history without a reload.
    emitBalance(req.user.id, { vendorId: hit.vendor.id, balance: row.new_balance, community: row.new_community });
    persistTierSnapshot(req.user.id, tierProfile).catch(() => {});

    res.json({
      awarded: points,
      basePoints,
      bonusPoints: points - basePoints,
      tier: tierProfile.tier,
      multiplier: tierProfile.multiplier,
      vendorId: hit.vendor.id,
      vendorName: hit.vendor.name,
      total,
      receiptAt: receiptLocal,
      newBalance: row.new_balance,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/earn-code
 * The 6-digit identity code the student shows to earn points. The RPC
 * reuses the student's live code (stable across the app's periodic refresh) and
 * guarantees it's unique across all live codes. Client refreshes every ~2 min.
 */
router.post('/earn-code', requireConsent, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('create_earn_code', {
      p_user_id: req.user.id,
      p_ttl_seconds: 300,
    });
    if (error) throw error;
    res.json({ code: data, ttlSeconds: 300 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/redeem-code  { vendorId, rewardId, paidWith }
 * Pre-checks affordability so the student gets a clear error before showing a
 * code, then mints a unique 4-digit redemption code (one live code per student
 * per vendor, across BOTH currencies — tapping the other button replaces it).
 * The final atomic check + single-use consumption happens in redeem_by_code.
 *
 * `paidWith` is 'points' or 'visits'. These checks are advisory only:
 * create_redeem_code re-verifies against the DB, which is the authority.
 */
router.post('/redeem-code', requireConsent, async (req, res, next) => {
  try {
    const { vendorId, rewardId, paidWith = 'points' } = req.body ?? {};
    // Validate the shape up front: a malformed id would otherwise hit a uuid
    // column and error (here it's swallowed into a misleading VENDOR_UNAVAILABLE).
    if (!isUuid(vendorId) || !isUuid(rewardId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'vendorId and rewardId required.' });
    }
    if (paidWith !== 'points' && paidWith !== 'visits') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Choose points or visits.' });
    }

    const [{ data: vendorRow }, { data: reward }, { data: bal }, { data: card }] = await Promise.all([
      supabaseAdmin.from('vendors').select('active, punch_enabled').eq('id', vendorId).maybeSingle(),
      supabaseAdmin.from('rewards').select('cost_in_points, cost_in_visits, active').eq('id', rewardId).eq('vendor_id', vendorId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', req.user.id).eq('vendor_id', vendorId).maybeSingle(),
      supabaseAdmin.from('punch_cards').select('punches').eq('user_id', req.user.id).eq('vendor_id', vendorId).maybeSingle(),
    ]);

    // Belt-and-suspenders for a stale client: a vendor disabled by the operator
    // between page-load and redeem is cut off here too, not just hidden on the
    // next refresh. (The terminal is already blocked, so the code couldn't be
    // used anyway — this just gives a clear error instead of a dead code.)
    if (!vendorRow?.active) throw new Error('VENDOR_UNAVAILABLE');
    if (!reward?.active) throw new Error('REWARD_NOT_FOUND');

    // Both prices are nullable since migration-029, so every comparison has to
    // be currency-explicit. A bare `balance < reward.cost_in_points` against a
    // NULL cost is `false` in JS, which would silently mint a code that then
    // dies at the counter with the student standing in front of the cashier.
    if (paidWith === 'points') {
      if (reward.cost_in_points == null) throw new Error('REWARD_NOT_POINTS_PRICED');
      if ((bal?.balance ?? 0) < reward.cost_in_points) throw new Error('INSUFFICIENT_POINTS');
    } else {
      if (!vendorRow.punch_enabled) throw new Error('PUNCH_DISABLED');
      if (reward.cost_in_visits == null) throw new Error('REWARD_NOT_VISITS_PRICED');
      if ((card?.punches ?? 0) < reward.cost_in_visits) throw new Error('INSUFFICIENT_VISITS');
    }

    const { data, error } = await supabaseAdmin.rpc('create_redeem_code', {
      p_user_id: req.user.id,
      p_vendor_id: vendorId,
      p_reward_id: rewardId,
      p_paid_with: paidWith,
      p_ttl_seconds: 120,
    });
    if (error) throw error;
    res.json({ code: data, ttlSeconds: 120, paidWith });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/tier
 * 30-day engagement score + current earn multiplier for the home tier bar.
 */
router.get('/tier', requireConsent, async (req, res, next) => {
  try {
    res.json(await computeTierProfile(req.user.id));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/community — the cross-vendor pool (community-points.md step 4).
 * Not keyed to a vendor: one row per student, minted at 10% of every earn.
 * A student who has never earned has no row, which is a 0 balance, not an error.
 */
router.get('/community', requireConsent, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('community_balances')
      .select('balance, lifetime_earned')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ balance: data?.balance ?? 0, lifetimeEarned: data?.lifetime_earned ?? 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/community-transfer  { vendorId, amount, requestId? }
 * Move community points into one vendor's balance — one-way, final
 * (community-points.md step 5). The amount is the student's choice; whether
 * they have it, and whether the vendor is eligible / under its monthly inbound
 * cap, is decided inside the atomic transfer_community_points RPC. `requestId`
 * is the same client-generated idempotency token /api/vendor/award uses, so a
 * network retry of a confirmed move can't move the points twice.
 */
router.post('/community-transfer', requireConsent, async (req, res, next) => {
  try {
    const { vendorId, amount, requestId } = req.body ?? {};
    if (!isUuid(vendorId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'vendorId required.' });
    }
    const amt = Number(amount);
    // Whole points only, bounded well above any real balance (the RPC's
    // balance >= amount guard is the true ceiling — this just keeps a junk
    // value from reaching an integer column as a cast error).
    if (!Number.isInteger(amt) || amt < 1 || amt > 1_000_000) {
      return res.status(400).json({ error: 'AMOUNT_INVALID', message: 'Enter a valid number of points to move.' });
    }
    const clientToken = (typeof requestId === 'string' && /^[\w-]{8,64}$/.test(requestId))
      ? requestId
      : null;

    const { data, error } = await supabaseAdmin.rpc('transfer_community_points', {
      p_user_id: req.user.id,
      p_vendor_id: vendorId,
      p_amount: amt,
      p_client_token: clientToken,
    });
    if (error) throw error;

    const newCommunity = data?.[0]?.new_community ?? 0;
    const newBalance = data?.[0]?.new_vendor_balance ?? 0;
    // Same event the award path pushes, so every open tab's vendor card and
    // community counter move together (public/student/app.js reads both fields).
    emitBalance(req.user.id, { vendorId, balance: newBalance, community: newCommunity });

    res.json({ newCommunity, newBalance });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/referral — this student's share code and how it is doing.
 * `program` is null when no referral program is running, which the card uses to
 * hide itself rather than advertise a bonus nobody will be paid.
 */
router.get('/referral', requireConsent, async (req, res, next) => {
  try {
    const [{ data: profile, error: pErr }, program] = await Promise.all([
      supabaseAdmin.from('profiles').select('referral_code').eq('user_id', req.user.id).maybeSingle(),
      activeReferralProgram(),
    ]);
    if (pErr) throw pErr;

    // Every profile gets a code from a trigger at signup (migration-039), so a
    // missing one means a row that predates the migration's backfill somehow.
    // Report it as "no code" rather than 500 — the rest of the card still works.
    const code = profile?.referral_code ?? null;
    const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;

    const { data: mine, error: mErr } = await supabaseAdmin
      .from('referrals')
      .select('status, referrer_points')
      .eq('referrer_id', req.user.id);
    if (mErr) throw mErr;

    const rows = mine ?? [];
    const cfg = { ...REFERRAL_DEFAULTS, ...(program?.config ?? {}) };

    res.json({
      code,
      shareUrl: code ? `${origin}/?ref=${code}` : null,
      joined: rows.length,
      // "Waiting" is the honest word: the friend signed up but hasn't bought
      // anything yet, and the card says exactly that.
      waiting: rows.filter((r) => r.status === 'pending').length,
      earned: rows.filter((r) => r.status === 'paid').reduce((n, r) => n + r.referrer_points, 0),
      program: program
        ? { referrerPoints: cfg.referrerPoints, friendPoints: cfg.friendPoints }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/referral  { code }
 * Claim a friend's code. Called once, by the app, right after a signed-in
 * student is seen to be carrying a `?ref=` code (see public/student/app.js) —
 * the code survives the OAuth round trip in localStorage, because the redirect
 * back from Google drops the query string.
 *
 * Everything that decides whether this is allowed lives in attributeReferral,
 * and the one rule that must never bend — a student is referred once, ever —
 * is a UNIQUE index underneath it.
 */
router.post('/referral', requireConsent, async (req, res, next) => {
  try {
    const result = await attributeReferral(req.user.id, req.body?.code);
    // The friend's signup bonus lands immediately, so push it the same way an
    // award does and their counter moves while they're still on the screen.
    if (result.friendPoints > 0) {
      const { data } = await supabaseAdmin
        .from('community_balances')
        .select('balance')
        .eq('user_id', req.user.id)
        .maybeSingle();
      emitBalance(req.user.id, { community: data?.balance ?? 0 });
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/history — the student's last 30 days.
 *
 * Two sources merged, because community points arrive two different ways: the
 * 10% that rides on an `earn` row (migration-026), and an incentive payout,
 * which has no vendor and therefore cannot be a transaction at all
 * (community_grants, migration-039). A referral bonus that never appeared here
 * would look to a student like points from nowhere.
 *
 * Grants are shaped into the same envelope the client's historyRow() already
 * reads rather than shipped as a second list: the tab groups strictly by day,
 * so two lists would have to be interleaved on the client anyway.
 */
router.get('/history', requireConsent, async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('transactions')
      // community_points rides on the earn's own row, so the History tab can
      // show "+150 pts · +15 community" without a second query. paid_with /
      // visits_spent do the same job for a visits redemption, which is points=0
      // and would otherwise render as a meaningless "-0 pts".
      // `reverses` marks a compensating row, which carries the original's type
      // with every number negated and would otherwise render as a duplicate.
      .select('id, vendor_id, type, points, dollar_amount, community_points, paid_with, visits_spent, reverses, created_at, vendors(name), rewards(title)')
      .eq('user_id', req.user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const { data: grants, error: gErr } = await supabaseAdmin
      .from('community_grants')
      .select('id, points, kind, reason, created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);
    if (gErr) throw gErr;

    // type 'grant' is a CLIENT-SIDE label, not a transactions.type — nothing
    // here is written back, and transactions_type_check knows nothing about it.
    // points carries the amount so the row's chip works unchanged; grant_kind
    // is what the client uses to choose the wording.
    const asRows = (grants ?? []).map((g) => ({
      id: g.id,
      type: 'grant',
      grant_kind: g.kind,
      reason: g.reason,
      points: 0,                    // no vendor balance moved
      community_points: g.points,
      vendor_id: null,
      created_at: g.created_at,
    }));

    const merged = [...(data ?? []), ...asRows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 200);

    res.json(merged);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * Deals: vendor campaigns targeted at this student (migration-032).
 *
 * The list is the source of truth, NOT the notification. Every campaign a
 * student is targeted by lands here the moment it is created, whether or not a
 * push was ever allowed, delivered, or throttled away. That is what makes the
 * delivery throttle safe to be as aggressive as it is: suppressing a
 * notification removes an interruption, never a message.
 * ============================================================ */

/** GET /api/me/deals — live deals for this student, newest first. */
router.get('/deals', requireConsent, async (req, res, next) => {
  try {
    const nowIso = new Date().toISOString();
    const [{ data, error }, { data: state }, { count: subCount }] = await Promise.all([
      supabaseAdmin
        .from('campaign_recipients')
        .select('campaign_id, read_at, opened_at, vendor_campaigns!inner(title, body, kind, expires_at, created_at, vendor_id, vendors!inner(name, has_logo, active))')
        .eq('user_id', req.user.id)
        .gt('vendor_campaigns.expires_at', nowIso)
        .limit(50),
      supabaseAdmin
        .from('student_notify_state')
        .select('push_opt_in')
        .eq('user_id', req.user.id)
        .maybeSingle(),
      // Do we actually hold somewhere to send to? claim_campaign_pushes will not
      // claim a student without one (migration-032), so with zero rows here the
      // student is unreachable no matter what their switch says — and that is
      // invisible from the browser, where permission can read 'granted' over a
      // subscribe that never completed or an endpoint we pruned as dead.
      supabaseAdmin
        .from('push_subscriptions')
        .select('endpoint', { count: 'exact', head: true })
        .eq('user_id', req.user.id)
        .eq('role', 'student'),
    ]);
    if (error) throw error;

    // Sorting and the active-vendor filter are done here rather than in the
    // query: the list is at most a handful of rows, and filtering across two
    // levels of embedding is the sort of PostgREST syntax that breaks quietly
    // on a client upgrade.
    const deals = (data ?? [])
      .filter((r) => r.vendor_campaigns?.vendors?.active)
      .map((r) => ({
        id: r.campaign_id,
        vendorId: r.vendor_campaigns.vendor_id,
        vendor: r.vendor_campaigns.vendors.name,
        hasLogo: Boolean(r.vendor_campaigns.vendors.has_logo),
        title: r.vendor_campaigns.title,
        body: r.vendor_campaigns.body,
        kind: r.vendor_campaigns.kind,
        expiresAt: r.vendor_campaigns.expires_at,
        createdAt: r.vendor_campaigns.created_at,
        read: Boolean(r.read_at),
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      deals,
      unread: deals.filter((d) => !d.read).length,
      // `push_opt_in` defaults on; the row only exists once they have been
      // targeted or have changed the setting.
      dealAlerts: state?.push_opt_in ?? true,
      // "Can this student be reached at all", as distinct from "did they say
      // yes". The client re-subscribes when this is false and permission is
      // granted, which is what repairs the otherwise-permanent silent state.
      pushReady: (subCount ?? 0) > 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/deals/read  { id? }
 * Marks one deal read, or all of them when `id` is absent (which is what
 * opening the list does).
 */
router.post('/deals/read', requireConsent, async (req, res, next) => {
  try {
    const id = req.body?.id;
    if (id !== undefined && !isUuid(String(id))) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown deal.' });
    }
    let q = supabaseAdmin
      .from('campaign_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .is('read_at', null);
    if (id !== undefined) q = q.eq('campaign_id', String(id));
    const { error } = await q;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/deals/open  { id }
 * Click-through attribution: the vendor's DEALS tab shows how many of the
 * students it reached actually tapped in. Idempotent (first tap wins).
 */
router.post('/deals/open', requireConsent, async (req, res, next) => {
  try {
    const id = String(req.body?.id ?? '');
    if (!isUuid(id)) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown deal.' });
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('campaign_recipients')
      .update({ opened_at: now, read_at: now })
      .eq('user_id', req.user.id)
      .eq('campaign_id', id)
      .is('opened_at', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------- push subscriptions + the student's own switch ---------- */

/** GET /api/me/push/public-key — null when the server has no VAPID keys. */
router.get('/push/public-key', requireConsent, (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

/**
 * POST /api/me/push/subscribe  { endpoint, keys: { p256dh, auth } }
 * Upserted on endpoint, so re-posting on every load just keeps it fresh.
 * role='student' is what keeps operator alerts (notifyAdmins) off this device.
 */
router.post('/push/subscribe', requireConsent, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
    const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
    const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth
        || p256dh.length > 300 || auth.length > 100) {
      return res.status(400).json({ error: 'BAD_SUBSCRIPTION', message: 'That push subscription looks invalid.' });
    }
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .upsert({ endpoint, p256dh, auth, user_id: req.user.id, role: 'student' }, { onConflict: 'endpoint' });
    if (error) throw error;
    // Turning notifications on is also an opt-in: a student who switched deal
    // alerts off and later re-granted permission means it.
    await supabaseAdmin
      .from('student_notify_state')
      .upsert({ user_id: req.user.id, push_opt_in: true, updated_at: new Date().toISOString() },
              { onConflict: 'user_id' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/push/unsubscribe  { endpoint? }
 * Drops this device's endpoint (or all of them). Used when the student turns
 * deal alerts off, so we stop paying to push at a device that will ignore it.
 */
router.post('/push/unsubscribe', requireConsent, async (req, res, next) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
    let q = supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('user_id', req.user.id)
      .eq('role', 'student');
    if (endpoint) q = q.eq('endpoint', endpoint);
    const { error } = await q;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/me/notify  { dealAlerts: boolean }
 * The opt-out the Privacy Policy promises. Governs PUSH only: the in-app deals
 * list is unaffected, because turning off interruptions is not the same as
 * refusing to be told anything.
 */
router.patch('/notify', requireConsent, async (req, res, next) => {
  try {
    const on = req.body?.dealAlerts;
    if (typeof on !== 'boolean') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Deal alerts must be on or off.' });
    }
    const { error } = await supabaseAdmin
      .from('student_notify_state')
      .upsert({ user_id: req.user.id, push_opt_in: on, updated_at: new Date().toISOString() },
              { onConflict: 'user_id' });
    if (error) throw error;
    if (!on) {
      await supabaseAdmin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', req.user.id)
        .eq('role', 'student');
    }
    res.json({ dealAlerts: on });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/export
 * Everything WeRewards holds about the signed-in student, as a JSON download:
 * profile (Google identity we store), per-vendor balances, full transaction
 * history, and the latest engagement-score snapshot. A privacy baseline.
 */
router.get('/export', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [profile, balances, community, transactions, scores, deals, notify, grants, invitesSent, inviteUsed] = await Promise.all([
      supabaseAdmin.from('profiles').select('user_id, name, email, revisits, created_at, referral_code').eq('user_id', uid).maybeSingle(),
      supabaseAdmin.from('point_balances').select('vendor_id, balance, updated_at').eq('user_id', uid),
      // The community pool is a balance we hold, so the export promises it too.
      supabaseAdmin.from('community_balances').select('balance, lifetime_earned, updated_at').eq('user_id', uid).maybeSingle(),
      supabaseAdmin
        .from('transactions')
        // paid_with / visits_spent too: a visits redemption stores points = 0, so
        // without them the export would claim the student spent nothing.
        .select('id, vendor_id, type, points, dollar_amount, community_points, paid_with, visits_spent, reward_id, created_at, vendors(name), rewards(title)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false }),
      supabaseAdmin.from('user_scores').select('*').eq('user_id', uid).maybeSingle(),
      // Which vendor deals we targeted this student with, and what we did with
      // each one. "Everything we hold" now includes the marketing record.
      supabaseAdmin
        .from('campaign_recipients')
        .select('campaign_id, status, pushed_at, read_at, opened_at, vendor_campaigns(title, body, kind, created_at, vendors(name))')
        .eq('user_id', uid),
      supabaseAdmin.from('student_notify_state').select('push_opt_in, last_push_at').eq('user_id', uid).maybeSingle(),
      // Community points we GAVE them and why (migration-039/040). Not a
      // transaction, so the history above misses it entirely — and "points that
      // appeared from nowhere" is exactly what an export exists to explain.
      supabaseAdmin
        .from('community_grants')
        .select('id, points, kind, reason, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false }),
      // Both sides of the referral link. Deliberately two reads rather than an
      // OR: referrals has two FKs to profiles, and keeping them apart is what
      // lets the payload label who invited whom without the reader guessing.
      // NOTE the absence of friend_id. An export must return the requester's
      // data, not another data subject's, and the referrer never held that
      // identifier: the app only ever shows them counts. "You invited someone
      // on this date, they qualified, you were paid N" is the whole of their
      // own record. (The reverse read below does keep `code`, because that is
      // a value the student typed in themselves.)
      supabaseAdmin
        .from('referrals')
        .select('id, status, referrer_points, qualified_at, paid_at, created_at')
        .eq('referrer_id', uid)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('referrals')
        .select('id, code, status, friend_points, created_at')
        .eq('friend_id', uid)
        .maybeSingle(),
    ]);
    for (const r of [profile, balances, community, transactions, scores, deals, notify, grants, invitesSent, inviteUsed]) {
      if (r.error) throw r.error;
    }

    res.setHeader('Content-Disposition', 'attachment; filename="werewards-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: { id: uid, email: req.user.email },
      profile: profile.data,
      balances: balances.data ?? [],
      community: community.data ?? { balance: 0, lifetime_earned: 0 },
      transactions: transactions.data ?? [],
      scores: scores.data,
      deals: deals.data ?? [],
      notifications: notify.data ?? { push_opt_in: true, last_push_at: null },
      // Bonus points from an incentive or an operator, and the referral links
      // we hold about this student.
      bonusPoints: grants.data ?? [],
      referrals: {
        code: profile.data?.referral_code ?? null,
        invitesSent: invitesSent.data ?? [],
        inviteUsed: inviteUsed.data ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/delete
 * Deletes the signed-in student's auth user. `on delete cascade` removes the
 * profile, balances, live codes, and score snapshot; transaction rows are kept
 * but anonymized (user_id → null, migration-011) so vendors' revenue totals
 * don't silently change. Irreversible.
 *
 * Dual-role guard (migration-035): a vendor-linked account keeps its auth user
 * (and with it the terminal login) — only the student side goes. Deleting the
 * profiles row directly triggers the same cascades the auth-user delete would
 * (balances, codes, snapshots; transactions anonymize), minus vendor_staff.
 */
router.post('/delete', async (req, res, next) => {
  try {
    await forgetPushSubscriptions(req.user.id);

    const { count, error: staffErr } = await supabaseAdmin
      .from('vendor_staff')
      .select('vendor_id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    if (staffErr) throw staffErr;

    if (count) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .delete()
        .eq('user_id', req.user.id);
      if (error) throw error;
      return res.json({ ok: true, keptVendorLogin: true });
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * push_subscriptions has NO foreign key on user_id (the error_logs convention,
 * migration-018), so the profile cascade that clears campaign_recipients and
 * student_notify_state does NOT reach it. Left alone, a deleted account's push
 * endpoints would outlive the account — and the Privacy Policy says they are
 * deleted with it. Done BEFORE the auth user goes, so a failure here surfaces
 * as a failed deletion rather than silently orphaning them.
 */
async function forgetPushSubscriptions(userId) {
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('role', 'student');
  if (error) throw error;
}

export default router;
