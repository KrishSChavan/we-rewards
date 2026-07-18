// Security regression tests: lock in the two guarantees added by migration-007
// and the server-side PIN gate. Opt-in — skipped unless TEST_SUPABASE_URL is set.
//
//   1. The money RPCs (award_points, redeem_by_code) have EXECUTE revoked from
//      anon/authenticated, so a browser client can't mint or spend points.
//   2. A PIN-protected vendor route rejects a request with no X-Vendor-Pin.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbConfigured, admin, newAnonClient, createVendor, createUser, linkStaff, cleanup,
} from './helpers.js';

describe('security regressions', { skip: dbConfigured ? false : 'set TEST_SUPABASE_URL to run' }, () => {
  let vendor, student;

  before(async () => {
    vendor = await createVendor({ pointsPerDollar: 10, pin: '4321' });
    student = await createUser({ password: 'StudentPw123!' });
  });
  after(async () => cleanup({ vendorId: vendor?.id, userIds: [student?.id] }));

  test('the anon role cannot execute award_points', async () => {
    const anon = newAnonClient();
    const { error } = await anon.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 100, p_dollar_amount: 10,
    });
    assert.ok(error, 'award_points must be denied to anon');
  });

  test('a signed-in (authenticated) user cannot execute award_points or redeem_by_code', async () => {
    const client = newAnonClient();
    const { error: signInErr } = await client.auth.signInWithPassword({
      email: student.email, password: student.password,
    });
    assert.equal(signInErr, null, 'the student should be able to sign in');

    const award = await client.rpc('award_points', {
      p_user_id: student.id, p_vendor_id: vendor.id, p_points: 100, p_dollar_amount: 10,
    });
    assert.ok(award.error, 'award_points must be denied to authenticated');

    const redeem = await client.rpc('redeem_by_code', { p_code: '0000', p_vendor_id: vendor.id });
    assert.ok(redeem.error, 'redeem_by_code must be denied to authenticated');
  });

  test('a PIN-protected route rejects a request with no X-Vendor-Pin (401 PIN_REQUIRED)', async () => {
    // Point the app at the test project, then mount it on an ephemeral port.
    process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
    const { app } = await import('../../server.js');

    // A vendor-staff login with a valid JWT, but we deliberately omit the PIN.
    const owner = await createUser({ password: 'OwnerPw123!' });
    let listener;
    try {
      await linkStaff(vendor.id, owner.id);
      const client = newAnonClient();
      await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
      const { data: { session } } = await client.auth.getSession();

      listener = app.listen(0);
      const port = listener.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/vendor/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ code: '0000' }),
      });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'PIN_REQUIRED');
    } finally {
      listener?.close();
      await cleanup({ userIds: [owner.id] });
    }
  });

  // Per-vendor PIN lockout (migration-020): repeated wrong PINs lock the vendor
  // independent of source IP, and a correct PIN clears the counter. Driven
  // through the HTTP verify-pin route so the whole path is exercised.
  test('too many wrong PINs lock the vendor (429 PIN_LOCKED)', async () => {
    process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
    const { app } = await import('../../server.js');

    const lockVendor = await createVendor({ pointsPerDollar: 10, pin: '4321' });
    const owner = await createUser({ password: 'OwnerPw123!' });
    let listener;
    try {
      await linkStaff(lockVendor.id, owner.id);
      const client = newAnonClient();
      await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
      const { data: { session } } = await client.auth.getSession();
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };

      listener = app.listen(0);
      const port = listener.address().port;
      const verify = (pin) => fetch(`http://127.0.0.1:${port}/api/vendor/verify-pin`, {
        method: 'POST', headers, body: JSON.stringify({ pin }),
      });

      // Threshold is 5 (migration-020). The first four wrong PINs are 401 BAD_PIN;
      // the fifth trips the lock and returns 429 PIN_LOCKED.
      for (let i = 0; i < 4; i++) {
        const r = await verify('0000');
        assert.equal(r.status, 401, `wrong PIN #${i + 1} is a plain 401`);
        assert.equal((await r.json()).error, 'BAD_PIN');
      }
      const locked = await verify('0000');
      assert.equal(locked.status, 429, 'the 5th wrong PIN locks the vendor');
      assert.equal((await locked.json()).error, 'PIN_LOCKED');

      // While locked, even the CORRECT PIN is refused (the lock is checked first).
      const duringLock = await verify('4321');
      assert.equal(duringLock.status, 429, 'a correct PIN is refused while locked');
      assert.equal((await duringLock.json()).error, 'PIN_LOCKED');

      // Clearing the lock in the DB, the correct PIN works and resets the counter.
      await admin.from('vendors').update({ pin_locked_until: null, failed_pin_attempts: 0 }).eq('id', lockVendor.id);
      const ok = await verify('4321');
      assert.equal(ok.status, 200, 'the correct PIN unlocks once the window passes');
      assert.ok((await ok.json()).token, 'a PIN session token is minted');
    } finally {
      listener?.close();
      await cleanup({ vendorId: lockVendor.id, userIds: [owner.id] });
    }
  });

  // The operator kill-switch: a vendor with active=false is fully cut off at the
  // terminal. requireVendor gates every /api/vendor/* route, so /config — the
  // first call the terminal makes — is a faithful proxy for "the terminal works".
  test('a disabled vendor is cut off at the terminal (403 VENDOR_DISABLED)', async () => {
    process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
    const { app } = await import('../../server.js');

    const offVendor = await createVendor({ pointsPerDollar: 10 });
    const owner = await createUser({ password: 'OwnerPw123!' });
    let listener;
    try {
      await linkStaff(offVendor.id, owner.id);
      const client = newAnonClient();
      await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
      const { data: { session } } = await client.auth.getSession();
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      };

      listener = app.listen(0);
      const port = listener.address().port;
      const base = `http://127.0.0.1:${port}`;

      // While active, the terminal can read its config.
      const okRes = await fetch(`${base}/api/vendor/config`, { headers: authHeaders });
      assert.equal(okRes.status, 200, 'an active vendor can load its config');

      // Operator flips it off → every vendor route is now blocked.
      const { error: offErr } = await admin.from('vendors').update({ active: false }).eq('id', offVendor.id);
      assert.equal(offErr, null);

      const cfg = await fetch(`${base}/api/vendor/config`, { headers: authHeaders });
      assert.equal(cfg.status, 403);
      assert.equal((await cfg.json()).error, 'VENDOR_DISABLED');

      const award = await fetch(`${base}/api/vendor/award`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ code: '123456', exactAmount: 5 }),
      });
      assert.equal(award.status, 403, 'awarding is blocked while disabled');
      assert.equal((await award.json()).error, 'VENDOR_DISABLED');

      // Turning it back on restores access (non-destructive toggle).
      await admin.from('vendors').update({ active: true }).eq('id', offVendor.id);
      const back = await fetch(`${base}/api/vendor/config`, { headers: authHeaders });
      assert.equal(back.status, 200, 're-enabling restores the terminal');
    } finally {
      listener?.close();
      await cleanup({ vendorId: offVendor.id, userIds: [owner.id] });
    }
  });
});
