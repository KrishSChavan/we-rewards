// Shared validation for the vendor pricing surface — reward items and the
// dollar-to-point ratio. Both write paths use it: the vendor's own routes
// (/api/vendor/settings, /api/vendor/rewards) and the operator dashboard
// (/api/admin/vendors/:id/...), so the two can't drift apart.
//
// Since migration-052 there is a THIRD door, and it is unlike the other two:
// the public /join form, where an applicant names their first items before a
// vendors row (and therefore a points-per-dollar rate) exists to price them
// against. That door prices in dollars and converts on accept — see the
// starter-item section at the foot of this file.

export const RATIO_MIN = 0.5;
export const RATIO_MAX = 1000;

/** points_per_dollar → { value } (2dp, fits numeric(6,2)) or { error }. */
export function validRatio(raw) {
  const r = Number(raw);
  if (!Number.isFinite(r) || r < RATIO_MIN || r > RATIO_MAX) {
    return { error: `Points per dollar must be between ${RATIO_MIN} and ${RATIO_MAX}.` };
  }
  return { value: Math.round(r * 100) / 100 };
}

// A price is: a positive integer, or null meaning "not sold in this currency".
// Blank string counts as null so an emptied form field clears the price.
export function validPrice(raw, label, max) {
  if (raw == null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { error: `${label} must be a whole number from 1 to ${max}.` };
  }
  return { value: n };
}

// Mirrors the DB's rewards_has_a_price CHECK (migration-029): points, visits,
// or both, but never neither.
export function validReward(title, cost, visits, emoji) {
  const t = String(title ?? '').trim();
  const e = String(emoji ?? '🎁').trim().slice(0, 16) || '🎁'; // emoji can be multi-codepoint
  if (!t || t.length > 60) return { error: 'Give the item a name (up to 60 characters).' };

  const p = validPrice(cost, 'Point cost', 100000);
  if (p.error) return { error: p.error };
  const v = validPrice(visits, 'Visit cost', 50);
  if (v.error) return { error: v.error };
  if (p.value == null && v.value == null) {
    return { error: 'Set a point cost, a visit cost, or both.' };
  }
  return { title: t, cost: p.value, visits: v.value, emoji: e };
}

/* ---------- starter items: the ones an applicant names on /join ----------

   A vendor's FIRST redeemable item, collected before they have a terminal, a
   rate, or any idea what a point is. Everything below exists because of one
   asymmetry: the items a vendor edits later are priced in POINTS (they can see
   their rate, and the ITEMS tab prints the dollar equivalent under every one),
   but an applicant on /join has no rate to price against — the vendors row does
   not exist yet, and which rate it lands on depends on the table default, on
   what the operator sets, and on whether this login already runs a store whose
   settings migration-043 will copy.

   So the public door asks in DOLLARS ("how much should a customer spend with
   you to earn this?") and the point cost is derived at accept, per location,
   from the rate that location actually got. See migration-052. */

// What a customer spends to earn one starter item. Both bounds are sanity
// bounds on a public, unauthenticated form rather than product limits, and both
// are exactly what the /join inputs enforce, so nothing typed into a form that
// accepted it can then be refused by the server. A vendor who wants an item
// outside this band sets it from their terminal afterwards, where they can see
// what it costs in points. Decimals are allowed inside it ($7.50 is a price).
export const SPEND_MIN = 1;
export const SPEND_MAX = 1000;

// Enough for a real opening menu, few enough that the form stays a form. An
// applicant with more items adds them from the terminal on day one.
export const MAX_STARTER_ITEMS = 6;

/**
 * Validate ONE starter item → { item: { title, spend, emoji } } or { error }.
 *
 * @param at  how to name this item in an error message ("Item 2"), so an
 *   applicant with four of them is told WHICH one is wrong. The /join form
 *   counts from 1, and so does this.
 */
export function validStarterItem(raw, at = 'Item') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} is not filled in.` };

  const title = String(raw.title ?? '').trim();
  // Same cap and the same "multi-codepoint emoji survive a slice" handling as
  // validReward above, because this string ends up in the same column.
  const emoji = String(raw.emoji ?? '\u{1F381}').trim().slice(0, 16) || '\u{1F381}';
  if (!title || title.length > 60) return { error: `${at}: give the item a name (up to 60 characters).` };

  // Number(''), Number(null) and Number([]) are all 0, and Number(undefined) is
  // NaN — so the range check below is what refuses a blank, not a separate
  // branch. Money, so two decimals: a third would be quietly dropped by the
  // rounding in starterItemToReward and the applicant would never see it go.
  const spend = Math.round(Number(raw.spend) * 100) / 100;
  if (!Number.isFinite(spend) || spend < SPEND_MIN || spend > SPEND_MAX) {
    return { error: `${at}: enter how much a customer spends to earn it, from $${SPEND_MIN} to $${SPEND_MAX}.` };
  }

  return { item: { title, spend, emoji } };
}

/**
 * Validate a whole list of starter items → { items } or { error }.
 *
 * `required` is the one difference between the two doors that call this, and it
 * is a decision rather than drift — the same one migration-049 made about the
 * phone number. On /join it is TRUE: an applicant is telling us what their spot
 * will offer, they are looking at a form built to ask, and letting them past
 * without an item is how a spot goes live showing students "No rewards yet".
 * On the operator's "Add vendor" form it is FALSE: somebody adding a vendor at
 * a demo is standing next to the person and may not have agreed the item yet,
 * and refusing the whole save over it would push them to invent one — which is
 * strictly worse than a blank, because an invented item is an obligation the
 * vendor never agreed to and a student can redeem it.
 */
export function validStarterItems(raw, { required = false } = {}) {
  const list = raw ?? [];
  if (!Array.isArray(list)) return { error: 'Items must be a list.' };
  if (required && list.length === 0) {
    return { error: 'Add at least one item customers can redeem with their points.' };
  }
  if (list.length > MAX_STARTER_ITEMS) {
    return { error: `You can name up to ${MAX_STARTER_ITEMS} items here. Add the rest from your terminal once you're set up.` };
  }

  const items = [];
  for (let i = 0; i < list.length; i++) {
    const v = validStarterItem(list[i], `Item ${i + 1}`);
    if (v.error) return { error: v.error };
    items.push(v.item);
  }
  return { items };
}

/**
 * A validated starter item + the rate its vendors row actually landed on → the
 * public.rewards insert. This is the dollars-to-points conversion the whole
 * design turns on; see the header above and migration-052.
 *
 * Clamped to the same 1..100000 band validPrice enforces, so no combination of
 * a legal spend and a legal rate (RATIO_MAX is 1000) can produce a row the
 * vendor's own routes would then refuse to edit. Rounded, not floored: the
 * figure is "about $25 of purchases" on both screens that show it, and a
 * systematic round-down would make every item quietly cheaper than asked for.
 */
export function starterItemToReward(item, pointsPerDollar) {
  const rate = Number(pointsPerDollar);
  // Falls back to the vendors table default rather than throwing: this runs
  // mid-onboard, after the login and the vendors row already exist, and a
  // missing rate must not be the thing that unwinds a whole accept.
  const usable = Number.isFinite(rate) && rate > 0 ? rate : 10;
  const points = Math.min(100000, Math.max(1, Math.round(item.spend * usable)));
  return { title: item.title, emoji: item.emoji, cost_in_points: points };
}
