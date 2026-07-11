// Preloaded before any test file (see the `test` script: `node --import ./test/setup.js`).
//
// src/lib/supabase.js throws at import time if SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are unset. The pure unit tests import that module
// transitively but never touch the network, so harmless placeholders are enough
// to let the module graph load. `||=` means we never overwrite real values a
// developer or CI already exported — so this can't accidentally point unit tests
// at a live project either.
//
// The DB-backed integration/security tests use a SEPARATE set of variables
// (TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY / TEST_SUPABASE_SERVICE_ROLE_KEY)
// and skip themselves entirely when TEST_SUPABASE_URL is unset — so they never
// hit these placeholders and never hit your real .env project by accident.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
