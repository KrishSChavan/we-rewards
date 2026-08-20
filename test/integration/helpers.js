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
import { TERMS_VERSION } from '../../src/lib/terms.js';

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

/**
 * Create a throwaway auth user AND its profile row, and return it.
 *
 * The profile is written explicitly. It used to be created by a trigger on
 * auth.users, and this helper's comment said so for a long time after
 * migration-022 deleted that trigger (deliberately: a profile row is the record
 * of consent, and a trigger would have manufactured consent for anyone who
 * merely authenticated). Without it, every RPC that writes a balance fails on
 * point_balances' foreign key to profiles, `data` comes back null, and the
 * whole money and community suites die at their first assertion with
 * "Cannot read properties of null" — 18 tests that looked like a schema drift
 * and were actually this one missing insert.
 *
 * Consent is stamped as current, because these tests are exercising the money
 * paths, not the consent gate; a test that wants a stale-consent user should
 * write that row itself.
 */
export async function createUser({ password } = {}) {
  const email = `test-${rand()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: password ?? `Pw-${randomUUID()}`,
    email_confirm: true,
  });
  if (error) throw error;

  const { error: pErr } = await admin.from('profiles').insert({
    user_id: data.user.id,
    email,
    name: 'Test Student',
    terms_accepted_at: new Date().toISOString(),
    terms_version: TERMS_VERSION,
  });
  if (pErr) throw pErr;

  return { id: data.user.id, email, password };
}

/** Link an auth user to a vendor as staff (for vendor-authenticated routes). */
export async function linkStaff(vendorId, userId) {
  const { error } = await admin
    .from('vendor_staff')
    .insert({ vendor_id: vendorId, user_id: userId, role: 'owner' });
  if (error) throw error;
}

/**
 * Add a reward to a vendor. Either price may be null (migration-029), but the
 * DB's rewards_has_a_price CHECK requires at least one, so `cost: null` is only
 * legal alongside a `visits` price.
 */
export async function createReward(vendorId, { title = 'Free drink', cost = 100, visits = null } = {}) {
  const { data, error } = await admin
    .from('rewards')
    .insert({ vendor_id: vendorId, title, cost_in_points: cost, cost_in_visits: visits, emoji: '🥤' })
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
