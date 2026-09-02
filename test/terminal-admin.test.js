// Unit tests for the operator's vendor-terminal login (src/lib/terminal-admin.js):
// one env-configured email+password that can open ANY vendor's till at /terminal
// and work it as that vendor.
//
// Three pure pieces carry the whole feature and none of them needs a database:
//
//   • terminalAdminConfig reads the two env vars and decides whether the feature
//     is on at all. Its refusals are what stop a weak or half-set credential
//     from ever guarding every shop on the platform.
//   • isTerminalAdmin decides whether a signed-in account IS that operator. It
//     is the branch at the top of requireVendor, so a false positive here hands
//     out every till in the app — which is why the unconfigured cases below are
//     the most load-bearing tests in this file.
//   • chooseAdminVendorId decides WHICH vendor the request is about. Getting it
//     wrong doesn't 500, it rings a real sale up at a business nobody picked —
//     the same reason chooseVendorLink is pulled out and tested branch by branch
//     in test/multi-location.test.js.
//
// Deliberately driven through an `env` argument rather than process.env, so
// every branch is reachable without mutating global state a parallel test could
// observe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  terminalAdminConfig,
  isTerminalAdmin,
  chooseAdminVendorId,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  ensureTerminalAdmin,
  ADMIN_FLAG,
  terminalAdminBootVerdict,
  resetTerminalAdminBootVerdict,
} from '../src/lib/terminal-admin.js';

const PASSWORD = 'x'.repeat(MIN_PASSWORD_LENGTH);
const ON = { TERMINAL_ADMIN_EMAIL: 'ops@example.com', TERMINAL_ADMIN_PASSWORD: PASSWORD };

/* ---------- switched off is the default, and it is a real off ---------- */

test('neither var set = not configured, and null is distinct from an error', () => {
  assert.equal(terminalAdminConfig({}), null);
  assert.equal(terminalAdminConfig({ TERMINAL_ADMIN_EMAIL: '', TERMINAL_ADMIN_PASSWORD: '' }), null);
});

test('half-configured is an ERROR, never a silent off', () => {
  // Answering null here would look exactly like "switched off", and the operator
  // would spend the afternoon wondering why a password they set doesn't work.
  assert.match(terminalAdminConfig({ TERMINAL_ADMIN_PASSWORD: PASSWORD }).error, /EMAIL is not/);
  assert.match(terminalAdminConfig({ TERMINAL_ADMIN_EMAIL: 'ops@example.com' }).error, /PASSWORD is not/);
});

/* ---------- the password rules ---------- */

test('a short password switches the feature OFF rather than being accepted', () => {
  // Sign-in goes to Supabase GoTrue, not to this app, so none of the
  // express-rate-limit ceilings in server.js apply to guessing this string.
  const cfg = terminalAdminConfig({ ...ON, TERMINAL_ADMIN_PASSWORD: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) });
  assert.match(cfg.error, new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
  assert.equal(cfg.email, undefined);
});

test('exactly MIN_PASSWORD_LENGTH is allowed (boundary)', () => {
  assert.equal(terminalAdminConfig(ON).error, undefined);
  assert.equal(terminalAdminConfig(ON).email, 'ops@example.com');
});

test('over MAX_PASSWORD_LENGTH is refused, since bcrypt would ignore the tail', () => {
  const long = 'x'.repeat(MAX_PASSWORD_LENGTH + 1);
  assert.match(terminalAdminConfig({ ...ON, TERMINAL_ADMIN_PASSWORD: long }).error, /72 characters or fewer/);
  assert.equal(terminalAdminConfig({ ...ON, TERMINAL_ADMIN_PASSWORD: 'x'.repeat(MAX_PASSWORD_LENGTH) }).error, undefined);
});

test('an address with no @ is refused', () => {
  assert.match(terminalAdminConfig({ ...ON, TERMINAL_ADMIN_EMAIL: 'ops' }).error, /not an email/);
});

test('the email is normalised (trimmed, lower-cased) so config and token agree', () => {
  const cfg = terminalAdminConfig({ ...ON, TERMINAL_ADMIN_EMAIL: '  OPS@Example.COM  ' });
  assert.equal(cfg.email, 'ops@example.com');
});

test('the password is NOT trimmed — leading/trailing space is part of a secret', () => {
  const pw = ` ${'x'.repeat(MIN_PASSWORD_LENGTH)} `;
  assert.equal(terminalAdminConfig({ ...ON, TERMINAL_ADMIN_PASSWORD: pw }).password, pw);
});

/* ---------- isTerminalAdmin: the branch that hands out every till ---------- */

