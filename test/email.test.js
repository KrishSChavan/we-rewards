// Unit tests for the mail transport (src/lib/email.js) and the delivery-event
// webhook (src/routes/webhooks.js).
//
// No API key is set in the test environment, so `emailEnabled` is false and
// sendEmail short-circuits before any network call — which is itself one of the
// things worth asserting: a checkout with no keys must never reach out, and
// must never throw at a caller who is on a request path. The handful of cases
// that DO need a configured transport (what a 422 does, and the boot-time sender
// warning, both of which are decided at import time) run in a child process with
// the env set and fetch stubbed. See runWithKey below.
//
// What is covered here is the logic that has no second chance to be right:
//   • the unsubscribe HMAC, which is the ONLY thing standing between a public
//     URL and unsubscribing somebody else — and which must REFUSE a malformed
//     token rather than throw, because the throw reaches the global handler and
//     pages every admin from an unauthenticated, unthrottled public route,
//   • which 422 from Resend blames the recipient and which blames our own
//     EMAIL_FROM / EMAIL_REPLY_TO, because suppressing on the second one mutes
//     every address mailed during a misconfiguration, permanently,
//   • the Svix signature, which is the only thing standing between a public URL
//     and suppressing an address (a denial of service against a vendor's
//     password reset),
//   • which bounces are permanent, where guessing wrong locks a real vendor out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  emailEnabled, sendEmail, maskEmail, emailUrl,
  unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl,
} from '../src/lib/email.js';
import { verifySvix, classifyEvent, isPermanentBounce } from '../src/routes/webhooks.js';

/* ---------- the config gate ---------- */

test('with no key configured the transport is off and never reaches the network', async () => {
  assert.equal(emailEnabled, false, 'the test env must not carry a real RESEND_API_KEY');
  // Resolves, never rejects. Every caller is either mid-request (an application
  // being submitted) or in a background worker, and neither may fail because
  // mail is unconfigured.
  const res = await sendEmail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>', text: 'x' });
  assert.deepEqual(res, { ok: false, reason: 'disabled' });
});

test('a malformed recipient is refused locally, before it can cost an API call', async () => {
  for (const to of ['', 'not-an-address', 'a@b', 'a b@c.com', null, undefined]) {
    const res = await sendEmail({ to, subject: 'x', html: '<p>x</p>' });
    assert.equal(res.ok, false, `${to} should not be sendable`);
  }
});

/* ---------- which 422 is the recipient's fault, and which is our own config ---------- */

const LIB = pathToFileURL(path.resolve('src/lib/email.js')).href;

/**
 * Load src/lib/email.js in a CHILD PROCESS with RESEND_API_KEY / EMAIL_FROM /
 * EMAIL_REPLY_TO set, global fetch replaced by a stub and console.warn captured,
 * then run `body` and print what it returns as JSON.
 *
 * Why a child: emailEnabled, FROM and REPLY_TO are all read at IMPORT time — the
 * boot-time sender-format warning is the whole point of that check, so it cannot
 * be exercised any other way — and exporting a key into this process would leave
 * every other test in the suite holding a transport that believes it can send.
 * Same shape, and the same reasoning, as runWithKey in test/posthog.test.js.
 *
 * The stub answers api.resend.com with the given status/detail and Supabase with
 * the smallest body postgrest-js accepts: `[]` for the suppression lookup, which
 * it reads as "no row" so the send proceeds, and `{}` for the email_suppress RPC.
 * Every request is recorded, so a test can assert whether suppress() ran AT ALL —
 * which is the actual question here, because the write is fire-and-forget and
 * sendEmail's return value looks identical either way.
 */
