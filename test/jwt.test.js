// Local access-token verification (src/lib/jwt.js) — the check that replaced a
// network round-trip to Supabase Auth on every authenticated request.
//
// Everything here is a pure unit test: keys are generated in-process and handed
// to the verifier factory, so no Supabase project, no network, and no env vars
// are involved. Two properties carry the weight:
//
//   1. The anon and service_role API keys are HS256 JWTs signed with the SAME
//      project secret we verify user tokens with. If they were ever accepted as
//      user tokens, anyone holding the public anon key would be signed in.
//   2. A token we positively judged invalid must never reach GoTrue. Two
//      unauthenticated endpoints accept an optional bearer token, so forwarding
//      junk would turn this server into an amplifier against our own auth host.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT, createLocalJWKSet } from 'jose';
import { createTokenVerifier, createUserResolver, secretMatchesAnonKey } from '../src/lib/jwt.js';

const ISSUER = 'http://127.0.0.1:54321/auth/v1';
const SECRET_TEXT = 'super-secret-jwt-token-with-at-least-32-characters-long';
const SECRET = new TextEncoder().encode(SECRET_TEXT);
const USER_ID = '2658d566-f72b-425c-85c5-d7c038ff4616';

// The signing key GoTrue publishes at /auth/v1/.well-known/jwks.json, plus a
// second pair that is NOT published — used to stand in for a key rotation we
// haven't refetched yet.
const live = await generateKeyPair('ES256', { extractable: true });
const rotated = await generateKeyPair('ES256', { extractable: true });
const liveJwk = { ...(await exportJWK(live.publicKey)), kid: 'live-key', alg: 'ES256', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [liveJwk] });

// The claim set GoTrue actually stamps on a user access token, copied from a
// real one minted against the local stack.
function claims(over = {}) {
  return {
    iss: ISSUER,
    sub: USER_ID,
    aud: 'authenticated',
    email: 'student@psu.edu',
    role: 'authenticated',
    aal: 'aal1',
    session_id: 'c302ae5b-ee95-4928-8b65-c122a48c9428',
    is_anonymous: false,
    user_metadata: { email_verified: true, full_name: 'Real Student', name: 'Real Student' },
    app_metadata: { provider: 'google', providers: ['google'] },
    ...over,
  };
}

function es256(over = {}, { key = live.privateKey, kid = 'live-key', expIn = '1h' } = {}) {
  return new SignJWT(claims(over))
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(expIn)
    .sign(key);
}

function hs256(payload, { secret = SECRET, expIn = '1h' } = {}) {
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt();
  return (expIn ? jwt.setExpirationTime(expIn) : jwt).sign(secret);
}

// The verifier as production runs it: JWKS for asymmetric tokens, shared secret
// for legacy HS256 ones.
const verify = createTokenVerifier({ issuer: ISSUER, jwks, secret: SECRET });

describe('a genuine Supabase access token', () => {
  test('an ES256 token signed by the published key is accepted', async () => {
    const r = await verify(await es256());
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.user, { id: USER_ID, email: 'student@psu.edu', name: 'Real Student' });
  });

  test('a legacy HS256 token signed with the project secret is accepted', async () => {
    const r = await verify(await hs256(claims()));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.user.id, USER_ID);
  });

  test('the display name falls back to user_metadata.name, then to null', async () => {
    const onlyName = await verify(await es256({ user_metadata: { name: 'Just Name' } }));
    assert.equal(onlyName.user.name, 'Just Name');

    const neither = await verify(await es256({ user_metadata: {} }));
    assert.equal(neither.user.name, null);

    const noMeta = await verify(await es256({ user_metadata: undefined, email: undefined }));
    assert.equal(noMeta.user.name, null);
    assert.equal(noMeta.user.email, null, 'email is null rather than undefined');
  });
});

