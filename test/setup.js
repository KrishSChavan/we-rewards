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
//
// The URL used to be http://localhost:54321 — the default port `supabase start`
// listens on. That is not a placeholder, it is the address of a real server on
// any machine that happens to have the local stack running (as it does on this
// one, for days at a stretch). The seo.test.js routes that exercise the
// catalogue-read-fails path (`/sitemap.xml`, `/spots`) got real requests to a
// live Kong instead of an immediate refusal, and a request carrying this file's
// non-JWT key string hangs there instead of 401ing (Kong never even logs it) —
// undici's fetch waits out its 300s headers timeout before failing, which reads
// as the whole test file hanging with no failing assertion to point at. `.invalid`
// is the RFC 2606 TLD reserved to never resolve, so this fails on DNS lookup in
// under a second regardless of what is or isn't running on the developer's
// machine.
process.env.SUPABASE_URL ||= 'http://unit-test-placeholder.invalid';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