function runWithKey(body, {
  status = 422,
  detail = '',
  from = 'WeRewards <hello@we-rewards.com>',
  replyTo = '',
} = {}) {
  const src = `
    const calls = [];
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : null });
      const json = { 'Content-Type': 'application/json' };
      if (u.startsWith('https://api.resend.com/')) {
        return new Response(${JSON.stringify(detail)}, { status: ${Number(status)}, headers: json });
      }
      // Supabase. '[]' is "no row" to postgrest-js's maybeSingle (so the address
      // is not already suppressed and the send goes ahead) and a fine enough
      // answer for the email_suppress RPC, whose result this module ignores.
      return new Response('[]', { status: 200, headers: json });
    };
    const mail = await import(${JSON.stringify(LIB)});
    const out = await (${body})(mail, calls, warnings);
    console.log('__RESULT__' + JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: {
      ...process.env,
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: from,
      EMAIL_REPLY_TO: replyTo,
      APP_ORIGIN: 'https://we-rewards.test',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/** Send one mail through the child and report what the 422 caused. */
function sendAgainst422(detail, opts = {}) {
  return runWithKey(`async (mail, calls) => {
    const res = await mail.sendEmail({ to: 'student@example.com', subject: 'x', html: '<p>x</p>', text: 'x' });
    return {
      res,
      suppressed: calls.some((c) => c.url.includes('/rpc/email_suppress')),
      reachedResend: calls.some((c) => c.url.startsWith('https://api.resend.com/')),
    };
  }`, { status: 422, detail, ...opts });
}

// Resend's real wording for a sender it will not accept. Held in a constant with
// genuine backticks because the backticks are what the narrowed test keys on.
const BT = String.fromCharCode(96);
const FROM_422 = `{"statusCode":422,"name":"validation_error","message":"Invalid ${BT}from${BT} field. The email address needs to follow the ${BT}email@example.com${BT} or ${BT}Name <email@example.com>${BT} format."}`;

test('a 422 about our own From line must not suppress the recipient', () => {
  // This is the bug this test exists for. `to` is validated locally before any
  // request is made, so a 422 arriving from Resend is far more likely to be about
  // the request shape — and a wording-only /invalid/ test matched the sender error
  // above, suppressing at scope 'all' every address mailed while EMAIL_FROM was
  // wrong. Nothing ever un-does that: both deletes of email_suppressions filter
  // on scope='marketing' and prune_email_suppressions is not scheduled anywhere,
  // so it is password resets and sign-in codes dying silently and permanently for
  // real people, for one typo in a config var.
  const out = sendAgainst422(FROM_422, { from: 'WeRewards <hello@we-rewards.com>' });
  assert.equal(out.reachedResend, true, 'the send must actually have been attempted');
  assert.equal(out.suppressed, false, 'a sender-side 422 must never touch the suppression list');
  assert.deepEqual(out.res, { ok: false, reason: 'http', status: 422 });
});

test('a 422 about reply_to must not suppress the recipient either', () => {
  // EMAIL_REPLY_TO is sent verbatim and was never format-checked at all, so it is
  // the same failure with a second env var. The substring "to" inside "reply_to"
  // is exactly the trap a loose word-boundary test falls into.
  const out = sendAgainst422(`{"statusCode":422,"message":"Invalid ${BT}reply_to${BT} field. The email address is not valid."}`);
  assert.equal(out.suppressed, false);
});

test('a 422 that names the recipient still suppresses the address', () => {
  // The narrowing must not cost us the real case: Resend validates syntax and
  // known-invalid domains before accepting, so an address it names is one the
  // student typed wrong at signup and retrying it forever is how a sending
  // domain's bounce rate climbs.
  for (const detail of [
    `{"statusCode":422,"message":"Invalid ${BT}to${BT} field. Please use the format email@example.com"}`,
    '{"statusCode":422,"message":"The recipient address is not valid."}',
  ]) {
    const out = sendAgainst422(detail);
    assert.equal(out.suppressed, true, `should suppress on: ${detail}`);
  }
});

test('a 500 from Resend never suppresses, however it is worded', () => {
  // A bad minute at the vendor is not a statement about the mailbox. Suppressing
  // on one would mute a live address permanently for a transient outage.
  const out = sendAgainst422('{"statusCode":500,"message":"Invalid recipient (not really, this is a server error)"}', { status: 500 });
  assert.equal(out.suppressed, false);
  assert.deepEqual(out.res, { ok: false, reason: 'http', status: 500 });
});

test('a malformed sender line is warned about at boot, loudly, without disabling mail', () => {
  // The warning IS the fix for the silent version of this outage: every caller
  // swallows a failed send (vendor-recover answers ACCEPTED, student-email returns
  // ok:true), so without a line in the Heroku log at boot there is no symptom at
  // all beyond mail simply never arriving.
  const bad = runWithKey(
    'async (mail, calls, warnings) => ({ enabled: mail.emailEnabled, warnings })',
    { from: 'WeRewards hello@we-rewards.com' }
  );
  assert.equal(bad.enabled, true, 'a malformed From must NOT change what emailEnabled means');
  assert.ok(bad.warnings.some((w) => w.includes('EMAIL_FROM')), `expected an EMAIL_FROM warning, got ${JSON.stringify(bad.warnings)}`);

  const badReply = runWithKey(
    'async (mail, calls, warnings) => ({ warnings })',
    { replyTo: 'not-an-address' }
  );
  assert.ok(badReply.warnings.some((w) => w.includes('EMAIL_REPLY_TO')), `expected an EMAIL_REPLY_TO warning, got ${JSON.stringify(badReply.warnings)}`);

  // Both accepted forms stay silent: a display name with the address in angle
  // brackets (what we actually send, because a bare From line is a cheap spam
  // signal) and a bare address.
  for (const from of ['WeRewards <hello@we-rewards.com>', 'hello@we-rewards.com']) {
    const ok = runWithKey('async (mail, calls, warnings) => ({ warnings })', { from, replyTo: 'support@we-rewards.com' });
    assert.deepEqual(ok.warnings, [], `${from} is valid and must not warn`);
  }
});

/* ---------- logging hygiene ---------- */

test('addresses are masked for logs but stay distinguishable', () => {
  // Server logs are read by someone debugging deliverability, who needs to tell
  // two recipients apart without the log becoming a mailing list.
  assert.equal(maskEmail('krishna@gmail.com'), 'k*****a@gmail.com');
  assert.equal(maskEmail('jo@x.com'), 'j*@x.com');
  assert.equal(maskEmail('a@x.com'), 'a*@x.com');
  assert.equal(maskEmail('not-an-address'), '(invalid)');
  assert.equal(maskEmail(''), '(invalid)');
  assert.equal(maskEmail(null), '(invalid)');
  // The local part never survives whole, however long it is.
  assert.equal(maskEmail('averylonglocalpart@x.com').includes('averylong'), false);
});

/* ---------- the unsubscribe token ---------- */

test('an unsubscribe token is stable, and is not transferable between students', () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';

  // Stable: the link in an email sent last week has to still work today, which
  // is the whole reason this is an HMAC and not a stored row.
  assert.equal(unsubscribeToken(a), unsubscribeToken(a));
  // ...and not walkable. Editing the uuid in the URL is the obvious attack on a
  // link that carries a user id in plain sight.
  assert.notEqual(unsubscribeToken(a), unsubscribeToken(b));

  assert.equal(verifyUnsubscribeToken(a, unsubscribeToken(a)), true);
  assert.equal(verifyUnsubscribeToken(a, unsubscribeToken(b)), false);
});

test('verification refuses every malformed token without throwing', () => {
  const u = '11111111-1111-1111-1111-111111111111';
  const good = unsubscribeToken(u);
  // timingSafeEqual THROWS on a length mismatch rather than returning false, so
  // a short token would 500 the unsubscribe page instead of refusing it — and a
  // 500 to Gmail's one-click is what makes it stop offering the button.
  for (const bad of ['', 'x', good.slice(0, -1), `${good}x`, null, undefined, 12345]) {
    assert.equal(verifyUnsubscribeToken(u, bad), false, `${bad} should be refused`);
  }

  // THE ONE THAT GOT THROUGH: a JS-length guard is not a byte-length guard.
  // String#length counts UTF-16 code units and timingSafeEqual compares utf8
  // BYTES, so 31 base64url characters plus one multibyte character is length 32
  // and 33 bytes — it passed the old guard and threw a RangeError out of
  // src/routes/unsubscribe.js authorize(), which has no try/catch, all the way to
  // logError: an error_logs insert plus a web-push alert to every operator, then
  // a 500, on a route that mounts ahead of every rate limiter. Anyone with curl
  // could page the whole admin team in a loop.
  for (const multibyte of [`${good.slice(0, -1)}é`, `${good.slice(0, -2)}€`, `${good.slice(0, -1)}\u{1F600}`]) {
    assert.equal(
      verifyUnsubscribeToken(u, multibyte), false,
      `a ${Buffer.byteLength(multibyte)}-byte, ${multibyte.length}-character token must be refused, not thrown on`
    );
  }
  // Right length, wrong alphabet: refused by shape before any comparison, which
  // is also what keeps both buffers one byte per character.
  for (const outside of [`${good.slice(0, -1)}!`, `${good.slice(0, -1)}+`, `${good.slice(0, -1)} `]) {
    assert.equal(verifyUnsubscribeToken(u, outside), false, `${outside} should be refused`);
  }

  // THE ONE THAT GOT THROUGH THE *FIRST* FIX: the shape gate was behind a
  // `String(token ?? '')`, and String() throws on an object that has no primitive
  // conversion. This is not a hypothetical value — express 4 parses the query with
  // qs.parse(str, { allowPrototypes: true }), so `?t[toString]=x` IS this object.
  // (A null-prototype object throws for the same reason — nothing inherited left
  // to call — but a query string can't make one: measured against the installed
  // qs 6.15.3, `?t[__proto__]=x` yields an ORDINARY object whose String() is
  // "[object Object]". Kept in the table anyway: this function is also called
  // with values that did not come from qs.) Same 500 as the multibyte case
  // above (error_logs row + push to every operator, no rate limiter in front),
  // just thrown one line earlier, so the type gate has to come before any
  // coercion. Labels are hand-written: interpolating these values into the
  // assertion message would throw inside the test itself.
  const noPrimitive = [
    ['{ toString: "x" }', { toString: 'x' }],
    ['Object.create(null)', Object.create(null)],
    ['{ toString() { throw } }', { toString() { throw new Error('nope'); } }],
    ['{ valueOf: null, toString: null }', { valueOf: null, toString: null }],
  ];
  for (const [label, hostile] of noPrimitive) {
    assert.equal(verifyUnsubscribeToken(u, hostile), false, `${label} should be refused, not thrown on`);
  }
  // Arrays are the everyday version of the same thing: `?t=a&t=b` is ['a','b'].
  assert.equal(verifyUnsubscribeToken(u, [good]), false, 'a repeated ?t= param arrives as an array');
  assert.equal(verifyUnsubscribeToken(u, [good, good]), false, 'a repeated ?t= param arrives as an array');

  // AND THE *OTHER* ARGUMENT. Gating only `token` left the function non-total:
  // unsubscribeToken() coerces userId inside `unsub:${userId}`, so a hostile FIRST
  // argument threw from a frame with no guard of its own — the same TypeError, the
  // same error_logs row and push to every operator. authorize() pins `u` to a
  // string and then a uuid today, so this is not live; it is asserted because the
  // function's contract is "refuses everything, throws at nobody", and the next
  // caller will not read authorize() first. Token is well-formed in every case, so
  // only the userId type can be what refuses it.
  for (const [label, hostile] of noPrimitive) {
    assert.equal(
      verifyUnsubscribeToken(hostile, good), false,
      `userId ${label} should be refused, not thrown on`,
    );
  }
  assert.equal(verifyUnsubscribeToken([u], good), false, 'a repeated ?u= param arrives as an array');
  assert.equal(verifyUnsubscribeToken(undefined, good), false, 'a missing ?u= is not a user');
  assert.equal(verifyUnsubscribeToken(null, good), false, 'a missing ?u= is not a user');

  // ...and none of that broke the happy path.
  assert.equal(verifyUnsubscribeToken(u, good), true);
});

test('the unsubscribe URL carries both halves the route needs', () => {
  const u = '11111111-1111-1111-1111-111111111111';
  const url = unsubscribeUrl(u);
  assert.ok(url.includes(`u=${u}`));
  assert.ok(url.includes(`t=${unsubscribeToken(u)}`));
});

test('emailUrl falls back to the request origin when APP_ORIGIN is unset', () => {
  // The campaign worker has no request, which is why APP_ORIGIN is warned about
  // at boot; a request-path caller can still do better than a relative link.
  const req = { protocol: 'https', get: () => 'we-rewards.com' };
  assert.equal(emailUrl('/terminal/', req), 'https://we-rewards.com/terminal/');
  assert.equal(emailUrl('terminal/', req), 'https://we-rewards.com/terminal/');
});

/* ---------- the Svix signature on the webhook ---------- */

const SECRET = `whsec_${Buffer.from('super-secret-key').toString('base64')}`;

/** Sign a payload the way Svix does, so the test exercises the real scheme. */
function sign(raw, { id = 'msg_1', timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${sig}`,
  };
}

