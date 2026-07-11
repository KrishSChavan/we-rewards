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
});
