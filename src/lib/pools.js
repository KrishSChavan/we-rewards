// Point pools: where a vendor's points actually live (migration-044).
//
// Since migration-043 one login can run several locations. Since 044 an operator
// can put some of those locations in a POOL, and a pooled location spends from a
// shared purse instead of its own. A customer earns 500 at Downtown and buys a
// 350-point coffee at Campus.
//
// THE WHOLE RULE, and there is only one:
//
//     vendor.pool_id == null  ->  the purse is point_balances(user_id, vendor_id)
//     vendor.pool_id != null  ->  the purse is pool_balances(user_id, pool_id)
//
// It is a property of the vendors ROW, not a setting that can be read as true in
// one query and false in the next. There is deliberately no `sharing_enabled`
// flag: a flag beside a membership pointer creates a state (in a pool, not
// sharing) where a customer has two live purses at one counter.
//
// WHAT IS NOT SHARED: reward items, visits/punch cards, redeem codes, earning
// rates, stats and the staff PIN all stay per-location. Only the money is
// common. Anything in this file that starts to look like it knows about a menu
// is in the wrong file.
//
// The SQL functions do this same resolution again, in SQL, because they must:
// award_points and redeem_by_code resolve the purse under a `for share` lock on
// the vendors row, which is what stops a pool join interleaving with a sale.
// This module is for the READ paths (what to show a customer, what to show a
// cashier) and must never be the only thing standing between a write and the
// right table.

import { supabaseAdmin } from './supabase.js';

/** Is this vendor's money shared with its siblings? */
export const isPooled = (vendor) => Boolean(vendor?.pool_id);

/**
 * Which row holds this vendor's points, as a plain descriptor. Pure.
 *
 * `table`/`column`/`id` are exactly what a PostgREST filter needs, so a caller
 * can build a query from this without re-deriving the rule and getting it
 * subtly different.
 */
export function purseOf(vendor) {
  return vendor?.pool_id
    ? { table: 'pool_balances',  column: 'pool_id',   id: vendor.pool_id, shared: true }
    : { table: 'point_balances', column: 'vendor_id', id: vendor?.id ?? null, shared: false };
}

/**
 * Pick a vendor's balance out of two already-fetched maps. Pure, and the single
 * place the fallback order is written down.
 *
 * `?? 0` on both arms is not laziness: a customer who has never earned at this
 * spot has no row in either table, and "no row" is zero points. It is also the
 * shape that makes a pooled spot a customer has never visited show the chain's
 * balance rather than a zero.
 */
export function balanceFrom(vendor, { byVendor, byPool }) {
  return (vendor?.pool_id ? byPool?.get(vendor.pool_id) : byVendor?.get(vendor?.id)) ?? 0;
}

/**
 * Read every purse ONE customer holds, and hand back a resolver over them.
 *
 * Two queries whatever the catalogue size, because both are keyed on the user
 * and neither needs the vendor list: a customer has one row per spot they have
 * earned at and one per pool they hold money in, and both sets are small. This
 * replaces the single point_balances read the balances endpoint used to do, so
 * the cost of pooling on the busiest student query is exactly one extra
 * user-keyed lookup.
 *
 * Returns `{ byVendor, byPool, of }` — `of(vendor)` is the number to show.
 */
export async function readPurses(userId) {
  const [{ data: vendorRows, error: vErr }, { data: poolRows, error: pErr }] = await Promise.all([
    supabaseAdmin.from('point_balances').select('vendor_id, balance').eq('user_id', userId),
    supabaseAdmin.from('pool_balances').select('pool_id, balance').eq('user_id', userId),
  ]);
  if (vErr) throw vErr;
  if (pErr) throw pErr;

  const byVendor = new Map((vendorRows ?? []).map((r) => [r.vendor_id, r.balance]));
  const byPool = new Map((poolRows ?? []).map((r) => [r.pool_id, r.balance]));
  return { byVendor, byPool, of: (vendor) => balanceFrom(vendor, { byVendor, byPool }) };
}

