/**
 * In-process caches for the reads that are IDENTICAL ACROSS STUDENTS.
 *
 * WHY THIS EXISTS
 * Every student's home screen re-runs the same two reads: the active-vendor
 * catalogue (`vendors where active = true`, plus every vendor's rewards) and one
 * `/api/vendor-logo/:id` per card. Neither depends on who is asking. The
 * catalogue is also unindexed — `vendors` carries only its `id` primary key and
 * a unique on `slug`, so filtering on `active` and sorting by `created_at` is a
 * sequential scan plus a sort, every time — and the logo route pulls a base64
 * blob out of Postgres per vendor per render. Balances are NOT cached here and
 * must never be: they are per-student, they move on every award, and the socket
 * layer exists to keep them live.
 *
 * SINGLE-FLIGHT IS THE POINT, NOT THE TTL.
 * A plain TTL cache still lets a cold key stampede: 300 students opening the app
 * in the same second all miss, and all 300 run the same sequential scan. So a
 * miss stores the PROMISE before awaiting it, and every caller that arrives
 * while it is in flight awaits that same promise. One query serves the herd.
 * This is what makes the cache a concurrency fix rather than a latency tweak.
 *
 * STALE-ON-ERROR.
 * A loader that throws never overwrites a good entry and is never itself cached
 * — one Supabase blip must not poison a key for the whole TTL. If an expired
 * entry is still within `staleMs`, it is served instead of propagating the
 * error, so a transient outage degrades to slightly-old data rather than a 500
 * on every home screen at once. Past `staleMs` the error propagates, because
 * silently serving arbitrarily old data is worse than saying so.
 *
 * INVALIDATION IS AN OPTIMISATION, NOT THE CORRECTNESS STORY.
 * Write paths call invalidate() so an edit shows up immediately, but the TTL is
 * what makes a MISSED invalidation self-heal in seconds instead of living until
 * the next deploy. Both, deliberately: new write paths get added over time and
 * one of them will forget to call this.
 */

import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

/** Wall-clock ms. Indirected so tests can drive time without a real clock. */
let now = () => Date.now();

/** @internal test seam — see test/cache.test.js. Pass no argument to restore. */
export function _setClock(fn) {
  now = typeof fn === 'function' ? fn : () => Date.now();
}

/**
 * @param {object} opts
 * @param {string} opts.name        for stats() and log lines
 * @param {number} opts.ttlMs       how long a fresh entry serves without a re-read
 * @param {number} [opts.staleMs]   extra window past the TTL in which a stale
 *                                  entry may be served IF the refresh fails.
 *                                  0 disables stale-on-error.
 * @param {number} [opts.maxEntries] evict least-recently-used past this many keys.
 *                                  Omit for an unbounded cache (fine for a
 *                                  single-key catalogue; not for per-id blobs).
 * @param {(value: any) => number} [opts.sizeOf] bytes per value, for maxBytes.
 * @param {number} [opts.maxBytes]  evict LRU until the total fits. Requires sizeOf.
 */
