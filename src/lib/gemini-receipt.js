// Receipt reading via Google's Gemini API — the primary reader, with the
// tesseract worker in ocr.js as the fallback the caller reaches for.
//
// It does two things tesseract cannot do at all:
//   1. Judges whether the photo is a genuine printed receipt (a photo of a
//      screen, a screenshot, a hand-drawn "receipt", an edited total).
//   2. Reads the fields directly, instead of us regexing them out of noisy OCR
//      text — it copes with a total that wrapped a line or a faded date.
//
// PRIVACY: this is the one place a student's receipt photo leaves our server.
// It is POSTed to Google as inline base64 for the life of one request. We
// never write it to disk, the DB, or a log line, and nothing in this module
// may log the image or the recognized text. Listed in the Privacy Policy §4.
//
// ---- The contract with the caller ----
// THREE outcomes, and the line between the last two is the whole point of this
// module:
//
//   { isReceipt, ... }   A verdict was reached. "This is NOT a real receipt" is
//                        one of those verdicts and is NOT a failure: it resolves
//                        to `{ isReceipt: false, ... }` and the caller rejects
//                        the claim. Falling back to tesseract on a fraud verdict
//                        would launder the rejection, since tesseract has no
//                        authenticity check whatsoever — that would make the
//                        feature worse than useless.
//
//   { unreadable: true } The reader WAS reached and its verdict was LOST: output
//                        JSON cut off at MAX_OUTPUT_TOKENS, an Interaction whose
//                        status isn't 'completed' (a safety block), or a response
//                        with no is_receipt in it. Each of those is PROOF the
//                        model saw the image and answered, and each is steerable
//                        by the UPLOADED IMAGE, so resolving them to null would
//                        hand a forger the tesseract path on request: an image
//                        crafted to trip a safety filter or to blow the output
//                        budget would launder itself straight past the only
//                        forgery check in the system. The caller asks the student
//                        for a clearer photo instead, and these deliberately do
//                        NOT count toward the failure streak (see
//                        noteUnreadable) — a bad photo is not an outage.
//
//                        THE PRICE OF THAT, STATED PLAINLY: if Gemini starts
//                        losing EVERY verdict — an API-shape change, a new safety
//                        filter, a degradation that answers 200 with a status that
//                        isn't 'completed' — then receipt claims FAIL CLOSED for
//                        every student, on purpose, with no breaker and no
//                        tesseract fallback. That is the right direction for money
//                        (tesseract pays out on a photographed screen) but it is
//                        an outage of the feature, so it must not be invisible:
//                        recordReaderOutcome below watches the rate of lost
//                        verdicts separately from failureStreak and pages the
//                        operator when it is systemic. THE RUNBOOK LEVER is to
//                        unset GEMINI_API_KEY: geminiConfigured() reads the env on
//                        every call, so with it gone geminiReady() is false,
//                        readReceiptWithGemini returns null on its first line, and
//                        routes/student.js's reader 2 (tesseract) completes claims
//                        again — with no forgery check, which is the trade the
//                        operator is choosing when they pull it.
//
//                        A TIMEOUT IS NOT IN THIS LIST. Membership here requires
//                        evidence the reader answered, and a timeout is the one
//                        outcome that carries none: see the catch in
//                        readReceiptWithGemini for why it is classed as an
//                        outage even though that leaves one narrow bypass.
//
//   null                 No verdict AND no evidence the reader was ever reached:
//                        no API key, the breaker is open, a DNS/TLS/socket error,
//                        a timeout, a non-2xx, an HTTP body that isn't JSON,
//                        quota exhaustion. THIS is the "fall back to tesseract"
//                        signal.

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Flash-Lite: the cheapest multimodal tier, and fast enough to sit in front of
// a student tapping "submit". Overridable so a bad model id is an .env edit
// rather than a deploy (see scripts/check-gemini.js to verify one).
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Deliberately tight. This call is on the critical path of a request that
// still has to run tesseract afterwards if we give up, and the whole thing has
// to finish inside Heroku's 30s H12 window — the caller hands what's left of
// that budget to tesseract, so every second spent waiting here is a second the
// fallback doesn't get. Flash-Lite answers a 1600px receipt in ~2-4s.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 9_000;

