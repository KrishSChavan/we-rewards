// Integration tests for the atomic money RPCs against a real (disposable)
// Supabase. Opt-in: the whole suite is skipped unless TEST_SUPABASE_URL is set
// (see helpers.js). Covers award, single-use redeem, rollback on insufficient
// balance, expired-code rejection, and the void/refund reversal (migration-010).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbConfigured, admin, createVendor, createUser, createReward, cleanup,
} from './helpers.js';

describe('money paths (RPCs)', { skip: dbConfigured ? false : 'set TEST_SUPABASE_URL to run' }, () => {
  let vendor, student;

  before(async () => {
    vendor = await createVendor({ pointsPerDollar: 10 });
    student = await createUser();
  });
  after(async () => cleanup({ vendorId: vendor?.id, userIds: [student?.id] }));

  async function balance() {
    const { data } = await admin
      .from('point_balances').select('balance')
      .eq('user_id', student.id).eq('vendor_id', vendor.id).maybeSingle();
    return data?.balance ?? 0;
  }

  test('award_points adds the right points and records a transaction', async () => {
    const before = await balance();
    const { data, error } = await admin.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 150, p_dollar_amount: 15,
    });
    assert.equal(error, null);
    assert.equal(data[0].new_balance, before + 150);

    const { data: tx } = await admin
      .from('transactions').select('type, points, dollar_amount')
      .eq('user_id', student.id).eq('vendor_id', vendor.id).eq('type', 'earn')
      .order('created_at', { ascending: false }).limit(1).single();
    assert.equal(tx.points, 150);
    assert.equal(Number(tx.dollar_amount), 15);
  });

  test('a redeem code is single-use: a double-submit only redeems once', async () => {
    const reward = await createReward(vendor.id, { cost: 50 });
    // ensure enough balance
    await admin.rpc('award_points', { p_user_id: student.id, p_vendor_id: vendor.id, p_points: 200, p_dollar_amount: 20 });
    const start = await balance();

    const { data: code } = await admin.rpc('create_redeem_code', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_reward_id: reward.id, p_ttl_seconds: 120,
    });

    const first = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(first.error, null);
    assert.equal(first.data[0].new_balance, start - 50);

    const second = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.ok(second.error, 'the second submit of the same code must fail');
    assert.equal(await balance(), start - 50, 'balance only moved once');
  });

  test('redeem with an insufficient balance rolls back and leaves the code live', async () => {
    const poor = await createUser();
    try {
      const reward = await createReward(vendor.id, { cost: 999999 });
      await admin.rpc('award_points', { p_user_id: poor.id, p_vendor_id: vendor.id, p_points: 10, p_dollar_amount: 1 });
      const { data: code } = await admin.rpc('create_redeem_code', {
        p_user_id: poor.id, p_vendor_id: vendor.id, p_reward_id: reward.id, p_ttl_seconds: 120,
      });

      const res = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
      assert.ok(res.error, 'insufficient balance must raise');
      assert.match(res.error.message, /INSUFFICIENT_POINTS/);

      // The whole transaction rolled back, INCLUDING the code's delete — so the
      // code is still live and a later (funded) redeem would succeed.
      const { data: still } = await admin.from('redeem_codes').select('code').eq('code', code).maybeSingle();
      assert.ok(still, 'the code survives a rolled-back redeem');
    } finally {
      await cleanup({ userIds: [poor.id] });
    }
  });

  test('an expired redeem code is rejected', async () => {
    const reward = await createReward(vendor.id, { cost: 10 });
    await admin.rpc('award_points', { p_user_id: student.id, p_vendor_id: vendor.id, p_points: 50, p_dollar_amount: 5 });
    const { data: code } = await admin.rpc('create_redeem_code', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_reward_id: reward.id, p_ttl_seconds: 120,
    });
    // force it into the past
    await admin.from('redeem_codes').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('code', code);

    const res = await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id });
    assert.ok(res.error, 'an expired code must be rejected');
  });

  test('reverse_transaction voids an award and refuses to double-reverse', async () => {
    // award, then reverse it
    const { data: awarded } = await admin.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 80, p_dollar_amount: 8,
    });
    const balAfterAward = awarded[0].new_balance;

    const { data: tx } = await admin
      .from('transactions').select('id, points')
      .eq('user_id', student.id).eq('vendor_id', vendor.id).eq('type', 'earn')
      .order('created_at', { ascending: false }).limit(1).single();

    const rev = await admin.rpc('reverse_transaction', { p_transaction_id: tx.id, p_vendor_id: vendor.id });
    assert.equal(rev.error, null);
    assert.equal(rev.data[0].new_balance, balAfterAward - 80, 'the 80 points are clawed back');

    // a compensating row exists and the original is marked reversed
    const { data: orig } = await admin.from('transactions').select('reversed_by').eq('id', tx.id).single();
    assert.ok(orig.reversed_by, 'the original links to its compensating row');

    const again = await admin.rpc('reverse_transaction', { p_transaction_id: tx.id, p_vendor_id: vendor.id });
    assert.ok(again.error, 'a transaction cannot be reversed twice');
  });

  test('reversing an award never drives the balance negative (clamped at zero)', async () => {
    const spender = await createUser();
    try {
      const reward = await createReward(vendor.id, { cost: 100 });
      // award 100, spend all 100, then void the original award
      const { data: aw } = await admin.rpc('award_points', {
        p_user_id: spender.id, p_vendor_id: vendor.id, p_points: 100, p_dollar_amount: 10,
      });
      assert.equal(aw[0].new_balance, 100);
      const { data: code } = await admin.rpc('create_redeem_code', {
        p_user_id: spender.id, p_vendor_id: vendor.id, p_reward_id: reward.id, p_ttl_seconds: 120,
      });
      await admin.rpc('redeem_by_code', { p_code: code, p_vendor_id: vendor.id }); // balance now 0

      const { data: earnTx } = await admin
        .from('transactions').select('id')
        .eq('user_id', spender.id).eq('vendor_id', vendor.id).eq('type', 'earn')
        .order('created_at', { ascending: false }).limit(1).single();

      const rev = await admin.rpc('reverse_transaction', { p_transaction_id: earnTx.id, p_vendor_id: vendor.id });
      assert.equal(rev.error, null);
      assert.equal(rev.data[0].new_balance, 0, 'balance clamps at 0, never negative');
    } finally {
      await cleanup({ userIds: [spender.id] });
    }
  });

  test('reverse_transaction refuses to undo a transaction older than one minute', async () => {
    await admin.rpc('award_points', { p_user_id: student.id, p_vendor_id: vendor.id, p_points: 40, p_dollar_amount: 4 });
    const { data: tx } = await admin
      .from('transactions').select('id')
      .eq('user_id', student.id).eq('vendor_id', vendor.id).eq('type', 'earn')
      .order('created_at', { ascending: false }).limit(1).single();

    // Backdate it past the 1-minute anti-abuse window.
    await admin.from('transactions')
      .update({ created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() })
      .eq('id', tx.id);

    const res = await admin.rpc('reverse_transaction', { p_transaction_id: tx.id, p_vendor_id: vendor.id });
    assert.ok(res.error, 'a stale transaction cannot be reversed');
    assert.match(res.error.message, /REVERSAL_EXPIRED/);
  });
});
