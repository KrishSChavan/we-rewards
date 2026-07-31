// Integration tests for punches as a second currency (migration-029) against a
// real (disposable) Supabase. Opt-in: skipped unless TEST_SUPABASE_URL is set
// (see helpers.js). Covers the once-per-night unique, the visit counter, the
// unified redeem code, spend-and-reset, undo reimbursement, hold binding +
// atomicity, and the feature-off refusal.
//
// The punch-IN half (rotating token, holds, business-day boundary) is unchanged
// from migration-028; those tests are kept verbatim in spirit because that flow
// is exactly what migration-029 promised not to touch.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbConfigured, admin, createVendor, createUser, createReward, cleanup,
} from './helpers.js';

// punch_in takes the scanned 30-second slot and derives the business night from
// it, so tests pick slots on real evenings rather than passing a date directly.
// 10pm ET on the given day = 02:00Z the next morning (summer, EDT).
const eveningWindow = (isoDate, hourUtc = 2, minuteUtc = 0) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d + 1, hourUtc, minuteUtc, 0) / 1000 / 30);
};

describe('punches as a currency (RPCs)', { skip: dbConfigured ? false : 'set TEST_SUPABASE_URL to run' }, () => {
  let vendor, student, cheap, dear, pointsOnly;

  before(async () => {
    vendor = await createVendor();
    student = await createUser();
    // profiles row (punch tables FK profiles): mirror what accept-terms creates
    await admin.from('profiles').upsert({ user_id: student.id, email: student.email, name: 'Punch Tester' });
    const { error } = await admin.from('vendors')
      .update({ punch_enabled: true })
      .eq('id', vendor.id);
    assert.equal(error, null);

    cheap = await createReward(vendor.id, { title: 'Free coffee', cost: 50, visits: 3 });
    dear = await createReward(vendor.id, { title: 'Free meal', cost: 500, visits: 15 });
    pointsOnly = await createReward(vendor.id, { title: 'Tote bag', cost: 200, visits: null });
  });
  after(async () => cleanup({ vendorId: vendor?.id, userIds: [student?.id] }));

  const punch = (isoDate, opts = {}) =>
    admin.rpc('punch_in', {
      p_user_id: opts.userId ?? student.id,
      p_vendor_id: opts.holdId ? null : vendor.id,
      p_token_window: opts.holdId ? null : eveningWindow(isoDate, opts.hourUtc, opts.minuteUtc),
      p_hold_id: opts.holdId ?? null,
      p_binding_hash: opts.binding ?? null,
      p_timezone: 'America/New_York',
    });

  const hold = (isoDate, binding = null) =>
    admin.rpc('create_punch_hold', {
      p_vendor_id: vendor.id,
      p_token_window: eveningWindow(isoDate),
      p_ttl_seconds: 600,
      p_binding_hash: binding,
    });

  const visitsOf = async (userId = student.id) => {
    const { data } = await admin.from('punch_cards')
      .select('punches').eq('user_id', userId).eq('vendor_id', vendor.id).maybeSingle();
    return data?.punches ?? 0;
  };

  const mint = (rewardId, paidWith = 'visits', userId = student.id) =>
    admin.rpc('create_redeem_code', {
      p_user_id: userId, p_vendor_id: vendor.id, p_reward_id: rewardId,
      p_paid_with: paidWith, p_ttl_seconds: 120,
    });

  /* ---------- punch in: unchanged by migration-029 ---------- */

  test('first punch starts the counter; a second the same night is refused', async () => {
    const first = await punch('2026-07-01');
    assert.equal(first.error, null);
    assert.equal(first.data[0].new_punches, 1);
    assert.equal(first.data[0].vendor_id, vendor.id);

    // Same night, a LATER token slot: still no second punch.
    const second = await punch('2026-07-01', { hourUtc: 3 });
    assert.ok(second.error, 'the once-per-night unique must refuse');
    assert.match(second.error.message, /ALREADY_PUNCHED/);
  });

  test('a punch after midnight still belongs to the same bar night', async () => {
    // 1:30am ET on Jul 2 = 05:30Z, which is Jul 1's night (6am boundary).
    const late = await punch('2026-07-01', { hourUtc: 5, minuteUtc: 30 });
    assert.ok(late.error, 'a 1:30am punch is the same night as the 11pm one');
    assert.match(late.error.message, /ALREADY_PUNCHED/);
  });

  test('the counter accumulates across nights and never resets on its own', async () => {
    for (const day of ['2026-07-02', '2026-07-03', '2026-07-04']) {
      const res = await punch(day);
      assert.equal(res.error, null);
    }
    assert.equal(await visitsOf(), 4, 'four nights, four punches, no card to roll over');
  });

  test('exactly one counter row per (student, vendor)', async () => {
    const { data } = await admin.from('punch_cards')
      .select('id').eq('user_id', student.id).eq('vendor_id', vendor.id);
    assert.equal(data.length, 1, 'migration-029 collapsed cards into a single counter');
  });

  /* ---------- minting: server-side re-verification (D7) ---------- */

  test('minting refuses when the counter is short, whatever the client claims', async () => {
    assert.equal(await visitsOf(), 4);
    const res = await mint(dear.id);            // needs 15
    assert.ok(res.error);
    assert.match(res.error.message, /INSUFFICIENT_VISITS/);
  });

  test('minting refuses a currency the reward is not priced in', async () => {
    const res = await mint(pointsOnly.id);      // no cost_in_visits
    assert.ok(res.error);
    assert.match(res.error.message, /REWARD_NOT_VISITS_PRICED/);
  });

  test('minting does NOT spend: an unused code costs the student nothing', async () => {
    const before = await visitsOf();
    const { data: code, error } = await mint(cheap.id);
    assert.equal(error, null);
    assert.match(code, /^\d{4}$/);
    assert.equal(await visitsOf(), before, 'the counter only moves at the counter');

    // Codes expire unspent all the time; that must not cost punches either.
    await admin.from('redeem_codes')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('code', code);
    assert.equal(await visitsOf(), before);
    await admin.from('redeem_codes').delete().eq('code', code);
  });

  test('one live code per (student, vendor) ACROSS both currencies', async () => {
    // Enough points to make the points mint legal too.
    const award = await admin.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 600, p_dollar_amount: 60,
    });
    assert.equal(award.error, null);

    const a = await mint(cheap.id, 'visits');
    assert.equal(a.error, null);
    const b = await mint(pointsOnly.id, 'points');
    assert.equal(b.error, null);

    const { data: live } = await admin.from('redeem_codes')
      .select('code, paid_with').eq('user_id', student.id).eq('vendor_id', vendor.id);
    assert.equal(live.length, 1, 'the second mint replaces the first, never coexists');
    assert.equal(live[0].paid_with, 'points', 'the survivor is the one minted last');
    assert.notEqual(a.data, b.data, 'and it is a different code');
    await admin.from('redeem_codes').delete().eq('user_id', student.id);
  });

  /* ---------- burning: spend, reset, and reimburse ---------- */

  test('burning resets the counter to 0 and records what was forfeited', async () => {
    // Bank a surplus: 3 needed, more than 3 held.
    const have = await visitsOf();
    assert.ok(have > cheap.cost_in_visits, `expected a surplus, had ${have}`);

    const { data: code, error: mintErr } = await mint(cheap.id);
    assert.equal(mintErr, null);

    const burn = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(burn.error, null);
    assert.equal(burn.data[0].paid_with, 'visits');
    assert.equal(burn.data[0].visits_left, 0);
    assert.equal(burn.data[0].reward_title, 'Free coffee');
    assert.equal(await visitsOf(), 0, 'reset to zero regardless of the price');

    const { data: tx } = await admin.from('transactions')
      .select('type, points, paid_with, visits_spent')
      .eq('user_id', student.id).eq('paid_with', 'visits')
      .order('created_at', { ascending: false }).limit(1).single();
    assert.equal(tx.type, 'redeem');
    assert.equal(tx.points, 0, 'a punch redemption moves no points');
    assert.equal(tx.visits_spent, have, 'the WHOLE pre-burn count is the forfeit');
  });

  test('the same code cannot be burned twice', async () => {
    await punch('2026-07-05');
    await punch('2026-07-06');
    await punch('2026-07-07');
    const { data: code } = await mint(cheap.id);
    const first = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(first.error, null);
    const second = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.ok(second.error, 'delete..returning is the single-use gate');
    assert.match(second.error.message, /CODE_INVALID/);
  });

  test('a burn that loses the race refuses AND rolls the code deletion back', async () => {
    await punch('2026-07-08');
    await punch('2026-07-09');
    await punch('2026-07-10');
    const { data: code } = await mint(cheap.id);

    // Something drains the counter between mint and burn.
    await admin.from('punch_cards')
      .update({ punches: 0 }).eq('user_id', student.id).eq('vendor_id', vendor.id);

    const burn = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.ok(burn.error);
    assert.match(burn.error.message, /INSUFFICIENT_VISITS/);

    const { data: still } = await admin.from('redeem_codes').select('code').eq('code', code).maybeSingle();
    assert.ok(still, 'a failed burn must not eat the code');
    await admin.from('redeem_codes').delete().eq('code', code);
  });

  test('undo ADDS punches back, so one earned in between survives', async () => {
    await admin.from('punch_cards')
      .update({ punches: 12 }).eq('user_id', student.id).eq('vendor_id', vendor.id);

    const { data: code } = await mint(cheap.id);
    const burn = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(burn.error, null);
    assert.equal(await visitsOf(), 0);

    // A punch lands before anyone hits undo.
    await punch('2026-07-11');
    assert.equal(await visitsOf(), 1);

    const { data: tx } = await admin.from('transactions')
      .select('id').eq('user_id', student.id).eq('paid_with', 'visits')
      .order('created_at', { ascending: false }).limit(1).single();

    const undo = await admin.rpc('reverse_transaction', {
      p_transaction_id: tx.id, p_vendor_id: vendor.id,
    });
    assert.equal(undo.error, null);
    assert.equal(undo.data[0].paid_with, 'visits');
    assert.equal(undo.data[0].restored_visits, 12);
    assert.equal(await visitsOf(), 13, 'add-back, not set: 1 + 12, never 12');
  });

  /* ---------- the points path is untouched ---------- */

  test('a points redemption still deducts points and leaves punches alone', async () => {
    // point_balances is guarded by migration-025, so it can only be seeded
    // through the RPC — a direct upsert is refused by the write-guard trigger.
    const award = await admin.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 400, p_dollar_amount: 40,
    });
    assert.equal(award.error, null);

    await admin.from('punch_cards')
      .update({ punches: 7 }).eq('user_id', student.id).eq('vendor_id', vendor.id);
    const balBefore = award.data[0].new_balance;

    const { data: code, error } = await mint(pointsOnly.id, 'points');
    assert.equal(error, null);
    const burn = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(burn.error, null);
    assert.equal(burn.data[0].paid_with, 'points');
    assert.equal(burn.data[0].new_balance, balBefore - pointsOnly.cost_in_points);
    assert.equal(await visitsOf(), 7, 'paying with points must not touch the counter');

    const { data: tx } = await admin.from('transactions')
      .select('points, paid_with, visits_spent')
      .eq('user_id', student.id).eq('paid_with', 'points')
      .order('created_at', { ascending: false }).limit(1).single();
    assert.equal(tx.points, -pointsOnly.cost_in_points);
    assert.equal(tx.visits_spent, null);
  });

  /* ---------- pricing constraint ---------- */

  test('a reward must carry at least one price', async () => {
    const { error } = await admin.from('rewards')
      .insert({ vendor_id: vendor.id, title: 'Priceless', cost_in_points: null, cost_in_visits: null, emoji: '❓' });
    assert.ok(error, 'rewards_has_a_price must refuse');
  });

  test('points-only and punches-only rewards are both legal', async () => {
    const a = await admin.from('rewards')
      .insert({ vendor_id: vendor.id, title: 'Points only', cost_in_points: 10, cost_in_visits: null, emoji: '🥤' })
      .select().single();
    assert.equal(a.error, null);
    const b = await admin.from('rewards')
      .insert({ vendor_id: vendor.id, title: 'Punches only', cost_in_points: null, cost_in_visits: 4, emoji: '🎒' })
      .select().single();
    assert.equal(b.error, null);
  });

  /* ---------- holds: unchanged by migration-029 ---------- */

  test('a hold is bound to its browser and single-use', async () => {
    const other = await createUser();
    try {
      await admin.from('profiles').upsert({ user_id: other.id, email: other.email, name: 'Hold Tester' });
      const { data: holdId, error } = await hold('2026-08-01', 'binding-abc');
      assert.equal(error, null);

      // Forwarded holdId, wrong binding (someone else's browser): refused.
      const wrong = await punch(null, { userId: other.id, holdId, binding: 'binding-xyz' });
      assert.ok(wrong.error);
      assert.match(wrong.error.message, /HOLD_INVALID/);

      // Forwarded holdId, no binding at all: refused.
      const none = await punch(null, { userId: other.id, holdId });
      assert.ok(none.error);
      assert.match(none.error.message, /HOLD_INVALID/);

      // Those refusals rolled back, so the real owner can still claim it.
      const ok = await punch(null, { userId: other.id, holdId, binding: 'binding-abc' });
      assert.equal(ok.error, null);
      assert.equal(ok.data[0].vendor_id, vendor.id, 'the vendor comes from the hold, not the caller');

      // ...and the claim consumed it.
      const replay = await punch(null, { userId: other.id, holdId, binding: 'binding-abc' });
      assert.ok(replay.error);
      assert.match(replay.error.message, /HOLD_INVALID/);
    } finally {
      await cleanup({ userIds: [other.id] });
    }
  });

  test('a refused punch does NOT burn the hold (claim and punch are one transaction)', async () => {
    // The student already punched on 2026-07-04, so this claim raises
    // ALREADY_PUNCHED — and must roll the hold's consumption back with it.
    const { data: holdId } = await hold('2026-07-04', 'binding-keep');
    const refused = await punch(null, { holdId, binding: 'binding-keep' });
    assert.ok(refused.error);
    assert.match(refused.error.message, /ALREADY_PUNCHED/);

    const { data: still } = await admin.from('punch_holds').select('id').eq('id', holdId).maybeSingle();
    assert.ok(still, 'the hold survives a refused punch, so a retry is possible');
    await admin.from('punch_holds').delete().eq('id', holdId);
  });

  test('an expired hold is rejected', async () => {
    const { data: holdId } = await hold('2026-08-02', 'binding-old');
    await admin.from('punch_holds')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', holdId);
    const res = await punch(null, { holdId, binding: 'binding-old' });
    assert.ok(res.error);
    assert.match(res.error.message, /HOLD_INVALID/);
  });

  test('one token slot can only mint a bounded number of holds', async () => {
    const window = eveningWindow('2026-09-01');
    const mintHold = () => admin.rpc('create_punch_hold', {
      p_vendor_id: vendor.id, p_token_window: window, p_ttl_seconds: 600, p_binding_hash: 'flood',
    });
    let refusal = null;
    for (let i = 0; i < 40 && !refusal; i += 1) {
      const res = await mintHold();
      if (res.error) refusal = res.error;
    }
    assert.ok(refusal, 'the per-slot cap must eventually refuse');
    assert.match(refusal.message, /HOLD_LIMIT/);
    await admin.from('punch_holds').delete().eq('vendor_id', vendor.id);
  });

  test('everything refuses when the vendor has punches off', async () => {
    const off = await createVendor();
    const bystander = await createUser();
    try {
      await admin.from('profiles').upsert({ user_id: bystander.id, email: bystander.email, name: 'Bystander' });

      const p = await admin.rpc('punch_in', {
        p_user_id: bystander.id, p_vendor_id: off.id, p_token_window: eveningWindow('2026-07-01'),
        p_hold_id: null, p_binding_hash: null, p_timezone: 'America/New_York',
      });
      assert.ok(p.error);
      assert.match(p.error.message, /PUNCH_DISABLED/);

      const h = await admin.rpc('create_punch_hold', {
        p_vendor_id: off.id, p_token_window: 1, p_ttl_seconds: 600, p_binding_hash: null,
      });
      assert.ok(h.error);
      assert.match(h.error.message, /PUNCH_DISABLED/);
    } finally {
      await cleanup({ vendorId: off.id, userIds: [bystander.id] });
    }
  });
});
