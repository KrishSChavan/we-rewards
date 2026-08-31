// GET /r/<code> — what a printed banner's QR actually points at (migration-050).
//
// The whole route is: count the scan, remember the banner in a cookie, bounce
// into the student app. It is mounted at the top level rather than under /api
// because the URL is PRINTED — it ends up on vinyl, and every character of it
// is a character someone might have to read out loud or type by hand.
//
// FOUR THINGS THIS FILE HAS TO GET RIGHT, none of them obvious:
//
//   302, NEVER 301. server.js's only other redirect carries the note: a
//   permanent redirect is cached by the browser indefinitely with no way to
//   bust it. Here that would pin a visitor's very first scan as the answer
//   forever, so a second scan of a second banner would never even reach us.
//
//   NO-STORE, OR THE NUMBERS STOP MOVING. Cloudflare sits in front of the dyno
//   and caches aggressively, and this response also carries a Set-Cookie — an
//   edge cache that stored it would either drop the cookie or hand one
//   visitor's cookie to the next person who scanned. Both failures look like
//   "the poster works fine" and silently flatten the report.
//
//   THE SERVICE WORKER HAS TO BE TOLD TO LEAVE THIS ALONE. public/student/sw.js
//   intercepts every same-origin GET except /api/ and /socket.io/, so an
//   already-installed PWA would serve a cached copy of this redirect and never
//   reach the server. Worse, Cache.put rejects on the opaqueredirect a
//   navigation fetch produces, and that rejection is unhandled there. The
//   exemption is added in that file; this comment exists so the two are found
//   together.
//
//   AN UNKNOWN CODE IS NOT A 404. The QR is on a wall. If a code is mistyped or
//   a banner is deleted, the person holding the phone still deserves to land in
//   the app rather than on an error page, so it redirects home and the operator
//   finds the mistake in the logs instead.
//
// TWO KINDS OF CODE RESOLVE HERE (migration-053 added the second). A BANNER code
// is 8 lowercase characters this server minted; an AMBASSADOR code is 3-10
// uppercase characters an operator typed for a person. They share this route
// rather than getting one each, because everything above — the 302, the
// no-store, the service-worker exemption, the rate limiter in server.js and the
// URIError guard at the foot of this file — was learned the hard way and would
// not be got right twice. Banners are tried FIRST and the order is fixed, so a
// string that somehow satisfied both shapes always resolves to the banner; the
// admin form refuses an ambassador code that collides with an existing banner's,
// which is the only direction a human can actually cause.
//
// ⚠ THE SECOND ARM WIDENED WHAT THIS ENDPOINT WILL LOOK UP, and that is worth
// knowing before adding a third. A banner code is 8 characters of a restricted
// alphabet, so almost every junk path was refused by a regex and cost nothing.
// An ambassador code is ANY 3-10 alphanumerics, so /r/hello and /r/test now each
// cost one indexed lookup. That is inherent — a code that short cannot be ruled
// out without asking — and the controls are the unique-index lookup being cheap
// and the 600-per-quarter-hour-per-IP limiter in server.js. It also means a test
// probe that used to touch no database may now touch one; see the note at the
// top of test/tracked-qr.test.js, where exactly that happened.

import { Router } from 'express';
import { recordScan, normalizeCode } from '../lib/tracked-qr.js';
import {
  recordScan as recordAmbassadorScan,
  normalizeCode as normalizeAmbassadorCode,
} from '../lib/ambassadors.js';

const router = Router();

router.get('/:code', async (req, res) => {
  // Never throws and never calls next(err): a telemetry failure must not turn a
  // scanned poster into an error page. The catch-all below is the same promise.
  try {
    // Cache-Control before anything can go wrong, so even the failure paths
    // below are uncacheable. no-store rather than no-cache: no-cache still
    // lets a store happen and only forces revalidation.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const raw = req.params.code;

    // ---- 1. a printed banner (migration-050) ----
    // normalizeCode is strict — exactly 8 characters of a lowercase alphabet
    // with no 0/1/l/o/i — so this arm silently declines anything shaped like an
    // ambassador code without a query, and vice versa.
    const code = normalizeCode(raw);
    if (code) {
      const banner = await recordScan({ req, res, rawCode: code });
      if (banner) {
        // The query parameter is belt and braces over the cookie recordScan
        // just set: a browser that refuses cookies still attributes the signup,
        // and a browser that refuses query strings does not exist. app.js
        // strips it at boot, before Google's OAuth round trip can lose it.
        return res.redirect(302, `/?qr=${encodeURIComponent(banner.code)}`);
      }
    }

    // ---- 2. an ambassador (migration-053) ----
    // Deliberately reached even when arm 1 matched the SHAPE but found no
    // banner, so a deleted banner's code can later be reissued to a person
    // without the old one shadowing it.
    //
    // Note this hands back the SAME `?qr=` parameter. The client never
    // interprets the code — it stashes it and posts it to accept-terms, where
    // two evaluators each ignore what isn't theirs — so one parameter serves
    // both features and public/student/app.js needed no change for this.
    const ambCode = normalizeAmbassadorCode(raw);
    if (ambCode) {
      const amb = await recordAmbassadorScan({ req, res, rawCode: ambCode });
      // Null covers "no such ambassador" AND "paused", and the two are
      // deliberately indistinguishable from out here: a retired ambassador's
      // link is supposed to stop working, unlike a paused banner's.
      if (amb) return res.redirect(302, `/?qr=${encodeURIComponent(amb.code)}`);
    }

    if (!code && !ambCode) {
      console.warn(`[tracked-qr] malformed code scanned: ${String(raw).slice(0, 40)}`);
    } else {
      console.warn(`[tracked-qr] unknown code scanned: ${String(raw).slice(0, 40)}`);
    }
    return res.redirect(302, '/');
  } catch (err) {
    console.warn(`[tracked-qr] resolve failed: ${err?.message ?? err}`);
    return res.redirect(302, '/');
  }
});

/* ⚠ THE ONE ERROR THE HANDLER ABOVE CANNOT CATCH.

   Express decodes :code inside Layer.match, BEFORE the handler body runs, so
   a malformed percent-escape — GET /r/%, a misread QR, a link a chat client
   mangled — throws a URIError that the try/catch up there never sees. Left
   alone it reaches the central error handler in server.js, which finds no
   known code in "Failed to decode param '%'" and answers 500, logs to the
   console and files an error_logs row. This path is unauthenticated and
   allowed 600 hits per quarter-hour per IP, so that is a way to bury real
   failures under fake ones on the operator's dashboard.

   It is also how a caller reaches into that handler: the message embeds the
   raw param and the handler matches known codes by SUBSTRING, so
   /r/%zzREWARD_NOT_FOUND came back as a 404 REWARD_NOT_FOUND.

   Handled here, where it belongs, and answered the way every other unusable
   code is: a 302 home. Only decode failures — anything else is a real fault
   and still deserves the central handler. */
router.use((err, req, res, next) => {
  const undecodable = err instanceof URIError
    || /Failed to decode param/i.test(String(err?.message ?? ''));
  if (!undecodable || res.headersSent) return next(err);

  console.warn(`[tracked-qr] undecodable code: ${String(req.originalUrl).slice(0, 80)}`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  return res.redirect(302, '/');
});

export default router;