// Long enough that raw_text can't truncate the JSON on a long grocery receipt —
// a cut-off response is unparseable, and since this branch classes that as
// { unreadable: true } (see the contract above) the student is asked to retake a
// photograph that was FINE, and the retake transcribes to the same length, so the
// claim can never clear. That makes headroom here a product decision, not tuning:
// 8_192 rather than the 4_096 this started at, because the typical receipt uses
// ~600 output tokens and a ceiling is a LIMIT, NOT A SPEND — Gemini bills the
// tokens actually generated, so doubling it costs nothing on the 99% of reads
// that never approach it and only buys room for the pathological long one. What
// it does risk is latency (a runaway generation has more rope), and that is
// already bounded by TIMEOUT_MS above. Kept at a value every Flash tier accepts;
// if a future model id rejects it the call 400s, which `npm run check:gemini`
// reports immediately (and which noteFailure parks behind the breaker).
const MAX_OUTPUT_TOKENS = 8_192;

// ---- Circuit breaker ----
// Once the daily free-tier quota is gone, EVERY scan would otherwise pay the
// full timeout before falling back — turning a working feature into a
// nine-second pause on every upload. So a quota error stops us calling at all
// for a while. Five minutes is the compromise: the per-minute quota resets
// inside it, and a spent daily quota costs one wasted call per 5 min until
// midnight PT rather than one per scan.
const QUOTA_COOLDOWN_MS = 5 * 60_000;
// Transient trouble (network, 5xx) gets a much shorter, streak-gated pause, so
// a single blip doesn't disable the reader but a real outage doesn't have every
// student pay the timeout either.
const FAILURE_COOLDOWN_MS = 60_000;
const FAILURE_STREAK = 3;

// ---- Systemic-fault detector for LOST VERDICTS ----
// The breaker above cannot cover the { unreadable: true } outcomes, and must not:
// counting them would let three crafted uploads open it and switch the forgery
// check off for the whole campus (see noteUnreadable). So a systemic fault in
// which EVERY read loses its verdict has no breaker, no fallback, and — before
// this — no symptom but one console.warn per upload among the ordinary bad-photo
// ones. This is the missing symptom: a rate, watched separately from
// failureStreak, that pages the operator instead of changing any behaviour.
//
// WHY A RATE AND NOT A STREAK: the denominator is what tells the two cases apart.
// A systemic fault loses ~100% of reads; bad photos are a minority of a stream
// that is otherwise producing verdicts, however many of them arrive.
//
// The three numbers, all chosen to page LATE rather than page wrongly:
//   15 min  — long enough for a real fault to accumulate evidence at the modest
//             volume this feature sees (claim_receipt caps a student at 3 claims
//             a day), short enough that the alert lands while the incident is
//             live instead of the next morning. Also what bounds the memory here:
//             the arrays hold one timestamp per reader-reached read in the last
//             quarter hour.
//   10      — a bad-photo floor, and the number the "don't page for bad photos"
//             instruction really turns on. Note that a LOST read does not consume
//             that 3/day cap (claim_receipt never runs), so one stubborn student
//             can retake as often as they like: the floor has to sit above any
//             plausible run of that. Ten inside a quarter hour clears it, and
//             otherwise needs ~ten students photographing screens at once.
//   75%     — of reads where the reader ANSWERED (outages are excluded: they are
//             the breaker's job and prove nothing was reached). A systemic fault
//             sits at 100%, so three quarters still catches a partial one, while
//             ordinary bad photos mixed into healthy traffic can never reach it.
// One page per incident: the cooldown is longer than the window, so the window
// has fully turned over before a second page is possible. The per-read
// console.warn in noteUnreadable remains the running record.
const UNREADABLE_WINDOW_MS = 15 * 60_000;
const UNREADABLE_ALERT_MIN = 10;
const UNREADABLE_ALERT_SHARE = 0.75;
const UNREADABLE_ALERT_COOLDOWN_MS = 30 * 60_000;

let breakerUntil = 0;
let failureStreak = 0;
// Timestamps of reads where the reader demonstrably answered, split by whether
// the verdict survived. Appended in arrival order, pruned to the window.
let unreadableAt = [];
let verdictAt = [];
let unreadableAlertedAt = 0;

/** True when the API key is configured at all. */
export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** True when we'd actually attempt a call right now (configured + breaker closed). */
export function geminiReady() {
  return geminiConfigured() && Date.now() >= breakerUntil;
}