export function createCache({ name, ttlMs, staleMs = 0, maxEntries = 0, sizeOf = null, maxBytes = 0 }) {
  if (!name) throw new Error('createCache: name is required');
  if (!(ttlMs > 0)) throw new Error(`createCache(${name}): ttlMs must be > 0`);
  if (maxBytes && !sizeOf) throw new Error(`createCache(${name}): maxBytes requires sizeOf`);

  /**
   * key -> { value, bytes, expiresAt, staleUntil, inflight }
   *
   * A Map, because insertion order IS the LRU order: a read deletes and re-sets
   * its key to move it to the end, so the oldest live key is always the first
   * one the iterator yields. No separate list to keep in step.
   */
  const entries = new Map();
  let bytes = 0;
  const stats = { hits: 0, misses: 0, stampedesJoined: 0, staleServed: 0, evictions: 0, errors: 0 };

  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.bytes || 0;
    entries.delete(key);
  };

  // Oldest-first until both bounds are satisfied. An entry with a promise still
  // in flight is skipped: evicting it would strand the callers already awaiting
  // it and let a second copy of the same query start.
  const evict = () => {
    if (!maxEntries && !maxBytes) return;
    for (const [key, e] of entries) {
      const overCount = maxEntries && entries.size > maxEntries;
      const overBytes = maxBytes && bytes > maxBytes;
      if (!overCount && !overBytes) break;
      if (e.inflight) continue;
      drop(key);
      stats.evictions += 1;
    }
  };

  /** Move `key` to the LRU tail. Safe to call on a key that just got re-set. */
  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    name,

    /**
     * Read `key`, running `loader()` on a miss. Concurrent misses share one run.
     *
     * `loader` must THROW to signal failure — a resolved value is cached as-is,
     * including null/undefined, because "this vendor has no logo" is a real
     * answer worth remembering rather than re-querying on every card.
     */
    async get(key, loader) {
      const t = now();
      const hit = entries.get(key);

      if (hit) {
        // Someone else is already loading this exact key. Join them rather than
        // starting a second identical query.
        if (hit.inflight) {
          stats.stampedesJoined += 1;
          return hit.inflight;
        }
        if (t < hit.expiresAt) {
          stats.hits += 1;
          touch(key, hit);
          return hit.value;
        }
      }

      stats.misses += 1;

      const inflight = (async () => {
        try {
          const value = await loader();
          const size = sizeOf ? Number(sizeOf(value)) || 0 : 0;
          const fresh = {
            value,
            bytes: size,
            expiresAt: now() + ttlMs,
            staleUntil: now() + ttlMs + staleMs,
            inflight: null,
          };
          // Recompute the byte total against whatever this key held before —
          // drop() first so a replaced entry's bytes are not counted twice.
          drop(key);
          entries.set(key, fresh);
          bytes += size;
          evict();
          return value;
        } catch (err) {
          stats.errors += 1;
          // The failed attempt must leave no trace: clear the promise so the
          // next caller retries, but keep the old value if there is one.
          const prev = entries.get(key);
          if (prev) {
            prev.inflight = null;
            // Still inside the stale window → serve the old value rather than
            // failing every home screen at once on one transient error.
            if (staleMs > 0 && now() < prev.staleUntil) {
              stats.staleServed += 1;
              console.warn(`[cache:${name}] serving stale "${key}" — refresh failed: ${err?.message ?? err}`);
              return prev.value;
            }
            drop(key);
          }
          throw err;
        }
      })();

      // Store the promise BEFORE the first await above can yield, so a caller
      // arriving in the same tick finds it and joins instead of missing.
      const placeholder = entries.get(key) ?? { value: undefined, bytes: 0, expiresAt: 0, staleUntil: 0 };
      placeholder.inflight = inflight;
      touch(key, placeholder);

      return inflight;
    },

    /** Forget one key, or every key when called with no argument. */
    invalidate(key) {
      if (key === undefined) {
        entries.clear();
        bytes = 0;
        return;
      }
      drop(key);
    },

    /** For the admin dashboard / debugging. Never on a hot path. */
    stats() {
      const total = stats.hits + stats.misses;
      return {
        name,
        entries: entries.size,
        bytes,
        ...stats,
        hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0,
      };
    },
  };
}

/* ============================================================
 * The instances.
 * ============================================================ */

/**
 * The active-vendor catalogue, exactly as GET /api/me/balances needs it
 * (vendors + their rewards). One key — 'all' — because there is one catalogue;
 * it is keyed at all only so it can share createCache with the logo cache.
 *
 * 30s rather than something longer: this is the safety net under a missed
 * invalidation, and a vendor toggled off by an operator staying visible for half
 * a minute is the worst case anyone experiences. The terminal is cut off
 * immediately regardless — requireVendor re-reads the row on every request and
 * does not consult this cache.
 *
 * staleMs of 2 minutes: if Supabase is unreachable, students keep seeing the
 * spots list they saw a moment ago instead of an error, which is the difference
 * between a blip and an outage.
 */
export const vendorCatalogueCache = createCache({
  name: 'vendor-catalogue',
  ttlMs: 30_000,
  staleMs: 120_000,
});

/**
 * Decoded logo bytes, keyed by vendor id. These are what turn one home-screen
 * render into N database round trips: each card's background-image hits
 * /api/vendor-logo/:id, which reads a base64 blob (capped at 500_000 chars, so
 * ~375 KB decoded) out of `vendors` and decodes it per request.
 *
 * Longer TTL than the catalogue — a logo changes when a vendor uploads a new
 * one, which is close to never, and the upload path invalidates this directly.
 *
 * BOUNDED, unlike the catalogue: this holds image buffers, and at 200 vendors an
 * unbounded copy would be ~75 MB of a 512 MB dyno. 64 MB and 250 entries, both
 * LRU, so the working set stays hot and a long tail of rarely-viewed logos
 * cannot crowd out anything else.
 *
 * A `null` value is cached too: "this vendor has no usable logo" is the answer
 * for every vendor without artwork, and re-querying that on every render is
 * exactly the fan-out this cache exists to stop.
 */