test('a correctly signed, fresh payload verifies', () => {
  const raw = JSON.stringify({ type: 'email.bounced' });
  assert.deepEqual(verifySvix(raw, sign(raw), SECRET), { ok: true });
});

test('a tampered body fails, even with otherwise valid headers', () => {
  const raw = JSON.stringify({ type: 'email.bounced', data: { to: ['victim@x.com'] } });
  const headers = sign(raw);
  // The attack this closes: replay a real event with the address swapped, and
  // suppress a vendor's login so their password reset never arrives.
  const swapped = JSON.stringify({ type: 'email.bounced', data: { to: ['someone-else@x.com'] } });
  assert.equal(verifySvix(swapped, headers, SECRET).ok, false);
});

test('a stale signature is refused, so one captured request cannot be replayed forever', () => {
  const raw = JSON.stringify({ type: 'email.complained' });
  const old = Math.floor(Date.now() / 1000) - 60 * 60;
  assert.equal(verifySvix(raw, sign(raw, { timestamp: old }), SECRET).reason, 'stale');
  // ...in both directions: a far-future timestamp is equally not a live request.
  const future = Math.floor(Date.now() / 1000) + 60 * 60;
  assert.equal(verifySvix(raw, sign(raw, { timestamp: future }), SECRET).reason, 'stale');
});

