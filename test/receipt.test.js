// Unit tests for the pure receipt-parsing helpers (src/lib/receipt.js).
// No OCR, no database: fixtures are the kind of noisy text tesseract actually
// returns for thermal receipts — dropped characters, 0/O and 1/I and 5/S
// swaps, register lines (CASH TEND / CHANGE) below the total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  diceSimilarity,
  matchVendor,
  extractTotal,
  extractDateTime,
  parseIsoDateTime,
} from '../src/lib/receipt.js';

const VENDORS = [
  { id: 'v-roots', name: 'Roots Natural Kitchen' },
  { id: 'v-bagel', name: 'Bagel Crust' },
  { id: 'v-yallah', name: 'Yallah Taco' },
];

// ---------- normalizeName / diceSimilarity ----------

test('normalizeName lowercases, de-accents, and collapses punctuation', () => {
  assert.equal(normalizeName('Café  Périgord #12!'), 'cafe perigord 12');
  assert.equal(normalizeName("McDonald's"), 'mcdonald s');
  assert.equal(normalizeName(null), '');
});

test('diceSimilarity: identical is 1, disjoint is 0, close stays high', () => {
  assert.equal(diceSimilarity('bagel crust', 'bagel crust'), 1);
  assert.equal(diceSimilarity('bagel crust', 'xyzq'), 0);
  assert.ok(diceSimilarity('r0ots natural k1tchen', 'roots natural kitchen') > 0.7);
});

// ---------- matchVendor ----------

test('matchVendor: clean header name is a confident hit', () => {
  const text = 'ROOTS NATURAL KITCHEN\n123 College Ave\nState College PA\n\nBOWL  11.50';
  const hit = matchVendor(text, VENDORS);
  assert.equal(hit?.vendor.id, 'v-roots');
  assert.equal(hit?.score, 1);
});

test('matchVendor: survives OCR character swaps in the header', () => {
  const text = 'R0OTS NATURAL K1TCHEN\n123 College Ave\nTOTAL 11.50';
  const hit = matchVendor(text, VENDORS);
  assert.equal(hit?.vendor.id, 'v-roots');
  assert.ok(hit.score >= 0.6);
});

test('matchVendor: a menu item deep in the body does not match', () => {
  // The vendor name appears only past the header window — a receipt from some
  // OTHER shop selling a "Yallah Taco special" must not match Yallah Taco.
  const filler = Array.from({ length: 16 }, (_, i) => `ITEM LINE ${i} 1.00`).join('\n');
  const text = `SOME OTHER PLACE\n${filler}\nYALLAH TACO SPECIAL 8.00`;
  assert.equal(matchVendor(text, VENDORS), null);
});

test('matchVendor: two plausible vendors is a rejection, not a guess', () => {
  const ambiguous = [
    { id: 'a', name: 'Campus Cafe' },
    { id: 'b', name: 'Campus Cafe West' },
  ];
  const text = 'CAMPUS CAFE WEST\nTOTAL 9.00';
  assert.equal(matchVendor(text, ambiguous), null);
});

test('matchVendor: gibberish or an empty vendor list matches nothing', () => {
  assert.equal(matchVendor('lorem ipsum dolor\nsit amet', VENDORS), null);
  assert.equal(matchVendor('ROOTS NATURAL KITCHEN', []), null);
});

// ---------- extractTotal ----------

test('extractTotal: TOTAL wins over the subtotal/tax stack above it', () => {
  const text = 'BOWL  11.50\nSUBTOTAL  11.50\nTAX  0.69\nTOTAL  12.19';
  assert.equal(extractTotal(text), 12.19);
});

test('extractTotal: register lines below the total are ignored', () => {
  const text = 'SUBTOTAL 11.50\nTAX 0.69\nTOTAL 12.19\nCASH TEND 20.00\nCHANGE 7.81';
  assert.equal(extractTotal(text), 12.19);
});

test('extractTotal: the LAST labeled line wins (grand total under total)', () => {
  const text = 'TOTAL 21.20\nGRAND TOTAL 23.32';
  assert.equal(extractTotal(text), 23.32);
});

test('extractTotal: corrupted TOTAL line falls back to max non-excluded amount', () => {
  // "12.4S" is not money, so the labeled pass fails; the fallback takes the
  // biggest amount on a non-excluded line (the items, not CASH TEND).
  const text = 'BURGER 4.99\nFRIES 5.99\nTOTAL 12.4S\nCASH TEND 20.00';
  assert.equal(extractTotal(text), 5.99);
});

