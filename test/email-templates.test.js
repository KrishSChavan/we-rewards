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
  studentEmailCode,
  dealDigest,
  pointsReminder,
  announcement,
  isEmailableReminder,
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
  // Zero-width and non-spacing characters inside a hidden element are the
  // signature of keyword obfuscation. A padding run of them in the preheader
  // is what made Outlook report "invisible characters found in email" and file
  // the whole message as junk. The guard is on what a CLIENT decodes, not on
  // the source, because the entity forms are what a template would reach for.
  const decoded = msg.html
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&zwnj;/g, '\u200c')
    .replace(/&zwj;/g, '\u200d')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&shy;/g, '\u00ad');
  const invisible = decoded.match(/[\u00a0\u00ad\u034f\u200b-\u200f\u2060-\u2064\ufeff]/g) ?? [];
  assert.equal(invisible.length, 0, `${label}: ships ${invisible.length} invisible characters`);
  // Comments ship to the recipient and are read by content filters. Notes to
  // ourselves belong in the source, not in the message.
  assert.equal(/<!--/.test(msg.html.replace(/^<!doctype html>/i, '')), false, `${label}: emits an HTML comment`);
  // RFC 5322 caps a line at 998 octets. Past it the message is re-encoded in
  // transit, which is both a spam signal and a way to mangle a printed code.
  const longest = Math.max(...msg.html.split('\n').map((l) => l.length));
  assert.ok(longest <= 998, `${label}: has a ${longest}-character line`);
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
  // The link-code email is the one Outlook was junking, and it had no coverage
  // at all until that happened. Both branches: the merge copy is a different
  // body and a longer preheader, so it is a different message to get wrong.
  assertWellFormed(studentEmailCode({ code: '482913', signedInAs: 'casey.p@gmail.com' }), 'student link');
  assertWellFormed(studentEmailCode({ code: '482913', signedInAs: 'casey.p@gmail.com', willMerge: true }), 'student link/merge');
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

/* ---------- the re-engagement pair (migration-064) ---------- */

test('only a reminder tier that names a real fact may be emailed', () => {
  // THE ANTI-SPAM RULE, as a pure function. migration-060 refused reminders an
  // email fallback because "mailing someone to say nothing has happened is how
  // an account gets marked as spam", and that reasoning survives here: the three
  // tiers that name a balance, a shortfall or a live deal go out, and the two
  // that are really adverts do not. The generic tier is the one that matters —
  // it is by its own admission the line "with no number in it".
  assert.equal(isEmailableReminder('afford'), true);
  assert.equal(isEmailableReminder('close'), true);
  assert.equal(isEmailableReminder('deal'), true);
  assert.equal(isEmailableReminder('discover'), false, 'an advert for a spot they have never visited is emailable');
  assert.equal(isEmailableReminder('generic'), false, 'the content-free tier is emailable');
  assert.equal(isEmailableReminder(undefined), false);

  // And the template itself is the gate, not just the predicate: a caller that
  // forgets to check still cannot compose one.
  assert.equal(pointsReminder({ kind: 'generic', vendorName: 'Taco Bar' }), null);
  assert.equal(pointsReminder({ kind: 'discover', vendorName: 'Taco Bar' }), null);
});

test('a reminder refuses to assert a fact it was not given', () => {
  // The same rule reminders.js applies to a balance it could not read: saying
  // "you have 0 pts" to someone holding 400 is worse than saying nothing. A tier
  // missing the numbers its own sentence promises composes nothing at all.
  assert.equal(pointsReminder({ kind: 'afford', vendorName: 'Taco Bar' }), null, 'afford with no points composed anyway');
  assert.equal(pointsReminder({ kind: 'afford', vendorName: 'Taco Bar', points: 120 }), null, 'afford with no reward composed anyway');
  assert.equal(pointsReminder({ kind: 'close', vendorName: 'Taco Bar', rewardTitle: 'a free taco' }), null, 'close with no shortfall composed anyway');
  assert.equal(pointsReminder({ kind: 'deal', vendorName: 'Taco Bar' }), null, 'deal with no title composed anyway');
  // No vendor to name means no sentence worth sending, whatever the tier.
  assert.equal(pointsReminder({ kind: 'afford', points: 120, rewardTitle: 'a free taco' }), null);
});

