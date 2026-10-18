// Free items (migration-067): a reward priced at 0 points, optionally once per
// student. These are the server-side rules the vendor's and the operator's item
// routes share (src/lib/rewards.js). The database enforces the same rules as
// CHECKs; test/sql/behavior-067.sql covers that half, and the redemption RPCs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validReward, mergeRewardEdit, onceUpdate } from '../src/lib/rewards.js';
import { rewardCost } from '../src/lib/spots-page.js';

describe('validReward and a 0-point price', () => {
  test('0 points is a valid price: a free item', () => {
    const v = validReward('Water', 0, null, '🥤');
    assert.equal(v.error, undefined);
    assert.equal(v.cost, 0);
    assert.equal(v.once, false, 'every visit unless asked otherwise');
  });

  test('the form posts "0" as text, and that is free too', () => {
    assert.equal(validReward('Water', '0', '', '🥤').cost, 0);
  });

  test('blank still means "not sold for points", not free', () => {
    const v = validReward('Coffee', '', 5, '☕');
    assert.equal(v.cost, null);
    assert.equal(v.visits, 5);
  });

  test('a free item can be once per student', () => {
    assert.equal(validReward('Cookie', 0, null, '🍪', true).once, true);
  });

  test('once is ignored on a priced item rather than refused', () => {
    const v = validReward('Coffee', 50, null, '☕', true);
    assert.equal(v.error, undefined);
    assert.equal(v.once, false);
  });

  test('only a real `true` turns once on', () => {
    for (const junk of ['true', 1, 'yes', {}, null, undefined]) {
      assert.equal(validReward('Cookie', 0, null, '🍪', junk).once, false, `once=${JSON.stringify(junk)}`);
    }
  });

  test('a free item cannot also have a visit price', () => {
    assert.match(validReward('Water', 0, 5, '🥤').error, /free item can.t also have a visit cost/);
  });

  test('negative and fractional points are still refused, and the message says 0 is allowed', () => {
    assert.match(validReward('X', -1, null).error, /from 0 to 100000/);
    assert.match(validReward('X', 0.5, null).error, /from 0 to 100000/);
  });

  test('no price at all is still refused', () => {
    assert.match(validReward('X', '', '').error, /Set a point cost, a visit cost, or both/);
  });

  test('a visit price of 0 is still refused: only points can be free', () => {
    assert.match(validReward('X', null, 0).error, /Visit cost must be a whole number from 1 to 50/);
  });
});

describe('editing an item (PATCH merge)', () => {
  const freeOnce = { title: 'Cookie', cost_in_points: 0, cost_in_visits: null, emoji: '🍪', once_per_student: true };
  const priced = { title: 'Coffee', cost_in_points: 50, cost_in_visits: null, emoji: '☕', once_per_student: false };

  const edit = (body, current) => {
    const v = validReward(...mergeRewardEdit(body, current));
    return { v, once: v.error ? undefined : onceUpdate(body, current, v) };
  };

  test('renaming a once-only item keeps it once-only and writes nothing about it', () => {
    const { v, once } = edit({ title: 'Big cookie' }, freeOnce);
    assert.equal(v.once, true);
    assert.deepEqual(once, {});
  });

  test('pricing a once-only item clears the flag in the same write', () => {
    const { v, once } = edit({ costInPoints: 40 }, freeOnce);
    assert.equal(v.cost, 40);
    assert.deepEqual(once, { once_per_student: false });
  });

  test('making a priced item free writes the chosen limit', () => {
    assert.deepEqual(edit({ costInPoints: 0, oncePerStudent: true }, priced).once, { once_per_student: true });
    assert.deepEqual(edit({ costInPoints: 0, oncePerStudent: false }, priced).once, { once_per_student: false });
  });

  test('switching a free item between every visit and once', () => {
    assert.deepEqual(edit({ oncePerStudent: false }, freeOnce).once, { once_per_student: false });
  });

  test('a priced item that stays priced never names the column', () => {
    assert.deepEqual(edit({ costInPoints: 60 }, priced).once, {});
    assert.deepEqual(edit({ oncePerStudent: true }, priced).once, {});
  });

  test('a row from before migration-067 has no flag, and reads as every visit', () => {
    const old = { title: 'Coffee', cost_in_points: 50, cost_in_visits: null, emoji: '☕' };
    const { v } = edit({ title: 'Latte' }, old);
    assert.equal(v.once, false);
  });

  test('giving a free item a visit price is refused', () => {
    assert.match(edit({ costInVisits: 5 }, freeOnce).v.error, /free item/);
  });

  test('making a dual-priced item free needs the visit price cleared too', () => {
    const dual = { title: 'Bagel', cost_in_points: 80, cost_in_visits: 5, emoji: '🥯' };
    assert.match(edit({ costInPoints: 0 }, dual).v.error, /free item/);
    assert.equal(edit({ costInPoints: 0, costInVisits: '' }, dual).v.cost, 0);
  });
});

test('the public spots page says Free, not "0 points"', () => {
  assert.equal(rewardCost({ cost_in_points: 0, cost_in_visits: null }), 'Free');
  assert.equal(rewardCost({ cost_in_points: 1 }), '1 point');
});
