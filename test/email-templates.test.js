// Unit tests for src/lib/email-templates.js. No network, no API key, no mailbox:
// composition is the half of email that can be checked deterministically, which
// is exactly why it lives apart from the transport.
//
// What is worth testing here is not "does the copy read well" but the three
// things that fail SILENTLY in a real inbox and are invisible in review:
//   • an unescaped business name taking the layout apart,
//   • a missing text/plain part, which every spam filter scores against,
//   • a deal email going out with no way to unsubscribe from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  applicationReceived,
  applicationAccepted,
  vendorResetCode,
  dealDigest,
} from '../src/lib/email-templates.js';

/** Every template owes the caller the same three fields, both parts non-empty. */
function assertWellFormed(msg, label) {
  assert.ok(msg, `${label}: nothing returned`);
  assert.equal(typeof msg.subject, 'string', `${label}: no subject`);
  assert.ok(msg.subject.length > 0 && msg.subject.length < 120, `${label}: bad subject length`);
  assert.match(msg.html, /^<!doctype html>/, `${label}: html is not a document`);
  assert.ok(msg.text.length > 40, `${label}: text alternative is missing or a stub`);
  // A <style> block is stripped by some clients and rewritten by others; every
  // rule has to be inline or it is not a rule.
  assert.equal(/<style[\s>]/i.test(msg.html), false, `${label}: has a <style> block`);
  // No remote assets. They are blocked by default, so anything load-bearing
  // that lives in one is invisible on first open.
  assert.equal(/<img[\s>]|url\(http/i.test(msg.html), false, `${label}: references a remote asset`);
}

test('esc neutralises every character that could break out of the markup', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(esc("it's"), 'it&#39;s');
  // Ampersand must be replaced FIRST, or the escapes escape each other and
  // `<` renders as `&amp;lt;`.
  assert.equal(esc('&lt;'), '&amp;lt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('every template returns a well-formed pair of parts', () => {
  assertWellFormed(applicationReceived({ businessName: 'Blue Bird Cafe', contactName: 'Sam' }), 'received');
  assertWellFormed(applicationAccepted({ businessName: 'Blue Bird Cafe', contactName: 'Sam', email: 'sam@x.com' }), 'accepted');
  assertWellFormed(vendorResetCode({ businessName: 'Blue Bird Cafe', code: 'K7M2-NP94' }), 'reset');
  assertWellFormed(dealDigest({ name: 'Alex', items: [{ campaignId: 'c1', vendor: 'Taco Stand', title: 'Half price', body: 'Today only.' }] }), 'digest');
});

test('a hostile business name cannot escape into the markup', () => {
  // A vendor applies through a public form. The name they type reaches the
  // operator's inbox and, on accept, their own — so it is attacker-controlled
  // text in a document we generate.
  const hostile = '<img src=x onerror="alert(1)">Café & "Bar"';
  for (const [label, msg] of [
    ['received', applicationReceived({ businessName: hostile, contactName: hostile })],
    ['accepted', applicationAccepted({ businessName: hostile, contactName: hostile, email: 'a@b.com' })],
    ['reset', vendorResetCode({ businessName: hostile, code: 'K7M2-NP94' })],
  ]) {
    // The tag is what matters. `onerror=` still appears as LITERAL TEXT and
    // that is fine — with the angle brackets and quotes escaped there is no
    // element for it to be an attribute of.
    assert.equal(msg.html.includes('<img'), false, `${label}: raw tag survived`);
    assert.ok(msg.html.includes('&lt;img'), `${label}: the name was dropped rather than escaped`);
    assert.ok(msg.html.includes('&quot;alert(1)&quot;'), `${label}: quotes were not escaped`);
  }
});

test('a hostile deal title cannot escape either, and is not double-escaped', () => {
  const msg = dealDigest({
    name: 'Alex',
    items: [{ campaignId: 'c1', vendor: 'Taco & Co', title: '2 <for> 1', body: 'Today only.' }],
  });
  assert.equal(msg.html.includes('<for>'), false);
  assert.ok(msg.html.includes('2 &lt;for&gt; 1'));
  // The heading is escaped exactly once. Escaping it in the template AND in the
  // layout renders "&amp;lt;" to the reader — invisible in code, obvious in a
  // mailbox, and only caught by asserting on the output.
  assert.equal(msg.html.includes('&amp;lt;'), false, 'the title was escaped twice');
  assert.equal(msg.html.includes('&amp;amp;'), false, 'an ampersand was escaped twice');
});

test('the accepted email says WHICH password works when the account was linked', () => {
  // migration-035 links an existing account instead of creating one, and that
  // account keeps its own password. A vendor told "use the password you chose
  // when you applied" in that case cannot sign in, and phones for a reset on
  // day one — so this sentence is the whole difference between the two.
  const fresh = applicationAccepted({ businessName: 'X', contactName: 'Sam', email: 'a@b.com', linkedExisting: false });
  assert.match(fresh.text, /password you chose when you applied/i);
  assert.equal(/already use/i.test(fresh.text), false);

  const linked = applicationAccepted({ businessName: 'X', contactName: 'Sam', email: 'a@b.com', linkedExisting: true });
  assert.match(linked.text, /password you already use/i);
  assert.match(linked.html, /not the one you typed on the application form/i);

  // Both name the exact sign-in address: a chain owner may have applied with
  // one address and read mail at another.
  assert.ok(fresh.html.includes('a@b.com'));
  assert.ok(fresh.text.includes('a@b.com'));
});

test('neither vendor email can ship a link to the terminal that 404s', () => {
  // The terminal is mounted at /terminal (server.js: `{ mount: '/terminal', dir:
  // 'vendor' }`) while its SOURCE lives in public/vendor, and both templates were
  // originally written against the directory name. That put a dead link in the
  // primary button of the two emails whose whole job is getting a vendor into the
  // terminal: the welcome email, and the one sent to somebody already locked out.
  //
  // Asserting on the DEFAULTS matters as much as on the callers. Every caller
  // passes terminalUrl today, so a wrong default is invisible until someone adds
  // a caller that doesn't — and then it ships a bare relative path into a mail
  // client, where there is no origin to resolve it against at all.
  for (const [label, msg] of [
    ['accepted', applicationAccepted({ businessName: 'X', contactName: 'Sam', email: 'a@b.com' })],
    ['reset', vendorResetCode({ businessName: 'X', code: 'AAAA-BBBB' })],
  ]) {
    assert.equal(/["\s(]\/?vendor\//.test(msg.html), false, `${label}: html links at /vendor/`);
    assert.equal(/["\s(]\/?vendor\//.test(msg.text), false, `${label}: text links at /vendor/`);
    assert.ok(msg.html.includes('/terminal/'), `${label}: html has no /terminal/ link`);
    assert.ok(msg.text.includes('/terminal/'), `${label}: text has no /terminal/ link`);
  }
});

test('the accepted email can be followed by someone who has never installed an app', () => {
  // These vendors are handed an iPad and a queue of customers. The install steps
  // are the part most likely to strand one of them, so the things that actually
  // cause the support call are pinned here rather than left to review.
  const msg = applicationAccepted({
    businessName: 'Blue Bird Cafe', contactName: 'Sam', email: 'sam@x.com',
    terminalUrl: 'https://we-rewards.com/terminal/',
  });

  // Named browser, because a link opened from another app lands in a web view
  // whose menu has no Add to Home Screen at all.
  assert.match(msg.html, /Safari/);
  assert.match(msg.html, /Add to Home Screen/);
  // The near-miss that silently does nothing, called out by name.
  assert.match(msg.html, /Add Bookmark/i);
  // Below iOS 14.3 an installed icon has NO getUserMedia, so the scanner dies at
  // the counter and only a force-quit recovers it. One line here beats that.
  assert.match(msg.html, /14\.3/);
  assert.match(msg.text, /14\.3/);

  // The address is for TYPING off a screen, so it carries no scheme and no
  // trailing slash even though the button's href does.
  assert.ok(msg.html.includes('we-rewards.com/terminal<'), 'the typed address is not clean');
  assert.ok(msg.html.includes('href="https://we-rewards.com/terminal/"'), 'the button href is not absolute');

  assert.ok(msg.text.includes('we-rewards.com/terminal'), 'the text part lost the typed address');
  // Steps must survive into the text part; a plain-text reader gets no <ol>.
  for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) {
    assert.ok(msg.text.includes(n), `the text part is missing step ${n}`);
  }
});

test('the reset code is readable from the notification alone', () => {
  // A vendor is standing at a counter. Putting the code in the subject means
  // they never have to open anything, and it is safe to do because the code is
  // single-use and dies in 30 minutes.
  const msg = vendorResetCode({ businessName: 'Blue Bird', code: 'K7M2-NP94', ttlMinutes: 30 });
  assert.ok(msg.subject.includes('K7M2-NP94'), 'the code is not in the subject');
  assert.ok(msg.html.includes('K7M2-NP94'));
  assert.ok(msg.text.includes('K7M2-NP94'));
  assert.match(msg.text, /30 minutes/);
  // Never a click-to-reset link: that would move the security boundary into the
  // mailbox, and the code flow already works from a different device.
  assert.equal(/reset\?token|magic|one-click reset/i.test(msg.html), false);
});

test('the self-serve reset adds the "wasn\'t you" line the operator-minted one does not need', () => {
  const operator = vendorResetCode({ businessName: 'X', code: 'AAAA-BBBB', selfServe: false });
  const self = vendorResetCode({ businessName: 'X', code: 'AAAA-BBBB', selfServe: true });
  assert.match(self.html, /Someone asked to reset/i);
  assert.equal(/Someone asked to reset/i.test(operator.html), false);
});

test('a deal email always carries a way out of deal emails', () => {
  const url = 'https://we-rewards.com/unsubscribe?u=abc&t=xyz';
  const msg = dealDigest({
    name: 'Alex',
    items: [{ campaignId: 'c1', vendor: 'Taco Stand', title: 'Half price', body: 'Today only.' }],
    appUrl: 'https://we-rewards.com/?deal=c1',
    unsubscribeUrl: url,
  });
  // In the HTML the ampersands are entity-escaped, because an href is an
  // attribute value and a bare `&` there is invalid markup that some clients
  // repair by truncating the URL at the first parameter — which would drop the
  // token and turn the link into "that link didn't work".
  assert.ok(msg.html.includes(url.replace(/&/g, '&amp;')), 'no unsubscribe link in the footer');
  // The text part is not markup, so it carries the URL verbatim.
  assert.ok(msg.text.includes(url), 'no unsubscribe link in the text part');
});

test('one deal reads as that vendor, several read as a digest that names them all', () => {
  const one = dealDigest({ items: [{ campaignId: 'c1', vendor: 'Taco Stand', title: 'Half price tacos', body: 'Today.' }] });
  assert.equal(one.subject, 'Taco Stand: Half price tacos');

  const many = dealDigest({
    items: [
      { campaignId: 'c1', vendor: 'Taco Stand', title: 'Half price', body: 'Today.' },
      { campaignId: 'c2', vendor: 'Noodle Bar', title: 'Free drink', body: 'With any bowl.' },
      { campaignId: 'c3', vendor: 'The Pub', title: 'Quiz night', body: 'Eight sharp.' },
    ],
  });
  assert.equal(many.subject, '3 spots have something on');
  // The point of a digest is that a coalesced vendor stays VISIBLE. Every one
  // of them gets its own card, or the throttling is quietly eating vendors.
  for (const name of ['Taco Stand', 'Noodle Bar', 'The Pub']) {
    assert.ok(many.html.includes(name), `${name} is missing from the digest`);
    assert.ok(many.text.includes(name), `${name} is missing from the text digest`);
  }
});

test('an empty bundle composes nothing rather than an empty email', () => {
  assert.equal(dealDigest({ items: [] }), null);
  assert.equal(dealDigest({ items: [null] }), null);
  assert.equal(dealDigest({}), null);
});

test('templates survive the fields they are allowed to be missing', () => {
  // Every one of these is reachable: migration-042 made cuisine and friends
  // optional, a profile row can exist with no name, and a location count of one
  // is the common case that sends no `locations` array at all.
  assertWellFormed(applicationReceived({}), 'received/empty');
  assertWellFormed(applicationAccepted({}), 'accepted/empty');
  assertWellFormed(vendorResetCode({ code: 'AAAA-BBBB' }), 'reset/empty');
  assertWellFormed(
    dealDigest({ items: [{ campaignId: 'c1', vendor: 'X', title: 'T', body: 'B' }] }),
    'digest/no-name'
  );
});

test('a multi-location application is acknowledged as one, not as a single shop', () => {
  const many = applicationReceived({ businessName: 'Joes', contactName: 'Jo', locationCount: 3 });
  assert.match(many.text, /3 locations/);
  const one = applicationReceived({ businessName: 'Joes', contactName: 'Jo', locationCount: 1 });
  assert.equal(/locations/.test(one.text), false);
});
