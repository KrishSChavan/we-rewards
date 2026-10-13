// Preloaded before any test file (see the `test` script: `node --import ./test/setup.js`).
//
// src/lib/supabase.js throws at import time if SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are unset. The pure unit tests import that module
// transitively but never touch the network, so harmless placeholders are enough
// to let the module graph load. See the warning above the assignments below for
// why they are unconditional.
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
// ⚠ UNCONDITIONAL, not `||=`, AND THE DIFFERENCE IS AN INCIDENT. This block
// used to read `process.env.SUPABASE_URL ||= ...` with a comment claiming that
// respecting an already-exported value meant the unit tests "can't accidentally
// point at a live project". It is the exact opposite: `||=` means the suite
// inherits whatever happens to be in the shell, and on 2026-10-13 a developer
// loaded production config into their terminal to run `npm run check:resend`
// (`set -a; eval "$(heroku config -s -a we-rewards)"; set +a`) and then ran a
// deploy from the same shell. The deploy preflight runs `npm test`, so the whole
// unit suite executed against the PRODUCTION Supabase project with the service
// role key: it read real students by name and email, wrote seven junk rows into
// notification_log and left a bogus admin row in push_subscriptions. Thirty
// tests failed, which is the only reason anyone noticed.
//
// The DB-backed tests are unaffected by this: test/integration/* assign
// SUPABASE_URL = TEST_SUPABASE_URL themselves before they touch anything, and
// skip entirely when TEST_SUPABASE_URL is unset. So nothing is lost by refusing
// to honour an ambient value here, and a whole class of accident goes away.
process.env.SUPABASE_URL = 'http://unit-test-placeholder.invalid';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Every credential that lets a module reach the outside world, removed for the
// same reason and by the same incident. Each of these is read at MODULE SCOPE to
// compute an `enabled` flag (pushEnabled, emailEnabled, posthogEnabled, and the
// Gemini and Stripe equivalents), so a key present in the shell silently flips a
// no-op into a live client: real pushes to real devices, real mail, real
// analytics, real Gemini quota, real Stripe calls.
//
// Four tests already asserted their own flag was false with messages like "the
// test env must not carry a real RESEND_API_KEY". Those guards were right and
// they are kept, but a guard that FAILS after the damage is not the same as not
// being able to do the damage. This is the second half.
//
// Deleted rather than blanked: `delete` is what makes `process.env.X || ''`
// fall through, and it is also what a child process spawned with
// `{...process.env}` inherits the absence of -- which matters, because the
// worker tests in reminders/broadcasts/campaigns.test.js drive real module code
// in a child and would otherwise carry a live key into it.
//
// A test that WANTS one of these passes it explicitly (see MAIL_ON in
// test/reminders.test.js, or the VAPID pair runConfigured generates), which
// still works: an explicit value in the child's env wins over an absent one.
for (const key of [
  'RESEND_API_KEY',        // sends mail
  'VAPID_PUBLIC_KEY',      // sends push
  'VAPID_PRIVATE_KEY',
  'POSTHOG_API_KEY',       // sends analytics
  'GEMINI_API_KEY',        // spends receipt-scanning quota
  'STRIPE_SECRET_KEY',     // moves money
]) {
  delete process.env[key];
}
