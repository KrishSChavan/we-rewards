// Pure parsing for scanned receipts: vendor match, total, printed date/time.
// No I/O — everything here is unit-tested against noisy OCR fixtures in
// test/receipt.test.js (same split as scoreProfile in tiers.js).
//
// The inputs are worst-case tesseract output: thermal print photographed at an
// angle, so expect dropped characters, l/1 and S/5 swaps, and stray
// punctuation. The design leans on two things OCR noise can't easily break: the
// vendor list is tiny and KNOWN (fuzzy match against it, never freeform), and
// money amounts have a rigid ..dd shape.
//
// These parsers still run when the AI reader (lib/gemini-receipt.js) handled
// the scan: it returns a transcription alongside its structured fields, and the
// route falls back to parsing that text for any single field the model left
// null. So this module stays the floor under both readers, not the tesseract
// branch's private code.

/** Lowercase, de-accent, collapse every non-alphanumeric run to one space. */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Character-bigram Dice coefficient in [0, 1]. Chosen over edit distance
 * because it degrades gracefully under single-character OCR swaps and needs
 * no dependency.
 */
export function diceSimilarity(a, b) {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

// The vendor name prints in the receipt header; scanning the whole document
// invites false hits from menu items ("Diner Burger" at a place named Diner).
const HEADER_LINES = 15;
// Accept threshold, and how clearly the winner must beat the runner-up.
// Ambiguity between two plausible vendors is a rejection, not a guess.
const MATCH_MIN = 0.6;
const MATCH_MARGIN = 0.1;

/**
 * Find which participating vendor printed this receipt.
 * `vendors` is the active-vendor list ({ id, name, ... }); returns
 * { vendor, score } or null when nothing matches confidently.
 */
export function matchVendor(text, vendors) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => normalizeName(l))
    .filter(Boolean)
    .slice(0, HEADER_LINES);
  if (!lines.length) return null;
  const head = lines.join(' ');

  const scored = [];
  for (const vendor of vendors ?? []) {
    const vn = normalizeName(vendor?.name);
    if (!vn) continue;
    let score;
    if (head.includes(vn)) {
      score = 1;
    } else {
      score = 0;
      for (const line of lines) score = Math.max(score, diceSimilarity(line, vn));
    }
    scored.push({ vendor, score });
  }
  scored.sort((x, y) => y.score - x.score);

  const best = scored[0];
  if (!best || best.score < MATCH_MIN) return null;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score >= MATCH_MIN && best.score - runnerUp.score < MATCH_MARGIN) {
    return null; // two vendors both look right — refuse rather than guess
  }
  return best;
}

// Money: one or two decimals would over-match quantities; exactly two, with
// optional thousands separators, is the receipt shape. The (?!\d) stops
// "12.345" from yielding "12.34".
const MONEY_RE = /(?:\$\s*)?(\d{1,3}(?:[ ,]\d{3})*[.,]\d{2})(?!\d)/g;
// Lines that carry the number we want…
const TOTAL_LINE = /\b(?:grand\s*total|amount\s*due|balance\s*due|total)\b/i;
// …and lines that carry a number we must NOT mistake for it. "tend(er/ered)"
// covers CASH TEND 20.00-style register lines.
const EXCLUDE_LINE = /\bsub\s*-?\s*total\b|\btax\b|\btip\b|\bgratuity\b|\bchange\b|\bcash\b|\btend(?:er(?:ed)?)?\b|\bsavings?\b|\bdiscount\b|\bpoints?\b/i;

function parseMoney(token) {
  // The last . or , is the decimal separator; everything else is grouping.
  const idx = Math.max(token.lastIndexOf('.'), token.lastIndexOf(','));
  const whole = token.slice(0, idx).replace(/[^0-9]/g, '');
  return Number.parseFloat(`${whole}.${token.slice(idx + 1)}`);
}

function moneyTokens(line) {
  const out = [];
  for (const m of line.matchAll(MONEY_RE)) out.push(parseMoney(m[1]));
  return out;
}

/**
 * The amount paid, as a number, or null when no plausible total is present.
 * Bounds (> 0, <= $200) are the caller's to judge — it picks the error code.
 */
