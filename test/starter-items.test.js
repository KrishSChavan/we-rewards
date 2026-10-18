// Unit tests for the items a vendor names before they have a terminal
// (migration-052). Three pure pieces carry the feature and none of them needs a
// database:
//
//   • validStarterItems (src/lib/rewards.js) decides what may be named, and
//     whether naming nothing is allowed — the one behaviour that differs
//     between the public /join door and the operator's own "Add vendor" form.
//   • starterItemToReward turns the dollars an applicant typed into the points
//     a rewards row holds. This is the load-bearing conversion: /join has no
//     points field, so it is the ONLY place the two currencies meet, and getting
//     it wrong mis-prices every item a vendor opens with. Since migration-068
//     the applicant names what the item SELLS FOR (`price`, saved at 4x); an
//     application sent before that names a `spend`, converted at the rate.
//   • validApplication (src/routes/apply.js) is the public door itself, held
//     here to the rule that an application naming no items cannot get in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validStarterItem, validStarterItems, starterItemToReward,
  SPEND_MIN, SPEND_MAX, PRICE_MIN, PRICE_MAX, MAX_STARTER_ITEMS,
} from '../src/lib/rewards.js';
import { validApplication } from '../src/routes/apply.js';
import { validNewVendor } from '../src/routes/admin.js';

const ITEM = { title: 'Free small coffee', spend: 25, emoji: '☕' };

/* ---------- one item ---------- */

test('a filled-in item comes back trimmed', () => {
  const out = validStarterItem({ title: '  Free small coffee  ', spend: '25', emoji: ' ☕ ' });
  assert.deepEqual(out.item, { title: 'Free small coffee', spend: 25, emoji: '☕' });
});

test('a missing emoji falls back to the gift box the terminal also defaults to', () => {
  assert.equal(validStarterItem({ title: 'Free slice', spend: 30 }).item.emoji, '🎁');
  assert.equal(validStarterItem({ title: 'Free slice', spend: 30, emoji: '   ' }).item.emoji, '🎁');
});

test('a nameless item is refused, and the message says which one', () => {
  const out = validStarterItem({ spend: 25 }, 'Item 2');
  assert.match(out.error, /Item 2/);
  assert.match(out.error, /name/i);
});

test('60 characters of title is allowed, 61 is not (boundary)', () => {
  assert.equal(validStarterItem({ title: 'x'.repeat(60), spend: 25 }).item.title.length, 60);
  assert.match(validStarterItem({ title: 'x'.repeat(61), spend: 25 }).error, /60 characters/);
});

test('the spend bounds are inclusive at both ends', () => {
  assert.equal(validStarterItem({ title: 'a', spend: SPEND_MIN }).item.spend, SPEND_MIN);
  assert.equal(validStarterItem({ title: 'a', spend: SPEND_MAX }).item.spend, SPEND_MAX);
  assert.ok(validStarterItem({ title: 'a', spend: SPEND_MIN - 0.01 }).error);
  assert.ok(validStarterItem({ title: 'a', spend: SPEND_MAX + 0.01 }).error);
});

test('a blank, missing or unparseable spend is refused rather than read as zero', () => {
  // Number('') and Number(null) are both 0, and 0 is below SPEND_MIN — so these
  // are refused by the range check rather than by a special case, which is the
  // point: there is no input that quietly becomes a free item.
  for (const spend of ['', null, undefined, 'twenty', {}, []]) {
    assert.ok(validStarterItem({ title: 'a', spend }).error, `should refuse ${JSON.stringify(spend)}`);
  }
});

test('a spend is rounded to the cent, so a third decimal cannot vanish silently', () => {
  assert.equal(validStarterItem({ title: 'a', spend: 12.499 }).item.spend, 12.5);
  assert.equal(validStarterItem({ title: 'a', spend: 12.5 }).item.spend, 12.5);
});

test('an item that is not an object at all is refused, not skipped', () => {
  for (const junk of [null, 'Free coffee', 42, ['Free coffee']]) {
    assert.ok(validStarterItem(junk).error, `should refuse ${JSON.stringify(junk)}`);
  }
});

/* ---------- the list ---------- */

