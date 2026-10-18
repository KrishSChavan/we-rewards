// $1 = 1 point at every vendor, and items priced from what they sell for
// (migration-068). The database half — the conversion, the CHECK, the 50%
// mint — is test/sql/behavior-068.sql. This file holds the JavaScript half:
//
//   • lockedRatio: the settings doors accept the rate only as 1 and write it
//     nowhere, so a terminal still on the old Settings screen keeps saving.
//   • suggestedItemPoints / validItemPrice: the 4x suggestion and the price a
//     vendor may store, and the terminal's browser copy of the suggestion,
//     which must never disagree with the server's.
//   • the write paths that used to set points_per_dollar no longer can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  POINTS_PER_DOLLAR, ITEM_POINTS_MULTIPLIER, ITEM_PRICE_MAX,
  lockedRatio, suggestedItemPoints, validItemPrice, pointsFor,
} from '../src/lib/rewards.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/* ---------- the rate ---------- */

test('the one rate is 1 point per $1', () => {
  assert.equal(POINTS_PER_DOLLAR, 1);
  assert.equal(pointsFor(12.99, POINTS_PER_DOLLAR), 12);   // earning still floors
});

test('a settings body may carry the rate only as 1', () => {
  // The old terminal sends Number($('set-ratio').value), so 1 arrives as a number;
  // a hand-made request might send the string the column prints.
  for (const ok of [1, '1', 1.0, '1.00']) assert.deepEqual(lockedRatio(ok), { ok: true }, `refused ${ok}`);
  for (const bad of [10, 0.5, 2, 0, -1, 'ten', '', NaN, {}]) {
    assert.match(lockedRatio(bad).error ?? '', /1 point per \$1/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('no write path sets points_per_dollar any more', () => {
  // The vendor Settings PATCH, the operator's vendor PATCH and their pool
  // fan-outs all used to. The CHECK would refuse any value but 1 anyway; this
  // keeps a refactor from quietly bringing a write back.
  for (const rel of ['../src/routes/vendor.js', '../src/routes/admin.js', '../scripts/onboard-vendor.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /updates\.points_per_dollar\s*=/, rel);
    assert.doesNotMatch(src, /\.update\(\{\s*points_per_dollar/, rel);
    assert.doesNotMatch(src, /points_per_dollar:\s*Number\(/, rel);
  }
});

test('the terminal no longer has a rate field to send', () => {
  const html = read('../public/vendor/index.html');
  const js = read('../public/vendor/terminal.js');
  assert.doesNotMatch(html, /id="set-ratio"/);
  assert.doesNotMatch(js, /pointsPerDollar:\s*Number\(/);
  assert.doesNotMatch(read('../public/admin/index.html'), /id="vendor-edit-ratio"/);
});

/* ---------- the 4x suggestion ---------- */

test('the suggestion is 4x the whole-dollar price', () => {
  assert.equal(ITEM_POINTS_MULTIPLIER, 4);
  assert.equal(suggestedItemPoints(5), 20);
  assert.equal(suggestedItemPoints('5.00'), 20);
  // $4.99 earns 4 a purchase, so four purchases earn 16, not 4 x 4.99 = 20.
  assert.equal(suggestedItemPoints(4.99), 16);
  assert.equal(pointsFor(4.99, 1) * 4, suggestedItemPoints(4.99));
  assert.equal(suggestedItemPoints(12.5), 48);
  assert.equal(suggestedItemPoints(ITEM_PRICE_MAX), 4000);
});

test('buying the item four times always earns at least the suggestion', () => {
  // The promise on the form: buy it 4 times, the 5th is free. Swept every cent.
  for (let cents = 1; cents <= 100000; cents++) {
    const price = cents / 100;
    const pts = suggestedItemPoints(price);
    assert.ok(Number.isInteger(pts) && pts >= 4 && pts <= 100000, `$${price} -> ${pts}`);
    if (price >= 1) assert.ok(4 * pointsFor(price, 1) >= pts, `$${price}: 4 buys earn ${4 * pointsFor(price, 1)} < ${pts}`);
  }
});

test('an item under $1 still suggests 4, never 0 (which would make it free)', () => {
  assert.equal(suggestedItemPoints(0.75), 4);
  assert.equal(suggestedItemPoints(0.01), 4);
});

test('no price, no suggestion', () => {
  for (const none of [null, undefined, '', 0, -3, 'abc', NaN]) {
    assert.equal(suggestedItemPoints(none), null, `suggested for ${JSON.stringify(none)}`);
  }
});

test('the terminal suggests exactly what the server would', () => {
  // public/vendor/terminal.js is a browser bundle and keeps its own copy.
  const src = read('../public/vendor/terminal.js');
  const from = src.indexOf('const ITEM_POINTS_MULTIPLIER');
  const to = src.indexOf('// Not `priceText`');
  assert.ok(from > 0 && to > from, 'suggestion landmarks moved in public/vendor/terminal.js — re-anchor this test');
  // eslint-disable-next-line no-new-func
  const client = new Function(`${src.slice(from, to)}\nreturn suggestedItemPoints;`)();
  for (const v of [null, undefined, '', '  ', 0, '0', -1, 'abc', 0.01, 0.75, 1, '4.99', 4.99, 5, 12.5, 999.99, 1000, 5000]) {
    assert.equal(client(v), suggestedItemPoints(v), `disagree on ${JSON.stringify(v)}`);
  }
  for (let cents = 1; cents <= 20000; cents += 7) {
    assert.equal(client(cents / 100), suggestedItemPoints(cents / 100), `disagree on $${cents / 100}`);
  }
});

/* ---------- the stored price ---------- */

test('an item price is stored in cents, and blank clears it', () => {
  assert.deepEqual(validItemPrice('4.99'), { value: 499 });
  assert.deepEqual(validItemPrice(4.99), { value: 499 });
  assert.deepEqual(validItemPrice(1000), { value: 100000 });
  assert.deepEqual(validItemPrice(0.01), { value: 1 });
  assert.deepEqual(validItemPrice(''), { value: null });
  assert.deepEqual(validItemPrice(null), { value: null });
  assert.deepEqual(validItemPrice(undefined), { value: null });
});

test('a price outside $0.01 to $1,000 is refused, matching the DB CHECK', () => {
  for (const bad of [0, '0', 0.001, -1, 1000.01, 5000, 'abc', NaN, {}, [1, 2]]) {
    assert.match(validItemPrice(bad).error ?? '', /from \$0\.01 to \$1,000/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the migration\'s CHECK and the validator agree on the band', () => {
  const sql = read('../supabase/migrations/20261018130000_migration-068.sql');
  assert.match(sql, /item_price_cents between 1 and 100000/);
  assert.equal(ITEM_PRICE_MAX * 100, 100000);
  assert.match(sql, /check \(points_per_dollar = 1\)/);
  assert.match(sql, /c_rate {6}constant numeric := 0\.50;/);
});

test('no browser bundle declares the same top-level function twice', () => {
  // Every one of these loads as a classic <script>, where a second top-level
  // `function x` silently replaces the first EVERYWHERE in the file. That is
  // how the item list's priceText(cents) lost to billing's priceText(price)
  // and printed "Sells for null"; the parse-only build check cannot see it.
  for (const rel of ['../public/vendor/terminal.js', '../public/student/app.js', '../public/admin/admin.js',
    '../public/join/join.js', '../public/scan/scan.js']) {
    const seen = new Map();
    read(rel).split('\n').forEach((line, i) => {
      const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (!m) return;
      assert.ok(!seen.has(m[1]), `${rel}: function ${m[1]} declared at lines ${seen.get(m[1])} and ${i + 1}`);
      seen.set(m[1], i + 1);
    });
  }
});