export function extractTotal(text) {
  const lines = String(text ?? '').split('\n');

  // Labeled pass: the LAST total-labeled line wins, because the grand total
  // prints below the subtotal/tax stack it summarizes.
  let labeled = null;
  for (const line of lines) {
    if (!TOTAL_LINE.test(line) || EXCLUDE_LINE.test(line)) continue;
    const tokens = moneyTokens(line);
    if (tokens.length) labeled = tokens[tokens.length - 1];
  }
  if (labeled != null) return labeled;

  // Fallback: the biggest money amount on any non-excluded line. On a receipt
  // that's the total more often than not, and a wrong pick is bounded by the
  // $200 ceiling plus the dedup key including this exact number.
  let max = null;
  for (const line of lines) {
    if (EXCLUDE_LINE.test(line)) continue;
    for (const v of moneyTokens(line)) {
      if (max == null || v > max) max = v;
    }
  }
  return max;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const DATE_ISO = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/;
const DATE_US = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/;
const DATE_MONTH_FIRST = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i;
const DATE_DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i;
const TIME_AMPM = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s*m\b/i;
const TIME_24H = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

function validDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2099;
}

function parseDate(line) {
  let m = DATE_ISO.exec(line);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDate(y, mo, d)) return { y, m: mo, d };
  }
  m = DATE_US.exec(line);
  if (m) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    const yRaw = Number(m[3]);
    const y = m[3].length === 2 ? 2000 + yRaw : yRaw;
    // US month-first by default; an impossible month with a possible day
    // means the receipt printed day-first.
    if (a > 12 && b <= 12) [a, b] = [b, a];
    if (validDate(y, a, b)) return { y, m: a, d: b };
  }
  m = DATE_MONTH_FIRST.exec(line);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const [d, y] = [Number(m[2]), Number(m[3])];
    if (validDate(y, mo, d)) return { y, m: mo, d };
  }
  m = DATE_DAY_FIRST.exec(line);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    const [d, y] = [Number(m[1]), Number(m[3])];
    if (validDate(y, mo, d)) return { y, m: mo, d };
  }
  return null;
}

function parseTime(line) {
  let m = TIME_AMPM.exec(line);
  if (m) {
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    const pm = m[3].toLowerCase() === 'p';
    if (hh < 1 || hh > 12 || mm > 59) return null;
    if (hh === 12) hh = 0;
    if (pm) hh += 12;
    return { hh, mm };
  }
  m = TIME_24H.exec(line);
  if (m) {
    const [hh, mm] = [Number(m[1]), Number(m[2])];
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
  }
  return null;
}

/**
 * The printed date AND time, or null when either is unreadable. Both are
 * required: the dedup key is (vendor, timestamp, total), and a receipt whose
 * timestamp can't be read can't be de-duplicated honestly.
 */
export function extractDateTime(text) {
  const lines = String(text ?? '').split('\n');

  // Prefer a line carrying both — that's how registers print it, and it stops
  // an address line's "Suite 20-26" pairing with a time from elsewhere.
  for (const line of lines) {
    const date = parseDate(line);
    if (!date) continue;
    const time = parseTime(line.replace(DATE_ISO, ' ').replace(DATE_US, ' '));
    if (time) return { ...date, ...time };
  }

  // Otherwise first date + first time found anywhere.
  let date = null;
  let time = null;
  for (const line of lines) {
    if (!date) date = parseDate(line);
    if (!time) {
      const cleaned = line.replace(DATE_ISO, ' ').replace(DATE_US, ' ');
      time = parseTime(cleaned);
    }
    if (date && time) break;
  }
  return date && time ? { ...date, ...time } : null;
}

/**
 * The same { y, m, d, hh, mm } shape, built from the separate date and time
 * strings the AI reader returns (lib/gemini-receipt.js) instead of from OCR
 * text. Returns null when either side is missing or out of range, which is the
 * caller's cue to fall back to extractDateTime() over the transcription.
 *
 * Strict on the date on purpose — this is model output, and a hallucinated
 * "2026-13-45" must die here rather than reach the SQL timestamp cast. The time
 * goes through the same parseTime() as OCR text, so a model that answers
 * "1:22 PM" despite being told 24-hour still parses.
 */
export function parseIsoDateTime(dateStr, timeStr) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(String(dateStr ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validDate(y, mo, d)) return null;
  const time = parseTime(String(timeStr ?? ''));
  return time ? { y, m: mo, d, ...time } : null;
}
