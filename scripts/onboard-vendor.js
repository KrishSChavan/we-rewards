/**
 * One-time vendor onboarding (you run this, not the vendor):
 *
 *   node scripts/onboard-vendor.js \
 *     --name "Local Eats" --slug local-eats \
 *     --email owner@example.com --password TempPass123! \
 *     --ratio 10 --pin 4321
 *
 * Creates: auth user for the vendor login, vendors row, vendor_staff link.
 * Default tiers are applied; edit them in the Supabase dashboard or add flags later.
 */
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ')]; })
);

const required = ['name', 'slug', 'email', 'password', 'ratio', 'pin'];
const missing = required.filter((k) => !args[k]);
if (missing.length) {
  console.error(`Missing flags: ${missing.map((m) => '--' + m).join(', ')}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
  email: args.email,
  password: args.password,
  email_confirm: true,
});
if (userErr) { console.error('Auth user failed:', userErr.message); process.exit(1); }

const { data: vendor, error: vendErr } = await supabase
  .from('vendors')
  .insert({
    name: args.name,
    slug: args.slug,
    points_per_dollar: Number(args.ratio),
    pin_hash: await bcrypt.hash(String(args.pin), 10),
  })
  .select()
  .single();
if (vendErr) { console.error('Vendor insert failed:', vendErr.message); process.exit(1); }

const { error: staffErr } = await supabase
  .from('vendor_staff')
  .insert({ vendor_id: vendor.id, user_id: userData.user.id, role: 'owner' });
if (staffErr) { console.error('Staff link failed:', staffErr.message); process.exit(1); }

console.log(`✓ Vendor "${vendor.name}" created (${vendor.id})`);
console.log(`✓ Terminal login: ${args.email}`);
console.log(`  Next: add rewards rows for this vendor in the Supabase dashboard.`);