describe('API keys can never be replayed as user tokens', () => {
  // These are the Supabase CLI's fixed demo keys — identical on every machine,
  // published in Supabase's own docs, and signed with SECRET_TEXT above. The
  // production pair has the same shape (iss "supabase", a "ref" claim, no sub).
  const DEMO_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
  const DEMO_SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

  test('the public anon key is rejected outright, not merely deferred', async () => {
    const r = await verify(DEMO_ANON);
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false, 'must be a hard 401, never handed to GoTrue');
  });

  test('the service_role key is rejected outright', async () => {
    const r = await verify(DEMO_SERVICE);
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('its signature really is valid — only the claims save us', async () => {
    // Proves the two tests above are load-bearing: the demo keys ARE correctly
    // signed with this secret, so nothing but the claim fences stops them.
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, DEMO_ANON), true);
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, DEMO_SERVICE), true);
  });

  test('each fence stops it alone: wrong issuer', async () => {
    const r = await verify(await hs256(claims({ iss: 'supabase' })));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('each fence stops it alone: no audience', async () => {
    const r = await verify(await hs256(claims({ aud: undefined })));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('each fence stops it alone: role is not "authenticated"', async () => {
    for (const role of ['anon', 'service_role', undefined]) {
      const r = await verify(await hs256(claims({ role })));
      assert.equal(r.ok, false, `role ${role} must be rejected`);
      assert.equal(r.reason, 'NOT_A_USER_TOKEN');
    }
  });

  test('each fence stops it alone: no subject', async () => {
    for (const sub of [undefined, '']) {
      const r = await verify(await hs256(claims({ sub })));
      assert.equal(r.ok, false, `sub ${JSON.stringify(sub)} must be rejected`);
      assert.equal(r.fallback, false);
    }
  });
});

describe('forged and broken tokens', () => {
  test('a tampered payload fails the signature check', async () => {
    const good = await es256();
    const [h, , s] = good.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ sub: '00000000-0000-0000-0000-000000000000' })))
      .toString('base64url');
    const r = await verify(`${h}.${forged}.${s}`);
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('an unsecured "alg: none" token is refused before any key is consulted', async () => {
    const r = await verify(new UnsecuredJWT(claims()).encode());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'UNSUPPORTED_ALG');
    assert.equal(r.fallback, false);
  });

  test('alg confusion: an ES256 payload re-signed HS256 with the public key is refused', async () => {
    // The classic attack — swap the header to a symmetric algorithm and sign
    // with the (public) verification key. Our HS256 branch only ever consults
    // the configured project secret, so this cannot verify.
    const publicMaterial = new TextEncoder().encode(JSON.stringify(liveJwk));
    const r = await verify(await hs256(claims(), { secret: publicMaterial }));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('an expired token is refused', async () => {
    const r = await verify(await hs256(claims({ exp: Math.floor(Date.now() / 1000) - 3600 }), { expIn: null }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ERR_JWT_EXPIRED');
    assert.equal(r.fallback, false);
  });

  test('a token with no expiry at all is refused', async () => {
    const { exp, ...noExp } = claims();
    const r = await verify(await hs256(noExp, { expIn: null }));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
  });

  test('garbage, empty and non-string inputs are refused', async () => {
    for (const bad of ['not-a-jwt', 'a.b.c', '', null, undefined, 42, {}]) {
      const r = await verify(bad);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(r.fallback, false);
    }
  });

  test('an unsupported algorithm is refused rather than deferred', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims())).toString('base64url');
    const r = await verify(`${header}.${body}.AAAA`);
    assert.equal(r.reason, 'UNSUPPORTED_ALG');
  });
});

