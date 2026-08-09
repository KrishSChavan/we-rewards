// The AI receipt reader (src/lib/gemini-receipt.js), against a stubbed fetch.
//
// What's actually being pinned down here is the contract the receipt route
// depends on, and the two halves of it pull in opposite directions:
//
//   * EVERY infrastructure failure must resolve to null ("fall back to
//     tesseract"), never throw and never look like a verdict. A thrown error
//     here would 500 a scan that tesseract could have completed.
//   * A fraud verdict must NOT resolve to null, or the route would fall back to
//     tesseract — which has no authenticity check — and pay out on the forgery.
//
// Nothing here touches the network: fetch is replaced per case.

import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readReceiptWithGemini,
  geminiConfigured,
  geminiReady,
  resetGeminiBreaker,
} from '../src/lib/gemini-receipt.js';

const IMG = 'AAAA'; // stand-in base64; the stub never decodes it

/** An Interaction whose model output is `obj` as a JSON string. */
function interaction(obj) {
  return {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(obj) }] }],
  };
}

const GOOD = {
  is_receipt: true,
  authenticity_confidence: 0.95,
  reject_reason: null,
  vendor_name: 'Rothrock Cafe',
  total: 18.45,
  date: '2026-08-09',
  time: '13:22',
  raw_text: 'ROTHROCK CAFE\nTOTAL 18.45\n08/09/2026 1:22 PM',
};

/** Install a fetch stub; returns a `calls` array and restores on cleanup. */
function stubFetch(t, handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length);
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  resetGeminiBreaker();
  process.env.GEMINI_API_KEY = 'test-key';
});

after(() => { delete process.env.GEMINI_API_KEY; });

test('no API key → null, and never calls out', async (t) => {
  delete process.env.GEMINI_API_KEY;
  const calls = stubFetch(t, () => jsonResponse(interaction(GOOD)));
  assert.equal(geminiConfigured(), false);
  assert.equal(geminiReady(), false);
  assert.equal(await readReceiptWithGemini(IMG), null);
  assert.equal(calls.length, 0, 'must not spend a request without a key');
});

test('a good response is normalized for the route', async (t) => {
  stubFetch(t, () => jsonResponse(interaction(GOOD)));
  const r = await readReceiptWithGemini(IMG);
  assert.deepEqual(r, {
    isReceipt: true,
    confidence: 0.95,
    rejectReason: null,
    vendorName: 'Rothrock Cafe',
    total: 18.45,
    date: '2026-08-09',
    time: '13:22',
    rawText: GOOD.raw_text,
  });
});

test('sends the image inline with the key header and a JSON schema', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(interaction(GOOD)));
  await readReceiptWithGemini(IMG, 'image/png');

  const { url, init } = calls[0];
  assert.match(url, /\/v1beta\/interactions$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], 'test-key');

  const body = JSON.parse(init.body);
  const image = body.input.find((p) => p.type === 'image');
  assert.equal(image.data, IMG);
  assert.equal(image.mime_type, 'image/png', 'must forward the real mime, not assume JPEG');
  assert.equal(body.response_format.mime_type, 'application/json');
  assert.equal(body.response_format.schema.properties.is_receipt.type, 'boolean');
  // Nullable fields are the whole reason the model can say "I couldn't read
  // it" instead of inventing a total to satisfy the schema.
  assert.deepEqual(body.response_format.schema.properties.total.type, ['number', 'null']);
});

test('a fraud verdict is returned, NOT swallowed as a failure', async (t) => {
  stubFetch(t, () => jsonResponse(interaction({
    ...GOOD,
    is_receipt: false,
    authenticity_confidence: 0.9,
    reject_reason: 'photo of a screen',
  })));
  const r = await readReceiptWithGemini(IMG);
  // Returning null here would send the route to tesseract, which would read
  // the screenshot happily and award the points.
  assert.notEqual(r, null);
  assert.equal(r.isReceipt, false);
  assert.equal(r.rejectReason, 'photo of a screen');
});

