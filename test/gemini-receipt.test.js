// The AI receipt reader (src/lib/gemini-receipt.js), against a stubbed fetch.
//
// What's actually being pinned down here is the three-outcome contract the
// receipt route depends on, and its parts pull in opposite directions:
//
//   * A genuine infrastructure failure must resolve to null ("fall back to
//     tesseract"), never throw and never look like a verdict. A thrown error
//     here would 500 a scan that tesseract could have completed.
//   * A fraud verdict must NOT resolve to null, or the route would fall back to
//     tesseract — which has no authenticity check — and pay out on the forgery.
//   * Neither may an outcome THE UPLOADED IMAGE CAN STEER once the reader has
//     demonstrably answered: a safety block, output truncated at the token
//     ceiling, a response with no verdict in it. Those resolve to
//     { unreadable: true }, which the route turns into "retake the photo" — and
//     they must not touch the failure streak, because three crafted uploads
//     opening the 60s breaker would switch the forgery check off for every
//     student scanning at the time.
//   * A TIMEOUT belongs with the infrastructure failures, not with those. It is
//     the one outcome that proves nothing came back, and classing it as
//     "unreadable" would mean a hanging Gemini never opens the breaker: the
//     fallback stays switched off for the whole incident and every student is
//     told to retake a photo that was fine.
//   * AND BECAUSE unreadables sit outside the breaker on purpose, a fault that
//     loses EVERY verdict refuses EVERY claim with no fallback. That behaviour
//     stands (it is the safe direction for money), so the last group of cases
//     pins the only thing that can go wrong with it silently: the operator gets
//     paged when the lost-verdict rate is systemic, and is NOT paged for the bad
//     photos that arrive all day.
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

/**
 * Capture the reader's operator-facing log lines. The systemic-fault escalation
 * is observable here on purpose: the console.error is the half of the alert that
 * survives a deploy with no VAPID keys, so it is what a test can pin. (The web
 * push itself is a lazily-imported, un-awaited notifyAdmins that is a silent
 * no-op without VAPID keys — which is the state of the test env.)
 */
function captureConsole(t) {
  const out = { warn: [], error: [] };
  const real = { warn: console.warn, error: console.error };
  console.warn = (...args) => out.warn.push(args.join(' '));
  console.error = (...args) => out.error.push(args.join(' '));
  t.after(() => { console.warn = real.warn; console.error = real.error; });
  return out;
}

/** The lost-verdict shape the alerting cases drive: reader answered, no verdict. */
const LOST_VERDICT = { status: 'failed', steps: [] };

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

test('asks for enough output budget that a long receipt is not a permanent 400', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(interaction(GOOD)));
  await readReceiptWithGemini(IMG);
  // This ceiling is a product decision, not tuning, which is why it is pinned:
  // output truncated at max_output_tokens is classed { unreadable: true }, so the
  // student is told to retake a photo that was fine and the retake transcribes to
  // the same length — the claim can never clear. A ceiling is a limit, not a
  // spend (only generated tokens are billed), so the headroom is close to free.
  assert.ok(JSON.parse(calls[0].init.body).generation_config.max_output_tokens >= 8_192,
    'lowering this makes a long grocery receipt unclaimable, not cheaper');
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

test('a missing is_receipt verdict asks for a retake, not an implicit pass', async (t) => {
  const { is_receipt, ...noVerdict } = GOOD;
  stubFetch(t, () => jsonResponse(interaction(noVerdict)));
  // Defaulting to "genuine" here would let a malformed response wave through
  // exactly the images this reader exists to catch — and so would null, because
  // null sends the same image to tesseract, which waves everything through.
  assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
});

test('non-JSON output (e.g. truncated at the token ceiling) → unreadable, NOT null', async (t) => {
  stubFetch(t, () => jsonResponse({ status: 'completed', output_text: '{"is_receipt": tru' }));
  // How much text there is to transcribe is a property of the photo, so an image
  // can provoke this. null here would be a forger's way of choosing tesseract.
  assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
});

test('a non-completed interaction (e.g. a safety block) → unreadable, NOT null', async (t) => {
  stubFetch(t, () => jsonResponse({ status: 'failed', steps: [] }));
  // Which images trip a safety filter is decided by the images.
  assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
});

