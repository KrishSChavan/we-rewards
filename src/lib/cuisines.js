/**
 * The cuisine vocabulary, and the normalisers every write path runs input
 * through (migration-042).
 *
 * WHY THE LIST LIVES HERE AND NOT IN A CHECK CONSTRAINT. A `check (cuisine <@
 * array[...])` would be self-documenting and impossible to bypass, but adding
 * "poke" would then be a migration — and a migration that has to ship in
 * lockstep with the picker markup that offers it. The column caps cardinality
 * and nothing else; this module is the vocabulary, and it is the only thing
 * that needs editing to extend it.
 *
 * WHY THE STUDENT APP DOESN'T READ IT. The filter sheet builds its chips from
 * the cuisines the visible spots actually carry, not from this list, so it can
 * never offer "Seafood" to a campus with no seafood on it. That also means a
 * tag added here becomes filterable the moment one vendor picks it, with no
 * client release. /api/cuisines exists for the two PICKERS (the /join
 * application and the admin editors), which do need the full list — you cannot
 * choose a tag that is only offered once someone has already chosen it.
 *
 * ORDER IS THE PICKER'S ORDER. Roughly by how much of State College sells it,
 * so the common answers are reachable without scrolling a checkbox grid on a
 * phone. Not alphabetical: "asian" first is an accident of the alphabet, and
 * "coffee" first is a fact about a college town.
 */
export const CUISINES = [
  { value: 'coffee',       label: 'Coffee' },
  { value: 'pizza',        label: 'Pizza' },
  { value: 'sandwiches',   label: 'Sandwiches' },
  { value: 'burgers',      label: 'Burgers' },
  { value: 'breakfast',    label: 'Breakfast' },
  { value: 'bakery',       label: 'Bakery' },
  { value: 'desserts',     label: 'Desserts' },
  { value: 'ice-cream',    label: 'Ice cream' },
  { value: 'bubble-tea',   label: 'Bubble tea' },
  { value: 'smoothies',    label: 'Smoothies' },
  { value: 'chinese',      label: 'Chinese' },
  { value: 'japanese',     label: 'Japanese' },
  { value: 'korean',       label: 'Korean' },
  { value: 'thai',         label: 'Thai' },
  { value: 'indian',       label: 'Indian' },
  { value: 'mexican',      label: 'Mexican' },
  { value: 'mediterranean', label: 'Mediterranean' },
  { value: 'italian',      label: 'Italian' },
  { value: 'bbq',          label: 'BBQ' },
  { value: 'wings',        label: 'Wings' },
  { value: 'bar',          label: 'Bar' },
  { value: 'seafood',      label: 'Seafood' },
  { value: 'vegetarian',   label: 'Vegetarian' },
  { value: 'deli',         label: 'Deli' },
  { value: 'convenience',  label: 'Convenience' },
];

/** Matches vendors_cuisine_len in migration-042. Keep the two in step. */
export const MAX_CUISINES = 3;

const VALID = new Set(CUISINES.map((c) => c.value));

/**
 * Coerce whatever a form sent into a storable `text[]`.
 *
 * Silently DROPS unknown tags rather than 400ing the whole save. The input is
 * a fixed set of checkboxes on surfaces we ship, so an unrecognised value is
 * either a stale client that still offers a tag we retired or someone poking
 * the endpoint by hand — and in the first case, failing the vendor's entire
 * profile save over one obsolete checkbox is the wrong trade. Order follows
 * CUISINES so `{pizza,coffee}` and `{coffee,pizza}` store identically and a
 * re-save is a genuine no-op.
 *
 * @param {unknown} input array of tags (anything else → []).
 * @returns {string[]} deduped, canonically ordered, at most MAX_CUISINES.
 */
export function normalizeCuisine(input) {
  if (!Array.isArray(input)) return [];
  const picked = new Set(
    input.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter((t) => VALID.has(t)),
  );
  return CUISINES.map((c) => c.value).filter((v) => picked.has(v)).slice(0, MAX_CUISINES);
}

/**
 * Coerce a price tier to 1..4, or null for "not said".
 *
 * null is the meaningful default — see the migration header. A 0, an empty
 * string, or junk all mean untagged, NOT cheap.
 *
 * @param {unknown} input
 * @returns {number|null}
 */
export function normalizePriceLevel(input) {
  if (input === null || input === undefined || input === '') return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}