/**
 * One customer's balance at ONE vendor, through whichever purse applies.
 *
 * For the single-vendor paths (the terminal's scan, the redeem preview, the
 * student's affordability check) where fetching every purse would be wasteful.
 * The caller must pass a vendor row that actually carries pool_id — pass a row
 * selected without it and this silently reads the wrong table, which is why
 * every call site selects it explicitly.
 */
export async function balanceFor(userId, vendor) {
  const purse = purseOf(vendor);
  if (!purse.id) return 0;
  const { data, error } = await supabaseAdmin
    .from(purse.table)
    .select('balance')
    .eq('user_id', userId)
    .eq(purse.column, purse.id)
    .maybeSingle();
  if (error) throw error;
  return data?.balance ?? 0;
}

/**
 * The public facts about a vendor's pool: what to call it and how many spots
 * share it. Null for an unpooled vendor, which is nearly all of them.
 *
 * `size` counts ACTIVE members only, because it exists to be read out to a
 * customer ("Shared across 3 Joe's Pizza spots") and a location the operator
 * switched off is not somewhere they can go. That makes it a display number and
 * NOT an authorisation one: a deactivated member still shares the purse, and its
 * customers' points are still spendable at its siblings.
 */
export async function poolFacts(poolId) {
  if (!poolId) return null;
  const [{ data: pool, error: pErr }, { count, error: cErr }] = await Promise.all([
    supabaseAdmin.from('point_pools').select('id, label').eq('id', poolId).maybeSingle(),
    supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true })
      .eq('pool_id', poolId).eq('active', true),
  ]);
  if (pErr) throw pErr;
  if (cErr) throw cErr;
  if (!pool) return null;
  return { poolId: pool.id, poolLabel: pool.label, poolSize: count ?? 0 };
}

/**
 * Every ACTIVE location that spends from the same purse as `vendor`, itself
 * included. The rooms a balance push has to reach: one shared balance changing
 * is one event that must repaint every sibling's card, not one event per
 * sibling — three events would fire three "+50 pts" toasts for one purchase.
 *
 * An unpooled vendor answers `[vendor.id]`, so every caller can pass the result
 * straight through without branching.
 *
 * DELIBERATELY NEVER THROWS. Every caller is on the far side of a committed
 * money write — award, redeem and reverse each call this while building the
 * push that follows the RPC — and a rejection there would answer the terminal
 * with an error for a sale that actually went through, which is the one thing a
 * till must never be told. A failed sibling lookup degrades to "repaint the card
 * we already know about": the other cards refresh on their next poll, and the
 * money was never in question. Nothing here authorises anything, so failing
 * open costs nothing but a stale card.
 */
export async function poolVendorIds(vendor) {
  if (!vendor?.pool_id) return vendor?.id ? [vendor.id] : [];
  const { data, error } = await supabaseAdmin
    .from('vendors').select('id').eq('pool_id', vendor.pool_id).eq('active', true);
  if (error) {
    console.error('poolVendorIds failed, pushing to the writing vendor only:', error.message);
    return vendor.id ? [vendor.id] : [];
  }
  const ids = (data ?? []).map((v) => v.id);
  // The vendor being written to is always in the list, even if it was just
  // deactivated mid-transaction: its own card must repaint either way.
  return ids.includes(vendor.id) ? ids : [...ids, vendor.id];
}

/**
 * poolVendorIds for a caller that holds only an id — the community transfer,
 * which is handed a vendorId by the client and never reads the vendors row.
 *
 * One extra lookup, and it is off every hot path: a transfer is a deliberate,
 * rare act. Fails open for the same reason as poolVendorIds, and for the same
 * caller shape (the push follows a committed RPC).
 */
export async function poolVendorIdsById(vendorId) {
  if (!vendorId) return [];
  const { data, error } = await supabaseAdmin
    .from('vendors').select('id, pool_id').eq('id', vendorId).maybeSingle();
  if (error || !data) {
    if (error) console.error('poolVendorIdsById lookup failed:', error.message);
    return [vendorId];
  }
  return poolVendorIds(data);
}