test('a timeout → null (an outage), and counts toward the breaker streak', async (t) => {
  const calls = stubFetch(t, () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  });
  // A timeout is ambiguous — a pathological upload can make Flash-Lite chew past
  // 9s, but so can an endpoint that accepts the socket and black-holes it, the
  // usual shape of a provider incident — and from inside the catch the two are
  // indistinguishable. It resolves as an outage, because what THAT gets wrong is
  // one slow-image bypass of a check the streak gate was built to absorb, while
  // the other reading takes the whole receipt feature down: no breaker, no
  // tesseract, and every student told for the length of the incident to retake a
  // receipt that was already flat and well lit.
  assert.equal(await readReceiptWithGemini(IMG), null, 'null = fall back to tesseract');
  assert.equal(await readReceiptWithGemini(IMG), null);
  assert.equal(geminiReady(), true, 'one slow read must not disable the reader');
  await readReceiptWithGemini(IMG);
  assert.equal(geminiReady(), false, 'a hanging Gemini MUST open the breaker — this is the fix');
  assert.equal(calls.length, 3, 'and the fourth scan skips the 9s wait entirely');
});

test('a socket/DNS error → null, never a rejection', async (t) => {
  // Our side of the wire, and nothing the photograph chose: this is the real
  // "fall back to tesseract" case.
  stubFetch(t, () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }); });
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

test('unreadable outcomes never open the breaker, however many arrive', async (t) => {
  // THE ATTACK THIS CLOSES. Every one of these is image-steerable, so if they
  // counted toward the streak a forger could send three crafted photos and buy a
  // 60-second window in which EVERY student's scan skips the forgery gate
  // entirely — one attacker switching the check off for the whole campus.
  const calls = stubFetch(t, () => jsonResponse({ status: 'failed', steps: [] }));

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
  }
  assert.equal(geminiReady(), true, 'a stream of bad photos is not an outage');
  assert.equal(calls.length, 5, 'and every scan still gets its forgery check');
});

test('an unreadable neither counts toward the streak nor clears it', async (t) => {
  // Two real failures, an unreadable in the middle, then a third real failure.
  // The breaker must open on the LAST one: not earlier (the unreadable did not
  // count) and not later (it did not reset the streak the way a verdict does).
  let n = 0;
  stubFetch(t, () => (++n === 3 ? jsonResponse({ status: 'failed', steps: [] }) : jsonResponse({}, 500)));

  await readReceiptWithGemini(IMG); // real failure 1
  await readReceiptWithGemini(IMG); // real failure 2
  await readReceiptWithGemini(IMG); // unreadable — must not be counted
  assert.equal(geminiReady(), true, 'an unreadable must not be the third strike');
  await readReceiptWithGemini(IMG); // real failure 3
  assert.equal(geminiReady(), false, 'nor may it wipe the two genuine failures');
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

// ---- The systemic-fault alert (gemini-receipt.js recordReaderOutcome) ----
// These cover the failure mode the "retake, never silently fall back" decision
// did not contemplate: if Gemini loses EVERY verdict (an API-shape change, a new
// safety filter, a quota-shaped degradation), unreadables are deliberately
// outside the breaker, so receipt claims fail closed for every student with no
// fallback. That stays true — it is the safe direction for money — but it must
// not be invisible, and it must not become a page every time somebody
// photographs a menu.

test('one lost verdict does not page the operator', async (t) => {
  const log = captureConsole(t);
  stubFetch(t, () => jsonResponse(LOST_VERDICT));

  assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
  assert.equal(log.warn.length, 1, 'still logs the per-read line');
  assert.deepEqual(log.error, [], 'a single bad photo is not an incident');
});

test('bad photos short of the floor do not page, however the window fills', async (t) => {
  const log = captureConsole(t);
  stubFetch(t, () => jsonResponse(LOST_VERDICT));

  // Nine: one short of UNREADABLE_ALERT_MIN, and every one of them 100% of the
  // reads in the window. The floor is what keeps one stubborn student's run of
  // retakes (a failed read never reaches the 3/day claim cap) off the operator's
  // phone, so it must hold even at a 100% rate.
  for (let i = 0; i < 9; i += 1) await readReceiptWithGemini(IMG);
  assert.deepEqual(log.error, [], 'nine is under the floor');
});

test('a sustained stream of lost verdicts pages the operator, once', async (t) => {
  const log = captureConsole(t);
  // The exact systemic shape this alert was added for: the API answers 200 with
  // an interaction that never reaches 'completed' — an API-shape change, a new
  // safety filter, a soft quota envelope. Every student's claim is refused and
  // nothing else in the system notices.
  stubFetch(t, () => jsonResponse({ status: 'in_progress', steps: [] }));

  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true });
  }
  assert.ok(log.warn.every((l) => l.includes('status in_progress')),
    'the per-read line names the status, so the operator can see it is one cause');
  assert.equal(log.error.length, 1, 'the tenth crosses the line');
  const alert = log.error[0];
  // Not "SYSTEMIC FAULT": this module sees no user id, so a rate of 10-of-10 is
  // indistinguishable from one client retrying one bad photo, and 30 reads per IP
  // per 15 min is the whole window. The line must therefore name both readings
  // instead of asserting the one it has not established.
  assert.match(alert, /READER DEGRADED/);
  assert.doesNotMatch(alert, /SYSTEMIC FAULT/, 'do not assert a cause the rate cannot prove');
  assert.match(alert, /one client retrying/, 'the benign reading is offered');
  assert.match(alert, /whole stream/, 'and so is the serious one');
  assert.match(alert, /10 of 10 reads in 15 min lost their verdict/);
  // The runbook, in the line itself: this is the only lever that restores claims
  // during a systemic fault, and it works because geminiConfigured() re-reads the
  // env on every call (see the "no API key -> null" case at the top of this file).
  assert.match(alert, /unset\s+GEMINI_API_KEY/i);
  assert.match(alert, /failing closed/);

  // One page per incident: the operator's phone must not buzz per upload for the
  // whole outage, and the console.warn per read is the running record.
  for (let i = 0; i < 6; i += 1) await readReceiptWithGemini(IMG);
  assert.equal(log.error.length, 1, 'the cooldown outlasts the window');

  // AND THE ALERT CHANGES NOTHING. It must not open the breaker or enable the
  // fallback, or a forger with sixteen crafted images would have bought exactly
  // the bypass the streak gate exists to deny them: a window in which every
  // student's scan skips the forgery check.
  assert.equal(geminiReady(), true, 'alerting must not disable the reader');
  assert.deepEqual(await readReceiptWithGemini(IMG), { unreadable: true },
    'and claims still fail closed rather than falling back');
});

