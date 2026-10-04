// Unit tests for the terms-consent gate (src/middleware/auth.js).
//
// consentRejection is the whole policy, factored out of requireConsent so every
// branch runs without a database. This is the gate that makes the sign-in modal
// more than decoration — a client can dismiss the modal, but not these rules —
// so the failure-closed cases matter more than the happy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentRejection } from '../src/middleware/auth.js';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { TERMS_VERSION, TERMS_DOCUMENTS } from '../src/lib/terms.js';

const V = '2026-07-19';
const accepted = { terms_accepted_at: '2026-07-19T12:00:00Z', terms_version: V };

test('a profile that accepted the current version is allowed through', () => {
  assert.equal(consentRejection(accepted, V), null);
});

test('no profile row at all is rejected as CONSENT_REQUIRED', () => {
  // The migration-022 case: OAuth created auth.users, but the student never
  // accepted, so no profile was created and no account exists.
  const r = consentRejection(null, V);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'CONSENT_REQUIRED');
});

test('a profile with a null accepted_at is rejected as CONSENT_REQUIRED', () => {
  // Pre-migration rows created by the old auto-create trigger look like this.
  const r = consentRejection({ terms_accepted_at: null, terms_version: null }, V);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'CONSENT_REQUIRED');
});

test('a profile on a superseded version is rejected as CONSENT_STALE', () => {
  const r = consentRejection({ terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: '2026-01-01' }, V);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'CONSENT_STALE', 'stale consent must be distinguishable from none');
});

test('stale and missing consent both report the version the client should show', () => {
  for (const profile of [null, { terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: 'old' }]) {
    assert.equal(consentRejection(profile, V).body.termsVersion, V);
  }
});

test('rejection is 403, never 401 — the token is valid, only consent is missing', () => {
  // The client keys off this: 401 means sign out and retry, 403 means prompt.
  // Conflating them would sign a student out instead of showing the modal.
  assert.equal(consentRejection(null, V).status, 403);
});

test('a timestamp with a version of null is rejected, not allowed through', () => {
  // Defensive: a half-written row must fail closed rather than match by accident.
  const r = consentRejection({ terms_accepted_at: '2026-07-19T12:00:00Z', terms_version: null }, V);
  assert.ok(r, 'must not be allowed through');
  assert.equal(r.body.error, 'CONSENT_STALE');
});

test('the live TERMS_VERSION is a usable version string', () => {
  assert.equal(typeof TERMS_VERSION, 'string');
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/, 'bump this to the document “Last Updated” date');
  // A profile stamped with the real constant must pass against itself.
  assert.equal(
    consentRejection({ terms_accepted_at: '2026-07-19T12:00:00Z', terms_version: TERMS_VERSION }),
    null
  );
});