export const vendorLogoCache = createCache({
  name: 'vendor-logo',
  ttlMs: 10 * 60_000,
  staleMs: 60 * 60_000,
  maxEntries: 250,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: (v) => (v?.body?.length ?? 0) + 64,
});

/**
 * Drop everything derived from the `vendors` or `rewards` tables.
 *
 * Call this from EVERY write path that touches either — vendor create/update/
 * delete, the operator's on/off toggle, the terminal's settings save, and all
 * reward CRUD. It is deliberately coarse: at this scale the whole catalogue is
 * one query, so working out which vendor changed buys nothing and is one more
 * thing to get wrong.
 *
 * `vendorId` is optional and only narrows the logo cache, whose entries really
 * are per-vendor. Omit it and every logo is dropped too.
 */
export function invalidateVendorCaches(vendorId) {
  vendorCatalogueCache.invalidate();
  if (vendorId) vendorLogoCache.invalidate(String(vendorId));
  else vendorLogoCache.invalidate();
}

/**
 * The Recommended list: the ids of the most-visited active spots, in order.
 *
 * Global, not per-student — which is exactly why it can be cached at all, and
 * why it is cheap enough to compute in SQL on a schedule rather than per
 * request. It only ever renders for a student with no recent activity, but it
 * is fetched alongside the catalogue rather than conditionally, because
 * branching the query on the student's history would mean a slow path for
 * precisely the newest users.
 *
 * Five minutes: this is a popularity ranking over 30 days, so it barely moves
 * between reads, and a new signup seeing a five-minute-old ranking is
 * indistinguishable from a live one.
 */
export const recommendedVendorsCache = createCache({
  name: 'recommended-vendors',
  ttlMs: 5 * 60_000,
  staleMs: 60 * 60_000,
});

/**
 * How deep the visit ranking goes. THIS IS A CANDIDATE POOL, NOT A ROW LENGTH.
 *
 * The Recommended row shows five spots, and it used to ask for exactly five —
 * which was right while the row was the same five for everybody. It is not any
 * more: the client now drops spots the student has already been to
 * (`visited` in GET /api/me/balances) before it picks the five, and a regular
 * who has been to four of the top five would have been left with a row of one.
 *
 * Twenty-five is deep enough that a student would have to have visited two
 * dozen spots before the ranking runs dry on them, and still one small cached
 * array shared by every student. The five-at-a-time cap lives on the client,
 * with the rest of the picking (public/student/app.js → RECOMMENDED_TARGET).
 *
 * DEPLOY SKEW, for whoever changes this next. The cap is on the CLIENT, so a
 * page still running the pre-cap app.js against this server renders every id it
 * is sent — a 25-card carousel and a 25-row "Top" filter. It is cosmetic and it
 * self-heals: sw.js is network-first for the shell, so the next launch with a
 * connection has the new bundle. The window is a page that was already open
 * when the deploy landed. Raising this number widens that window's blast
 * radius, not its likelihood.
 */
export const RECOMMENDED_LIMIT = 25;

/** How far back top_vendors_by_visits looks when ranking. */
const RECOMMENDED_WINDOW_DAYS = 30;

/**
 * Ids of the most-visited active vendors, best first. Never throws upward on a
 * missing function — an empty list degrades the Home carousel to "no spots
 * yet", which is survivable, whereas a rejected promise here would take the
 * whole /balances payload down with it.
 */
