// Shared validation for the vendor pricing surface — reward items and the
// dollar-to-point ratio. Both write paths use it: the vendor's own routes
// (/api/vendor/settings, /api/vendor/rewards) and the operator dashboard
// (/api/admin/vendors/:id/...), so the two can't drift apart.
//
// Since migration-052 there is a THIRD door, and it is unlike the other two:
// the public /join form, where an applicant names their first items before
// they have a terminal. That door asks what each item sells for and turns it
// into points on accept — see the starter-item section at the foot of this file.

// ONE RATE FOR EVERY VENDOR since migration-068: $1 = 1 point, held by the
// vendors_points_per_dollar_is_one CHECK. Vendors used to pick their own (0.5 to
// 1000), which left "150 points" meaning $15 at one spot and $150 at the next.
// The column stays, and every earn path still reads it, because it is the one
// number the award maths is written against; this constant is what the
// write paths compare to.
export const POINTS_PER_DOLLAR = 1;

/**
 * A pointsPerDollar in a settings body → { ok } or { error }. Only 1 passes,
 * and the caller writes nothing either way. Kept as a check rather than
 * dropping the field because a terminal still running the old Settings screen
 * sends the rate with every save: 1 must not break that save, and any other
 * number should be told why it did not stick rather than silently ignored.
 */
export function lockedRatio(raw) {
  if (Number(raw) === POINTS_PER_DOLLAR) return { ok: true };
  return { error: 'Every spot earns 1 point per $1 spent, so the earning rate can’t be changed.' };
}

// ITEM PRICES (migration-068). The ITEMS form asks what an item sells for and
// suggests a point price of 4x: at $1 = 1 point, a student who buys it four
// times has earned the fifth. The suggestion uses WHOLE dollars because earning
// rounds down (pointsFor): a $4.99 coffee earns 4 points, so 4 x 4.99 = 20
// would take five coffees, not four. The vendor can type any point price
// instead; nothing prices an item from this on its own.
export const ITEM_POINTS_MULTIPLIER = 4;
export const ITEM_PRICE_MAX = 1000;   // dollars; = the rewards_item_price_range CHECK

/** The suggested point price for an item that sells for `price` dollars, or null. */
export function suggestedItemPoints(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Under $1 still suggests 4, not 0: 0 points is a FREE item (migration-067).
  return Math.min(100000, Math.max(1, Math.floor(n)) * ITEM_POINTS_MULTIPLIER);
}

/**
 * An itemPrice in a request body (dollars) → { value: cents | null } or { error }.
 * Blank or null clears it: the price is optional, and an item that predates it
 * has none.
 */
export function validItemPrice(raw) {
  if (raw == null || raw === '') return { value: null };
  const n = Number(raw);
  const cents = Math.round(n * 100);
  if (!Number.isFinite(n) || cents < 1 || cents > ITEM_PRICE_MAX * 100) {
    return { error: `Item price must be from $0.01 to $${ITEM_PRICE_MAX.toLocaleString('en-US')}.` };
  }
  return { value: cents };
}

/**
 * Points earned for a dollar amount at a points-per-dollar ratio.
 *
 * WHY THIS IS NOT `Math.floor(dollars * ratio)`. Both inputs are decimal money
 * but doubles are binary, so the product lands a hair BELOW the integer for
 * many ordinary amounts and the floor then drops a whole point:
 *
 *     1.16 * 25  === 28.999999999999996   ->  floor 28, not 29
 *     8.20 * 15  === 122.99999999999999   ->  floor 122, not 123
 *
 * Sweeping every cent from $0.01 to $200: the naive form is wrong 287 times at
 * ratio 25, 573 at 50, 1145 at 100, 148 at 1000 - and never at the default 10,
 * which is why this went unnoticed. Multiplying integer cents by integer
 * hundredths keeps every intermediate exact (the largest is 20000 * 100000 =
 * 2e9, well inside 2^53), so the result is the documented
 * floor(amount * points_per_dollar) at every ratio the column ever held (0.5 to
 * 1000 until migration-068 fixed it at 1, where the naive form is also exact).
 *
 * The terminal and the scan page compute the same preview client-side and
 * cannot import this (they are browser bundles, not server modules), so the
 * expression is duplicated there - public/vendor/terminal.js and
 * public/scan/scan.js both point back here. Change all three together.
 */
export function pointsFor(dollarAmount, ratio) {
  const cents = Math.round(Number(dollarAmount) * 100);
  const hundredths = Math.round(Number(ratio) * 100);
  if (!Number.isFinite(cents) || !Number.isFinite(hundredths)) return 0;
  return Math.floor((cents * hundredths) / 10000);
}

// A price is: a whole number from `min` to `max`, or null meaning "not sold in
// this currency". Blank string counts as null so an emptied form field clears
// the price.
export function validPrice(raw, label, max, min = 1) {
  if (raw == null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `${label} must be a whole number from ${min} to ${max}.` };
  }
  return { value: n };
}

// Mirrors the DB's rewards CHECKs (migrations 029 and 067): points, visits, or
// both, but never neither. A point cost of 0 is a FREE item, which cannot also
// carry a visit price, and is the only kind that can be once per student.
// `once` is anything but `true` → false, and is quietly false on a priced item
// rather than an error: the price already limits how often a student has it.
export function validReward(title, cost, visits, emoji, once = false) {
  const t = String(title ?? '').trim();
  const e = String(emoji ?? '🎁').trim().slice(0, 16) || '🎁'; // emoji can be multi-codepoint
  if (!t || t.length > 60) return { error: 'Give the item a name (up to 60 characters).' };

  const p = validPrice(cost, 'Point cost', 100000, 0);
  if (p.error) return { error: p.error };
  const v = validPrice(visits, 'Visit cost', 50);
  if (v.error) return { error: v.error };
  if (p.value == null && v.value == null) {
    return { error: 'Set a point cost, a visit cost, or both.' };
  }
  const free = p.value === 0;
  if (free && v.value != null) {
    return { error: 'A free item can’t also have a visit cost. Clear the visit cost, or give it a point cost.' };
  }
  return { title: t, cost: p.value, visits: v.value, emoji: e, once: free && once === true };
}