test('UNCONFIGURED never matches, whatever the account says its email is', () => {
  // The one that matters most. A bare `email === process.env.TERMINAL_ADMIN_EMAIL`
  // answers TRUE for '' against an unset var — and '' is exactly what an
  // anonymous or address-less session carries — which would give every token
  // holder in the world every vendor terminal on the platform.
  for (const candidate of ['', null, undefined, 'ops@example.com', 'anyone@example.com']) {
    assert.equal(isTerminalAdmin(candidate, {}), false, `should refuse ${JSON.stringify(candidate)}`);
  }
});

test('a MISCONFIGURED deployment is not an admin either', () => {
  // A four-character password gets the feature switched off, not a
  // four-character password guarding every shop.
  const weak = { ...ON, TERMINAL_ADMIN_PASSWORD: 'abcd' };
  assert.equal(isTerminalAdmin('ops@example.com', weak), false);
});

test('the configured address matches, case- and whitespace-insensitively', () => {
  for (const candidate of ['ops@example.com', 'OPS@EXAMPLE.COM', '  Ops@Example.com  ']) {
    assert.equal(isTerminalAdmin(candidate, ON), true, `should accept ${JSON.stringify(candidate)}`);
  }
});

test('any other address is not the operator', () => {
  for (const candidate of ['', null, undefined, 'ops@example.co', 'xops@example.com', 'ops@example.com.evil.com']) {
    assert.equal(isTerminalAdmin(candidate, ON), false, `should refuse ${JSON.stringify(candidate)}`);
  }
});

/* ---------- chooseAdminVendorId: never guessed ---------- */

test('a well-formed uuid is taken as the vendor to act as', () => {
  const id = '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
  assert.equal(chooseAdminVendorId(id), id);
  assert.equal(chooseAdminVendorId(id.toUpperCase()), id.toUpperCase());
});

test('anything that is not a uuid answers null rather than reaching a uuid column', () => {
  // Unvalidated, these throw 22P02 in Postgres and surface as a noisy 500.
  for (const junk of [undefined, null, '', 'all', '../../etc/passwd', 42, ['a'], '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f', 'x'.repeat(36)]) {
    assert.equal(chooseAdminVendorId(junk), null, `should refuse ${JSON.stringify(junk)}`);
  }
});

test('an operator is NEVER given a default vendor, even with one on the platform', () => {
  // chooseVendorLink's "only one link, so the header is redundant" shortcut is
  // right for a vendor and would be a catastrophe here: the operator has every
  // vendor available and a guess opens a stranger's till. There is no argument
  // to this function that produces a vendor id out of nothing.
  assert.equal(chooseAdminVendorId(undefined), null);
});

/* ---------- the boot verdict: refusing to provision must also refuse to authorise ----------

   ensureTerminalAdmin declines to reset the password of an address that is
   already somebody's account. That refusal leaves THEIR password working, so if
   isTerminalAdmin still read the env alone, the mistake would hand that person
   every till on the platform the moment they signed into /terminal. These tests
   are the proof that declining to provision also declines to authorise.

   Ownership is decided by the app_metadata flag we stamp at creation, NOT by
   "has no profile row and staffs no vendor". That inference is wrong for the
   single most likely address to be typed here by mistake — an /admin operator's
   Google account, which has neither — so it would adopt it and staple a
   password onto it. Driven through a fake supabaseAdmin: no network, no DB. */

