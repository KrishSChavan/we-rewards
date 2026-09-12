// Unit tests for the in-process read caches (src/lib/cache.js).
//
// No database and no real clock: createCache is exercised directly with a
// counting loader and a fake clock, so TTL and stale windows are stepped
// deterministically rather than slept through.
//
// The single-flight tests are the ones that matter. A plain TTL cache still
// lets a cold key stampede — every student opening the app in the same second
// misses together and every one of them runs the same sequential scan — and
// that is precisely the load this module exists to remove.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCache,
  _setClock,
  lookupVendor,
  vendorCatalogueCache,
  resetAllCaches,
} from '../src/lib/cache.js';

afterEach(() => _setClock());

/** A loader that counts its calls and resolves on the next microtask. */
function counted(value) {
  const fn = async () => { fn.calls += 1; return typeof value === 'function' ? value() : value; };
  fn.calls = 0;
  return fn;
}

/** A controllable clock: returns `t`, which tests advance by hand. */
function fakeClock(start = 1_000_000) {
  const c = { t: start, advance(ms) { c.t += ms; } };
  _setClock(() => c.t);
  return c;
}

test('a hit inside the TTL does not re-run the loader', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  const load = counted('catalogue');

  assert.equal(await cache.get('k', load), 'catalogue');
  assert.equal(await cache.get('k', load), 'catalogue');
  assert.equal(await cache.get('k', load), 'catalogue');
  assert.equal(load.calls, 1, 'loader ran once for three reads');
});

test('the entry expires at the TTL and the next read reloads', async () => {
  const clock = fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  const load = counted(() => `v${load.calls}`);

  await cache.get('k', load);
  clock.advance(999);
  await cache.get('k', load);
  assert.equal(load.calls, 1, 'still fresh one ms before expiry');

  clock.advance(2);
  await cache.get('k', load);
  assert.equal(load.calls, 2, 'reloaded once past the TTL');
});

test('SINGLE FLIGHT: concurrent misses on one key run the loader exactly once', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });

  let release;
  const gate = new Promise((r) => { release = r; });
  const load = counted(async () => { await gate; return 'shared'; });

  // 300 callers arriving before the first load resolves — the stampede case.
  const all = Promise.all(Array.from({ length: 300 }, () => cache.get('k', load)));
  release();
  const results = await all;

  assert.equal(load.calls, 1, 'one query served all 300 callers');
  assert.ok(results.every((r) => r === 'shared'));
  assert.equal(cache.stats().stampedesJoined, 299);
});

test('single flight is per key — different keys load independently', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  const load = counted(() => 'x');

  await Promise.all([cache.get('a', load), cache.get('b', load), cache.get('a', load)]);
  assert.equal(load.calls, 2, 'two distinct keys, two loads');
});

test('a throwing loader is NOT cached — the next read retries', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });

  let fail = true;
  const load = counted(() => { if (fail) throw new Error('supabase down'); return 'ok'; });

  await assert.rejects(() => cache.get('k', load), /supabase down/);
  fail = false;
  assert.equal(await cache.get('k', load), 'ok', 'retried rather than caching the failure');
  assert.equal(load.calls, 2);
});

test('every caller of a failed in-flight load sees the error, not a hang', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  const load = counted(async () => { throw new Error('boom'); });

  const results = await Promise.allSettled(Array.from({ length: 5 }, () => cache.get('k', load)));
  assert.equal(load.calls, 1);
  assert.ok(results.every((r) => r.status === 'rejected'), 'no caller is left hanging');
});

test('stale-on-error serves the previous value inside the stale window', async () => {
  const clock = fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000, staleMs: 10_000 });

  let fail = false;
  const load = counted(() => { if (fail) throw new Error('supabase down'); return 'good'; });

  assert.equal(await cache.get('k', load), 'good');

  clock.advance(2000);           // past the TTL, inside the stale window
  fail = true;
  assert.equal(await cache.get('k', load), 'good', 'served stale rather than failing');
  assert.equal(cache.stats().staleServed, 1);
});