export function loadRecommendedVendorIds() {
  return recommendedVendorsCache.get('top', async () => {
    const { data, error } = await supabaseAdmin.rpc('top_vendors_by_visits', {
      p_limit: RECOMMENDED_LIMIT,
      p_days: RECOMMENDED_WINDOW_DAYS,
    });
    if (error) {
      // Deliberately not a throw: this is a nice-to-have row on one screen, and
      // it must never be the reason a student cannot see their balances. The
      // most likely cause is migration-041 not having been applied yet.
      console.warn(`[cache:recommended-vendors] top_vendors_by_visits failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map((r) => r.vendor_id);
  });
}

/** Every cache, for a stats endpoint or a test's afterEach. */
export const allCaches = [vendorCatalogueCache, vendorLogoCache, recommendedVendorsCache];

/** Wipe everything. Tests, and nothing else. */
export function resetAllCaches() {
  for (const c of allCaches) c.invalidate();
}

/* ============================================================
 * The cached loaders.
 *
 * These live here rather than in the routes so there is exactly ONE place that
 * knows the catalogue query, its cache, and its invalidation. A second copy of
 * the query somewhere else would silently bypass all of this — which is how the
 * duplicate active-vendor read in tiers.js came about in the first place.
 * ============================================================ */

/**
 * Every active vendor with its rewards, in the shape GET /api/me/balances maps
 * over. Ordered newest-first, which is the order the home carousel inherits.
 *
 * Throws on a Supabase error so the cache's stale-on-error path can see it — a
 * loader that swallowed the error and returned [] would cache "there are no
 * vendors", which renders as an empty app rather than as a failure.
 */
export function loadVendorCatalogue() {
  return vendorCatalogueCache.get('all', async () => {
    const { data, error } = await supabaseAdmin
      .from('vendors')
      // created_at rides along so the app can mark a spot as newly joined. It
      // is already the sort key; it just was never selected.
      // cuisine + price_level (migration-042) feed the Spots tab's filter
      // sheet. Both are small scalars on a row that is already being read, so
      // they ride along here rather than justifying a second query — and
      // because the sheet's chips are derived from the catalogue itself, a
      // vendor tagging themselves becomes filterable on the next cache turn.
      //
      // pool_id + the pool's label (migration-044) are what decide WHICH TABLE
      // a vendor's balance lives in. Every row out of here is handed to
      // purseOf/balanceFrom in src/lib/pools.js, and a vendors row fetched
      // WITHOUT pool_id looks unpooled: it would be read out of point_balances
      // and show a customer a zero next to a shared purse that holds their
      // points. The label is embedded rather than looked up per card because
      // the FK added by 044 makes it one join on a query that already runs.
      //
      // DEPLOY ORDER, and this is the one query where it bites: PostgREST
      // answers 400 to the WHOLE request on a single unknown column, and this
      // is the read behind every student's home screen. Ship this file against
      // a database without migration-044 and nobody sees any spots at all —
      // not just the pooled ones. 044 goes first, always.
      .select('id, name, slug, address, latitude, longitude, has_logo, accepts_community_points, punch_enabled, points_per_dollar, cuisine, price_level, created_at, pool_id, point_pools(label), rewards(id, title, cost_in_points, cost_in_visits, emoji, active)')
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  });
}

/**
 * Just the ids of active vendors — what the tier calculation needs to know how
 * many distinct spots exist. Served off the SAME cached catalogue rather than
 * its own `select('id')`, which was a second sequential scan of `vendors` on
 * every tier refresh, running in parallel with the first one.
 */
export async function loadActiveVendorIds() {
  const vendors = await loadVendorCatalogue();
  return vendors.map((v) => ({ id: v.id }));
}

/**
 * One vendor's decoded logo, or null when there isn't a usable one.
 *
 * Returns `{ body, contentType, etag }`. The etag is derived from the bytes, so
 * it changes exactly when the artwork does and a browser revalidating with
 * If-None-Match can be answered 304 without touching the database at all.
 *
 * `null` is a cached answer, not a cache miss: most vendors have no logo, and
 * re-querying for each of them on every render is the fan-out this prevents.
 */
export function loadVendorLogo(vendorId) {
  return vendorLogoCache.get(String(vendorId), async () => {
    const { data, error } = await supabaseAdmin
      .from('vendors')
      .select('logo, active')
      .eq('id', vendorId)
      .maybeSingle();
    if (error) throw error;
    if (!data?.active || !data.logo) return null;

    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data.logo);
    if (!m) return null;

    const body = Buffer.from(m[2], 'base64');
    // Content hash, not a timestamp: two vendors uploading the same artwork
    // share an etag, and a re-upload of identical bytes doesn't bust a browser
    // cache for no reason. Weak-comparison-safe, so it is a strong etag.
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    return { body, contentType: m[1], etag };
  });
}