describe('when the key material is missing, GoTrue decides', () => {
  test('a rotated signing key we have not refetched yet defers instead of 401ing', async () => {
    const r = await verify(await es256({}, { key: rotated.privateKey, kid: 'rotated-key' }));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, true, 'a key rotation must not sign every student out');
    assert.equal(r.reason, 'ERR_JWKS_NO_MATCHING_KEY');
  });

  test('an HS256 token with no SUPABASE_JWT_SECRET set defers', async () => {
    const jwksOnly = createTokenVerifier({ issuer: ISSUER, jwks, secret: null });
    const r = await jwksOnly(await hs256(claims()));
    assert.equal(r.ok, false);
    assert.equal(r.fallback, true);
    assert.equal(r.reason, 'NO_HS256_SECRET');
  });

  test('an ES256 token with no JWKS configured defers', async () => {
    const secretOnly = createTokenVerifier({ issuer: ISSUER, jwks: null, secret: SECRET });
    const r = await secretOnly(await es256());
    assert.equal(r.ok, false);
    assert.equal(r.fallback, true);
    assert.equal(r.reason, 'NO_JWKS');
  });

  test('a JWKS endpoint that cannot be reached defers rather than 401ing', async () => {
    const unreachable = createTokenVerifier({
      issuer: ISSUER,
      jwks: async () => { throw new TypeError('fetch failed'); },
      secret: SECRET,
    });
    const r = await unreachable(await es256());
    assert.equal(r.ok, false);
    assert.equal(r.fallback, true);
    assert.equal(r.reason, 'KEY_FETCH_FAILED');
  });
});

describe('the resolver only touches the network when it has to', () => {
  const GOTRUE_USER = {
    data: { user: { id: USER_ID, email: 'student@psu.edu', user_metadata: { full_name: 'From GoTrue' } } },
    error: null,
  };

  function build(verifier) {
    let calls = 0;
    const resolve = createUserResolver({
      verify: verifier,
      getUser: async () => { calls += 1; return GOTRUE_USER; },
    });
    return { resolve, calls: () => calls };
  }

  test('a locally verified token never calls GoTrue', async () => {
    const { resolve, calls } = build(verify);
    const user = await resolve(await es256());
    assert.equal(user.name, 'Real Student', 'the claims, not a GoTrue lookup, populated req.user');
    assert.equal(calls(), 0);
  });

  test('a forged token is refused without calling GoTrue', async () => {
    const { resolve, calls } = build(verify);
    assert.equal(await resolve('not-a-jwt'), null);
    assert.equal(await resolve(new UnsecuredJWT(claims()).encode()), null);
    assert.equal(calls(), 0, 'junk tokens must not be amplified into auth-host traffic');
  });

  test('an undecidable token — and only that — is handed to GoTrue', async () => {
    const { resolve, calls } = build(createTokenVerifier({ issuer: ISSUER, jwks, secret: null }));
    const user = await resolve(await hs256(claims()));
    assert.equal(user.name, 'From GoTrue');
    assert.equal(calls(), 1);
  });

  test('strict mode always asks GoTrue, even for a token that verifies locally', async () => {
    const { resolve, calls } = build(verify);
    const user = await resolve(await es256(), { strict: true });
    assert.equal(user.name, 'From GoTrue', 'strict must not short-circuit on the local result');
    assert.equal(calls(), 1);
  });

  test('a missing token short-circuits with no call at all', async () => {
    const { resolve, calls } = build(verify);
    assert.equal(await resolve(''), null);
    assert.equal(await resolve(undefined, { strict: true }), null);
    assert.equal(calls(), 0);
  });

  test('a token GoTrue itself rejects resolves to null', async () => {
    let calls = 0;
    const resolve = createUserResolver({
      verify: createTokenVerifier({ issuer: ISSUER, jwks, secret: null }),
      getUser: async () => { calls += 1; return { data: null, error: { message: 'invalid JWT' } }; },
    });
    assert.equal(await resolve(await hs256(claims())), null);
    assert.equal(calls, 1);
  });
});

describe('the SUPABASE_JWT_SECRET boot check', () => {
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

  test('the right secret verifies the project anon key', () => {
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, ANON), true);
  });

  test('a secret from another project is caught, so it is ignored rather than locking everyone out', () => {
    assert.equal(secretMatchesAnonKey('a-different-projects-jwt-secret-32-chars', ANON), false);
    assert.equal(secretMatchesAnonKey(`${SECRET_TEXT} `, ANON), false, 'a stray trailing space is a wrong secret');
  });

  test('an anon key that is not a legacy HS256 JWT is unverifiable, so the secret is trusted as given', () => {
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, 'sb_publishable_abc123'), null);
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, ''), null);
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, 'not.a.jwt'), null);
    const es256Header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    assert.equal(secretMatchesAnonKey(SECRET_TEXT, `${es256Header}.e30.AAAA`), null);
  });
});
