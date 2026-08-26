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

import { Router } from 'express';
import { recordScan, normalizeCode } from '../lib/tracked-qr.js';

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

    const code = normalizeCode(req.params.code);
    if (!code) {
      console.warn(`[tracked-qr] malformed code scanned: ${String(req.params.code).slice(0, 40)}`);
      return res.redirect(302, '/');
    }

    const banner = await recordScan({ req, res, rawCode: code });
    if (!banner) {
      console.warn(`[tracked-qr] unknown code scanned: ${code}`);
      return res.redirect(302, '/');
    }

    // The query parameter is belt and braces over the cookie recordScan just
    // set: a browser that refuses cookies still attributes the signup, and a
    // browser that refuses query strings does not exist. app.js strips it at
    // boot, before Google's OAuth round trip can lose it.
    return res.redirect(302, `/?qr=${encodeURIComponent(banner.code)}`);
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