/**
 * Test-only: drop the circuit-breaker state between cases — and the
 * lost-verdict window with it, since that is process-global too and a case that
 * left nine unreadables behind would otherwise page from inside the next one.
 */
export function resetGeminiBreaker() {
  breakerUntil = 0;
  failureStreak = 0;
  unreadableAt = [];
  verdictAt = [];
  unreadableAlertedAt = 0;
}

function openBreaker(ms, why) {
  const until = Date.now() + ms;
  if (until > breakerUntil) {
    breakerUntil = until;
    // Operator-facing only: no image, no receipt text, no student id. Without
    // this line a silently-disabled reader looks exactly like a working one.
    console.warn(`[gemini] pausing receipt AI for ${Math.round(ms / 1000)}s: ${why}`);
  }
}

function noteFailure(why) {
  failureStreak += 1;
  if (failureStreak >= FAILURE_STREAK) {
    openBreaker(FAILURE_COOLDOWN_MS, `${failureStreak} consecutive failures (${why})`);
    failureStreak = 0;
  }
  return null;
}

/**
 * The other half of noteFailure, for an outcome the uploaded image can steer.
 *
 * It logs — a spike of these is either a truncation bug or somebody probing the
 * reader, and both want to be visible — but it MUST NOT touch failureStreak.
 * Counting these would mean three crafted uploads can open the 60s breaker, and
 * for that minute EVERY student's scan skips the forgery gate entirely: the one
 * attacker would have switched the check off for the whole campus. See the
 * three-outcome contract at the top of this file.
 *
 * The streak is left exactly as it was rather than reset, too. These outcomes say
 * nothing either way about whether the API is healthy — a safety block or a
 * response truncated at MAX_OUTPUT_TOKENS is a live, responsive endpoint
 * answering badly — so they neither accuse it nor vouch for it; only a real
 * verdict clears the streak.
 *
 * What they DO feed is recordReaderOutcome, which is a counter and not a gate: it
 * can page the operator but cannot open the breaker, so an attacker's crafted
 * uploads still buy them nothing but attention.
 */
function noteUnreadable(why) {
  // Operator-facing only, and subject to the same PRIVACY note as every other
  // line in this file: no image, no recognized text, no student id.
  console.warn(`[gemini] reader reached but no verdict (${why}) — asking for a retake`);
  recordReaderOutcome(true);
  return { unreadable: true };
}

/** Timestamps are appended in order, so everything expired is a prefix. */
function pruneWindow(list, cutoff) {
  let i = 0;
  while (i < list.length && list[i] < cutoff) i += 1;
  return i ? list.slice(i) : list;
}

/**
 * Record one read in which the reader ANSWERED, and page the operator when lost
 * verdicts stop looking like bad photography and start looking like us.
 *
 * This changes NO behaviour: it cannot open the breaker, cannot enable the
 * tesseract fallback, and cannot turn an unreadable into a verdict. Feeding it
 * crafted images buys an attacker a notification to the operator and nothing
 * else — which is the point of keeping it out of failureStreak. See the constants
 * above for why the threshold and window are what they are.
 *
 * @param {boolean} unreadable true for a lost verdict, false for a real one
 *   (a "this is not a receipt" verdict is a REAL one — the reader is healthy).
 */
