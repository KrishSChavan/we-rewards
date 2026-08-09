// Server-side receipt OCR (tesseract.js). One long-lived worker, strictly
// serialized jobs, and a hard cap on how many requests may be in flight —
// OCR is the only CPU-heavy thing this app does, and a 512MB dyno will OOM
// before it multitasks wasm workers.
//
// This is the FALLBACK reader. With GEMINI_API_KEY set, lib/gemini-receipt.js
// handles the scan and this module only runs when that call couldn't be made
// (no key, quota gone, timeout, outage) — so it has to keep working unattended
// for however long Google is unreachable. It reads text and nothing more: it
// cannot tell a photographed receipt from a photographed screen, which is why
// the route never falls back to it after an AI fraud verdict.
//
// Privacy contract (see POST /api/me/receipt): here the image never leaves the
// process — it exists only as an in-memory Buffer for the duration of
// recognize(). Nothing in this module may write it to disk (cacheMethod 'none'
// below), log it, or log the recognized text. The traineddata ships inside the
// slug via @tesseract.js-data/eng, so a fresh dyno never fetches anything at
// boot either.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Default-import + destructure: tesseract.js is CJS and this survives however
// Node's named-export detection feels about its index.js.
import Tesseract from 'tesseract.js';

const { createWorker } = Tesseract;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The LSTM-only data variant — same folder the CDN default would resolve to,
// but read from node_modules so it deploys with the code (house rule since the
// supabase-js CDN removal: no runtime dependence on third-party hosts).
const LANG_PATH = path.join(ROOT, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');

// 1 job recognizing + up to 2 waiting. Beyond that the dyno is saturated and
// the honest answer is 503 RECEIPT_BUSY, not a minute-long queue.
const MAX_IN_FLIGHT = 3;
// Heroku's router kills the request at 30s (H12); fail our way first so the
// student gets the readable error, not a dead connection. Callers may pass a
// smaller budget — the receipt route does, because when it lands here it has
// already spent part of that 30s waiting on the AI reader.
const JOB_TIMEOUT_MS = 25_000;
// Below this there isn't time to recognize anything, so a shorter budget would
// just guarantee a timeout after burning a worker slot.
const MIN_TIMEOUT_MS = 5_000;

let workerPromise = null;
let inFlight = 0;
let chain = Promise.resolve(); // serializes recognize() calls

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: LANG_PATH,
      gzip: true,            // read eng.traineddata.gz (the shipped file)
      cacheMethod: 'none',   // langPath is local — never copy it anywhere else
      // LOAD-BEARING: on a failed job tesseract.js rejects the job promise —
      // which we catch below — and then, with no errorHandler, ALSO rethrows
      // inside its message callback (createWorker.js:217). In Node that second
      // throw is an uncaughtException: one student uploading a corrupt image
      // took the whole server down in testing. The handler exists to swallow
      // exactly that duplicate throw; the real error still reaches the caller.
      errorHandler: () => {},
    }).then(async (w) => {
      // PSM 6 (one uniform block). NOT 4 ("single column"): receipts print
      // amounts right-aligned, and mode 4 was found to read only the label
      // column — every price and the time vanished from the output.
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      return w;
    });
    // A failed init (bad path, corrupt wasm) must not wedge OCR forever:
    // forget the promise so the next request retries from scratch.
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** True when another scan right now would exceed the in-flight cap. */
export function ocrBusy() {
  return inFlight >= MAX_IN_FLIGHT;
}

/**
 * OCR a receipt photo. Resolves to the recognized text; rejects with
 * RECEIPT_BUSY (cap), or RECEIPT_UNREADABLE (timeout — the hung worker is
 * terminated and lazily rebuilt, since a wasm worker that stalled once isn't
 * trustworthy). The caller owns the buffer and zeroes it afterwards.
 *
 * `timeoutMs` lets a caller that has already spent part of the request's 30s
 * hand over only what's left; it's clamped to [MIN_TIMEOUT_MS, JOB_TIMEOUT_MS].
 */
export function recognizeReceipt(buffer, timeoutMs = JOB_TIMEOUT_MS) {
  if (ocrBusy()) return Promise.reject(new Error('RECEIPT_BUSY'));
  inFlight += 1;

  const budget = Math.min(
    JOB_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Number(timeoutMs) || JOB_TIMEOUT_MS),
  );

  const job = chain.then(async () => {
    const worker = await getWorker();
    let timer;
    try {
      const result = await Promise.race([
        worker.recognize(buffer),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR_TIMEOUT')), budget);
        }),
      ]);
      return result?.data?.text ?? '';
    } catch (err) {
      if (err?.message === 'OCR_TIMEOUT') {
        // A wasm worker that stalled once isn't trustworthy — rebuild lazily.
        workerPromise = null;
        worker.terminate().catch(() => {});
      }
      // Any recognize failure — timeout, corrupt image, decode error — is
      // "unreadable" to the student. (Worker INIT failures happen above the
      // try and still surface as 500s, where an operator will see them.)
      throw new Error('RECEIPT_UNREADABLE');
    } finally {
      clearTimeout(timer);
    }
  });

  // The chain must survive a failed job, and inFlight must drop either way.
  chain = job.then(() => {}, () => {});
  return job.finally(() => { inFlight -= 1; });
}

/**
 * Pre-build the worker at boot so the first student doesn't pay the ~2-4s
 * init on top of their own scan. Best-effort: a failure here just means the
 * first real request builds it instead.
 */
export function warmOcr() {
  getWorker().catch(() => {});
}
