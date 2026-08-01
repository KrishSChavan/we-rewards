// Unit tests for the pure half of vendor campaign delivery (src/lib/campaigns.js).
// No database and no push service: composeNotification() is fed the bundles the
// claim RPC produces and its output is the payload a student's phone renders.
//
// The throttle itself (cooldowns, caps, quiet hours, the per-vendor fence) lives
// in SQL and is verified against a real Postgres in test/sql/behavior-032.sql.
// What matters HERE is the other half of the anti-storm design: once several
// vendors have been coalesced into one notification, that notification has to
// actually name all of them. A bundle that silently renders as only the first
// vendor would look identical to the throttle eating the other four.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotification, CAMPAIGN_CONFIG, CAMPAIGN_DURATIONS } from '../src/lib/campaigns.js';

const item = (vendor, over = {}) => ({
  campaignId: `c-${vendor}`,
  vendorId: `v-${vendor}`,
  vendor,
  title: `${vendor} deal`,
  body: 'Show your code at the counter.',
  kind: 'deal',
  hasLogo: false,
  ...over,
});

test('an empty bundle produces nothing to send', () => {
  assert.equal(composeNotification([]), null);
  assert.equal(composeNotification(null), null);
  assert.equal(composeNotification([null, undefined]), null);
});

test('a single campaign is delivered in the vendor’s own words', () => {
  const p = composeNotification([item('Blue Bird')]);
  assert.equal(p.title, 'Blue Bird deal');
  // The vendor is named in the body, because the title is the vendor's headline
  // and a notification with no attribution reads as spam.
  assert.ok(p.body.startsWith('Blue Bird: '));
  assert.equal(p.count, 1);
  // Deep link straight to that deal, not the generic list.
  assert.equal(p.url, '/?deal=c-Blue Bird');
});

test('a single campaign uses the vendor logo as the icon when there is one', () => {
  assert.equal(composeNotification([item('Taco', { hasLogo: true })]).icon, '/api/vendor-logo/v-Taco');
  assert.equal(composeNotification([item('Taco')]).icon, undefined);
});

test('two campaigns become one notification that names both', () => {
  const p = composeNotification([item('Blue Bird'), item('Taco')]);
  assert.equal(p.count, 2);
  assert.match(p.title, /^2 spots/);
  assert.ok(p.body.includes('Blue Bird'));
  assert.ok(p.body.includes('Taco'));
  assert.equal(p.url, '/?deals=1');
});

test('three campaigns list all three', () => {
  const p = composeNotification([item('A'), item('B'), item('C')]);
  assert.ok(p.body.includes('A') && p.body.includes('B') && p.body.includes('C'));
  assert.equal(p.count, 3);
});

test('past three, the extras are counted rather than dropped silently', () => {
  const p = composeNotification([item('Alpha'), item('Bravo'), item('Charlie'), item('Delta')]);
  assert.equal(p.count, 4);
  assert.ok(p.body.includes('Alpha') && p.body.includes('Bravo') && p.body.includes('Charlie'));
  // Delta is not named, but the student is told it exists.
  assert.ok(p.body.includes('1 more'), `expected an "and 1 more" tail, got: ${p.body}`);
});

test('every payload carries the collapse tag, so nothing can stack in the shade', () => {
  // The last line of defence: same tag = replace, not append. If the server-side
  // throttle were ever bypassed, the phone still shows one WeRewards entry.
  for (const n of [1, 2, 5]) {
    const p = composeNotification(Array.from({ length: n }, (_, i) => item(`V${i}`)));
    assert.equal(p.tag, 'wr-deals');
  }
});

test('bodies are clipped to a length a notification actually shows', () => {
  const long = composeNotification([item('Cafe', { body: 'x'.repeat(400) })]);
  assert.ok(long.body.length <= 140, `body was ${long.body.length} chars`);
  assert.ok(long.body.endsWith('…'));

  const manyNames = composeNotification(
    ['Aaaaaaaaaaaaaaaaaaaa', 'Bbbbbbbbbbbbbbbbbbbb', 'Cccccccccccccccccccc'].map((v) => item(v))
  );
  assert.ok(manyNames.body.length <= 140);
});

test('titles are clipped too', () => {
  const p = composeNotification([item('Cafe', { title: 'y'.repeat(200) })]);
  assert.ok(p.title.length <= 60, `title was ${p.title.length} chars`);
});

test('no em dashes reach a student (the repo copy rule)', () => {
  const one = composeNotification([item('Cafe')]);
  const many = composeNotification([item('A'), item('B'), item('C'), item('D')]);
  for (const p of [one, many]) {
    assert.ok(!p.title.includes('—'), `em dash in title: ${p.title}`);
    assert.ok(!p.body.includes('—'), `em dash in body: ${p.body}`);
  }
});

test('the shipped defaults are the ones the Privacy Policy promises', () => {
  // §7.4 states two per day, five per week, four hours apart, quiet 10pm-9am.
  // If any of these move, that document has to move with them.
  assert.equal(CAMPAIGN_CONFIG.dailyCap, 2);
  assert.equal(CAMPAIGN_CONFIG.weeklyCap, 5);
  assert.equal(CAMPAIGN_CONFIG.cooldownMinutes, 240);
  assert.equal(CAMPAIGN_CONFIG.quietStart, 22);
  assert.equal(CAMPAIGN_CONFIG.quietEnd, 9);
  // And the coalescing hold has to be non-zero, or there is no window in which
  // a second vendor's deal can join the first one's notification.
  assert.ok(CAMPAIGN_CONFIG.coalesceMinutes > 0);
  assert.ok(CAMPAIGN_CONFIG.bundleMax >= 2);
});

test('the durations the terminal offers are the ones the server accepts', () => {
  assert.deepEqual(CAMPAIGN_DURATIONS, [24, 72, 168]);
  assert.ok(CAMPAIGN_DURATIONS.includes(CAMPAIGN_CONFIG.defaultDurationHours)
    || CAMPAIGN_CONFIG.defaultDurationHours === 48);
});
