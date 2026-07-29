import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile } from '../lib/tiers.js';
import { requireUser, requireConsent } from '../middleware/auth.js';
import { emitBalance } from '../lib/realtime.js';
import { TERMS_VERSION, TERMS_DOCUMENTS } from '../lib/terms.js';
import { isUuid } from '../lib/ids.js';

const router = Router();

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
      .select('terms_accepted_at, terms_version')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;

    const accepted = Boolean(profile?.terms_accepted_at) && profile.terms_version === TERMS_VERSION;
    res.json({
      accepted,
      // True when they previously agreed to an older version — the modal says
      // "our terms have changed" rather than greeting them as a new user.
      isRevision: Boolean(profile?.terms_accepted_at) && !accepted,
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
    const { error: upsertErr } = await supabaseAdmin
      .from('profiles')
      .upsert(
        { user_id: userId, email, name, terms_accepted_at: now, terms_version: TERMS_VERSION },
        { onConflict: 'user_id' }
      );
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

    res.json({ ok: true, termsVersion: TERMS_VERSION, acceptedAt: now });
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
 */
router.post('/decline', async (req, res, next) => {
  try {
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
    const [{ data: vendors, error: vErr }, { data: balances, error: bErr }] = await Promise.all([
      // Newest vendors first so they land at the start (left) of the home carousel.
      supabaseAdmin.from('vendors').select('id, name, slug, address, latitude, longitude, has_logo, accepts_community_points, rewards(id, title, cost_in_points, emoji, active)').eq('active', true).order('created_at', { ascending: false }),
      supabaseAdmin.from('point_balances').select('vendor_id, balance').eq('user_id', req.user.id),
    ]);
    if (vErr) throw vErr;
    if (bErr) throw bErr;

    const balanceMap = Object.fromEntries((balances ?? []).map((b) => [b.vendor_id, b.balance]));
    res.json(
      (vendors ?? []).map((v) => ({
        vendorId: v.id,
        name: v.name,
        slug: v.slug,
        address: v.address ?? null,
        latitude: v.latitude ?? null,
        longitude: v.longitude ?? null,
        hasLogo: Boolean(v.has_logo),
        balance: balanceMap[v.id] ?? 0,
        // Feeds the Move-points picker (community-points.md step 5). Advisory
        // only — the transfer RPC re-checks eligibility server-side.
        acceptsCommunity: Boolean(v.accepts_community_points),
        rewards: (v.rewards ?? []).filter((r) => r.active),
      }))
    );
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
 * POST /api/me/redeem-code  { vendorId, rewardId }
 * Pre-checks affordability so the student gets a clear error before showing a
 * code, then mints a unique 4-digit redemption code (one live code per student
 * per vendor — pending redemptions at other vendors are unaffected).
 * The final atomic check + single-use consumption happens in redeem_by_code.
 */
router.post('/redeem-code', requireConsent, async (req, res, next) => {
  try {
    const { vendorId, rewardId } = req.body ?? {};
    // Validate the shape up front: a malformed id would otherwise hit a uuid
    // column and error (here it's swallowed into a misleading VENDOR_UNAVAILABLE).
    if (!isUuid(vendorId) || !isUuid(rewardId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'vendorId and rewardId required.' });
    }

    const [{ data: vendorRow }, { data: reward }, { data: bal }] = await Promise.all([
      supabaseAdmin.from('vendors').select('active').eq('id', vendorId).maybeSingle(),
      supabaseAdmin.from('rewards').select('cost_in_points, active').eq('id', rewardId).eq('vendor_id', vendorId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', req.user.id).eq('vendor_id', vendorId).maybeSingle(),
    ]);

    // Belt-and-suspenders for a stale client: a vendor disabled by the operator
    // between page-load and redeem is cut off here too, not just hidden on the
    // next refresh. (The terminal is already blocked, so the code couldn't be
    // used anyway — this just gives a clear error instead of a dead code.)
    if (!vendorRow?.active) throw new Error('VENDOR_UNAVAILABLE');
    if (!reward?.active) throw new Error('REWARD_NOT_FOUND');
    if ((bal?.balance ?? 0) < reward.cost_in_points) throw new Error('INSUFFICIENT_POINTS');

    const { data, error } = await supabaseAdmin.rpc('create_redeem_code', {
      p_user_id: req.user.id,
      p_vendor_id: vendorId,
      p_reward_id: rewardId,
      p_ttl_seconds: 120,
    });
    if (error) throw error;
    res.json({ code: data, ttlSeconds: 120 });
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

/** GET /api/me/history — the student's transactions over the last 30 days */
router.get('/history', requireConsent, async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('transactions')
      // community_points rides on the earn's own row, so the History tab can
      // show "+150 pts · +15 community" without a second query.
      .select('id, vendor_id, type, points, dollar_amount, community_points, created_at, vendors(name), rewards(title)')
      .eq('user_id', req.user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data);
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
    const [profile, balances, community, transactions, scores] = await Promise.all([
      supabaseAdmin.from('profiles').select('user_id, name, email, revisits, created_at').eq('user_id', uid).maybeSingle(),
      supabaseAdmin.from('point_balances').select('vendor_id, balance, updated_at').eq('user_id', uid),
      // The community pool is a balance we hold, so the export promises it too.
      supabaseAdmin.from('community_balances').select('balance, lifetime_earned, updated_at').eq('user_id', uid).maybeSingle(),
      supabaseAdmin
        .from('transactions')
        .select('id, vendor_id, type, points, dollar_amount, community_points, reward_id, created_at, vendors(name), rewards(title)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false }),
      supabaseAdmin.from('user_scores').select('*').eq('user_id', uid).maybeSingle(),
    ]);
    for (const r of [profile, balances, community, transactions, scores]) if (r.error) throw r.error;

    res.setHeader('Content-Disposition', 'attachment; filename="werewards-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: { id: uid, email: req.user.email },
      profile: profile.data,
      balances: balances.data ?? [],
      community: community.data ?? { balance: 0, lifetime_earned: 0 },
      transactions: transactions.data ?? [],
      scores: scores.data,
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
 */
router.post('/delete', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
