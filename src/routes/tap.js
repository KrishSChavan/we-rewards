// GET /t and GET /t/<vendor> — what a passive NFC tag on a counter points at.
//
// The URL on the tag is https://we-rewards.com/t/<vendor slug> (or the vendor's
// uuid, or bare /t for a generic campus tag). It is WRITTEN INTO HARDWARE: a
// tag is programmed once and then stuck to a counter, so the URL is as fixed as
// a printed one and every character of it has to keep meaning the same thing
// for years.
//
// WHY A PAGE AND NOT A REDIRECT. An installed app catches the URL before it
// ever reaches here (iOS through the apple-app-site-association file server.js
// serves, Android Chrome by bouncing into the installed PWA on its own), so the
// only people who see this response are the ones who have NOT installed
// anything. For them the tap is the best install moment the product gets, and
// a bare redirect into the web app would spend it. src/lib/tap-page.js draws
// the page: vendor name, "Get the app", "Continue on the web".
//
// NO "REMEMBER MY CHOICE", by the owner's decision: the screen shows on every
// tap, and nothing here reads a preference back. The ONE cookie this route
// sets (wrw_tap, src/lib/nfc-taps.js) steers nothing: it is a visitor nonce
// whose hash lets the operator's tap counts tell a returning phone from a new
// one, scoped to Path=/t so it never rides on any other request. The only
// state a tap touches is two analytics rows: the client_events funnel event,
// and the nfc_taps row the "NFC tags" card in /admin reads (migration-065).
//
// WHAT IT INHERITS FROM src/routes/tracked-qr.js, learned the hard way there
// and not worth learning twice:
//
//   NO-STORE. Cloudflare fronts the dyno; a cached copy of this page would stop
//   the tap ever reaching the server, and the per-tap event with it.
//
//   THE SERVICE WORKER IS TOLD TO LEAVE IT ALONE. public/student/sw.js handles
//   every same-origin GET, so an installed PWA would otherwise answer /t from
//   cache or with the student shell. '/t' and '/.well-known' go in that
//   worker's FOREIGN list; this comment exists so the two are found together.
//
//   AN UNKNOWN OR MANGLED REF IS NOT A 404. The tag is on a wall. Whatever it
//   says, the person holding the phone gets the page and the operator finds
//   the mistake in the logs.
//
//   THE LIMITER lives in server.js (nfcTapLimiter, its own instance with the
//   poster limiter's settings), and the URIError guard at the foot of this
//   file answers a malformed percent-escape before it can reach the central
//   handler.

import { Router } from 'express';
import { publicSpotByRef, normalizeTapRef } from '../lib/spots-page.js';
import { tapPageHtml } from '../lib/tap-page.js';
import { logEvent } from '../lib/events.js';
import { isLikelyBot } from '../lib/tracked-qr.js';
// The catalogue wait lives with the tap log rather than here, because the
// app's own report of a tap (POST /api/me/nfc-tap) resolves the same ref
// under the same cap, and two copies of a measured timeout drift.
import {
  CATALOGUE_WAIT_MS, withTimeout, tapVisitorNonce, hashVisitor, recordNfcTap,
} from '../lib/nfc-taps.js';

/** Read per request, never at import, so a test can flip it. */
const storeUrl = () => process.env.IOS_APP_STORE_URL || '';

/**
 * Run an analytics write without waiting for it. Neither write below is
 * supposed to reject, but a rejection nobody is listening for takes the whole
 * process down on Node 15+, and a counter tag is the last place to find out a
 * telemetry module has grown a bug. A synchronous throw is caught the same way.
 */
const fireAndForget = (fn) => Promise.resolve().then(fn).catch((err) => {
  console.warn(`[nfc-tap] analytics write failed: ${err?.message ?? err}`);
});

/**
 * @param {object} [opts]
 * @param {(html: string) => string} [opts.stamp]  server.js passes versionAssets,
 *   so /tap.js gets the same ?v=<hash> every shell's scripts get.
 * @param {(ref: string) => Promise<object|null>} [opts.resolve]  the catalogue
 *   lookup; the default is the real one, tests inject an answer.
 * @param {number} [opts.timeoutMs]  see CATALOGUE_WAIT_MS in src/lib/nfc-taps.js.
 * @param {typeof recordNfcTap} [opts.record]  the tap log write; the default is
 *   the real one, tests inject a recorder to read what a tap would have counted.
 */
