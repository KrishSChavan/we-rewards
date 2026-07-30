// Integration tests for the punch-card RPCs (migration-028) against a real
// (disposable) Supabase. Opt-in: skipped unless TEST_SUPABASE_URL is set (see
// helpers.js). Covers the once-per-night unique, card lifecycle (open → fill →
// complete → next card), the single-use redeem code, hold binding + atomicity,
// and the feature-off refusal.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbConfigured, admin, createVendor, createUser, cleanup,
} from './helpers.js';

// punch_in takes the scanned 30-second slot and derives the business night from
// it, so tests pick slots on real evenings rather than passing a date directly.
// 10pm ET on the given day = 02:00Z the next morning (summer, EDT).
const eveningWindow = (isoDate, hourUtc = 2, minuteUtc = 0) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d + 1, hourUtc, minuteUtc, 0) / 1000 / 30);
};

describe('punch cards (RPCs)', { skip: dbConfigured ? false : 'set TEST_SUPABASE_URL to run' }, () => {
  let vendor, student;

  before(async () => {
    vendor = await createVendor();
    student = await createUser();
    // profiles row (punch tables FK profiles): mirror what accept-terms creates
    await admin.from('profiles').upsert({ user_id: student.id, email: student.email, name: 'Punch Tester' });
    const { error } = await admin.from('vendors')
      .update({ punch_enabled: true, punch_target: 3, punch_reward: 'Free cover' })
      .eq('id', vendor.id);
    assert.equal(error, null);
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

  test('first punch opens a card; a second the same night is refused', async () => {
    const first = await punch('2026-07-01');
    assert.equal(first.error, null);
    assert.equal(first.data[0].new_punches, 1);
    assert.equal(first.data[0].card_target, 3);
    assert.equal(first.data[0].card_completed, false);
    assert.equal(first.data[0].reward_text, 'Free cover');
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

  test('punches across nights fill the card; the target snapshot completes it', async () => {
    const p2 = await punch('2026-07-02');
    assert.equal(p2.error, null);
    assert.equal(p2.data[0].new_punches, 2);
    assert.equal(p2.data[0].card_completed, false);

    const p3 = await punch('2026-07-03');
    assert.equal(p3.error, null);
    assert.equal(p3.data[0].new_punches, 3);
    assert.equal(p3.data[0].card_completed, true, 'third punch completes a 3-target card');
    assert.equal(p3.data[0].ready_cards, 1);

    // The next punch opens a FRESH card rather than touching the full one.
    const p4 = await punch('2026-07-04');
    assert.equal(p4.error, null);
    assert.equal(p4.data[0].new_punches, 1, 'a new card starts at 1');
    assert.equal(p4.data[0].ready_cards, 1, 'the completed card is still waiting');
  });

  test('a full card redeems exactly once via its 4-digit code', async () => {
    const { data: code, error: codeErr } = await admin.rpc('create_punch_redeem_code', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_ttl_seconds: 120,
    });
    assert.equal(codeErr, null);
    assert.match(code, /^\d{4}$/);

    const first = await admin.rpc('redeem_punch_card', { p_code: code, p_vendor_id: vendor.id });
    assert.equal(first.error, null);
    assert.equal(first.data[0].reward_text, 'Free cover');
    assert.equal(first.data[0].customer_id, student.id);

    const second = await admin.rpc('redeem_punch_card', { p_code: code, p_vendor_id: vendor.id });
    assert.ok(second.error, 'the second submit of the same code must fail');

    // No completed-unredeemed card remains → minting another code refuses.
    const again = await admin.rpc('create_punch_redeem_code', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_ttl_seconds: 120,
    });
    assert.ok(again.error);
    assert.match(again.error.message, /PUNCH_CARD_NOT_READY/);
  });

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
    const mint = () => admin.rpc('create_punch_hold', {
      p_vendor_id: vendor.id, p_token_window: window, p_ttl_seconds: 600, p_binding_hash: 'flood',
    });
    let refusal = null;
    for (let i = 0; i < 40 && !refusal; i += 1) {
      const res = await mint();
      if (res.error) refusal = res.error;
    }
    assert.ok(refusal, 'the per-slot cap must eventually refuse');
    assert.match(refusal.message, /HOLD_LIMIT/);
    await admin.from('punch_holds').delete().eq('vendor_id', vendor.id);
  });

  test('everything refuses when the vendor has punch cards off', async () => {
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