test('every consent document says the same "Last Updated" date TERMS_VERSION claims', () => {
  // The process at the top of src/lib/terms.js is "bump TERMS_VERSION to the new
  // Last Updated date and update the matching date in the HTML", and until now
  // nothing checked the second half. Half-doing it is the one failure mode that
  // is invisible in production and indefensible afterwards: the consent record
  // points at a date the document does not carry, so there is no way to prove
  // which text a student actually agreed to.
  //
  // Compared as a parsed calendar date, not as a string, because the constant is
  // ISO ('2026-10-01') and the documents are prose ('October 1, 2026').
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = TERMS_VERSION.split('-').map(Number);
  const expected = `${MONTHS[m - 1]} ${d}, ${y}`;

  for (const doc of TERMS_DOCUMENTS) {
    const html = readFileSync(new URL(`../legal/${basename(doc.path)}`, import.meta.url), 'utf8');
    const found = html.match(/Last Updated:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
    assert.ok(found, `${doc.path} has no "Last Updated:" line to check`);
    assert.equal(
      found[1],
      expected,
      `${doc.path} says "Last Updated: ${found[1]}" but TERMS_VERSION is ${TERMS_VERSION} `
      + '(bump both together, or neither — see the header of src/lib/terms.js)'
    );
  }
});

test('every consent document the modal links is under /legal/', () => {
  // server.js allowlists exactly these basenames; a path that drifts out of
  // /legal/ would 404 in the modal and strand the student at the gate.
  assert.ok(TERMS_DOCUMENTS.length >= 2);
  for (const doc of TERMS_DOCUMENTS) {
    assert.match(doc.path, /^\/legal\/[\w-]+\.html$/, `${doc.key} has a servable path`);
    assert.ok(doc.label, `${doc.key} has a label for the checkbox link`);
  }
});

test('Privacy Policy section numbers are contiguous (append, never insert)', () => {
  // Sections are hand-numbered and cross-referenced by number ("see Section
  // 2.12"), so inserting one silently re-points every later reference. A gap or
  // a repeat here is what an insert-then-renumber, or a half-done one, leaves.
  const html = readFileSync(new URL('../legal/student-privacy-policy.html', import.meta.url), 'utf8');
  const h2 = [...html.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(h2, h2.map((_, i) => i + 1), `top-level sections run 1..n: ${h2}`);
  const subs = new Map();
  for (const [, a, b] of html.matchAll(/<h3>(\d+)\.(\d+) /g)) {
    if (!subs.has(a)) subs.set(a, []);
    subs.get(a).push(Number(b));
  }
  for (const [a, list] of subs) {
    assert.deepEqual(list, list.map((_, i) => i + 1), `subsections of ${a} run ${a}.1..n: ${list}`);
  }
});

test('Privacy Policy discloses the notification log it consents students to (migration-062)', () => {
  // TERMS_VERSION 2026-10-03 exists because of these sentences; the bump without
  // them would re-prompt every student to agree to text that says nothing new.
  const html = readFileSync(new URL('../legal/student-privacy-policy.html', import.meta.url), 'utf8');
  const s26 = html.slice(html.indexOf('<h3>2.6 '), html.indexOf('<h3>2.7 '));
  assert.ok(s26.length > 0, '§2.6 found');
  assert.match(s26, /record of every notification and email we send you, or try to send you/);
  assert.match(s26, /only the subject line, never the body, and never any code/);
  assert.match(s26, /type of device and browser/);
  assert.match(s26, /never record its push address or keys/);
  assert.match(s26, /administrative screen/);
  assert.match(s26, /30 days after the message, and immediately if you delete your account/);
  // The old wording said the counters were kept "purely" for frequency limits;
  // the admin budget view makes that false.
  assert.doesNotMatch(s26, /purely/);
  assert.match(html, /<td>Check and troubleshoot notification delivery \(admin-only\)<\/td>/, '§3 row');
  assert.match(html, /<td>Notification records \([^<]*\)<\/td><td>About 30 days after the message; deleted immediately if you delete your account<\/td>/, '§5 row');
  const s71 = html.slice(html.indexOf('<h3>7.1 '), html.indexOf('<h3>7.2 '));
  assert.match(s71, /your notification records/);
  assert.doesNotMatch(s71, /deal-notification records/);
  // A per-subscription id and the push-service family are stored too, so "by
  // its type only" would be an over-promise.
  assert.doesNotMatch(s26, /identified only by its type/);
  assert.match(s26, /which company's push service it uses/);
  assert.match(s26, /internal reference number/);
  // The per-student admin view shows the alert switches and live app-open
  // presence (alerts are held while the app is open), not just the log.
  assert.match(s26, /notification switches/);
  assert.match(s26, /app open at that moment/);
  const row3 = html.match(/<td>Check and troubleshoot notification delivery \(admin-only\)<\/td><td>([^<]*)<\/td>/);
  assert.ok(row3, '§3 row has a data cell');
  assert.match(row3[1], /notification switches/);
  assert.match(row3[1], /app open at that moment/);
});

test('Privacy Policy §2.9 no longer promises nearby records serve one purpose only (migration-062)', () => {
  // Each nearby alert is also written to the operator-visible notification log,
  // so "one purpose only" became false the day that log shipped.
  const html = readFileSync(new URL('../legal/student-privacy-policy.html', import.meta.url), 'utf8');
  const s29 = html.slice(html.indexOf('<h3>2.9 '), html.indexOf('<h3>2.10 '));
  assert.ok(s29.length > 0, '§2.9 found');
  assert.doesNotMatch(s29, /one purpose only/);
  assert.match(s29, /notification record described in Section 2\.6/);
  assert.match(s29, /check that it was delivered/);
  assert.match(s29, /copy is deleted about 30 days/);
});

test('Privacy Policy §12 discloses the email log kept for applicants and vendor contacts', () => {
  // The notification log records operator emails to applicants and vendor
  // contacts too, and those people are not covered by §2.6.
  const html = readFileSync(new URL('../legal/student-privacy-policy.html', import.meta.url), 'utf8');
  const s12 = html.slice(html.indexOf('<h2>12. '));
  assert.ok(s12.length > 0, '§12 found');
  assert.match(s12, /record of each email we send an applicant or vendor contact/);
  assert.match(s12, /subject line/);
  assert.match(s12, /about 30 days/);
});

test('Privacy Policy edits for migration-062 add no em dashes', () => {
  // Admin-visible copy rule; the sentences this change set touched are checked
  // so older em dashes elsewhere in the policy do not fail this.
  const html = readFileSync(new URL('../legal/student-privacy-policy.html', import.meta.url), 'utf8');
  for (const needle of ['notification record described in Section 2.6', 'internal reference number',
    'app open at that moment', 'record of each email we send an applicant']) {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, needle);
    const line = html.slice(html.lastIndexOf('\n', i), html.indexOf('\n', i));
    assert.doesNotMatch(line, /—/, `no em dash near "${needle}"`);
  }
});
