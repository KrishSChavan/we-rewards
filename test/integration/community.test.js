// Integration tests for the community-points engine (migrations 026 + 027)
// against a real (disposable) Supabase. Opt-in: the whole suite is skipped
// unless TEST_SUPABASE_URL is set (see helpers.js). Covers the step-7 checklist
// of community-points.md: the 10% mint (floor, idempotency, daily cap, inactive
// vendors), the reversal unwind (both columns, clamped), the one-way transfer
// (exact move, insufficient funds, ineligible vendors, the monthly inbound cap,
// no vendor undo), and the migration-025 guard on the new money table.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbConfigured, admin, createVendor, createUser, cleanup,
} from './helpers.js';

describe('community points (mint + transfer RPCs)', { skip: dbConfigured ? false : 'set TEST_SUPABASE_URL to run' }, () => {
  let vendorA, vendorB, student;

  before(async () => {
    vendorA = await createVendor({ pointsPerDollar: 10 });
    vendorB = await createVendor({ pointsPerDollar: 10 });
    student = await createUser();
  });
  after(async () => {
    await cleanup({ vendorId: vendorA?.id, userIds: [student?.id] });
    await cleanup({ vendorId: vendorB?.id });
  });

  const community = async (userId = student.id) => {
    const { data } = await admin
      .from('community_balances').select('balance, lifetime_earned')
      .eq('user_id', userId).maybeSingle();
    return data ?? { balance: 0, lifetime_earned: 0 };
  };
  const vendorBalance = async (vendorId, userId = student.id) => {
    const { data } = await admin
      .from('point_balances').select('balance')
      .eq('user_id', userId).eq('vendor_id', vendorId).maybeSingle();
    return data?.balance ?? 0;
  };
  const award = (points, { userId = student.id, vendorId = vendorA.id, token = null } = {}) =>
    admin.rpc('award_points', {
      p_user_id: userId, p_vendor_id: vendorId, p_points: points,
      p_dollar_amount: points / 10, p_client_token: token,
    });
  const transfer = (amount, { userId = student.id, vendorId = vendorB.id, token = null } = {}) =>
    admin.rpc('transfer_community_points', {
      p_user_id: userId, p_vendor_id: vendorId, p_amount: amount, p_client_token: token,
    });

  /* ---------- the mint (migration-026) ---------- */

  test('award_points mints floor(points × 10%): 9 mints 0, 10 mints 1', async () => {
    const start = (await community()).balance;

    const nine = await award(9);
    assert.equal(nine.error, null);
    assert.equal(nine.data[0].new_community, start, '9 points mints nothing');

    const ten = await award(10);
    assert.equal(ten.error, null);
    assert.equal(ten.data[0].new_community, start + 1, '10 points mints exactly 1');

    const big = await award(150);
    assert.equal(big.error, null);
    assert.equal(big.data[0].new_community, start + 1 + 15, '150 points mints 15');

    const cb = await community();
    assert.equal(cb.balance, start + 16);
    assert.equal(cb.lifetime_earned, cb.balance, 'nothing transferred/reversed yet');

    // The mint rides on the earn's own row.
    const { data: tx } = await admin
      .from('transactions').select('community_points')
      .eq('user_id', student.id).eq('vendor_id', vendorA.id).eq('type', 'earn')
      .order('created_at', { ascending: false }).limit(1).single();
    assert.equal(tx.community_points, 15);
  });

  test('a repeated client_token mints once', async () => {
    const token = `ct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const start = (await community()).balance;

    const first = await award(100, { token });
    assert.equal(first.error, null);
    assert.equal(first.data[0].new_community, start + 10);

    const second = await award(100, { token });
    assert.equal(second.error, null);
    assert.equal(second.data[0].new_community, start + 10, 'the retry mints nothing more');
    assert.equal((await community()).balance, start + 10);
  });

  test('daily mint cap: past 200 community points/day the mint stops, vendor points still land in full', async () => {
    const capped = await createUser();
    try {
      // 2000 award-points = 200 community points — exactly the daily cap.
      await award(1000, { userId: capped.id });
      await award(1000, { userId: capped.id });
      assert.equal((await community(capped.id)).balance, 200);

      const over = await award(500, { userId: capped.id });
      assert.equal(over.error, null);
      assert.equal(over.data[0].new_community, 200, 'the mint is capped...');
      assert.equal(over.data[0].new_balance, 2500, '...but the vendor points land in full');
      assert.equal((await community(capped.id)).balance, 200);
    } finally {
      await cleanup({ userIds: [capped.id] });
    }
  });

  test('an award at an inactive vendor mints 0 community points (vendor points still land)', async () => {
    const hidden = await createVendor({ pointsPerDollar: 10 });
    try {
      await admin.from('vendors').update({ active: false }).eq('id', hidden.id);
      const res = await award(100, { vendorId: hidden.id });
      assert.equal(res.error, null);
      assert.equal(res.data[0].new_balance, 100, 'the vendor award is untouched');

      const { data: tx } = await admin
        .from('transactions').select('community_points')
        .eq('user_id', student.id).eq('vendor_id', hidden.id).eq('type', 'earn')
        .single();
      assert.equal(tx.community_points, 0, 'only the community 10% is withheld');
    } finally {
      await cleanup({ vendorId: hidden.id });
    }
  });

  test('reverse_transaction unwinds the mint from balance AND lifetime_earned, clamped at 0', async () => {
    const undoer = await createUser();
    try {
      const { data: aw } = await award(100, { userId: undoer.id });
      assert.equal(aw[0].new_community, 10);

      // Move the 10 away FIRST, then void the earn — the one place the ledger
      // clamp can fire (community-points.md step 2's edge case).
      const mv = await transfer(10, { userId: undoer.id });
      assert.equal(mv.error, null);
      assert.equal((await community(undoer.id)).balance, 0);
      assert.equal((await community(undoer.id)).lifetime_earned, 10, 'transfers never touch lifetime');

      const { data: earnTx } = await admin
        .from('transactions').select('id')
        .eq('user_id', undoer.id).eq('vendor_id', vendorA.id).eq('type', 'earn')
        .single();
      const rev = await admin.rpc('reverse_transaction', { p_transaction_id: earnTx.id, p_vendor_id: vendorA.id });
      assert.equal(rev.error, null);

      const cb = await community(undoer.id);
      assert.equal(cb.balance, 0, 'clamped — the moved points were already gone');
      assert.equal(cb.lifetime_earned, 0, 'a voided earn was never really earned');
    } finally {
      await cleanup({ userIds: [undoer.id] });
    }
  });

  /* ---------- the transfer (migration-027) ---------- */

  test('a transfer of 80 moves exactly 80: community −80, vendor B +80, vendor A untouched', async () => {
    await award(1000);   // fund the pool (+100 community)
    const startCb = (await community()).balance;
    const startA = await vendorBalance(vendorA.id);
    const startB = await vendorBalance(vendorB.id);
    assert.ok(startCb >= 80, `test needs 80 community points, has ${startCb}`);

    const res = await transfer(80);
    assert.equal(res.error, null);
    assert.equal(res.data[0].new_community, startCb - 80);
    assert.equal(res.data[0].new_vendor_balance, startB + 80);
    assert.equal(await vendorBalance(vendorA.id), startA, 'the issuing vendor is untouched');

    // The ledger row: +80 vendor points, −80 community points, one row.
    const { data: tx } = await admin
      .from('transactions').select('points, community_points')
      .eq('user_id', student.id).eq('vendor_id', vendorB.id).eq('type', 'community_transfer')
      .order('created_at', { ascending: false }).limit(1).single();
    assert.equal(tx.points, 80);
    assert.equal(tx.community_points, -80);
  });

  test('a repeated transfer client_token moves once', async () => {
    const token = `mv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startCb = (await community()).balance;
    assert.ok(startCb >= 10, `test needs 10 community points, has ${startCb}`);

    const first = await transfer(5, { token });
    assert.equal(first.error, null);
    assert.equal(first.data[0].new_community, startCb - 5);

    const second = await transfer(5, { token });
    assert.equal(second.error, null);
    assert.equal(second.data[0].new_community, startCb - 5, 'the retry moves nothing more');
    assert.equal((await community()).balance, startCb - 5);
  });

  test('insufficient community points → INSUFFICIENT_POINTS, nothing moves', async () => {
    const startCb = (await community()).balance;
    const startB = await vendorBalance(vendorB.id);

    const res = await transfer(startCb + 1);
    assert.ok(res.error, 'must raise');
    assert.match(res.error.message, /INSUFFICIENT_POINTS/);
    assert.equal((await community()).balance, startCb, 'community balance unchanged');
    assert.equal(await vendorBalance(vendorB.id), startB, 'vendor balance unchanged (the credit rolled back)');
  });

  test('a transfer to an inactive or opted-out vendor → VENDOR_INELIGIBLE', async () => {
    const target = await createVendor({ pointsPerDollar: 10 });
    try {
      await admin.from('vendors').update({ accepts_community_points: false }).eq('id', target.id);
      const optedOut = await transfer(1, { vendorId: target.id });
      assert.ok(optedOut.error);
      assert.match(optedOut.error.message, /VENDOR_INELIGIBLE/);

      await admin.from('vendors').update({ accepts_community_points: true, active: false }).eq('id', target.id);
      const inactive = await transfer(1, { vendorId: target.id });
      assert.ok(inactive.error);
      assert.match(inactive.error.message, /VENDOR_INELIGIBLE/);
    } finally {
      await cleanup({ vendorId: target.id });
    }
  });

  test('the monthly inbound cap stops a transfer that would exceed it → VENDOR_CAP_REACHED', async () => {
    const capped = await createVendor({ pointsPerDollar: 10 });
    try {
      await admin.from('vendors').update({ community_monthly_cap: 100 }).eq('id', capped.id);
      assert.ok((await community()).balance >= 100, 'test needs 100 community points');

      const ok = await transfer(80, { vendorId: capped.id });
      assert.equal(ok.error, null, '80 of 100 is fine');

      const over = await transfer(30, { vendorId: capped.id });
      assert.ok(over.error, '80 + 30 > 100 must raise');
      assert.match(over.error.message, /VENDOR_CAP_REACHED/);

      const exact = await transfer(20, { vendorId: capped.id });
      assert.equal(exact.error, null, 'filling the cap exactly is allowed');
    } finally {
      await cleanup({ vendorId: capped.id });
    }
  });

  test('reverse_transaction on a transfer row → CANNOT_REVERSE_TRANSFER, both balances untouched', async () => {
    assert.ok((await community()).balance >= 5, 'test needs 5 community points');
    const res = await transfer(5);
    assert.equal(res.error, null);
    const cbAfter = (await community()).balance;
    const bAfter = await vendorBalance(vendorB.id);

    const { data: tx } = await admin
      .from('transactions').select('id')
      .eq('user_id', student.id).eq('vendor_id', vendorB.id).eq('type', 'community_transfer')
      .order('created_at', { ascending: false }).limit(1).single();

    const rev = await admin.rpc('reverse_transaction', { p_transaction_id: tx.id, p_vendor_id: vendorB.id });
    assert.ok(rev.error, 'a transfer is the student’s move — the vendor cannot undo it');
    assert.match(rev.error.message, /CANNOT_REVERSE_TRANSFER/);
    assert.equal((await community()).balance, cbAfter);
    assert.equal(await vendorBalance(vendorB.id), bAfter);
  });

  /* ---------- the migration-025 guard, extended (migration-026) ---------- */

  test('a direct service-role write to community_balances is rejected by the guard trigger', async () => {
    const res = await admin
      .from('community_balances')
      .update({ balance: 999999 })
      .eq('user_id', student.id);
    assert.ok(res.error, 'only the RPCs (which set app.points_write) may write this table');
  });
});