test('the emailable tiers compose a well-formed message that names the facts', () => {
  const afford = pointsReminder({
    name: 'Sam Reyes', kind: 'afford', vendorName: 'Taco Bar',
    rewardTitle: 'a free taco', points: 120,
    appUrl: 'https://we-rewards.com/', unsubscribeUrl: 'https://we-rewards.com/unsubscribe?u=1&t=2',
  });
  assertWellFormed(afford, 'reminder/afford');
  assert.match(afford.subject, /Taco Bar/);
  assert.match(afford.subject, /120/);
  assert.match(afford.text, /120 pts/);
  assert.match(afford.text, /a free taco/);

  const close = pointsReminder({
    name: 'Sam', kind: 'close', vendorName: 'Taco Bar',
    rewardTitle: 'a free taco', shortfall: 40,
    appUrl: 'https://we-rewards.com/', unsubscribeUrl: 'https://we-rewards.com/u',
  });
  assertWellFormed(close, 'reminder/close');
  assert.match(close.subject, /40 pts to go/);

  const dealMsg = pointsReminder({
    name: 'Sam', kind: 'deal', vendorName: 'Taco Bar', dealTitle: 'Half price tacos',
    appUrl: 'https://we-rewards.com/', unsubscribeUrl: 'https://we-rewards.com/u',
  });
  assertWellFormed(dealMsg, 'reminder/deal');
  assert.match(dealMsg.subject, /Half price tacos/);

  // THE SUBJECT IS NOT THE PUSH TITLE, deliberately. composeReminder's voice is
  // "Free food is waiting!", which is warm on a lock screen and the exact shape
  // a spam filter scores on in a subject line. Reaching the inbox is the entire
  // reason this template exists separately.
  for (const m of [afford, close, dealMsg]) {
    assert.equal(/^Free food is waiting/.test(m.subject), false, 'the push voice leaked into a subject line');
    assert.equal(m.subject.includes('!'), false, `an exclamation mark reached a subject line: ${m.subject}`);
  }
});

test('reminder and announcement emails carry the way out', () => {
  // Both are marketing, and one opt-out covers every marketing message we send
  // (src/routes/unsubscribe.js sets email_opt_in false AND suppresses the
  // address at the marketing scope). The link has to be in the body too, not
  // only in the List-Unsubscribe header src/lib/email.js adds.
  const r = pointsReminder({
    kind: 'close', vendorName: 'Taco Bar', rewardTitle: 'a free taco', shortfall: 40,
    unsubscribeUrl: 'https://we-rewards.com/unsubscribe?u=1&t=2',
  });
  assert.match(r.html, /unsubscribe\?u=1/, 'a marketing email had no opt-out in its body');
  assert.match(r.text, /Stop these emails/);

  const a = announcement({
    title: 'Finals week', body: 'Lots of spots are running something this week.',
    unsubscribeUrl: 'https://we-rewards.com/unsubscribe?u=1&t=2',
  });
  assert.match(a.html, /unsubscribe\?u=1/);
});

test('an announcement escapes the operator’s own words', () => {
  // Operator copy comes from a textarea on /admin and reaches every account on
  // campus. A title that takes the layout apart would do it in thousands of
  // inboxes at once, so this is escaped like any other attacker-influenced text.
  const a = announcement({
    name: 'Sam',
    title: '<script>alert(1)</script>',
    body: 'Body & "quotes" <b>here</b>',
    unsubscribeUrl: 'https://we-rewards.com/u',
  });
  assertWellFormed(a, 'announcement/escaping');
  assert.equal(a.html.includes('<script>'), false, 'a script tag survived into the HTML');
  assert.equal(a.html.includes('<b>here</b>'), false, 'operator HTML was rendered rather than escaped');
  assert.match(a.html, /&amp;/);
});

test('an announcement with no body is refused rather than sent empty', () => {
  // create_admin_broadcast raises BODY_REQUIRED so this should be unreachable,
  // but an announcement with nothing in it is not worth a slot from a student's
  // two-per-day, and null is how the worker is told to settle without sending.
  assert.equal(announcement({ title: 'Something' }), null);
  assert.equal(announcement({ title: 'Something', body: '   ' }), null);
  // A missing TITLE is survivable: the body is the message.
  assertWellFormed(announcement({ body: 'The app is down for an hour tonight.' }), 'announcement/no-title');
});
