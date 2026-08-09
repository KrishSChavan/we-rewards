// Verify GEMINI_API_KEY / GEMINI_MODEL against the live API before trusting
// receipt scanning to it.
//
//   npm run check:gemini                    # key + model + endpoint reachable
//   npm run check:gemini -- receipt.jpg     # ...and read a real receipt photo
//
// Worth running because a misconfigured key fails INVISIBLY in production: the
// route falls back to tesseract, receipts still scan, and the only thing you
// lose is the forgery check — silently, on every upload. This is the difference
// between "the AI reader is working" and "nothing is obviously broken".

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readReceiptWithGemini, geminiConfigured, geminiModel } from '../src/lib/gemini-receipt.js';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

// A 1x1 white JPEG. Enough to exercise the exact request the route sends —
// endpoint, auth header, model id, response_format schema, response parsing —
// without needing a receipt on hand. The model should answer "not a receipt",
// which is itself a fully successful round trip.
const BLANK_JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/E'
  + 'ABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let failed = false;

function fail(msg, hint) {
  failed = true;
  console.error(`\n  FAIL  ${msg}`);
  if (hint) console.error(`        ${hint}`);
}

/**
 * The reader deliberately stays quiet about individual failures — logging every
 * one would spam production with a line per upload. That's the wrong tradeoff
 * for a diagnostic, so when it gives up, ask the API again in the plainest
 * possible way and show exactly what came back.
 */
async function diagnose() {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: geminiModel(), input: 'ping' }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      // The error body arrives as either an object or a single-element array.
      const parsed = JSON.parse(text);
      message = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message ?? message;
    } catch { /* not JSON — the raw slice above is the best we have */ }

    console.error(`\n  The API answered HTTP ${res.status}:`);
    console.error(`    ${message}`);
    if (/API key not valid/i.test(message)) {
      console.error('\n  -> The key is wrong. Get one at https://aistudio.google.com/apikey');
    } else if (res.status === 404 || /not found|not supported/i.test(message)) {
      console.error(`\n  -> "${geminiModel()}" isn't a usable model id. Set GEMINI_MODEL in .env to a`);
      console.error('     current Gemini model that accepts images.');
    } else if (res.status === 429) {
      console.error('\n  -> Quota exhausted. The app handles this: it pauses the AI reader for 5');
      console.error('     minutes and scans fall back to tesseract, losing only the forgery check.');
    }
  } catch (err) {
    console.error(`\n  Couldn't reach the API at all: ${err.name} — ${err.message}`);
    console.error('  Check network access from this machine, or raise GEMINI_TIMEOUT_MS.');
  }
}

async function main() {
  if (!geminiConfigured()) {
    return fail('GEMINI_API_KEY is not set.',
      'Add it to .env — get one at https://aistudio.google.com/apikey');
  }

  const key = process.env.GEMINI_API_KEY;
  console.log(`  model     ${geminiModel()}`);
  console.log(`  key       ...${key.slice(-6)} (${key.length} chars)`);

  const imagePath = process.argv[2];
  let base64 = BLANK_JPEG;
  let mimeType = 'image/jpeg';

  if (imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    if (!MIME[ext]) return fail(`Unsupported image type "${ext}".`, 'Use .jpg, .png, or .webp.');
    mimeType = MIME[ext];
    try {
      base64 = (await readFile(imagePath)).toString('base64');
    } catch (err) {
      return fail(`Couldn't read ${imagePath}: ${err.message}`);
    }
    console.log(`  image     ${imagePath} (${Math.round(base64.length * 0.75 / 1024)} KB, ${mimeType})`);
  } else {
    console.log('  image     none — sending a 1x1 blank to test the round trip only');
    console.log('            (pass a photo to test a real read: npm run check:gemini -- receipt.jpg)');
  }

  console.log('\n  calling…');
  const started = Date.now();
  const result = await readReceiptWithGemini(base64, mimeType);
  const elapsed = Date.now() - started;

  if (!result) {
    fail(`No usable result after ${elapsed}ms.`);
    await diagnose();
    console.error('\n  Until this is fixed, every scan silently falls back to tesseract:');
    console.error('  receipts still work, but nothing checks whether they are genuine.');
    return;
  }

  console.log(`  OK        round trip in ${elapsed}ms\n`);
  console.log(`  is_receipt          ${result.isReceipt}`);
  console.log(`  confidence          ${result.confidence}`);
  console.log(`  reject_reason       ${result.rejectReason ?? '—'}`);
  console.log(`  vendor_name         ${result.vendorName ?? '—'}`);
  console.log(`  total               ${result.total ?? '—'}`);
  console.log(`  date / time         ${result.date ?? '—'} ${result.time ?? '—'}`);
  console.log(`  raw_text            ${result.rawText.length} chars`);

  if (!imagePath) {
    console.log(result.isReceipt === false
      ? '\n  Blank image correctly judged "not a receipt" — key, model, and schema all work.'
      : '\n  Note: a blank image was NOT rejected. The round trip works, but re-run with a\n'
        + '  real photo before trusting the forgery check.');
    return;
  }

  if (result.rawText) {
    console.log('\n  --- transcription ---');
    console.log(result.rawText.split('\n').map((l) => `  ${l}`).join('\n'));
  }

  // A real receipt read must clear the same bars the route applies, so surface
  // the ones that would have failed the claim.
  if (result.isReceipt) {
    const missing = [];
    if (!result.vendorName) missing.push('vendor_name');
    if (result.total == null) missing.push('total');
    if (!result.date) missing.push('date');
    if (!result.time) missing.push('time');
    if (missing.length) {
      console.log(`\n  Heads up: ${missing.join(', ')} came back null. In the app the route falls`);
      console.log('  back to parsing the transcription for those before failing the claim.');
    }
  } else {
    console.log(`\n  This photo was judged NOT genuine (confidence ${result.confidence}).`);
    console.log('  In the app that is a RECEIPT_NOT_GENUINE rejection when confidence >= 0.7.');
  }
}

await main();
// Set the code rather than calling process.exit(): exiting while the fetch
// handles are still unwinding trips a libuv assertion on Windows, which prints
// a scary line after a perfectly good report.
if (failed) process.exitCode = 1;