test('required: an empty list is refused on the public door', () => {
  assert.match(validStarterItems([], { required: true }).error, /at least one/i);
  assert.match(validStarterItems(undefined, { required: true }).error, /at least one/i);
});

test('not required: an empty list is fine on the operator door', () => {
  assert.deepEqual(validStarterItems([], { required: false }).items, []);
  assert.deepEqual(validStarterItems(undefined).items, []);
});

test('the cap is inclusive, and one past it is refused', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ title: `Item ${i}`, spend: 10 }));
  assert.equal(validStarterItems(many(MAX_STARTER_ITEMS)).items.length, MAX_STARTER_ITEMS);
  assert.match(validStarterItems(many(MAX_STARTER_ITEMS + 1)).error, new RegExp(String(MAX_STARTER_ITEMS)));
});

test('a bad item names its position, counting from 1 like the form does', () => {
  const out = validStarterItems([ITEM, { title: 'Free cookie' }]);
  assert.match(out.error, /Item 2/);
});

test('`rewards` must be a list', () => {
  assert.match(validStarterItems({ title: 'Free coffee', spend: 25 }).error, /list/);
});

/* ---------- dollars to points: a pre-068 `spend` ----------
   An application sent before migration-068 asked what a customer should
   SPEND, converted at the location's rate. Every vendor is on 1 now, but the
   conversion still has to honour whatever rate it is handed: 10/$ was the old
   table default, 5/$ a vendor who halved it, 0.5 and 1000 the old band's ends. */

test('at the default rate, the dollars an applicant typed become the obvious points', () => {
  assert.equal(starterItemToReward(ITEM, 10).cost_in_points, 250);
  assert.equal(starterItemToReward(ITEM, 5).cost_in_points, 125);
  assert.equal(starterItemToReward(ITEM, 1).cost_in_points, 25);
});

test('the title and emoji ride through untouched', () => {
  const r = starterItemToReward(ITEM, 10);
  assert.equal(r.title, 'Free small coffee');
  assert.equal(r.emoji, '☕');
});

test('a fractional result rounds rather than floors', () => {
  // 12.50 at 7/$ is 87.5 points. Flooring every item would make every vendor's
  // opening menu quietly cheaper than the dollar figure they were shown.
  assert.equal(starterItemToReward({ ...ITEM, spend: 12.5 }, 7).cost_in_points, 88);
});

test('no legal spend at any legal rate can fall outside the price column bounds', () => {
  // validPrice (the vendor's own routes) accepts 1..100000; a starter item that
  // landed outside that band would be an item its own vendor could not edit.
  for (const rate of [0.5, 1, 5, 10, 37.5, 1000]) {
    for (const spend of [SPEND_MIN, 7.5, 25, 999.99, SPEND_MAX]) {
      const pts = starterItemToReward({ ...ITEM, spend }, rate).cost_in_points;
      assert.ok(Number.isInteger(pts), `rate ${rate} spend ${spend} gave ${pts}`);
      assert.ok(pts >= 1 && pts <= 100000, `rate ${rate} spend ${spend} gave ${pts}`);
    }
  }
});

test('a missing or nonsense rate falls back to the one rate instead of throwing', () => {
  // This runs mid-onboard, after the login and the vendors row already exist. A
  // rate that failed to come back must not be the thing that unwinds an accept.
  // The fallback is 1 point per $1 (migration-068), not the old default of 10.
  for (const rate of [null, undefined, 0, -5, NaN, 'ten']) {
    assert.equal(starterItemToReward(ITEM, rate).cost_in_points, 25, `rate ${rate}`);
  }
});

/* ---------- what it sells for: the 068 question ---------- */

const PRICED = { title: 'Small coffee', price: 4.99, emoji: '☕' };

test('a priced item comes back with its price, not a spend', () => {
  const out = validStarterItem({ title: ' Small coffee ', price: '4.99', emoji: '☕' });
  assert.deepEqual(out.item, { title: 'Small coffee', price: 4.99, emoji: '☕' });
});

test('price wins when an item somehow carries both', () => {
  assert.deepEqual(validStarterItem({ title: 'a', price: 3, spend: 25 }).item, { title: 'a', price: 3, emoji: '🎁' });
});

