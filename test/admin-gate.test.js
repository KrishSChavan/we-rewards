// The /admin authorization policy (adminRejection in src/middleware/auth.js).
//
// The allowlist used to be the entire gate, which quietly made a Supabase
// dashboard setting load-bearing: with `mailer_autoconfirm` on, the public
// GoTrue signup endpoint hands out a confirmed session for any address that
// isn't registered yet — an operator address included. The provider check
// closes that without depending on the toggle.
//
// The property that matters just as much as the denials: this gate must not be
// able to lock the operator out. Every "we don't know" input below is asserted
// to ALLOW, because /admin has no recovery path other than a code change.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { adminRejection } from '../src/middleware/auth.js';

const ALLOWLIST = ['operator@example.com'];
const opts = { allowlist: ALLOWLIST };

// A real operator: signed in through the dashboard's Google button.
function operator(over = {}) {
  return {
    id: '2658d566-f72b-425c-85c5-d7c038ff4616',
    email: 'operator@example.com',
    name: 'The Operator',
    providers: ['google'],
    emailVerified: true,
    isAnonymous: false,
    ...over,
  };
}

describe('the operator is let in', () => {
  test('an allowlisted, confirmed Google account passes', () => {
    assert.equal(adminRejection(operator(), opts), null);
  });

  test('the email match is case-insensitive', () => {
    assert.equal(adminRejection(operator({ email: 'Operator@Example.COM' }), opts), null);
  });

  test('a Google account that also has a password identity passes', () => {
    // app_metadata.provider is whichever was used last, so an account created
    // with a password and later linked to Google can report either order.
    assert.equal(adminRejection(operator({ providers: ['email', 'google'] }), opts), null);
    assert.equal(adminRejection(operator({ providers: ['google', 'email'] }), opts), null);
  });
});

describe('the gate cannot lock the operator out', () => {
  test('an unknown provider list (GoTrue said nothing) is allowed', () => {
    assert.equal(adminRejection(operator({ providers: [] }), opts), null);
  });

  test('a missing provider list is allowed', () => {
    assert.equal(adminRejection(operator({ providers: undefined }), opts), null);
    assert.equal(adminRejection(operator({ providers: null }), opts), null);
  });

  test('unknown email-confirmation state is allowed, unlike a positive false', () => {
    assert.equal(adminRejection(operator({ emailVerified: null }), opts), null);
    assert.equal(adminRejection(operator({ emailVerified: undefined }), opts), null);
    assert.ok(adminRejection(operator({ emailVerified: false }), opts), 'false must still deny');
  });

  test('a truthy-but-not-true isAnonymous does not deny on its own', () => {
    // Only an explicit `true` denies; the field is absent on older GoTrue.
    assert.equal(adminRejection(operator({ isAnonymous: undefined }), opts), null);
  });
});

describe('the paths this closes', () => {
  test('an email/password account on an allowlisted address is denied', () => {
    // The attack: mailer_autoconfirm is on, the operator address was never
    // registered, an attacker signs up with it and gets a confirmed session.
    const attacker = operator({ providers: ['email'], emailVerified: true });
    const denial = adminRejection(attacker, opts);
    assert.equal(denial?.status, 403);
    assert.match(denial.reason, /signed in via email/);
  });

  test('an unconfirmed account on an allowlisted address is denied', () => {
    const denial = adminRejection(operator({ emailVerified: false }), opts);
    assert.equal(denial?.status, 403);
    assert.match(denial.reason, /not confirmed/);
  });

  test('an anonymous session on an allowlisted address is denied', () => {
    const denial = adminRejection(operator({ isAnonymous: true }), opts);
    assert.equal(denial?.status, 403);
    assert.match(denial.reason, /anonymous/);
  });

  test('a non-Google OAuth provider is denied while google remains the only one accepted', () => {
    assert.ok(adminRejection(operator({ providers: ['github'] }), opts));
    assert.ok(adminRejection(operator({ providers: ['azure', 'email'] }), opts));
  });
});

describe('the allowlist still gates everything', () => {
  test('a perfectly valid Google account off the allowlist is denied', () => {
    const denial = adminRejection(operator({ email: 'student@psu.edu' }), opts);
    assert.equal(denial?.status, 403);
    assert.match(denial.reason, /not on the allowlist/);
  });

  test('a user with no email, or no user at all, is denied', () => {
    assert.ok(adminRejection(operator({ email: null }), opts));
    assert.ok(adminRejection(null, opts));
    assert.ok(adminRejection(undefined, opts));
  });

  test('an empty allowlist denies everyone (fail-closed)', () => {
    assert.ok(adminRejection(operator(), { allowlist: [] }));
  });
});

test('every denial returns an identical body, so it is not an allowlist oracle', () => {
  const bodies = [
    adminRejection(operator({ email: 'nobody@example.com' }), opts),   // wrong email
    adminRejection(operator({ providers: ['email'] }), opts),          // right email, wrong provider
    adminRejection(operator({ emailVerified: false }), opts),          // right email, unconfirmed
    adminRejection(operator({ isAnonymous: true }), opts),             // right email, anonymous
  ];
  for (const b of bodies) {
    assert.equal(b.status, 403);
    assert.deepEqual(b.body, { error: 'NOT_ADMIN', message: 'Admin access only.' });
  }
  // ...and the reasons, which only ever reach the server log, do differ.
  assert.equal(new Set(bodies.map((b) => b.reason)).size, bodies.length);
});

test('the response body is frozen, so a route cannot rewrite it for later requests', () => {
  const denial = adminRejection(operator({ providers: ['email'] }), opts);
  assert.throws(() => { denial.body.message = 'tampered'; }, TypeError);
  assert.equal(adminRejection(null, opts).body.message, 'Admin access only.');
});

describe('only allowlisted addresses are logged', () => {
  // requireAdmin logs `denial.reason` alongside the email. That email must never
  // be attacker-chosen, or anyone could write arbitrary lines into the log by
  // presenting a token for an address of their choosing.
  test('a denial for an unknown address is not logged', () => {
    assert.equal(adminRejection(operator({ email: 'someone\n[admin] fake line' }), opts).log, false);
    assert.equal(adminRejection(null, opts).log, false);
  });

  test('a denial for an allowlisted address is logged', () => {
    for (const u of [{ providers: ['email'] }, { emailVerified: false }, { isAnonymous: true }]) {
      assert.equal(adminRejection(operator(u), opts).log, true);
    }
  });
});
