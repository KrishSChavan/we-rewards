// Shared setup for the DB-backed tests. These talk to a REAL Supabase project,
// so they are strictly opt-in: they read a SEPARATE set of env vars and skip
// themselves unless TEST_SUPABASE_URL is set. Point these at a DISPOSABLE
// project (a `supabase start` local stack, or a throwaway cloud project with
// schema.sql + every migration applied) — never your production/pilot DB.
//
//   TEST_SUPABASE_URL=...              # e.g. http://127.0.0.1:54321
//   TEST_SUPABASE_ANON_KEY=...
//   TEST_SUPABASE_SERVICE_ROLE_KEY=...
//
// Each test self-provisions a throwaway vendor + student and tears them down in
// an after() hook, so the tests are independent and leave no residue.
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

export const dbConfigured = Boolean(process.env.TEST_SUPABASE_URL);

const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
export const anonKey = process.env.TEST_SUPABASE_ANON_KEY;

// Service-role client (bypasses RLS) — only built when the suite is enabled.
export const admin = dbConfigured
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;

// A fresh anon-key client (role = anon until it signs in). Each caller gets its
// own so sign-ins don't clobber each other.
export const newAnonClient = () =>
  createClient(url, anonKey, { auth: { persistSession: false } });

const rand = () => randomUUID().slice(0, 8);

/** Insert a throwaway vendor. `pin` (optional) is bcrypt-hashed like onboarding. */
export async function createVendor({ pointsPerDollar = 10, pin = null } = {}) {
  const { data, error } = await admin
    .from('vendors')
    .insert({
      name: `Test Vendor ${rand()}`,
      slug: `test-vendor-${rand()}`,
      points_per_dollar: pointsPerDollar,
      pin_hash: pin ? await bcrypt.hash(String(pin), 10) : null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Create a throwaway auth user (+ its auto-created profile) and return it. */
export async function createUser({ password } = {}) {
  const email = `test-${rand()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: password ?? `Pw-${randomUUID()}`,
    email_confirm: true,
  });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

/** Link an auth user to a vendor as staff (for vendor-authenticated routes). */
export async function linkStaff(vendorId, userId) {
  const { error } = await admin
    .from('vendor_staff')
    .insert({ vendor_id: vendorId, user_id: userId, role: 'owner' });
  if (error) throw error;
}

/** Add a reward to a vendor. */
export async function createReward(vendorId, { title = 'Free drink', cost = 100 } = {}) {
  const { data, error } = await admin
    .from('rewards')
    .insert({ vendor_id: vendorId, title, cost_in_points: cost, emoji: '🥤' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Best-effort teardown: remove everything the test created, ignoring errors. */
export async function cleanup({ vendorId, userIds = [] } = {}) {
  try {
    if (vendorId) {
      await admin.from('transactions').delete().eq('vendor_id', vendorId);
      await admin.from('redeem_codes').delete().eq('vendor_id', vendorId);
      await admin.from('point_balances').delete().eq('vendor_id', vendorId);
      await admin.from('rewards').delete().eq('vendor_id', vendorId);
      await admin.from('vendor_pin_sessions').delete().eq('vendor_id', vendorId);
      await admin.from('vendors').delete().eq('id', vendorId);
    }
    for (const id of userIds) {
      await admin.from('transactions').delete().eq('user_id', id);
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  } catch { /* teardown is best-effort */ }
}
