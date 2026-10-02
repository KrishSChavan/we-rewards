// Unit tests for the broadcast composer's link validator (src/routes/admin.js).
//
// A broadcast is the only student-facing copy in this product that an operator
// types by hand, and the "where it opens" field is the only part of it that is
// not just words: it becomes the `url` on a web-push payload, which the student
// service worker hands to clients.openWindow(). So it is a navigation target
// supplied as free text, and the two shapes that matter are the two that stop
// being same-origin:
//
//   'https://…'  walks the student out of the PWA entirely, and inside the
//                Capacitor iOS wrapper that means out of the app, with no way
//                back except relaunching it.
//   '//host'     is protocol-relative. It LOOKS like a path (it starts with a
//                slash, which is the check a careless validator makes) and
//                resolves to a different origin.
//
// Tested as a boundary rather than through the route, for the same reason
// safeSearch is: it is a pure function, and the interesting cases are all
// inputs rather than round trips.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastUrl } from '../src/routes/admin.js';

describe('broadcastUrl', () => {
  test('blank means the home screen, not an error', () => {
    // The field is optional, so "nothing typed" has to be a null URL rather
    // than a refusal the operator has to clear before they can send.
    for (const v of ['', '   ', null, undefined]) {
      assert.deepEqual(broadcastUrl(v), { url: null }, `${JSON.stringify(v)} should mean "no link"`);
    }
  });

  test('a single-slash path is accepted and trimmed', () => {
    assert.deepEqual(broadcastUrl('/?deals=1'), { url: '/?deals=1' });
    assert.deepEqual(broadcastUrl('  /?spot=abc  '), { url: '/?spot=abc' });
    assert.deepEqual(broadcastUrl('/'), { url: '/' });
  });

  test('an absolute URL is refused, whatever its scheme', () => {
    for (const v of ['https://evil.test/x', 'http://evil.test', 'javascript:alert(1)', 'data:text/html,x']) {
      assert.ok(broadcastUrl(v)?.error, `${v} must not be accepted as a broadcast link`);
    }
  });

  test('a protocol-relative URL is refused even though it starts with a slash', () => {
    // The case a "does it start with /" check lets through. Both of these are
    // other origins.
    assert.ok(broadcastUrl('//evil.test/x')?.error, 'protocol-relative URL accepted');
    assert.ok(broadcastUrl('//evil.test')?.error);
  });

  test('anything not starting with a slash is refused', () => {
    for (const v of ['spots', '?deals=1', 'mailto:a@b.c', '../admin/']) {
      assert.ok(broadcastUrl(v)?.error, `${v} must be refused`);
    }
  });

  test('an over-long link is refused rather than silently truncated', () => {
    // Truncating would produce a working link to the WRONG place, which is
    // worse than refusing: the operator would never know.
    const long = `/${'a'.repeat(300)}`;
    assert.ok(broadcastUrl(long)?.error, 'a 300-character link should be refused');
    assert.deepEqual(broadcastUrl(`/${'a'.repeat(190)}`), { url: `/${'a'.repeat(190)}` });
  });

  test('every refusal carries a sentence the operator can act on', () => {
    // The route hands `error` straight back as the message, so an empty or
    // jargon string would surface verbatim in the UI.
    for (const v of ['https://evil.test', '//evil.test', 'spots', `/${'a'.repeat(300)}`]) {
      const { error } = broadcastUrl(v);
      assert.equal(typeof error, 'string');
      assert.ok(error.length > 10, `unhelpful message for ${v}: ${error}`);
      assert.ok(!error.includes('—'), 'the repo copy rule applies to operator copy too');
    }
  });
});