function recordReaderOutcome(unreadable) {
  const now = Date.now();
  const cutoff = now - UNREADABLE_WINDOW_MS;
  unreadableAt = pruneWindow(unreadableAt, cutoff);
  verdictAt = pruneWindow(verdictAt, cutoff);
  (unreadable ? unreadableAt : verdictAt).push(now);

  // Only a fresh unreadable can cross the line; a verdict arriving can only ever
  // move the rate down, so there is nothing to check on that path.
  if (!unreadable) return;
  const lost = unreadableAt.length;
  const reached = lost + verdictAt.length;
  // WHAT THESE TWO GATES CAN AND CANNOT TELL APART, because the alert wording
  // depends on it. They measure a RATE, and this module has no idea who is behind
  // a read — no user id reaches it. So one determined client retaking the same
  // crumpled receipt is lost=10, reached=10, share 1.0, and looks identical to the
  // reader having stopped answering for everybody.
  //
  // That ambiguity is NOT closed by demanding some healthy traffic alongside it: a
  // real systemic fault loses ~100% of reads, so there IS no healthy verdict to
  // require, and demanding one would silence exactly the incident this exists for
  // (test/gemini-receipt.test.js pins the all-lost case for that reason). Nor is it
  // closed by raising the floor: /api/me/receipt allows 30 reads per IP per 15 min
  // (server.js), which is the whole window, so any floor a systemic fault reaches
  // quickly is also reachable by one client with curl.
  //
  // So the gates stay sensitive — a missed outage costs every student their claim,
  // a false page costs one glance at the rate — and the ALERT SAYS WHICH IT CANNOT
  // RULE OUT rather than asserting a systemic fault it has not established.
  if (lost < UNREADABLE_ALERT_MIN || lost / reached < UNREADABLE_ALERT_SHARE) return;
  // One page per incident.
  if (unreadableAlertedAt && now - unreadableAlertedAt < UNREADABLE_ALERT_COOLDOWN_MS) return;
  unreadableAlertedAt = now;

  const mins = Math.round(UNREADABLE_WINDOW_MS / 60_000);
  const stat = `${lost} of ${reached} reads in ${mins} min lost their verdict`;
  // console.error, not warn: this is the one line in this file that means "the
  // receipt feature is refusing claims and it is OUR fault, not the photos".
  // It names the lever because the operator reading it at 2am should not have to
  // find this file — unsetting GEMINI_API_KEY drops every scan to tesseract (see
  // the contract at the top; geminiReady() re-reads the env on every call).
  console.error(
    `[gemini] READER DEGRADED: ${stat}. If that is a handful of students it is one`
    + ' client retrying a bad photo; if it is the whole stream the reader has stopped'
    + " answering and every student's claim is failing closed"
    + ' (400 RECEIPT_UNREADABLE for every student, by design — tesseract has no'
    + ' forgery check). To restore claims without the forgery check, unset'
    + ' GEMINI_API_KEY. Confirm with `npm run check:gemini`.'
  );

  // Escalate the way the operator is already reached for a fault only they can
  // fix (src/lib/alerts.js notifyError, routes/stripe-webhook.js's unrecognised
  // price): a web push to the /admin subscriptions. push.js is imported lazily
  // and the send is deliberately NOT awaited — it is best-effort, a student is
  // waiting on this response, and pulling push.js -> supabase.js into this
  // module's import graph would make every importer of the receipt reader
  // (scripts/check-gemini.js) need SUPABASE_* in its env. notifyAdmins never
  // throws and is a silent no-op with no VAPID keys configured, so the
  // console.error above is the alert that always survives.
  import('./push.js')
    .then(({ notifyAdmins }) => notifyAdmins({
      title: 'Receipt AI: no verdicts',
      body: `${stat}. Receipt claims are being refused. Unset GEMINI_API_KEY to fall back to tesseract (no forgery check).`,
      url: '/admin/',
    }))
    .catch((err) => console.warn(`[gemini] systemic-fault alert not sent: ${err?.message ?? err}`));
}

// The shape we force the model into. `type: ['x', 'null']` is how the Gemini
// schema subset spells nullable — and every field IS nullable on purpose:
// "I couldn't read the total" must be expressible, or the model will invent one
// to satisfy the schema.
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: {
      type: 'boolean',
      description: 'True if this is a photograph of a genuine printed paper receipt.',
    },
    authenticity_confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How confident you are in the is_receipt verdict, 0 to 1.',
    },
    reject_reason: {
      type: ['string', 'null'],
      description: 'When is_receipt is false, a short reason (e.g. "photo of a screen").',
    },
    vendor_name: {
      type: ['string', 'null'],
      description: 'Business name exactly as printed in the receipt header.',
    },
    total: {
      type: ['number', 'null'],
      description: 'Final amount paid, after tax and tip. Never the subtotal.',
    },
    date: { type: ['string', 'null'], description: 'Printed date as YYYY-MM-DD.' },
    time: { type: ['string', 'null'], description: 'Printed time as HH:MM, 24-hour.' },
    raw_text: {
      type: 'string',
      description: 'Plain-text transcription of the whole receipt, in printed line order.',
    },
  },
  required: [
    'is_receipt', 'authenticity_confidence', 'reject_reason',
    'vendor_name', 'total', 'date', 'time', 'raw_text',
  ],
};

