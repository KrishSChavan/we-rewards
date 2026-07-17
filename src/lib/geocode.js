// Keyless address → { lat, lng } geocoding via OpenStreetMap Nominatim.
//
// Called server-side ONLY, and only when a vendor sets/edits their address
// (onboarding CLI + the terminal Settings PATCH) — i.e. a handful of requests,
// well within Nominatim's usage policy (which requires a descriptive
// User-Agent and forbids heavy/bulk use). No API key, no browser CSP entry.
//
// Best-effort: returns null on empty input, network/HTTP error, timeout, or no
// match. Callers persist the address regardless and just skip the map thumbnail
// until a later save geocodes successfully.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Nominatim requires a genuine identifying User-Agent (with contact info).
const USER_AGENT = 'WeRewards/1.0 (krishschavan@gmail.com)';

/**
 * @param {string} address free-text street address
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
export async function geocode(address) {
  const q = String(address ?? '').trim();
  if (!q) return null;

  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const results = await res.json();
    const hit = Array.isArray(results) ? results[0] : null;
    if (!hit) return null;

    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null; // network error, timeout, or bad JSON — non-fatal
  }
}