export function createTapRouter({
  stamp = (html) => html, resolve = publicSpotByRef, timeoutMs = CATALOGUE_WAIT_MS, record = recordNfcTap,
} = {}) {
  const router = Router();

  router.get(['/', '/:ref'], async (req, res) => {
    // Never throws and never calls next(err): nothing that can go wrong here
    // is worth turning a tapped tag into an error page.
    try {
      // Headers before anything can fail, so the failure paths are uncacheable
      // and unindexable too. no-store rather than no-cache: no-cache still
      // lets a store happen and only forces revalidation.
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('X-Robots-Tag', 'noindex, nofollow');

      const raw = req.params.ref;
      const ref = normalizeTapRef(raw);
      if (raw && !ref) console.warn(`[nfc-tap] malformed ref: ${String(raw).slice(0, 40)}`);

      // A catalogue blip must not take a counter tag down with it: when the
      // read fails the ref goes through to the app as-is, and the app resolves
      // a slug itself once its own vendor list loads. An UNKNOWN ref against a
      // healthy catalogue gets the generic page, since there is nothing to
      // point at.
      let spot = null;
      let catalogueDown = false;
      if (ref) {
        try {
          spot = await withTimeout(resolve(ref), timeoutMs);
        } catch (err) {
          catalogueDown = true;
          console.warn(`[nfc-tap] catalogue read failed for ${ref}: ${err?.message ?? err}`);
        }
        if (!spot && !catalogueDown) console.warn(`[nfc-tap] unknown ref: ${ref}`);
      }

      const dest = spot
        ? `/?spot=${encodeURIComponent(spot.id)}`
        : ref && catalogueDown ? `/?spot=${encodeURIComponent(ref)}` : '/';
      const installDest = `${dest}${dest.includes('?') ? '&' : '?'}install=1`;

      // Fire and forget, both writes: neither ever throws, and the page must
      // not wait on an analytics insert. Link-preview crawlers are dropped for
      // the same reason the poster scans drop them: a bot's fetch is not a
      // tap, and a bot is not given a cookie either, so a crawler re-fetching
      // a pasted link never becomes a "returning visitor".
      const ua = req.headers['user-agent'];
      if (!isLikelyBot(ua)) {
        // The cookie BEFORE the body below: Set-Cookie is a header, and a
        // header set after res.send is lost without a sound.
        const nonce = tapVisitorNonce(req, res);
        // client_events + PostHog is the generic funnel log...
        fireAndForget(() => logEvent({
          source: 'student',
          event: 'nfc_tap',
          trigger: ref || 'generic',
          props: { known: Boolean(spot), catalogueDown },
          userAgent: ua,
          path: req.originalUrl,
        }));
        // ...and nfc_taps is what /admin reads (src/lib/nfc-taps.js says why
        // both). Keyed by the vendor's id so a slug rename keeps the history;
        // an unresolved ref is still a tap, recorded against the ref alone so
        // the operator can see a tag written with a stale or mistyped slug.
        fireAndForget(() => record({
          ref: ref || 'generic',
          vendorId: spot?.id ?? null,
          known: Boolean(spot),
          source: 'web',
          visitorHash: hashVisitor(nonce),
          userAgent: ua,
        }));
      }

      const html = tapPageHtml({ spot, dest, installDest, storeUrl: storeUrl() });
      return res.type('html').send(stamp(html));
    } catch (err) {
      console.warn(`[nfc-tap] render failed: ${err?.message ?? err}`);
      if (res.headersSent) return undefined;
      // The generic page rather than a 500; and if even that cannot be drawn,
      // the app itself, which is where every other failure here lands too.
      try {
        return res.type('html').send(tapPageHtml({ spot: null, dest: '/', installDest: '/?install=1', storeUrl: storeUrl() }));
      } catch {
        return res.redirect(302, '/');
      }
    }
  });

  /* The one error the handler above cannot catch, same as tracked-qr.js:
     Express decodes :ref inside Layer.match, BEFORE the handler runs, so a
     malformed percent-escape (GET /t/%, a tag written by hand, a link a chat
     client mangled) throws a URIError the try/catch never sees. Left alone it
     reaches the central handler in server.js, whose message EMBEDS THE RAW
     PARAM and is matched by substring, so the caller gets to pick the error
     code it is answered with. Handled here instead, the way every other
     unusable ref is: a bounce home, uncacheable. Only decode failures;
     anything else is a real fault and still deserves the central handler. */
  router.use((err, req, res, next) => {
    const undecodable = err instanceof URIError
      || /Failed to decode param/i.test(String(err?.message ?? ''));
    if (!undecodable || res.headersSent) return next(err);

    console.warn(`[nfc-tap] undecodable ref: ${String(req.originalUrl).slice(0, 80)}`);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    return res.redirect(302, '/');
  });

  return router;
}