test('past the stale window the error propagates rather than serving ancient data', async () => {
  const clock = fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000, staleMs: 10_000 });

  let fail = false;
  const load = counted(() => { if (fail) throw new Error('supabase down'); return 'good'; });

  await cache.get('k', load);
  clock.advance(20_000);         // past TTL + staleMs
  fail = true;
  await assert.rejects(() => cache.get('k', load), /supabase down/);
});

test('a recovered loader replaces the stale value', async () => {
  const clock = fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000, staleMs: 10_000 });

  let fail = false;
  const load = counted(() => { if (fail) throw new Error('down'); return `v${load.calls}`; });

  await cache.get('k', load);    // v1
  clock.advance(2000);
  fail = true;
  await cache.get('k', load);    // stale v1
  fail = false;
  clock.advance(1);
  assert.equal(await cache.get('k', load), 'v3', 'fresh value once the loader recovers');
});

test('null is a cached ANSWER, not a miss — the no-logo case', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  const load = counted(null);

  assert.equal(await cache.get('k', load), null);
  assert.equal(await cache.get('k', load), null);
  assert.equal(load.calls, 1, 'a vendor with no logo is not re-queried on every render');
});

test('invalidate(key) drops one key and leaves the rest', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });
  const load = counted(() => 'x');

  await cache.get('a', load);
  await cache.get('b', load);
  assert.equal(load.calls, 2);

  cache.invalidate('a');
  await cache.get('a', load);
  await cache.get('b', load);
  assert.equal(load.calls, 3, 'only "a" reloaded');
});

test('invalidate() with no argument clears everything', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });
  const load = counted(() => 'x');

  await cache.get('a', load);
  await cache.get('b', load);
  cache.invalidate();
  await cache.get('a', load);
  await cache.get('b', load);
  assert.equal(load.calls, 4);
  assert.equal(cache.stats().entries, 2);
});

test('maxEntries evicts least-recently-USED, not least-recently-written', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000, maxEntries: 2 });
  const load = counted(() => 'x');

  await cache.get('a', load);
  await cache.get('b', load);
  await cache.get('a', load);   // re-reading 'a' makes 'b' the coldest
  await cache.get('c', load);   // evicts 'b'

  assert.equal(cache.stats().entries, 2);
  await cache.get('a', load);
  assert.equal(load.calls, 3, '"a" survived — it was used most recently');
  await cache.get('b', load);
  assert.equal(load.calls, 4, '"b" was the one evicted');
});

test('maxBytes evicts until the budget fits', async () => {
  fakeClock();
  const cache = createCache({
    name: 'test',
    ttlMs: 60_000,
    maxBytes: 250,
    sizeOf: (v) => v.length,
  });
  const load = (n) => async () => 'x'.repeat(n);

  await cache.get('a', load(100));
  await cache.get('b', load(100));
  assert.equal(cache.stats().entries, 2);

  await cache.get('c', load(100));   // 300 > 250 → evict the oldest
  assert.equal(cache.stats().entries, 2);
  assert.ok(cache.stats().bytes <= 250);
  assert.equal(cache.stats().evictions, 1);
});

test('an in-flight entry is never evicted out from under its callers', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000, maxEntries: 1 });

  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = cache.get('slow', async () => { await gate; return 'slow-value'; });

  // A second key arrives while 'slow' is still loading and would, on a naive
  // LRU, evict it — stranding the caller above and letting a duplicate query
  // start behind it.
  await cache.get('fast', counted('fast-value'));

  release();
  assert.equal(await slow, 'slow-value');
});

test('stats report a hit rate that reflects real usage', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });
  const load = counted('v');

  await cache.get('k', load);   // miss
  await cache.get('k', load);   // hit
  await cache.get('k', load);   // hit

  const s = cache.stats();
  assert.equal(s.misses, 1);
  assert.equal(s.hits, 2);
  assert.equal(s.hitRate, 0.667);
  assert.equal(s.name, 'test');
});