/**
 * A reward PATCH body merged over the STORED row → validReward's arguments.
 * Shared by the vendor's and the operator's edit routes. Merging is what lets a
 * partial PATCH revalidate real values and lets a price be cleared, which a
 * placeholder like `costInPoints ?? 1` could never do. `current` may predate
 * migration-067 and lack once_per_student, which reads as false.
 */
export function mergeRewardEdit(body, current) {
  const pick = (key, stored) => (body?.[key] !== undefined ? body[key] : stored);
  return [
    pick('title', current.title),
    pick('costInPoints', current.cost_in_points),
    pick('costInVisits', current.cost_in_visits),
    pick('emoji', current.emoji),
    pick('oncePerStudent', current.once_per_student === true),
  ];
}

/**
 * The once_per_student write for a reward PATCH, or {} for none. Written when
 * the price or the flag was edited AND the item is or was free: becoming free
 * sets it, and pricing a free item must clear it in the same write or the DB's
 * rewards_once_only_when_free refuses the update. A priced item that stays
 * priced never names the column, so it keeps saving on a database without 067.
 */
export function onceUpdate(body, current, v) {
  if (body?.costInPoints === undefined && body?.oncePerStudent === undefined) return {};
  if (v.cost !== 0 && current.cost_in_points !== 0) return {};
  return { once_per_student: v.once };
}

/* ---------- starter items: the ones an applicant names on /join ----------

   A vendor's FIRST redeemable items, collected before they have a terminal or
   any idea what a point is. So the public door never asks for points. Since
   migration-068 it asks the question every shop can answer, what the item
   SELLS FOR, and the point cost is worked out on accept with the same 4x the
   terminal's ITEMS form suggests (suggestedItemPoints above): buy it four
   times, the fifth is free.

   Before 068 the question was "how much should a customer spend with you to
   earn it?", converted at the rate the location landed on (migration-052). An
   application already sent carries `spend` instead of `price`, and still
   converts that way: what the applicant asked for was a spend, and at $1 = 1
   point that spend IS the point cost. */

// Starter-item bounds. Sanity bounds on a public, unauthenticated form rather
// than product limits, and exactly what the /join inputs enforce, so nothing
// typed into a form that accepted it can then be refused by the server.
// Decimals are allowed inside them ($4.99 is a price).
export const PRICE_MIN = 0.01;
export const PRICE_MAX = ITEM_PRICE_MAX;
// The pre-068 question's bounds, kept for applications sent before it.
export const SPEND_MIN = 1;
export const SPEND_MAX = 1000;

// Enough for a real opening menu, few enough that the form stays a form. An
// applicant with more items adds them from the terminal on day one.
export const MAX_STARTER_ITEMS = 6;

/**
 * Validate ONE starter item → { item: { title, price, emoji } } or { error }.
 * An item with `spend` and no `price` is a pre-068 application and comes back
 * as { title, spend, emoji }, validated against the old bounds.
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
  // NaN — so the range checks below are what refuse a blank, not a separate
  // branch. Money, so two decimals: a third would be quietly dropped on the way
  // to item_price_cents and the applicant would never see it go.
  if (raw.price === undefined && raw.spend !== undefined) {
    const spend = Math.round(Number(raw.spend) * 100) / 100;
    if (!Number.isFinite(spend) || spend < SPEND_MIN || spend > SPEND_MAX) {
      return { error: `${at}: enter how much a customer spends to earn it, from $${SPEND_MIN} to $${SPEND_MAX}.` };
    }
    return { item: { title, spend, emoji } };
  }

  const price = Math.round(Number(raw.price) * 100) / 100;
  if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) {
    return { error: `${at}: enter what it sells for, from $${PRICE_MIN} to $${PRICE_MAX.toLocaleString('en-US')}.` };
  }
  return { item: { title, price, emoji } };
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
 * A validated starter item → the public.rewards insert.
 *
 * A priced item (068) gets suggestedItemPoints(price) and keeps its price, the
 * same as one added from the ITEMS form. A pre-068 `spend` item converts at the
 * location's rate, rounded rather than floored (the applicant was shown "about
 * $25 of purchases", and a round-down would make it quietly cheaper than asked
 * for), and clamped to the 1..100000 band validPrice enforces so the vendor's
 * own routes can always edit what this writes.
 */
export function starterItemToReward(item, pointsPerDollar) {
  if (item.price != null) {
    return {
      title: item.title,
      emoji: item.emoji,
      cost_in_points: suggestedItemPoints(item.price),
      item_price_cents: Math.round(item.price * 100),
    };
  }
  const rate = Number(pointsPerDollar);
  // Falls back to the one rate rather than throwing: this runs mid-onboard,
  // after the login and the vendors row already exist, and a missing rate must
  // not be the thing that unwinds a whole accept.
  const usable = Number.isFinite(rate) && rate > 0 ? rate : POINTS_PER_DOLLAR;
  const points = Math.min(100000, Math.max(1, Math.round(item.spend * usable)));
  return { title: item.title, emoji: item.emoji, cost_in_points: points };
}