test('the price band is inclusive at both ends and refuses blanks', () => {
  assert.equal(validStarterItem({ title: 'a', price: PRICE_MIN }).item.price, PRICE_MIN);
  assert.equal(validStarterItem({ title: 'a', price: PRICE_MAX }).item.price, PRICE_MAX);
  assert.ok(validStarterItem({ title: 'a', price: PRICE_MAX + 0.01 }).error);
  for (const price of ['', null, 0, -1, 'abc', [], {}]) {
    assert.match(validStarterItem({ title: 'a', price }).error ?? '', /what it sells for/, `should refuse ${JSON.stringify(price)}`);
  }
  // No price AND no spend is a blank price, not a pre-068 item.
  assert.match(validStarterItem({ title: 'a' }).error, /what it sells for/);
});

test('a priced item is saved at 4x its whole-dollar price, keeping the price', () => {
  // $4.99 earns 4 points a purchase (earning floors), so 4 purchases = 16.
  assert.deepEqual(starterItemToReward(PRICED, 1), {
    title: 'Small coffee', emoji: '☕', cost_in_points: 16, item_price_cents: 499,
  });
  assert.equal(starterItemToReward({ ...PRICED, price: 5 }, 1).cost_in_points, 20);
  assert.equal(starterItemToReward({ ...PRICED, price: 12.5 }, 1).cost_in_points, 48);
});

test('a price under $1 still suggests points, never a free item', () => {
  // 0 points means FREE (migration-067); a 75-cent item must not become one.
  assert.equal(starterItemToReward({ ...PRICED, price: 0.75 }, 1).cost_in_points, 4);
});

test('a priced item ignores the rate it is handed', () => {
  for (const rate of [null, 0, 1, 10, 1000]) {
    assert.equal(starterItemToReward(PRICED, rate).cost_in_points, 16, `rate ${rate}`);
  }
});

/* ---------- the public door ---------- */

const APPLICATION = {
  businessName: 'Joe’s Pizza',
  contactName: 'Joe',
  phone: '814 555 0100',
  email: 'joe@example.com',
  password: 'a-good-password',
};

test('an application naming no items is refused', () => {
  const out = validApplication(APPLICATION);
  assert.match(out.error, /at least one/i);
});

test('an application naming one item carries it through to the insert', () => {
  const out = validApplication({ ...APPLICATION, rewards: [ITEM] });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.fields.rewards, [{ title: 'Free small coffee', spend: 25, emoji: '☕' }]);
});

test('what /join sends since 068, a price, carries through both doors', () => {
  const app = validApplication({ ...APPLICATION, rewards: [{ title: 'Small coffee', price: '4.99', emoji: '☕' }] });
  assert.equal(app.error, undefined);
  assert.deepEqual(app.fields.rewards, [{ title: 'Small coffee', price: 4.99, emoji: '☕' }]);
  const base = { name: 'Joe’s Pizza', email: 'joe@example.com', password: 'a-good-password' };
  assert.deepEqual(validNewVendor({ ...base, rewards: [{ title: 'Small coffee', price: 4.99 }] }).rewards, [
    { title: 'Small coffee', price: 4.99, emoji: '🎁' },
  ]);
  assert.match(validNewVendor({ ...base, rewards: [{ title: 'Small coffee', price: 0 }] }).error, /what it sells for/);
});

test('the items are checked before the locations, matching the order on the page', () => {
  // An applicant scrolling up to find the field an error is about should meet it
  // on the way, not below the message.
  const out = validApplication({ ...APPLICATION, rewards: [{ title: '', spend: 25 }], locations: [{}] });
  assert.match(out.error, /Item 1/);
});

test('the operator door takes the same shape but does not insist on it', () => {
  const base = { name: 'Joe’s Pizza', email: 'joe@example.com', password: 'a-good-password' };
  assert.deepEqual(validNewVendor(base).rewards, []);
  assert.deepEqual(validNewVendor({ ...base, rewards: [ITEM] }).rewards, [
    { title: 'Free small coffee', spend: 25, emoji: '☕' },
  ]);
  // ...and what it refuses, it refuses for the same reasons the public door does.
  assert.ok(validNewVendor({ ...base, rewards: [{ title: 'Free coffee', spend: 0 }] }).error);
});
