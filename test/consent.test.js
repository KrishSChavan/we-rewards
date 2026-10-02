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
