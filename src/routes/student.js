import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile } from '../lib/tiers.js';
import { requireUser, requireConsent } from '../middleware/auth.js';
import { emitBalance, emitPunch } from '../lib/realtime.js';
import { TERMS_VERSION, TERMS_DOCUMENTS } from '../lib/terms.js';
import { isUuid } from '../lib/ids.js';
import { getVapidPublicKey } from '../lib/push.js';
import { verifyPunchToken, punchBindingHash, punchTimezone, PUNCH_BINDING_COOKIE } from '../lib/punch.js';

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
    const [{ data: vendors, error: vErr }, { data: balances, error: bErr }, { data: cards, error: cErr }] = await Promise.all([
      // Newest vendors first so they land at the start (left) of the home carousel.
      supabaseAdmin.from('vendors').select('id, name, slug, address, latitude, longitude, has_logo, accepts_community_points, punch_enabled, rewards(id, title, cost_in_points, cost_in_visits, emoji, active)').eq('active', true).order('created_at', { ascending: false }),
      supabaseAdmin.from('point_balances').select('vendor_id, balance').eq('user_id', req.user.id),
      // Visit counters (migration-029): exactly one row per (student, vendor).
      supabaseAdmin.from('punch_cards').select('vendor_id, punches').eq('user_id', req.user.id),
    ]);
    if (vErr) throw vErr;
    if (bErr) throw bErr;
    if (cErr) throw cErr;

    const balanceMap = Object.fromEntries((balances ?? []).map((b) => [b.vendor_id, b.balance]));
    const visitMap = Object.fromEntries((cards ?? []).map((c) => [c.vendor_id, c.punches ?? 0]));
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
        };
      })
    );
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

/** GET /api/me/history — the student's transactions over the last 30 days */
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
    res.json(data);
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
    const [profile, balances, community, transactions, scores, deals, notify] = await Promise.all([
      supabaseAdmin.from('profiles').select('user_id, name, email, revisits, created_at').eq('user_id', uid).maybeSingle(),
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
    ]);
    for (const r of [profile, balances, community, transactions, scores, deals, notify]) if (r.error) throw r.error;

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
    await forgetPushSubscriptions(req.user.id);
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
