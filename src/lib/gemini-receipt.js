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
// EVERY infrastructure failure resolves to `null`, meaning "I couldn't reach a
// verdict — fall back to tesseract": no API key, network error, timeout, any
// non-2xx, quota exhaustion, a non-completed interaction, or a response whose
// JSON doesn't parse.
//
// A successful read that says "this is NOT a real receipt" is NOT a failure.
// It resolves to `{ isReceipt: false, ... }` and the caller rejects the claim.
// Falling back to tesseract on a fraud verdict would launder the rejection,
// since tesseract has no authenticity check whatsoever — that would make the
// feature worse than useless.

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
// a cut-off response is unparseable, which costs us the call AND the fallback's
// time budget. Output tokens are the expensive half, but the typical receipt
// uses ~600 of these.
const MAX_OUTPUT_TOKENS = 4_096;

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

let breakerUntil = 0;
let failureStreak = 0;

/** True when the API key is configured at all. */
export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** True when we'd actually attempt a call right now (configured + breaker closed). */
export function geminiReady() {
  return geminiConfigured() && Date.now() >= breakerUntil;
}

/** Test-only: drop the circuit-breaker state between cases. */
export function resetGeminiBreaker() {
  breakerUntil = 0;
  failureStreak = 0;
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
 * @returns {Promise<null | {
 *   isReceipt: boolean, confidence: number, rejectReason: string|null,
 *   vendorName: string|null, total: number|null,
 *   date: string|null, time: string|null, rawText: string,
 * }>} null means "infrastructure failed, fall back to tesseract".
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
    // AbortSignal.timeout rejects with TimeoutError; DNS/TLS/socket land here too.
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
    return noteFailure('unparseable response');
  }

  // A safety block or an internal stop leaves a non-completed interaction with
  // no usable output — that's an infra failure, not a fraud verdict.
  if (body?.status && body.status !== 'completed') {
    return noteFailure(`status ${body.status}`);
  }

  const parsed = parseJson(outputText(body));
  if (!parsed) return noteFailure('no JSON in output'); // truncated or empty

  // is_receipt must be an explicit boolean. A missing verdict is a broken read,
  // not an implicit pass — defaulting it to true would let a malformed response
  // wave through exactly the images this call exists to catch.
  if (typeof parsed.is_receipt !== 'boolean') return noteFailure('no verdict in JSON');

  failureStreak = 0;

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
