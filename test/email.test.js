// Unit tests for the mail transport (src/lib/email.js) and the delivery-event
// webhook (src/routes/webhooks.js).
//
// No API key is set in the test environment, so `emailEnabled` is false and
// sendEmail short-circuits before any network call — which is itself one of the
// things worth asserting: a checkout with no keys must never reach out, and
// must never throw at a caller who is on a request path.
//
// What is covered here is the logic that has no second chance to be right:
//   • the unsubscribe HMAC, which is the ONLY thing standing between a public
//     URL and unsubscribing somebody else,
//   • the Svix signature, which is the only thing standing between a public URL
//     and suppressing an address (a denial of service against a vendor's
//     password reset),
//   • which bounces are permanent, where guessing wrong locks a real vendor out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  assert.equal(emailUrl('/vendor/', req), 'https://we-rewards.com/vendor/');
  assert.equal(emailUrl('vendor/', req), 'https://we-rewards.com/vendor/');
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