test('extractTotal: thousands separators and comma decimals both parse', () => {
  assert.equal(extractTotal('TOTAL 1,234.56'), 1234.56);
  assert.equal(extractTotal('TOTAL 12,19'), 12.19);
  assert.equal(extractTotal('AMOUNT DUE $8.00'), 8);
});

test('extractTotal: no money means null', () => {
  assert.equal(extractTotal('THANK YOU\nCOME AGAIN'), null);
});

// ---------- extractDateTime ----------

test('extractDateTime: US date with am/pm time on one line', () => {
  assert.deepEqual(
    extractDateTime('08/03/26 6:42 PM\nTOTAL 12.19'),
    { y: 2026, m: 8, d: 3, hh: 18, mm: 42 },
  );
});

test('extractDateTime: 12am and 12pm convert correctly', () => {
  assert.deepEqual(extractDateTime('08/03/2026 12:05 AM').hh, 0);
  assert.deepEqual(extractDateTime('08/03/2026 12:30 P.M.').hh, 12);
});

test('extractDateTime: ISO date with 24-hour time', () => {
  assert.deepEqual(
    extractDateTime('2026-08-03 18:42:11'),
    { y: 2026, m: 8, d: 3, hh: 18, mm: 42 },
  );
});

test('extractDateTime: an impossible month means the receipt printed day-first', () => {
  assert.deepEqual(
    extractDateTime('13/03/26 09:15'),
    { y: 2026, m: 3, d: 13, hh: 9, mm: 15 },
  );
});

test('extractDateTime: month-name dates parse', () => {
  assert.deepEqual(
    extractDateTime('Aug 3, 2026  6:42PM'),
    { y: 2026, m: 8, d: 3, hh: 18, mm: 42 },
  );
});

test('extractDateTime: date and time on different lines still pair', () => {
  assert.deepEqual(
    extractDateTime('DATE: 08/03/26\nORDER 41\nTIME: 6:42 PM'),
    { y: 2026, m: 8, d: 3, hh: 18, mm: 42 },
  );
});

test('extractDateTime: missing either part means null', () => {
  assert.equal(extractDateTime('08/03/26\nTOTAL 12.19'), null); // no time
  assert.equal(extractDateTime('6:42 PM\nTOTAL 12.19'), null); // no date
  assert.equal(extractDateTime('08/03/26 25:99'), null); // nonsense time only
});

// ---- parseIsoDateTime: the AI reader's structured date/time ----
// Same output shape as extractDateTime, but the input is model output rather
// than OCR text, so the failure mode to defend against is confident nonsense.

test('parseIsoDateTime: the documented shape parses', () => {
  assert.deepEqual(
    parseIsoDateTime('2026-08-09', '13:22'),
    { y: 2026, m: 8, d: 9, hh: 13, mm: 22 },
  );
});

test('parseIsoDateTime: unpadded parts and surrounding space are fine', () => {
  assert.deepEqual(
    parseIsoDateTime(' 2026-8-9 ', '09:05'),
    { y: 2026, m: 8, d: 9, hh: 9, mm: 5 },
  );
});

test('parseIsoDateTime: a model that ignores "24-hour" is still understood', () => {
  // Told HH:MM, answered 1:22 PM. Rejecting that would cost a valid claim.
  assert.deepEqual(
    parseIsoDateTime('2026-08-09', '1:22 PM'),
    { y: 2026, m: 8, d: 9, hh: 13, mm: 22 },
  );
  assert.deepEqual(
    parseIsoDateTime('2026-08-09', '12:05 AM'),
    { y: 2026, m: 8, d: 9, hh: 0, mm: 5 },
  );
});

test('parseIsoDateTime: an impossible date dies here, not at the SQL cast', () => {
  assert.equal(parseIsoDateTime('2026-13-01', '10:00'), null);
  assert.equal(parseIsoDateTime('2026-08-32', '10:00'), null);
  assert.equal(parseIsoDateTime('1899-08-09', '10:00'), null);
  assert.equal(parseIsoDateTime('2026-08-09', '25:00'), null);
});

test('parseIsoDateTime: a missing or non-ISO half means null, so the route falls back to the text', () => {
  assert.equal(parseIsoDateTime(null, '13:22'), null);
  assert.equal(parseIsoDateTime('2026-08-09', null), null);
  assert.equal(parseIsoDateTime('08/09/2026', '13:22'), null); // not ISO — don't guess the order
  assert.equal(parseIsoDateTime('2026-08-09', 'lunchtime'), null);
  assert.equal(parseIsoDateTime(undefined, undefined), null);
});