// Two jobs, stated separately, because they pull in opposite directions: the
// fraud half wants suspicion and the extraction half wants a best effort on a
// creased thermal print. The "when unsure, accept" rule is load-bearing — a
// false reject is a student who did nothing wrong being told they're cheating,
// and the total is still bounded by the $200 cap and the dedup key downstream.
const SYSTEM_INSTRUCTION = `You verify receipts for a college rewards app. Students photograph a paper receipt from a local restaurant to claim points, so a faked image is a direct theft of points from the vendor paying for them.

Make TWO independent judgements about the image.

1. AUTHENTICITY -> is_receipt
Set is_receipt to false only when the image is something other than a photograph of a real, machine-printed receipt existing on paper in the physical world. Reject:
- a photo of a screen (phone, laptop, monitor): look for moire patterns, a visible pixel grid, screen glare, a bezel, or unnaturally even backlighting
- a screenshot, a PDF render, or any digitally generated image
- a handwritten or hand-drawn receipt
- a photo of a photo, or a printout of a photographed receipt
- an image that is not a receipt at all (a menu, an invoice template, an unrelated object)
- signs of tampering: mismatched fonts or baselines, a total whose digits differ in weight or alignment from the rest, cloned or smudged regions, columns that do not line up

Real receipts are routinely blurry, creased, curled, faded, stained, cut off at an edge, or photographed at an angle in bad light. NONE of that is evidence of forgery on its own. If you are unsure, set is_receipt to true with a low authenticity_confidence rather than accusing an honest student. Set authenticity_confidence to how sure you are of the verdict you gave.

2. EXTRACTION
- vendor_name: the business name as printed in the header, verbatim
- total: the final amount the customer actually paid, as a number. This is the grand total after tax, and after any added tip. Never the subtotal, tax, tip line, change, cash tendered, or a loyalty balance. If both a pre-tip and a post-tip total are printed, use the post-tip one.
- date: the date printed on the receipt, as YYYY-MM-DD
- time: the time printed on the receipt, as HH:MM on a 24-hour clock
- raw_text: transcribe the entire receipt as plain text, one printed line per line, in the order it is printed

Use null for anything you cannot actually read. Never guess a digit, and never output a vendor, total, date, or time that is not printed on the image.`;