test('with no secret configured every request is refused rather than trusted', () => {
  const raw = JSON.stringify({ type: 'email.bounced' });
  assert.equal(verifySvix(raw, sign(raw), '').reason, 'unconfigured');
});

test('missing headers are refused, not treated as an unsigned-but-fine request', () => {
  const raw = '{}';
  const full = sign(raw);
  for (const drop of ['svix-id', 'svix-timestamp', 'svix-signature']) {
    const headers = { ...full };
    delete headers[drop];
    assert.equal(verifySvix(raw, headers, SECRET).reason, 'missing_headers', `dropping ${drop}`);
  }
});

test('any one of several rotated signatures is enough', () => {
  // Svix signs with the old and new secret at once during a rotation. Requiring
  // the first to match would drop every event mid-rotation.
  const raw = '{"type":"email.delivered"}';
  const good = sign(raw);
  const headers = { ...good, 'svix-signature': `v1,AAAA ${good['svix-signature']}` };
  assert.equal(verifySvix(raw, headers, SECRET).ok, true);
});

/* ---------- what an event means ---------- */

test('a permanent bounce suppresses, a transient one does not', () => {
  // Getting this backwards is not symmetric. Ignoring a hard bounce costs
  // sending reputation slowly; suppressing a soft one locks a vendor out of
  // password recovery immediately.
  assert.equal(isPermanentBounce({ bounce: { type: 'Permanent' } }), true);
  assert.equal(isPermanentBounce({ bounce: { type: 'HardBounce' } }), true);
  assert.equal(isPermanentBounce({ bounce: { type: 'Transient' } }), false);
  assert.equal(isPermanentBounce({ bounce: { type: 'Transient', subType: 'MailboxFull' } }), false);
  // Providers do not agree on spelling, so an unrecognised value is treated as
  // transient: keep the address we are unsure about.
  assert.equal(isPermanentBounce({ bounce: { type: 'Whatever' } }), false);
  assert.equal(isPermanentBounce({}), false);
  assert.equal(isPermanentBounce(null), false);
  // A provider-side permanent suppression is as final as a hard bounce.
  assert.equal(isPermanentBounce({ bounce: { type: 'Undetermined', subType: 'Suppressed' } }), true);
});

test('the event decision table', () => {
  // A spam report is the strongest statement a recipient can make. It stops
  // everything, including transactional mail, because continuing to send to
  // someone who reported us is what costs the domain.
  assert.deepEqual(
    classifyEvent('email.complained', { to: ['a@b.com'] }),
    { suppress: true, scope: 'all', reason: 'complained' }
  );
  assert.deepEqual(
    classifyEvent('email.bounced', { bounce: { type: 'Permanent' } }),
    { suppress: true, scope: 'all', reason: 'bounced' }
  );
  assert.deepEqual(classifyEvent('email.bounced', { bounce: { type: 'Transient' } }), { suppress: false });
  // Everything else is acknowledged and dropped: we do not need the analytics,
  // and per-message open data about students is a privacy cost with no benefit.
  for (const type of ['email.sent', 'email.delivered', 'email.opened', 'email.clicked', 'email.delivery_delayed', undefined]) {
    assert.deepEqual(classifyEvent(type, {}), { suppress: false }, `${type} should be ignored`);
  }
});
