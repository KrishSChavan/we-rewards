// Unit tests for the scan-here QR poster's input handling (src/lib/qr-poster.js).
//
// Everything here decides BEFORE any storage call, which is the point: the file
// name becomes both a storage key and a Content-Disposition filename, and the
// bytes arrive base64'd inside a JSON body from the operator's browser. Those
// two are the whole attack surface of the feature — the rest is a service-role
// upload into a private bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validPosterName, decodePosterBody, POSTER_MAX_BYTES } from '../src/lib/qr-poster.js';

const b64 = (s) => Buffer.from(s).toString('base64');

/* ---------- file names ---------- */

test('an ordinary poster name passes through with its content type', () => {
  const out = validPosterName('scan-here-poster.pdf');
  assert.equal(out.error, undefined);
  assert.equal(out.name, 'scan-here-poster.pdf');
  assert.equal(out.contentType, 'application/pdf');
});

test('the extension decides the content type, case-insensitively', () => {
  assert.equal(validPosterName('Poster.PDF').contentType, 'application/pdf');
  assert.equal(validPosterName('art.ZIP').contentType, 'application/zip');
  assert.equal(validPosterName('qr.JPG').contentType, 'image/jpeg');
  assert.equal(validPosterName('qr.jpeg').contentType, 'image/jpeg');
});

test('an unsupported or missing extension is refused', () => {
  // .html and .svg are the ones that matter: both can carry script, and this is
  // a file other people are told to download and open.
  for (const name of ['poster.html', 'poster.svg', 'poster.exe', 'poster', 'poster.']) {
    assert.match(validPosterName(name).error, /file types/, `should reject ${name}`);
  }
});

test('a directory traversal attempt keeps only the final segment', () => {
  // The name is concatenated into a storage key, so '../' must never survive.
  assert.equal(validPosterName('../../secrets/poster.pdf').name, 'poster.pdf');
  assert.equal(validPosterName('C:\\Users\\me\\poster.pdf').name, 'poster.pdf');
});

test('quotes and control characters are stripped, so the download header can’t be broken', () => {
  const out = validPosterName('po"ster\r\n.pdf');
  assert.equal(out.error, undefined);
  assert.ok(!/["\r\n]/.test(out.name), `unsafe characters survived: ${JSON.stringify(out.name)}`);
});

test('a name that is nothing but an extension is refused', () => {
  // '.pdf' would become a hidden file with no name at all.
  assert.match(validPosterName('.pdf').error, /file types/);
  assert.match(validPosterName('---.pdf').error, /name/);
});

/* ---------- the uploaded body ---------- */

test('a base64 payload decodes to the exact bytes', () => {
  const out = decodePosterBody({ filename: 'poster.pdf', data: b64('hello poster') });
  assert.equal(out.error, undefined);
  assert.equal(out.bytes.toString(), 'hello poster');
  assert.equal(out.name, 'poster.pdf');
  assert.equal(out.contentType, 'application/pdf');
});

test('a data: URL is accepted too — that is what FileReader produces', () => {
  const out = decodePosterBody({ filename: 'poster.pdf', data: `data:application/pdf;base64,${b64('hello poster')}` });
  assert.equal(out.error, undefined);
  assert.equal(out.bytes.toString(), 'hello poster');
});

test('the content type comes from the filename, never from the data URL', () => {
  // A data: URL declaring text/html must not make us serve the file as HTML.
  const out = decodePosterBody({ filename: 'poster.pdf', data: `data:text/html;base64,${b64('<script>')}` });
  assert.equal(out.contentType, 'application/pdf');
});

test('a bad filename is caught before the payload is decoded', () => {
  const out = decodePosterBody({ filename: 'poster.html', data: b64('x') });
  assert.match(out.error, /file types/);
  assert.equal(out.bytes, undefined);
});

test('an empty, missing or non-base64 payload is refused', () => {
  for (const data of ['', undefined, null, 42, 'not base64!!', b64('')]) {
    const out = decodePosterBody({ filename: 'poster.pdf', data });
    assert.ok(out.error, `should reject ${JSON.stringify(data)}`);
  }
});

test('a file over the size cap is refused, with the size in the message', () => {
  // Just past the limit: the JSON parser in server.js allows the base64 to
  // arrive, so this cap is the one that actually holds.
  const tooBig = Buffer.alloc(POSTER_MAX_BYTES + 1).toString('base64');
  const out = decodePosterBody({ filename: 'poster.pdf', data: tooBig });
  assert.match(out.error, /10 MB/);
});

test('a file exactly at the cap is allowed (boundary)', () => {
  const exact = Buffer.alloc(POSTER_MAX_BYTES).toString('base64');
  const out = decodePosterBody({ filename: 'poster.pdf', data: exact });
  assert.equal(out.error, undefined);
  assert.equal(out.bytes.length, POSTER_MAX_BYTES);
});
