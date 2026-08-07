// Shared validation for the vendor pricing surface — reward items and the
// dollar-to-point ratio. Both write paths use it: the vendor's own routes
// (/api/vendor/settings, /api/vendor/rewards) and the operator dashboard
// (/api/admin/vendors/:id/...), so the two can't drift apart.

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