test('rejects a nonsensical configuration at construction rather than at runtime', () => {
  assert.throws(() => createCache({ ttlMs: 1 }), /name is required/);
  assert.throws(() => createCache({ name: 'x', ttlMs: 0 }), /ttlMs must be > 0/);
  assert.throws(() => createCache({ name: 'x', ttlMs: 1, maxBytes: 10 }), /requires sizeOf/);
});

/* ============================================================
 * peek() and lookupVendor(): naming a vendor from memory alone.
 *
 * These exist for the error logger, which runs on a request that has ALREADY
 * failed — often because Supabase is unreachable. So the one behaviour that
 * matters as much as resolving a name is never doing any work to get it: no
 * loader, no await, no throw, no database.
 * ============================================================ */

test('peek returns what is cached without running the loader', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });
  const load = counted('v');

  assert.equal(cache.peek('k'), undefined, 'nothing cached yet');
  assert.equal(load.calls, 0, 'peek must never load');

  await cache.get('k', load);
  assert.equal(cache.peek('k'), 'v');
  assert.equal(load.calls, 1, 'peek did not cause a second load');
});

test('peek still answers past the TTL — a stale name is fine for labelling', () => {
  const clock = fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 1000 });
  return cache.get('k', counted('v')).then(() => {
    clock.advance(60 * 60_000);
    assert.equal(cache.peek('k'), 'v', 'an hour-old vendor name is still that vendor');
  });
});

test('peek distinguishes a cached null from a missing key', async () => {
  fakeClock();
  const cache = createCache({ name: 'test', ttlMs: 60_000 });
  await cache.get('no-logo', counted(null));
  assert.equal(cache.peek('no-logo'), null, 'a cached null is an answer');
  assert.equal(cache.peek('never-asked'), undefined, 'a missing key is not');
});

test('lookupVendor names a vendor by id and by slug', async () => {
  resetAllCaches();
  await vendorCatalogueCache.get('all', async () => ([
    { id: '11111111-1111-1111-1111-111111111111', name: 'Yallah Taco', slug: 'yallah-taco' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Fava Kitchen', slug: 'fava-kitchen' },
  ]));

  assert.equal(lookupVendor('11111111-1111-1111-1111-111111111111').name, 'Yallah Taco');
  assert.equal(lookupVendor('fava-kitchen').name, 'Fava Kitchen');
  assert.equal(lookupVendor('fava-kitchen').id, '22222222-2222-2222-2222-222222222222');
  assert.equal(lookupVendor('YALLAH-TACO').name, 'Yallah Taco', 'matched case-insensitively');
  resetAllCaches();
});

test('lookupVendor answers null on a cold cache instead of reading the database', () => {
  resetAllCaches();
  // The state a freshly booted dyno is in when its FIRST request is the one that
  // fails. A database read here would be a second failure inside the logger.
  assert.equal(lookupVendor('11111111-1111-1111-1111-111111111111'), null);
  assert.equal(lookupVendor(''), null);
  assert.equal(lookupVendor(null), null);
  assert.equal(lookupVendor(undefined), null);
});

test('lookupVendor re-indexes when the catalogue is re-read', async () => {
  resetAllCaches();
  const clock = fakeClock();
  await vendorCatalogueCache.get('all', async () => ([
    { id: 'v-1', name: 'Old Name', slug: 'a-spot' },
  ]));
  assert.equal(lookupVendor('a-spot').name, 'Old Name');

  clock.advance(10 * 60_000);   // past the 30s TTL
  await vendorCatalogueCache.get('all', async () => ([
    { id: 'v-1', name: 'Renamed Spot', slug: 'a-spot' },
  ]));
  assert.equal(lookupVendor('a-spot').name, 'Renamed Spot', 'the index followed the rename');
  resetAllCaches();
});

test('a catalogue row with no id cannot poison the index', async () => {
  resetAllCaches();
  await vendorCatalogueCache.get('all', async () => ([
    null, { name: 'No Id At All' }, { id: 'v-2', name: 'Fine', slug: 'fine' },
  ]));
  assert.doesNotThrow(() => lookupVendor('fine'));
  assert.equal(lookupVendor('fine').name, 'Fine');
  resetAllCaches();
});