const CREATED = { data: { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, error: null };
const EXISTS = { data: null, error: { code: 'email_exists', status: 422 } };

// `flag` is what getUserById reports in app_metadata: true = an account we made.
const fakeSupabase = ({ createUser, existingId, flag = false, getErr = null }) => {
  const calls = { updated: null };
  return {
    calls,
    auth: { admin: {
      createUser: async () => createUser,
      getUserById: async () => (getErr
        ? { data: null, error: getErr }
        : { data: { user: { app_metadata: flag ? { [ADMIN_FLAG]: true } : {} } }, error: null }),
      updateUserById: async (_id, attrs) => { calls.updated = attrs; return { error: null }; },
    } },
    rpc: async () => ({ data: existingId, error: null }),
  };
};

test('a fresh account is provisioned, and only then is anyone the operator', async () => {
  resetTerminalAdminBootVerdict();
  const line = await ensureTerminalAdmin({ supabaseAdmin: fakeSupabase({ createUser: CREATED }), env: ON });
  assert.match(line, /can open ANY vendor terminal/);
  assert.equal(terminalAdminBootVerdict(), true);
  assert.equal(isTerminalAdmin('ops@example.com', ON), true);
});

test('an existing account WITHOUT our flag is refused — and nobody is the operator', async () => {
  resetTerminalAdminBootVerdict();
  const supa = fakeSupabase({ createUser: EXISTS, existingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', flag: false });
  const line = await ensureTerminalAdmin({ supabaseAdmin: supa, env: ON });
  assert.match(line, /already someone else's account/);
  assert.match(line, /dedicated address/);
  assert.equal(terminalAdminBootVerdict(), false);
  // The password was NOT touched...
  assert.equal(supa.calls.updated, null);
  // ...and THAT is why the gate has to say no too: their own password still
  // works, so an env-only isTerminalAdmin would hand them every till.
  assert.equal(isTerminalAdmin('ops@example.com', ON), false);
});

test('our own account on a later boot carries the flag, is re-synced, and keeps it', async () => {
  // The second and every later boot: the account exists because we made it.
  resetTerminalAdminBootVerdict();
  const supa = fakeSupabase({ createUser: EXISTS, existingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', flag: true });
  const line = await ensureTerminalAdmin({ supabaseAdmin: supa, env: ON });
  assert.match(line, /can open ANY vendor terminal/);
  assert.equal(isTerminalAdmin('ops@example.com', ON), true);
  // The env var is the source of truth, so the password is pushed every boot...
  assert.equal(supa.calls.updated.password, PASSWORD);
  // ...and the flag is RE-STAMPED, because updateUserById replaces app_metadata
  // wholesale and dropping it would let migration-054's nightly sweep delete
  // this account at 04:43 UTC.
  assert.equal(supa.calls.updated.app_metadata[ADMIN_FLAG], true);
});

test('a fresh account is stamped with the flag at creation', async () => {
  // Same reason: without it, prune_unconsented_signups deletes the account the
  // night after it is made, since it has no profile, no staff link and no consent.
  resetTerminalAdminBootVerdict();
  let attrs = null;
  await ensureTerminalAdmin({
    supabaseAdmin: { auth: { admin: { createUser: async (a) => { attrs = a; return CREATED; } } } },
    env: ON,
  });
  assert.equal(attrs.app_metadata[ADMIN_FLAG], true);
  assert.equal(attrs.email_confirm, true);
});

test('an ownership lookup that ERRORS fails closed, it does not reset a password', async () => {
  // `data: null, error: <anything>` and "this is a stranger's account" must not
  // reach the same branch, or a transient blip resets somebody's password.
  resetTerminalAdminBootVerdict();
  const supa = fakeSupabase({ createUser: EXISTS, existingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', getErr: new Error('lookup down') });
  const line = await ensureTerminalAdmin({ supabaseAdmin: supa, env: ON });
  assert.match(line, /OFF/);
  assert.equal(supa.calls.updated, null);
  assert.equal(isTerminalAdmin('ops@example.com', ON), false);
});

test('provisioning that THROWS fails closed, and says a restart retries', async () => {
  resetTerminalAdminBootVerdict();
  const supa = { auth: { admin: { createUser: async () => { throw new Error('network down'); } } } };
  const line = await ensureTerminalAdmin({ supabaseAdmin: supa, env: ON });
  assert.match(line, /OFF/);
  assert.match(line, /restart to retry/);
  assert.equal(isTerminalAdmin('ops@example.com', ON), false);
});

test('the boot line never echoes the password', async () => {
  resetTerminalAdminBootVerdict();
  for (const supa of [fakeSupabase({ createUser: CREATED }), { auth: { admin: { createUser: async () => { throw new Error(PASSWORD); } } } }]) {
    resetTerminalAdminBootVerdict();
    const line = await ensureTerminalAdmin({ supabaseAdmin: supa, env: ON });
    if (line.includes(PASSWORD)) assert.fail(`boot line leaked the password: ${line}`);
  }
});

test('reusing an ADMIN_EMAILS address still works but is warned about', async () => {
  resetTerminalAdminBootVerdict();
  const line = await ensureTerminalAdmin({
    supabaseAdmin: fakeSupabase({ createUser: CREATED }), env: ON, adminEmails: ['OPS@example.com'],
  });
  assert.match(line, /also in ADMIN_EMAILS/);
  assert.equal(isTerminalAdmin('ops@example.com', ON), true);   // a warning, not a refusal
});

test('with the vars unset, boot latches OFF and says how to turn it on', async () => {
  resetTerminalAdminBootVerdict();
  const line = await ensureTerminalAdmin({ supabaseAdmin: fakeSupabase({ createUser: CREATED }), env: {} });
  assert.match(line, /TERMINAL_ADMIN_EMAIL and TERMINAL_ADMIN_PASSWORD/);
  assert.equal(isTerminalAdmin('ops@example.com', {}), false);
});

// Leave the module as the rest of the suite expects to find it.
test('cleanup: the boot verdict is reset for other tests', () => {
  resetTerminalAdminBootVerdict();
  assert.equal(terminalAdminBootVerdict(), null);
});
