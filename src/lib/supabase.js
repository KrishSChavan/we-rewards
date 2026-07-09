import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env');
}

// Server-side client. Bypasses RLS — never expose this key to the browser.
export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

// Used only to verify user JWTs sent from the browser.
export const supabaseAuth = createClient(url, anonKey, {
  auth: { persistSession: false },
});