test('reads the convenience output_text field when present', async (t) => {
  stubFetch(t, () => jsonResponse({ status: 'completed', output_text: JSON.stringify(GOOD) }));
  const r = await readReceiptWithGemini(IMG);
  assert.equal(r.total, 18.45);
});

test('survives a markdown-fenced JSON body', async (t) => {
  stubFetch(t, () => jsonResponse({
    status: 'completed',
    output_text: '```json\n' + JSON.stringify(GOOD) + '\n```',
  }));
  const r = await readReceiptWithGemini(IMG);
  assert.equal(r.vendorName, 'Rothrock Cafe');
});

test('coerces a stringified total and clamps confidence', async (t) => {
  stubFetch(t, () => jsonResponse(interaction({
    ...GOOD, total: '$18.45', authenticity_confidence: 1.4,
  })));
  const r = await readReceiptWithGemini(IMG);
  assert.equal(r.total, 18.45);
  assert.equal(r.confidence, 1);
});

test('unreadable fields come back as null, not guesses', async (t) => {
  stubFetch(t, () => jsonResponse(interaction({
    ...GOOD, vendor_name: null, total: null, date: null, time: null,
  })));
  const r = await readReceiptWithGemini(IMG);
  assert.equal(r.vendorName, null);
  assert.equal(r.total, null);
  assert.equal(r.rawText, GOOD.raw_text, 'transcription still lets the route parse them');
});

test('a missing is_receipt verdict is a failure, not an implicit pass', async (t) => {
  const { is_receipt, ...noVerdict } = GOOD;
  stubFetch(t, () => jsonResponse(interaction(noVerdict)));
  // Defaulting to "genuine" here would let a malformed response wave through
  // exactly the images this reader exists to catch.
  assert.equal(await readReceiptWithGemini(IMG), null);
});

test('non-JSON output (e.g. a truncated response) → null', async (t) => {
  stubFetch(t, () => jsonResponse({ status: 'completed', output_text: '{"is_receipt": tru' }));
  assert.equal(await readReceiptWithGemini(IMG), null);
});

test('a non-completed interaction → null', async (t) => {
  stubFetch(t, () => jsonResponse({ status: 'failed', steps: [] }));
  assert.equal(await readReceiptWithGemini(IMG), null);
});

test('a thrown fetch (network/timeout) → null, never a rejection', async (t) => {
  stubFetch(t, () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  assert.equal(await readReceiptWithGemini(IMG), null);
});

test('429 opens the breaker immediately — later scans skip the call entirely', async (t) => {
  const calls = stubFetch(t, () => jsonResponse({ error: 'RESOURCE_EXHAUSTED' }, 429));
  assert.equal(await readReceiptWithGemini(IMG), null);
  assert.equal(geminiReady(), false, 'quota is gone; stop paying the timeout per upload');

  assert.equal(await readReceiptWithGemini(IMG), null);
  assert.equal(calls.length, 1, 'the second scan must not call out at all');
});

test('one-off failures do not open the breaker; a streak of three does', async (t) => {
  const calls = stubFetch(t, () => jsonResponse({}, 500));

  await readReceiptWithGemini(IMG);
  assert.equal(geminiReady(), true, 'a single blip must not disable the reader');
  await readReceiptWithGemini(IMG);
  assert.equal(geminiReady(), true);
  await readReceiptWithGemini(IMG);
  assert.equal(geminiReady(), false, 'a sustained outage should stop costing every scan a timeout');
  assert.equal(calls.length, 3);
});

test('a success resets the failure streak', async (t) => {
  let n = 0;
  stubFetch(t, () => (++n === 3 ? jsonResponse(interaction(GOOD)) : jsonResponse({}, 500)));

  await readReceiptWithGemini(IMG); // fail 1
  await readReceiptWithGemini(IMG); // fail 2
  await readReceiptWithGemini(IMG); // success → streak cleared
  await readReceiptWithGemini(IMG); // fail 1 again, not 3
  assert.equal(geminiReady(), true, 'intermittent failures around successes must not trip it');
});