test('lost verdicts among healthy traffic never page, whatever the count', async (t) => {
  const log = captureConsole(t);
  // One unreadable per two good reads: ten lost verdicts — past the floor — but
  // 33% of a stream that is plainly producing verdicts. This is the ordinary
  // world (people photograph screens and menus), and it must never page.
  let n = 0;
  stubFetch(t, () => (++n % 3 === 0 ? jsonResponse(LOST_VERDICT) : jsonResponse(interaction(GOOD))));

  for (let i = 0; i < 30; i += 1) await readReceiptWithGemini(IMG);
  assert.deepEqual(log.error, [], 'the denominator is what tells a fault from bad photos');
});

test('a fraud verdict counts as the reader working, not as a lost verdict', async (t) => {
  const log = captureConsole(t);
  // Nine lost verdicts and nine "this is a photo of a screen" verdicts: 50%.
  // A rejection is PROOF the reader is healthy — counting it with the failures
  // would page the operator during a burst of genuine forgery attempts, which is
  // the one time the reader is doing exactly its job.
  let n = 0;
  stubFetch(t, () => (++n % 2 === 0
    ? jsonResponse(LOST_VERDICT)
    : jsonResponse(interaction({ ...GOOD, is_receipt: false, reject_reason: 'photo of a screen' }))));

  for (let i = 0; i < 18; i += 1) await readReceiptWithGemini(IMG);
  assert.deepEqual(log.error, [], 'a rejection is a verdict, and belongs in the denominator');
});

test('outages are not lost verdicts — they are the breakers job, not the pagers', async (t) => {
  const log = captureConsole(t);
  // Twelve 500s. These already have a symptom (the breaker, and the "pausing
  // receipt AI" warn) and they DO fall back to tesseract, so they must not also
  // be counted into the lost-verdict rate: the alert exists for the case that has
  // no breaker and no fallback.
  stubFetch(t, () => jsonResponse({}, 500));
  for (let i = 0; i < 12; i += 1) await readReceiptWithGemini(IMG);
  assert.equal(log.error.length, 0, 'an outage must not raise the lost-verdict alarm');
  assert.ok(log.warn.some((l) => l.includes('pausing receipt AI')), 'the breaker still logs');
});