/** Pull the model's text out of an Interaction, tolerating either response shape. */
function outputText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text;
  }
  const chunks = [];
  for (const step of Array.isArray(body?.steps) ? body.steps : []) {
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

/** Structured output should be bare JSON, but a fenced ```json block is cheap to survive. */
function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  const body = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : trimmed;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function asNumber(v) {
  // The schema says number, but a model that writes "18.45" or "$18.45" anyway
  // shouldn't cost the student their claim.
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/**
 * Verify and read a receipt photo.
 *
 * @param {string} base64 the image bytes, base64, WITHOUT the data-URL prefix
 * @param {string} mimeType e.g. 'image/jpeg'
 * @returns {Promise<null | { unreadable: true } | {
 *   isReceipt: boolean, confidence: number, rejectReason: string|null,
 *   vendorName: string|null, total: number|null,
 *   date: string|null, time: string|null, rawText: string,
 * }>} null means "infrastructure failed, fall back to tesseract";
 *   `{ unreadable: true }` means "the reader answered nothing usable about THIS
 *   image — ask for another photo, do NOT fall back". The three-outcome contract
 *   at the top of this file explains why those two must not be merged.
 */
export async function readReceiptWithGemini(base64, mimeType = 'image/jpeg') {
  if (!geminiReady()) return null;
  if (!base64) return null;

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        system_instruction: SYSTEM_INSTRUCTION,
        input: [
          { type: 'text', text: 'Verify and read this receipt.' },
          { type: 'image', data: base64, mime_type: mimeType },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: RECEIPT_SCHEMA,
        },
        generation_config: {
          temperature: 0,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          // Reading a receipt is perception, not reasoning; Flash-Lite thinks
          // at 'minimal' by default and we're paying for latency here.
          thinking_level: 'minimal',
        },
      }),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with TimeoutError; DNS/TLS/socket land here
    // too. BOTH are the same outcome — an outage — and the timeout is the
    // interesting one, so this is why.
    //
    // A timeout is AMBIGUOUS. TIMEOUT_MS elapsed with a request in flight that
    // carried this image, and from here we cannot tell "Flash-Lite is chewing on
    // a pathological upload" from "the endpoint accepted the socket and is
    // black-holing it" — the ordinary shape of a provider incident. We classify
    // it as an outage, i.e. null / countable, because of what the two readings
    // cost when we get them wrong:
    //
    //   Wrong as "unreadable": a hanging Gemini never touches failureStreak, so
    //   the FAILURE_STREAK breaker never opens, geminiReady() stays true, and
    //   every single scan waits the full 9s and is then told RECEIPT_UNREADABLE
    //   — "lay it flat and try again in good light" — for the whole incident.
    //   The receipt feature is DOWN, tesseract is switched off precisely when it
    //   is needed, and every student is blamed for a fault that is ours.
    //
    //   Wrong as "outage": a forger who can reliably push one request past 9s
    //   gets that upload read by tesseract, which has no authenticity check.
    //   Costly, but bounded — and bounded by design: it takes FAILURE_STREAK
    //   consecutive timeouts with no verdict in between to open the breaker, and
    //   any real verdict resets the streak (:390), so this is exactly the abuse
    //   the streak gate was built to absorb rather than a free switch.
    //
    // Unreadable therefore means strictly "the reader answered and we lost the
    // answer" (truncated JSON, non-'completed' status, no verdict in the JSON —
    // all of which prove a response came back). A timeout proves nothing came
    // back, so it is transport, it counts toward the breaker, and the claim is
    // completed by tesseract instead of failed. Keeping the whole feature
    // available through a Gemini outage outweighs one slow-image bypass.
    return noteFailure(err?.name === 'TimeoutError' ? 'timeout' : 'network');
  }

  if (res.status === 429) {
    // Quota or rate limit (RESOURCE_EXHAUSTED). Stop calling for a while — see
    // QUOTA_COOLDOWN_MS above for why this isn't just another failure.
    openBreaker(QUOTA_COOLDOWN_MS, 'quota exhausted (429)');
    return null;
  }
  if (!res.ok) {
    // 400 (bad model id / unsupported field) and 403 (bad key) are permanent
    // until someone edits .env, so the streak counter parks them behind the
    // breaker instead of retrying on every single upload.
    return noteFailure(`http ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    // The HTTP ENVELOPE isn't JSON — a proxy error page, a truncated chunked
    // response. That is the transport misbehaving rather than anything the model
    // said about this image, so it stays a countable infrastructure failure.
    return noteFailure('unparseable response');
  }

  // A safety block or an internal stop leaves a non-completed interaction with
  // no usable output. The reader HAD the image and we lost whatever it made of
  // it — and which images trip a safety filter is decided by the images — so
  // this asks for a retake rather than resolving to null, which would send this
  // very image to a reader that cannot tell a photographed screen from paper.
  if (body?.status && body.status !== 'completed') {
    return noteUnreadable(`status ${body.status}`);
  }

  // Truncated at MAX_OUTPUT_TOKENS (raw_text on a long grocery receipt) or empty.
  // How much text there is to transcribe is a property of the photograph, so the
  // same reasoning applies: another photo, not another reader.
  const parsed = parseJson(outputText(body));
  if (!parsed) return noteUnreadable('no JSON in output');

  // is_receipt must be an explicit boolean. A missing verdict is a broken read,
  // not an implicit pass — defaulting it to true would let a malformed response
  // wave through exactly the images this call exists to catch, and so would
  // returning null, because tesseract waves everything through.
  if (typeof parsed.is_receipt !== 'boolean') return noteUnreadable('no verdict in JSON');

  failureStreak = 0;
  // A verdict — including "this is not a real receipt" — is proof the reader is
  // working, so it is the denominator the lost-verdict rate is measured against.
  recordReaderOutcome(false);

  const confidence = asNumber(parsed.authenticity_confidence);
  return {
    isReceipt: parsed.is_receipt,
    // An unreadable confidence is treated as no confidence, which keeps the
    // caller's threshold from rejecting on a verdict we can't size.
    confidence: confidence == null ? 0 : Math.min(1, Math.max(0, confidence)),
    rejectReason: asString(parsed.reject_reason),
    vendorName: asString(parsed.vendor_name),
    total: asNumber(parsed.total),
    date: asString(parsed.date),
    time: asString(parsed.time),
    rawText: typeof parsed.raw_text === 'string' ? parsed.raw_text : '',
  };
}

/** The model id in use — for the boot log and scripts/check-gemini.js. */
export function geminiModel() {
  return MODEL;
}
