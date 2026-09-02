import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import studentRoutes from './src/routes/student.js';
import vendorRoutes from './src/routes/vendor.js';
import vendorRecoverRoutes from './src/routes/vendor-recover.js';
import adminRoutes from './src/routes/admin.js';
import applyRoutes from './src/routes/apply.js';
import unsubscribeRoutes from './src/routes/unsubscribe.js';
import webhookRoutes from './src/routes/webhooks.js';
import trackedQrRoutes from './src/routes/tracked-qr.js';
import { supabaseAdmin } from './src/lib/supabase.js';
import { CUISINES, MAX_CUISINES } from './src/lib/cuisines.js';
import { NEARBY_CONFIG } from './src/lib/nearby.js';
import { resolveUserFromToken, authVerificationMode } from './src/lib/jwt.js';
import { setIo } from './src/lib/realtime.js';
import { logError, requestContext, isCrawler } from './src/lib/errors.js';
import { logEvent } from './src/lib/events.js';
import { posthogEnabled, flushPostHog, batchUrl } from './src/lib/posthog.js';
import { isUuid } from './src/lib/ids.js';
import { loadVendorLogo } from './src/lib/cache.js';
import { startCampaignWorker, stopCampaignWorker } from './src/lib/campaigns.js';
import { startReferralWorker, stopReferralWorker } from './src/lib/referrals.js';
import { publicSignupBonus } from './src/lib/signup-bonus.js';
import { requireJson } from './src/middleware/require-json.js';
import { warmOcr } from './src/lib/ocr.js';
import { geminiConfigured, geminiModel } from './src/lib/gemini-receipt.js';
import { emailEnabled, emailFrom } from './src/lib/email.js';
import { ensureTerminalAdmin } from './src/lib/terminal-admin.js';
import { buildClientAssets, buildRoot, ensureFresh } from './scripts/build-client.js';
import { TERMS_DOCUMENTS } from './src/lib/terms.js';
import {
  verifyPunchToken, mintPunchBinding, PUNCH_BINDING_COOKIE, PUNCH_HOLD_TTL_SECONDS,
} from './src/lib/punch.js';
import { robotsTxt, sitemapXml, STATIC_SITEMAP_PATHS } from './src/lib/seo.js';
import { spotsIndexHtml, spotPageHtml, publicSpots, publicSpot, isIndexable } from './src/lib/spots-page.js';
import { howItWorksHtml, faqHtml } from './src/lib/content-pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind a proxy in prod (Render/Fly/etc.) so express-rate-limit sees the real
// client IP from X-Forwarded-For. This number MUST equal the count of trusted
// proxies between the internet and this process, or the rate limiters can be
// defeated by a spoofed header:
//   • one PaaS proxy (Render/Fly/Railway/Heroku) → 1  (the default)
//   • a second hop in front (e.g. Cloudflare → Render) → 2
//   • no proxy (bare `node server.js` on a public port) → 0/false
// Override per-environment with TRUST_PROXY rather than editing code.
const trustProxy = process.env.TRUST_PROXY;
app.set(
  'trust proxy',
  trustProxy == null ? 1
  : trustProxy === 'false' ? false
  : trustProxy === 'true' ? true
  : Number.isNaN(Number(trustProxy)) ? trustProxy   // e.g. a subnet string
  : Number(trustProxy)
);

// ---- Security headers (helmet) ----
// CSP is allow-listed to exactly what the two apps load: Google Fonts, Google
// avatar images, OpenStreetMap tiles (vendor map thumbnails), and Supabase
// REST/auth/realtime + socket.io over ws/wss. Misconfiguring this breaks the
// apps — keep in sync with the <script>/<link> tags and the SUPABASE_URL.
//
// No CDN in script-src any more: supabase-js is self-hosted out of node_modules
// (scripts/build-client.js), so every script this page runs is same-origin.
const supabaseOrigin = (() => {
  try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ''; }
})();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      // Google avatars + OpenStreetMap tiles for the vendor map thumbnails
      // (keyless; served straight from tile.openstreetmap.org).
      'img-src': ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://tile.openstreetmap.org'],
      // Only two connection targets: our own origin ('self' — covers the REST API
      // and the same-origin Socket.IO transport, which falls back to same-origin
      // long-polling if a browser won't upgrade ws under 'self') and Supabase
      // (auth + REST). No bare ws:/wss: wildcard, so injected code can't open a
      // socket to an arbitrary host and exfiltrate tokens.
      'connect-src': ["'self'", supabaseOrigin].filter(Boolean),
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'upgrade-insecure-requests': null, // don't force https in local dev
    },
  },
  // Google avatars are cross-origin; don't let COEP/CORP block them.
  crossOriginEmbedderPolicy: false,
}));

// ---- Response compression ----
// A single logged-out landing view ships a bit over 1.2 MB of text (HTML, the
// lowered app bundles, styles, the vendored leaflet/jsQR copies), and neither
// Heroku's router nor Cloudflare compresses on our behalf for a dyno that does
// not offer it. gzip takes that to roughly 280 KB.
//
// Placed after helmet so the security headers are set first, and above every
// route so it covers serveShell, the static mirror, the server-rendered public
// pages and the API alike. Two things that usually break a drop-in were checked
// and do not apply here: nothing in this app streams server-sent events, and the
// two responses that set Content-Length by hand (the QR poster PDF and the
// vendor logo PNG) are binary types compression's default filter already skips.
// socket.io hangs off the raw http server and never reaches Express, so its own
// permessage-deflate is untouched.
//
// Worth being honest about the SEO value: page speed is a very small ranking
// factor and this alone will not move a brand query. It is here because it is
// one line, it is the biggest single UX win available, and a slow first byte is
// what makes Search Console's URL inspection time out at the moment you press
// Request Indexing.
app.use(compression());

// ---- Indexing rules (see src/lib/seo.js for the whole story) ----
//
// Two separate jobs, and they are different headers on purpose.
//
// 1. A TEST DEPLOYMENT MUST NEVER BE INDEXED. It serves the same pages as
//    production from a URL nobody should land on, so every response gets
//    `noindex`. robots.txt already says `Disallow: /` there, but robots.txt only
//    stops the CRAWL: a URL somebody links or pastes can still be indexed
//    without ever being fetched, and only a header or meta tag forbids that.
//    This is mounted ABOVE every route so it covers the shells, the assets, the
//    404 and the API alike.
//
// 2. THE STAFF APPS ARE NOT PUBLIC PAGES. `/terminal`, `/admin` and `/scan` are
//    login walls. Indexed, they turn a search for the brand into a result that
//    reads like an internal tool. robots.txt disallows them too, and this is the
//    same belt-and-braces: the header is what a crawler that arrived by link
//    rather than by crawl actually obeys.
//
// APP_ENV is read here rather than passed in because the constant is defined
// further down, next to the rest of the deployment story.
app.use((_req, res, next) => {
  if ((process.env.APP_ENV || 'production') !== 'production') {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});
app.use(['/terminal', '/admin', '/scan'], (_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// ABOVE the JSON-only gate, and the only thing that is. RFC 8058 one-click
// unsubscribe is a POST carrying `List-Unsubscribe=One-Click` as
// application/x-www-form-urlencoded, which requireJson would answer 415 —
// Gmail would record the unsubscribe as broken and stop offering the button,
// leaving "Report spam" as the only way a student can make deal emails stop.
// The router reads nothing from the body (its proof is in the query string), so
// no parser runs for it either and the payload is simply ignored.
app.use('/unsubscribe', unsubscribeRoutes);

// JSON-only content-type gate. Refuse any non-JSON request body (esp. XML — the
// XXE vector) with 415 BEFORE express.json() or any other parser runs. We ship no
// XML parser, so this is belt-and-suspenders that fails closed. See require-json.js.
app.use(requireJson);

// Receipt photos are the ONE deliberately large JSON body (a base64 JPEG,
// client-downscaled to ≲1600px, typically well under 1MB). Its limiter mounts
// FIRST so a hammering IP is 429'd before 8MB gets parsed, then a route-scoped
// parser; the global 600kb parser below skips bodies this one already parsed
// (body-parser sets req._body). requireJson above still applies unchanged —
// the payload is ordinary application/json. Defined here, not in the limiter
// block below, because mount order against the parsers is what makes it work.
const receiptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // OCR is CPU-heavy, but the real fences are the 3/day cap in
           // claim_receipt and the in-process queue (RECEIPT_BUSY). This is
           // per-IP DoS hygiene, sized for a NAT'd campus network.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many receipt scans from this connection, try again in a few minutes.' },
});
app.use('/api/me/receipt', receiptLimiter, express.json({ limit: '8mb' }));

// The operator's "scan here" QR poster is the other large body: a print-ready
// PDF/ZIP, base64'd into JSON like the logo (this API takes no multipart — see
// middleware/require-json.js). base64 inflates by 4/3, so this allows the 10 MB
// file cap in lib/qr-poster.js plus the encoding overhead and the JSON envelope.
// No extra limiter: /api/admin/* is behind the operator allowlist, which is a
// far tighter gate than any per-IP cap. Mounted here, above the global parser,
// for the same mount-order reason as the receipt route.
app.use('/api/admin/qr-poster', express.json({ limit: '14mb' }));

// Resend delivery events. The Svix signature covers the EXACT bytes that were
// sent, so this path gets a raw parser rather than the JSON one: re-serialising
// a parsed object changes key order and whitespace, and the signature would
// never verify again. Mounted here for the same mount-order reason as the two
// parsers above — the global express.json() below skips a body already parsed.
app.use('/api/webhooks/resend', express.raw({ type: 'application/json', limit: '256kb' }));

// Bodies are tiny everywhere except a vendor saving a logo, which arrives as a
// base64 data-URL (resized client-side to ~128px, so tens of KB). 600kb gives
// that headroom; still small enough that the requireJson gate + rate limits keep
// the large-body DoS surface negligible. (The receipt route above is the one
// carve-out, with its own limiter + 8mb parser.)
app.use(express.json({ limit: '600kb' }));

// ---- Rate limiting ----
// In-memory store — correct for a single instance (the pilot). If this is ever
// run multi-instance, swap in a shared store (e.g. rate-limit-redis).
//
// NOTE ON KEYING: these limit per IP. Students share one NAT'd IP on campus
// wifi, so the general cap is deliberately generous (DoS protection only, not
// per-user throttling). The tight caps are on brute-force targets that see low
// legitimate volume. For per-user throttling at scale, key on the auth'd user.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many requests, try again shortly.' },
});
// The staff PIN is a 4-digit secret (10k combos) → the real brute-force target.
// Low legitimate volume (once per shift), so cap hard.
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many PIN attempts, wait a few minutes.' },
});
// 4-digit redeem codes are also enumerable; cap moderately (well above a busy
// vendor's real redemption rate, well below what makes enumeration practical).
// One limiter instance = one shared counter across every path it's mounted on
// (preview + confirm, rewards + punch cards), so the ceiling is sized for all
// four together: ~240 code lookups per terminal IP per 15 minutes.
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a minute and try again.' },
});
// Client crash reports post here (unauthenticated — errors happen pre-login too),
// so cap the write rate hard to keep it from being used to spam the log table.
const clientErrorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
// Install-funnel analytics post here (unauthenticated — pwa_launched can fire
// before the session restores). Chattier than crash reports (several events per
// install flow), so cap higher than clientErrorLimiter but still bounded.
const clientEventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
// Public vendor applications (/join) — unauthenticated writes, and each one bcrypt-hashes a
// password (CPU) and can carry a logo (~100s of KB), so cap it hard. A real
// applicant submits once, maybe twice after a validation error.
const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many applications from this connection, try again later.' },
});
// Community-point transfers move real value (community-points.md step 6), so
// they get their own cap like the other money-adjacent endpoints. Per-IP on a
// NAT'd campus network, so generous vs. one student's real usage (a handful of
// moves), tight vs. a script hammering the RPC.
const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many moves, wait a minute and try again.' },
});
// Punch claims are authenticated but cheap to spam (each one costs an RPC);
// generous per-IP because a busy bar's wifi can NAT a whole line of students
// through one address, tight enough to keep a script from hammering the RPC.
// (Token forgery isn't the concern — the HMAC is unguessable — this is DoS
// hygiene, like the general limiter.)
const punchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a minute and try again.' },
});
// The camera-scan handoff is UNauthenticated (the whole point is the student
// isn't signed in yet), so it gets its own bound. Each accepted hold writes a
// row; the per-vendor cap in create_punch_hold is the second fence.
const punchHoldLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a minute and try again.' },
});
// A printed banner's QR (migration-050). Deliberately LOOSE, and the looseness
// is the point: a poster at a club fair is scanned by a crowd standing on one
// campus wifi NAT, so a tight per-IP cap would throttle exactly the event the
// operator put the banner up for — the same trap already documented above for
// referrals. This is a DoS backstop on an unauthenticated write, nothing more.
// The number to trust against inflation is the UNIQUE visitor count, not this;
// link-preview crawlers are dropped in src/lib/tracked-qr.js before they ever
// reach a row.
const trackedQrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many scans from this network, wait a minute and try again.' },
});
// Unauthenticated password reset for a locked-out vendor (migration-031). The
// per-code guess cap inside vendor_reset_begin is the fence that actually
// matters — it survives IP rotation, which this can't — so size this for the
// legitimate case instead: a vendor gets one code read to them and types it
// once, maybe three times with fumbles. Also caps the bcrypt work an anonymous
// caller can force per IP.
const recoverLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a few minutes and try again.' },
});
// Campaign sends (migration-032) fan one request out to 100 students, so they
// get a cap of their own on top of the per-vendor weekly quota enforced in
// create_campaign. The quota is the real fence (it survives IP rotation); this
// bounds the audience-expansion work an authenticated terminal can force, and
// covers the reach-preview poll the composer makes as a vendor picks audiences.
const campaignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a minute and try again.' },
});
// Claiming a referral code (migration-039). Guessing was never the threat — six
// characters of a 31-letter alphabet is ~887 million codes — so this is DoS
// hygiene, sized the way punchLimiter is: generous per-IP, because campus wifi
// NATs a whole building through one address and a signup table at an activities
// fair is a dozen students claiming codes from the same one inside a minute.
// GET is skipped entirely: that's the share card, which every student loads on
// every app open and which decides nothing.
const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'POST',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts, wait a few minutes and try again.' },
});
app.use('/api', generalLimiter);
app.use('/api/vendor/verify-pin', pinLimiter);
app.use('/api/vendor/recover', recoverLimiter);
// ...and a tighter one on the half that SENDS MAIL, stacked on top of it. Two
// separate concerns share that prefix since migration-047: /recover spends
// guesses against a live code, /recover/request mints a new one and mails it.
// Without its own cap they share a budget, so hammering the mailer would use up
// the guesses a legitimate vendor needs — and on a NAT'd campus network that is
// one shared IP for everybody. The per-login cooldown in vendor_reset_request is
// the real fence (it survives IP rotation); this bounds the mail one address can
// be made to receive.
app.use('/api/vendor/recover/request', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Same uniform answer shape as the route itself: a caller must not be able to
  // tell a rate limit from a successful request for an address that doesn't exist.
  message: { ok: true, message: 'If that email runs a spot on WeRewards, a reset code is on its way. It lasts 30 minutes.' },
}));
// Every path that resolves a 4-digit code, not just the preview. app.use()
// matches on whole path segments, so '/api/vendor/redeem-preview' alone left
// '/api/vendor/redeem' and both punch-card paths covered by nothing but the
// 1000/15min general cap — enough to sweep 10% of the 4-digit space inside a
// live code's 120-second life.
// migration-029 folded the punch-card counter codes into redeem_codes, so the
// two punch-redeem paths are gone; /api/me/redeem-code joins the list because
// it MINTS into the same 4-digit space and was previously covered by nothing
// but the 1000/15min general cap.
app.use([
  '/api/vendor/redeem-preview',
  '/api/vendor/redeem',
  '/api/me/redeem-code',
], redeemLimiter);
app.use('/api/vendor/campaigns', campaignLimiter);
app.use('/api/me/community-transfer', transferLimiter);
app.use('/api/me/referral', referralLimiter);
app.use('/api/me/punch', punchLimiter);
app.use('/api/punch/hold', punchHoldLimiter);
app.use('/api/client-error', clientErrorLimiter);
app.use('/api/client-event', clientEventLimiter);
app.use('/api/apply', applyLimiter);

// ---- Which deployment is this? ----
// A test deployment (APP_ENV=staging) runs byte-identical code from the same
// branch as production; everything that differs is SERVED, never committed, so
// `staging` and `main` never drift apart and nothing has to be stripped before
// a merge. What has to differ is confined to the phone:
//   • the installed PWA must be an obviously different app, or the test icon
//     and the real one are indistinguishable on the home screen (same name,
//     same artwork, same everything) — see serveTestManifest + markTestEnv;
//   • each deploy must invalidate its own service-worker cache, or a test
//     session silently runs the previous deploy's bytes — see serveTestSw.
// Unset means production, so an unconfigured environment can never accidentally
// present itself as the safe one to experiment in.
const APP_ENV = process.env.APP_ENV || 'production';
const IS_TEST_ENV = APP_ENV !== 'production';

// Static app shells: student PWA at / , vendor terminal at /terminal , operator
// dash at /admin , public vendor application page at /join .
//
// Cache-busting. Cloudflare (in front of the dyno) caches /app.js, /styles.css,
// etc. for hours and tells browsers to as well. Those filenames never change,
// so after a deploy the old bytes keep being served until the cache expires.
// Fix: stamp every local .js/.css reference in the served HTML with a
// ?v=<content-hash> of that file. A changed file → new hash → new URL that no
// cache can serve stale; unchanged files keep their URL (and stay cached). The
// HTML documents are sent no-cache, so browsers always pick up the freshest
// tags. Rendered HTML and hashes are memoised — asset bytes don't change while
// a dyno is alive, and a redeploy starts a fresh process.
const assetHashes = new Map();   // abs file path -> 8-char content hash (or null if not on disk)
function assetHash(absPath) {
  if (!assetHashes.has(absPath)) {
    let h = null;
    try { h = crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex').slice(0, 8); }
    catch { /* not a real on-disk asset (e.g. /socket.io/socket.io.js) — leave the URL alone */ }
    assetHashes.set(absPath, h);
  }
  return assetHashes.get(absPath);
}

// One id standing for everything an app currently serves: a hash over the
// content hashes of every file under its root. It changes if and only if that
// app's bytes change, which is what makes it usable as a service-worker cache
// name (see serveTestSw) — a release id or a boot timestamp would also change
// when an idle Eco dyno sleeps and wakes, throwing away a good cache several
// times a day for nothing. Memoised per root: asset bytes can't change while
// the process lives, and a deploy starts a fresh one.
const appBuildIds = new Map();   // app root -> 8-char id
function appBuildId(root) {
  if (!appBuildIds.has(root)) {
    const h = crypto.createHash('sha1');
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));   // stable order → stable id
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else h.update(`${path.relative(root, abs)}:${assetHash(abs)}\n`);
      }
    };
    try { walk(root); } catch { /* unreadable → the empty hash, still stable */ }
    appBuildIds.set(root, h.digest('hex').slice(0, 8));
  }
  return appBuildIds.get(root);
}

// Add ?v=<hash> to href/src values that point at a local .js/.css file.
// External URLs (fonts, the supabase CDN) and non-file refs are left untouched.
const ASSET_REF = /\b(href|src)=(["'])([^"']+\.(?:js|css))(?:\?[^"']*)?\2/gi;
function versionAssets(html, mount, root) {
  return html.replace(ASSET_REF, (full, attr, quote, url) => {
    if (/^(?:https?:)?\/\//i.test(url) || url.startsWith('data:')) return full;   // external / inline
    // Refs are absolute (e.g. /app.js under mount / , /terminal/x.js under /terminal).
    // Strip the mount prefix, then resolve against the app's on-disk root.
    let rel = url;
    if (mount !== '/' && rel.startsWith(mount + '/')) rel = rel.slice(mount.length);
    const hash = assetHash(path.join(root, rel.replace(/^\/+/, '')));
    return hash ? `${attr}=${quote}${url}?v=${hash}${quote}` : full;   // not ours → skip
  });
}

// apple-mobile-web-app-capable, emitted per-request. iOS 16.4 (March 2023) made a
// manifest `display: standalone` enough on its own to launch a Home Screen icon
// chrome-less — that is how the student PWA runs, declaring no apple-* meta at all.
// Before 16.4 this tag is the only thing keeping a counter iPad out of Safari's URL
// bar and toolbars mid-transaction, so old devices must keep it.
//
// It is not free on modern iOS. The tag also opts the icon into the legacy WebClip
// container, whose frame on a notched phone is the screen minus the status bar but
// still pinned to y=0: the app sits one status bar too high and strands that height
// at the bottom, where no CSS can reach — the vendor terminal's bottom-band bug.
// Confirmed on an iPhone: iOS re-reads the tag from the served document at launch,
// so dropping it fixes an already-installed icon without a delete-and-re-add.
// public/vendor and public/admin carry the slot; student and join never declared
// the tag at all, so the replace below is a no-op for them.
//
// iPadOS 13+ Safari defaults to a desktop-class UA carrying no OS version, so an
// iPad normally falls into the "can't date it" branch and keeps the tag. That is
// the safe side of the trade: worst case it keeps a visible layout bug, rather than
// putting a live terminal behind browser chrome.
const IOS_UA = /\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+)[._](\d+)/;
function needsLegacyCapable(ua) {
  const m = IOS_UA.exec(ua || '');
  if (!m) return true;   // desktop, Android, or iPadOS desktop mode — leave the shell as authored
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < 16 || (major === 16 && minor < 4);
}
const CAPABLE_SLOT = '<!--APPLE-CAPABLE-->';
const CAPABLE_META = '<meta name="apple-mobile-web-app-capable" content="yes" />';

// The one case where an install must give the tag up even though needsLegacyCapable
// says keep it. Before iOS 14.3 the legacy WebClip container has no getUserMedia at
// all, so the tag costs the terminal its SCANNER, not just the layout bug above.
// UA sniffing cannot catch this: iPadOS 13+ sends a desktop-class Mac UA carrying no
// OS version, so every iPad lands in needsLegacyCapable's "can't date it" branch and
// keeps the tag. The device itself is the only thing that knows, so the page sets
// this cookie the first time the scanner finds the API missing while running
// chrome-less (see STANDALONE_CAM_COOKIE in public/vendor/terminal.js) and clears it
// again if the camera ever does start there. Withholding the tag makes the next
// launch open in Safari, which has the camera. That trades the URL bar for a working
// scanner, and on a point-of-sale terminal the scanner is the app.
const NO_STANDALONE_CAM = /(?:^|;\s*)wr_no_standalone_cam=1(?:\s*;|\s*$)/;

// Non-production shells carry two marks. `data-app-env` on <html> is a hook for
// any later CSS or script that wants to shout "this is the test app" — nothing
// uses it yet on purpose, because a fixed banner has to be fitted around the
// iOS safe-area handling rather than dropped on top of it. The <title> prefix
// is the one that pays off immediately: it's what the phone's app switcher and
// the browser tab show, so the two installs stop looking alike there too.
// Interpunct, not an em dash — the shells' COPY RULE covers this string.
function markTestEnv(html) {
  return html
    .replace(/<html\b/i, `<html data-app-env="${APP_ENV}"`)
    .replace(/<title>([^<]*)<\/title>/i, (_full, title) => `<title>TEST · ${title}</title>`);
}

const renderedShells = new Map();   // "<index.html path>|<variant>" -> versioned HTML string
function serveShell(mount, root) {
  const htmlPath = path.join(root, 'index.html');
  return (req, res) => {
    const legacy = needsLegacyCapable(req.get('user-agent'))
      && !NO_STANDALONE_CAM.test(req.get('cookie') || '');
    const key = `${htmlPath}|${legacy ? 'legacy' : 'modern'}`;
    let html = renderedShells.get(key);
    if (html == null) {
      html = versionAssets(fs.readFileSync(htmlPath, 'utf8'), mount, root)
        .replace(CAPABLE_SLOT, legacy ? CAPABLE_META : '');
      if (IS_TEST_ENV) html = markTestEnv(html);
      renderedShells.set(key, html);
    }
    res.set('Cache-Control', 'no-cache');   // always revalidate so new ?v= tags are seen
    res.vary('User-Agent');                 // ...and never hand one device's variant to another
    res.vary('Cookie');                     // ...including the chrome-less opt-out above
    res.type('html').send(html);
  };
}

// ---- 404 ----
// Every URL that matched no shell, no static asset and no API route ends up
// here (see the catch-all mounted after the last route). Before this existed
// they got Express's built-in handler: a bare "Cannot GET /termnal" in Times
// New Roman, which reads like the site is broken rather than like one character
// is wrong.
//
// The page is deliberately self-contained — no stylesheet, no script, all URLs
// absolute — because it is served AT the bad path, not redirected to a canonical
// one. A redirect would be worse here: it throws away the address the visitor
// typed, so they never see what they got wrong, and it turns a 404 into a 302
// that crawlers and link checkers read as a working link. See the long note at
// the top of public/shared/404.html for the constraints that follow from that.
//
// public/shared is not an app root and is not mirrored into .build (see
// scripts/build-client.js), so this is read from source.
const NOT_FOUND_FILE = path.join(__dirname, 'public/shared/404.html');
let notFoundHtml = null;
function notFoundPage() {
  // Memoised in production only, where the bytes can't change under a running
  // dyno. Off production it is re-read every time, for the same reason
  // freshenAsset exists below: this file is not a loaded module, so `node
  // --watch` does not restart on an edit to it, and a cached copy would mean
  // editing a page nobody is being served.
  if (notFoundHtml == null || IS_TEST_ENV) {
    const html = fs.readFileSync(NOT_FOUND_FILE, 'utf8');
    notFoundHtml = IS_TEST_ENV ? markTestEnv(html) : html;
  }
  return notFoundHtml;
}

// Extensions this app actually serves as subresources. A miss on one of these
// is a broken REFERENCE, not a URL a person typed, and answering it with an
// HTML document hands the browser HTML to parse as JavaScript. helmet's
// nosniff already refuses that, but a two-word text/plain body is cheaper and
// reads far better in a devtools network panel.
const ASSET_EXT = /\.([a-z0-9]{1,12})$/i;
const ASSET_EXTS = new Set([
  'js', 'css', 'map', 'json', 'wasm', 'traineddata',
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'ico', 'gif',
  'woff', 'woff2', 'ttf', 'txt', 'xml',
]);

function sendNotFound(req, res) {
  res.status(404);
  // Never cache a 404. Cloudflare sits in front of the dyno, and the student
  // PWA's service worker caches every same-origin GET it makes — so without
  // this, a path that 404s today and ships in the next deploy would keep
  // serving the miss to anyone who hit it early.
  res.set('Cache-Control', 'no-store');

  // API clients parse the body as JSON and show `message` verbatim; the shape
  // matches the central error handler below so a caller needs one code path.
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    return res.json({ error: 'NOT_FOUND', message: 'That endpoint does not exist.' });
  }
  // A fetch() that asked for JSON gets JSON even off /api.
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ error: 'NOT_FOUND', message: 'That page does not exist.' });
  }
  const ext = ASSET_EXT.exec(req.path);
  if (ext && ASSET_EXTS.has(ext[1].toLowerCase())) {
    return res.type('txt').send('Not found');
  }
  res.type('html').send(notFoundPage());
}

// ---- Client asset build ----
// Nothing under public/ is served directly any more. Every .js and .css is
// lowered to ES2017 (and old-Safari-safe CSS) into .build/ first, and the mounts
// below point at that mirror. See scripts/build-client.js for the why — short
// version: the hand-authored bundles and supabase-js all needed Safari 14+ just
// to PARSE, so on an older iPad every script died with a SyntaxError before its
// first statement, leaving the student PWA stuck on its boot splash and the
// vendor terminal on a white screen.
//
// Built at boot, synchronously and before any route is mounted: a fresh dyno
// then serves bytes that match the source it was deployed with, `node --watch`
// picks changes up on restart, and a broken build takes the process down here
// instead of serving a half-lowered app.
buildClientAssets({ log: (msg) => console.log(msg) });

const shells = [
  { mount: '/',         dir: 'student' },
  { mount: '/terminal', dir: 'vendor'  },
  { mount: '/admin',    dir: 'admin'   },
  { mount: '/join',     dir: 'join'    },
  // Fallback POS screen for a device too old for /terminal (built for an iPad
  // mini on iOS 12.5.7). No manifest/sw.js on purpose — see public/scan/README
  // note in scan.js: it must never run inside an installed home-screen icon,
  // since iOS gave getUserMedia to that container only from 14.3, and this
  // device is far below that. Opened as a plain Safari tab, the camera works.
  { mount: '/scan',     dir: 'scan'    },
].map((shell) => ({ ...shell, root: buildRoot(shell.dir) }));

// Dev-only: re-lower one asset if its source changed since boot. See the static
// mount loop below for why this exists. A malformed percent-escape in the URL is
// not worth a 500 — fall through and let express.static answer it.
function freshenAsset(dir) {
  return (req, _res, next) => {
    try { ensureFresh(dir, decodeURIComponent(req.path).replace(/^\/+/, '')); }
    catch { /* undecodable path, or a source file that no longer parses — serve what's built */ }
    next();
  };
}

// ---- Test-deployment overrides (APP_ENV != production) ----
// Both routes below are registered ONLY on a test deployment. In production
// they don't exist at all and express.static serves both files off disk exactly
// as before, so the risk this adds to the live app is a boolean.

// A different origin already gives a test deployment its own service worker,
// caches, storage and push subscription — but not its own identity. Installed
// from the same manifest, the test app lands on the home screen with the real
// app's name and artwork and there is no way to tell which one you tapped.
// Rewriting the name and the theme colour (which tints the Android status bar
// and the iOS splash) fixes that without a second set of icon files.
const TEST_THEME_COLOR = '#b3261e';   // crimson; nothing in the real apps is this colour
function serveTestManifest(root) {
  const file = path.join(root, 'manifest.json');
  return (_req, res) => {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return res.status(404).end(); }
    if (manifest.name) manifest.name = `TEST ${manifest.name}`;
    if (manifest.short_name) manifest.short_name = `TEST ${manifest.short_name}`;
    manifest.theme_color = TEST_THEME_COLOR;
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json').send(JSON.stringify(manifest, null, 2));
  };
}

// Stamp the app's build id onto the service worker's cache name. Two things
// follow, and the second is the point: the served sw.js BYTES change whenever
// the app changes, which is the only signal a browser uses to decide it has a
// new worker to install, and the cache name changes with it so the activate
// handler's prefix sweep drops the previous build. Net effect on a test
// deployment: a deploy always reaches the installed PWA, with no CACHE constant
// to remember to bump — forgetting that bump means an afternoon of testing the
// previous deploy's code and drawing conclusions from it.
//
// The suffix keeps each app inside its own namespace ('werewards-v46' becomes
// 'werewards-v46-1a2b3c4d', still matching the 'werewards-v' prefix the student
// worker sweeps on, and likewise for the terminal and admin prefixes), so the
// existing cleanup logic collects old build ids unchanged.
//
// Production is deliberately left alone for now: the same treatment would work
// there and would retire the manual bump for good, but it should earn that by
// behaving here first. Flipping it on later is this one condition.
const SW_CACHE_CONST = /(const\s+CACHE\s*=\s*)(['"])([^'"]+)\2/;
function serveTestSw(root) {
  const file = path.join(root, 'sw.js');
  return (_req, res) => {
    let js;
    try { js = fs.readFileSync(file, 'utf8'); }
    catch { return res.status(404).end(); }
    js = js.replace(SW_CACHE_CONST, (_full, head, quote, name) =>
      `${head}${quote}${name}-${appBuildId(root)}${quote}`);
    res.set('Cache-Control', 'no-cache');   // never let a stale worker script be reused
    res.type('application/javascript').send(js);
  };
}

// ---- Crawler-facing routes ----
// Mounted ABOVE the shells and the static mirror so nothing can shadow them,
// and so `/robots.txt` stays a decision this process makes rather than a file
// somebody has to remember to drop into public/student/ (where it would also
// have to be right for BOTH deployments, which it cannot be).
//
// Cached at the edge for an hour: Cloudflare fronts the dyno, both bodies are
// identical for every visitor, and an hour is short enough that a new vendor
// reaches the sitemap the same afternoon they are approved.
app.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(robotsTxt({ isTestEnv: IS_TEST_ENV }));
});

app.get('/sitemap.xml', async (req, res) => {
  // Vendor pages come off the SAME cached catalogue the student home screen
  // reads (src/lib/cache.js), so a crawler fetching this cannot cost a database
  // query that students are not already paying for. A catalogue read that fails
  // must not 500 the sitemap: the static pages are the ones that matter, and a
  // sitemap missing its vendor section for an hour is a far smaller problem
  // than one that answers Googlebot with an error.
  let spotPaths = [];
  try {
    const spots = await publicSpots();
    // Only the spots that are actually indexable. A page this app serves with
    // `noindex` and simultaneously submits in its sitemap sends two opposite
    // instructions, and Search Console reports the whole sitemap as containing
    // errors rather than quietly taking the noindex at its word.
    spotPaths = spots.filter(isIndexable).map((s) => `/spots/${s.slug}`);
  } catch (err) {
    await logError({
      source: 'server',
      message: `sitemap vendor section: ${err?.message}`,
      stack: err?.stack,
      path: req.originalUrl,
      method: req.method,
      userAgent: req.headers['user-agent'],
    });
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(sitemapXml([...STATIC_SITEMAP_PATHS, ...spotPaths]));
});

// ---- Evergreen public pages (src/lib/content-pages.js) ----
// Rendered per request rather than memoised: the strings are constant, the
// render is string concatenation, and a cache here would be the kind of
// optimisation that only ever costs a bug. Cloudflare holds the result for an
// hour, which is where the saving actually is.
app.get(['/how-it-works', '/how-it-works/'], (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(howItWorksHtml());
});
app.get(['/faq', '/faq/'], (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(faqHtml());
});

// ---- Public, crawlable spot pages (src/lib/spots-page.js) ----
// The only pages on this origin that name a real local business, and therefore
// the only ones that can ever answer a search for one. Server-rendered because
// a crawler cannot sign in to the student app.
//
// Five minutes of shared caching. The catalogue underneath is already cached
// in-process, so this is about Cloudflare absorbing a crawl, not about the
// database. Short enough that an approved vendor appears almost immediately.
// A catalogue read that fails answers 503, not 500, and the distinction is the
// whole reason this helper exists. Both are errors, but a crawler treats 503 as
// "the site is briefly unwell, come back" and holds the URL in the index, while
// a 500 on a page it has already indexed counts against the site and, repeated,
// gets the page dropped. `Retry-After` says how briefly. Never 200 with an empty
// list here either: "this directory has no spots" is a truthful-looking page
// that would replace a good one in the index over a transient Supabase blip.
async function spotsUnavailable(err, req, res) {
  await logError({
    source: 'server',
    message: `spot pages unavailable: ${err?.message}`,
    stack: err?.stack,
    path: req.originalUrl,
    method: req.method,
    status: 503,
    userAgent: req.headers['user-agent'],
  });
  res.status(503).set('Retry-After', '120').set('Cache-Control', 'no-store');
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Spots are briefly unavailable</title>'
    + '<p>The spots list could not be loaded just now. Please try again in a minute.</p>');
}

app.get(['/spots', '/spots/'], async (req, res) => {
  try {
    const spots = await publicSpots();
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(spotsIndexHtml(spots));
  } catch (err) {
    await spotsUnavailable(err, req, res);
  }
});

app.get('/spots/:slug', async (req, res) => {
  try {
    const spot = await publicSpot(String(req.params.slug || '').toLowerCase());
    // A slug that is not a live partner is a genuine 404, not an empty page:
    // a vendor who leaves must stop being indexed, and soft-404s (a 200 that
    // says "nothing here") are the thing Google penalises a directory for.
    if (!spot) return sendNotFound(req, res);
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(spotPageHtml(spot));
  } catch (err) {
    await spotsUnavailable(err, req, res);
  }
});

// Versioned HTML shells first, so they win over express.static's own index.html.
for (const { mount, root } of shells) {
  app.get(mount === '/' ? ['/'] : [mount, mount + '/'], serveShell(mount, root));
}
// Then the test-only rewrites, which must also beat express.static to the file.
// Only the apps that actually ship a manifest / worker get a route (public/join
// is a plain page, not an installable app).
if (IS_TEST_ENV) {
  const base = (mount) => (mount === '/' ? '' : mount);
  for (const { mount, root } of shells) {
    if (fs.existsSync(path.join(root, 'manifest.json'))) {
      app.get(`${base(mount)}/manifest.json`, serveTestManifest(root));
    }
    if (fs.existsSync(path.join(root, 'sw.js'))) {
      app.get(`${base(mount)}/sw.js`, serveTestSw(root));
    }
  }
}
// Then the static assets themselves (index disabled — the routes above own the HTML).
//
// Off production, each mount is preceded by a freshness check. Before the build
// existed, express.static read public/ directly and an edit to app.js or
// styles.css was live on the next reload; now that the mirror is built once at
// boot, that would silently stop being true and cost an afternoon of editing a
// file nobody is serving. ensureFresh re-lowers a single file when its source is
// newer than its build output, which restores the old loop. Production skips it:
// there the source can't change under a running dyno, so it would be two wasted
// stat() calls on every asset request.
for (const { mount, dir, root } of shells) {
  if (IS_TEST_ENV) app.use(mount, freshenAsset(dir));
  app.use(mount, express.static(root, {
    index: false,
    // versionAssets() stamps ?v=<content hash> onto every local .js/.css
    // reference in the served HTML, which makes a STAMPED url immutable by
    // construction: different bytes can only ever arrive under a different
    // query string. Without this they were served max-age=0 and every repeat
    // visit revalidated all twelve of them for nothing.
    //
    // The extension test is not decoration. Unstamped urls (/sw.js,
    // /manifest.json, the icons, and the bare paths the worker precaches) MUST
    // keep revalidating, and it also means a hostile /manifest.json?v=1 cannot
    // talk a visitor's browser into caching that file for a year.
    setHeaders(res) {
      if (res.req?.query?.v && /\.(?:js|css)$/i.test(res.req.path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// Every page above declares its own <link rel="icon">, but a browser still asks
// for /favicon.ico unprompted for any document that does NOT — the 404 page, an
// /api URL opened in a tab, a link-preview crawler — and that was a 404 until
// now. Redirect rather than ship a second copy of the artwork: the student icon
// is already on disk and already precached, and serving it under its real name
// keeps the image/png content type. That last part matters, because helmet sets
// X-Content-Type-Options: nosniff and express.static would type a file named
// .ico as image/x-icon no matter what bytes were inside it.
// 302, not 301: a permanent redirect is cached by the browser indefinitely with
// no way to bust it, and the target filename is exactly the thing that changes
// if the artwork is ever redrawn (see the icon note in student/index.html).
app.get('/favicon.ico', (_req, res) => res.redirect(302, '/icons/icon-192.png'));

// Legal documents. The consent modal links these with target="_blank", and the
// Terms/Privacy Policy both promise the current version is available in the app,
// so they must be reachable by URL.
//
// ALLOWLISTED, not a blanket static mount: legal/ also holds the vendor
// agreements and the device receipt, which are print-and-sign documents
// containing the operator's business address and fee figures. Those are not
// web content. Only the documents students actually consent to are served, and
// the list comes from TERMS_DOCUMENTS so it can't drift from what the modal links.
const PUBLIC_LEGAL_FILES = new Set(TERMS_DOCUMENTS.map((d) => path.basename(d.path)));
app.use(
  '/legal',
  (req, res, next) => {
    const requested = req.path.replace(/^\/+/, '');
    const file = requested.endsWith('.html') ? requested : `${requested}.html`;
    // Not the allowlist's own 404 text any more: a student who mistypes a
    // legal URL is a person in a browser, so they get the same page every
    // other wrong address gets.
    if (!PUBLIC_LEGAL_FILES.has(file)) return sendNotFound(req, res);
    next();
  },
  express.static(path.join(__dirname, 'legal'), {
    index: false,
    extensions: ['html'],   // /legal/student-terms-of-service also resolves
    maxAge: '1h',           // cache briefly; a revision ships with a TERMS_VERSION bump
  })
);

// Per-user API data must always be fresh — no ETag/304 revalidation, which was
// letting the browser serve a stale cached balance.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// API
app.use('/api/me', studentRoutes);      // student-authenticated endpoints
// MUST stay above the vendor router: that router applies requireVendor to every
// path under /api/vendor, and a vendor recovering a password has no session to
// authenticate with. Express matches mounts in order, so this one answers first
// and never falls through.
app.use('/api/vendor/recover', vendorRecoverRoutes);  // public — locked-out vendors
app.use('/api/vendor', vendorRoutes);   // vendor-authenticated endpoints
app.use('/api/admin', adminRoutes);     // operator-only (ADMIN_EMAILS) analytics + errors
app.use('/api/apply', applyRoutes);     // public vendor applications (rate-limited above)
app.use('/api/webhooks', webhookRoutes); // public, Svix-signed (Resend bounces/complaints)
// A printed banner's QR. Top-level and NOT under /api because this URL goes on
// vinyl — see src/routes/tracked-qr.js. Mounted here rather than beside
// /unsubscribe at the top of the file because the limiter above has to be in
// place first, and above sendNotFound because nothing after it is reachable.
app.use('/r', trackedQrLimiter, trackedQrRoutes);  // public — poster/banner QR scans

// The cuisine vocabulary, for the two surfaces that have to OFFER it: the
// public /join application and the admin vendor editors. Public because /join
// is, and there is nothing here a competitor could not read off the filter
// sheet anyway — it is a list of words.
//
// The student app deliberately does NOT call this: its filter chips come from
// the cuisines the visible spots actually carry, so it needs no second request
// on the critical path and can never offer a chip that matches nothing.
app.get('/api/cuisines', (_req, res) => {
  res.json({ cuisines: CUISINES, max: MAX_CUISINES });
});

// Client crash reporting: the student PWA and vendor terminal post uncaught
// errors here so they land in the same error_logs the /admin page reads.
// Unauthenticated (errors can happen before sign-in), validated + size-capped,
// and rate-limited above. Any auth token is used best-effort to attribute a user.
const CLIENT_ERROR_SOURCES = new Set(['student', 'vendor', 'admin']);
app.post('/api/client-error', async (req, res) => {
  const b = req.body ?? {};
  if (!CLIENT_ERROR_SOURCES.has(b.source)) {
    return res.status(400).json({ error: 'BAD_SOURCE' });
  }
  // Crawlers render these pages and break on them in ways no student ever sees
  // (see isCrawler). Accepted and dropped, not rejected: filtering here rather
  // than in the four client reporters means the boot guard is covered too, and
  // that is the one reporter that runs on a browser we can't ship a fix to.
  if (isCrawler(req.headers['user-agent'])) return res.status(204).end();
  let userId = null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      // Local verification matters more here than on the gated routes: this
      // endpoint is unauthenticated, so a token check that reached out to GoTrue
      // would let anyone turn a flood of junk tokens into a flood of outbound
      // auth calls. A bad token is now rejected without leaving the dyno.
      userId = (await resolveUserFromToken(token))?.id ?? null;
    } catch { /* anonymous client error — fine */ }
  }
  await logError({
    source: b.source,
    message: b.message,
    stack: b.stack,
    path: b.url,
    userId,
    userAgent: req.headers['user-agent'],
    context: b.context,
  });
  res.status(204).end();
});

// PWA install funnel analytics: the student PWA posts each funnel stage
// (install_eligible → install_prompt_shown → install_accepted, plus dismissals
// and pwa_launched) here so drop-off is queryable in client_events (migration-024).
// Same shape as /api/client-error: unauthenticated, best-effort user attribution,
// validated + rate-limited above. An unknown event is dropped rather than 400'd
// so a client rolled ahead of the server never spams errors into its own console.
const CLIENT_EVENT_SOURCES = new Set(['student', 'vendor', 'admin']);
const CLIENT_EVENTS = new Set([
  // install_prompt_deferred: Chromium's native prompt was due but the page held
  // no user activation, so it is armed and waiting on the student's next tap. A
  // healthy funnel has a matching install_prompt_shown close behind most of these.
  'install_eligible', 'install_prompt_deferred', 'install_prompt_shown',
  'install_prompt_dismissed', 'install_accepted', 'pwa_launched',
]);
app.post('/api/client-event', async (req, res) => {
  const b = req.body ?? {};
  if (!CLIENT_EVENT_SOURCES.has(b.source) || typeof b.event !== 'string') {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  if (!CLIENT_EVENTS.has(b.event)) return res.status(204).end();  // unknown → silently ignore
  let userId = null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      userId = (await resolveUserFromToken(token))?.id ?? null;
    } catch { /* anonymous event (e.g. pwa_launched pre-login) — fine */ }
  }
  await logEvent({
    source: b.source,
    event: b.event,
    trigger: typeof b.trigger === 'string' ? b.trigger : null,
    props: b.props,
    userId,
    userAgent: req.headers['user-agent'],
    path: b.url,
  });
  res.status(204).end();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Punch-card camera-scan handoff (migration-028). A phone-camera scan of the
// terminal's rotating QR lands here signed OUT, and the token dies in ~90s —
// far less time than Google OAuth + the consent modal take. So the page swaps
// the still-live token for a single-use, 10-minute hold FIRST, then sends the
// student through sign-in, and claims the hold via POST /api/me/punch after.
//
// Unauthenticated on purpose (there is no session yet), which makes the two
// fences below load-bearing:
//   • the returned holdId is useless on its own — the matching nonce goes back
//     ONLY as an httpOnly cookie, and punch_in requires both. A holdId copied
//     out of this response and sent to a friend can't be spent in their
//     browser, so one scan can't be turned into shareable punches.
//   • create_punch_hold caps holds per 30-second slot and evicts (rather than
//     refuses) at the per-vendor ceiling, so a flood can neither inflate one
//     token into hundreds of credentials nor lock genuine scanners out.
app.post('/api/punch/hold', async (req, res, next) => {
  try {
    const parsed = verifyPunchToken(req.body?.token);
    if (!parsed) {
      return res.status(401).json({
        error: 'PUNCH_INVALID',
        message: 'That visit code has expired. Scan the live code at the counter.',
      });
    }
    const binding = mintPunchBinding();
    const { data, error } = await supabaseAdmin.rpc('create_punch_hold', {
      p_vendor_id: parsed.vendorId,
      p_token_window: parsed.windowIndex,
      p_ttl_seconds: PUNCH_HOLD_TTL_SECONDS,
      p_binding_hash: binding.hash,
    });
    if (error) throw error;
    // SameSite=Lax survives the top-level Google OAuth redirect back to us, and
    // the claim itself is a same-origin fetch, so the cookie rides along with
    // no client-side handling. httpOnly means page JS can never read or replant
    // it — that is what binds the hold to this browser.
    res.cookie(PUNCH_BINDING_COOKIE, binding.nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: PUNCH_HOLD_TTL_SECONDS * 1000,
      path: '/',
    });
    res.json({ holdId: data, expiresIn: PUNCH_HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

// Public vendor logo. Served as real image bytes (decoded from the base64
// data-URL stored on the vendor) so the student card can use a plain <img>/
// background that the browser caches — keeping the polled /balances payload
// lean. Logos are shown to everyone, so no auth; only active vendors resolve.
// ONE RENDER OF THE VENDOR LIST USED TO BE ONE DATABASE QUERY PER CARD. Each
// card's background-image points here, and this read a base64 blob out of
// `vendors` and decoded it per request, behind `max-age=300` with no validator —
// so every five minutes each student paid N queries and N full downloads again,
// and nothing could ever answer 304. The service worker doesn't help either: it
// returns early on /api/ paths (public/student/sw.js).
//
// Three changes, in order of how much they matter:
//   1. The decoded bytes are cached in process (src/lib/cache.js), so N cards
//      cost at most N queries ONCE, shared by every student on the dyno, and
//      the vendor's logo-upload path invalidates it.
//   2. A content-derived ETag, so a browser revalidating gets a 304 with an
//      empty body instead of the image again.
//   3. An hour of max-age instead of five minutes, plus stale-while-revalidate
//      so the refresh happens off the paint path.
//
// NOT `immutable`, and NOT a year: this URL is mutable — a vendor re-uploading
// their artwork keeps the same /api/vendor-logo/<id>. A long max-age here would
// pin the old image in every student's browser with no way to reach them, since
// nothing about the URL changes. An hour is the trade: 12x fewer revalidations
// than before, each one now answered from memory rather than Postgres, and a new
// logo is live everywhere within the hour. To go longer the URL has to carry a
// content version (e.g. ?v=<hash> sourced from the catalogue) — worth doing if
// logo traffic ever matters again, but it needs a client change to go with it.
app.get('/api/vendor-logo/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).end();

    const logo = await loadVendorLogo(req.params.id);
    if (!logo) return res.status(404).end();

    // Set the validator before the conditional check, so the 304 carries it too
    // — a 304 without an ETag makes the browser drop its cached copy.
    res.set('ETag', logo.etag);
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');

    // req.fresh compares If-None-Match against the ETag we just set. Express
    // handles the weak/strong and multi-value cases; doing it by hand gets the
    // `W/` prefix and `*` wrong.
    if (req.fresh) return res.status(304).end();

    res.set('Content-Type', logo.contentType);
    res.send(logo.body);
  } catch {
    res.status(404).end();
  }
});

// Safe-to-expose config for browser clients (anon key is public by design; RLS protects data)
// Unauthenticated, fetched by every app at boot. `signupBonus` rides along so
// the SIGNED-OUT landing page can tell a student to use their university email
// BEFORE they pick a Google account — after that choice it is too late, and the
// bonus is decided by the address they arrive with. null when no program is
// running, so the page never promises a bonus nobody will be paid.
//
// `emailEnabled` rides along for the same reason and is needed at the same
// moment: the terminal's "Email me a code" button sits on the SIGNED-OUT recover
// screen, so the only way to hide it on a deployment that cannot send mail is a
// flag available before anyone has signed in. It is a property of the
// deployment, not of any account — it says nothing about whether a given address
// is a vendor login, which is the disclosure /api/vendor/recover/request's
// uniform response exists to prevent.
app.get('/api/public-config', async (_req, res) =>
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    signupBonus: await publicSignupBonus(),
    emailEnabled,
    // The two knobs the nearby-spots watcher needs before it can do anything
    // (migration-051). Served rather than baked into the bundle so the radius
    // and the dwell can be retuned from the environment without a rebuild —
    // they are the numbers most likely to want adjusting once the feature meets
    // a real street. Deliberately NOT the caps or quiet hours: those are
    // enforced in the database, and a client that knew them would be tempted to
    // decide for itself and skip the claim.
    nearby: NEARBY_CONFIG,
  })
);

// Nothing matched. MUST stay below every route and above the error handler:
// Express walks the stack in order, so a mount added after this one is
// unreachable. (See sendNotFound above for what each kind of caller gets.)
app.use(sendNotFound);

// Central error handler — routes call next(err)
app.use(async (err, req, res, _next) => {
  // Body-parser rejections (too large, malformed JSON) are the CALLER's mistake,
  // not a server fault. Without this they fell through to the 500 branch below,
  // which told the user "Something went wrong" and wrote a bogus row into the
  // error log — burying real failures under noise from an oversized upload.
  // Narrowly gated: only body-parser's own `entity.*` types with a 4xx status.
  if (typeof err?.type === 'string' && err.type.startsWith('entity.')
      && err.status >= 400 && err.status < 500) {
    const message = err.type === 'entity.too.large'
      ? 'That file is too large to upload.'
      : 'That request body could not be read.';
    return res.status(err.status).json({ error: 'BAD_BODY', message });
  }

  const known = {
    INSUFFICIENT_POINTS: [400, 'Not enough points for this reward.'],
    REWARD_NOT_FOUND: [404, 'Reward not found or inactive.'],
    VENDOR_UNAVAILABLE: [404, 'This spot is no longer available.'],
    CODE_INVALID: [401, 'That code is expired or invalid. Ask the customer to refresh their code.'],
    CODE_SPACE_EXHAUSTED: [503, 'Too many active codes right now, try again in a moment.'],
    TX_NOT_FOUND: [404, 'That transaction was not found for this vendor.'],
    ALREADY_REVERSED: [409, 'That transaction was already undone.'],
    CANNOT_REVERSE_REVERSAL: [400, 'That entry is itself an undo, so there is nothing to reverse.'],
    CANNOT_REVERSE_TRANSFER: [400, 'Moved-in community points are the student’s move to make, so it can’t be undone here.'],
    REVERSAL_EXPIRED: [403, 'Too late to undo. Undo is only available for one minute after a transaction.'],
    AMOUNT_INVALID: [400, 'Enter a valid number of points to move.'],
    VENDOR_INELIGIBLE: [409, 'This spot isn’t accepting moved-in points right now.'],
    VENDOR_CAP_REACHED: [409, 'This spot has hit its limit for moved-in points this month, try another spot.'],
    // Punch cards (migration-028)
    // The error CODES keep their punch_* names (they match the SQL and the DB
    // schema); only the copy the student reads is in visits language.
    PUNCH_DISABLED: [403, 'Visits aren’t available at this spot right now.'],
    ALREADY_PUNCHED: [409, 'You already counted a visit here tonight, come back tomorrow!'],
    PUNCH_INVALID: [401, 'That visit code has expired. Scan the live code at the counter.'],
    HOLD_INVALID: [401, 'That visit link has expired. Scan the code at the counter again.'],
    HOLD_LIMIT: [503, 'Visits are busy right now, try again in a moment.'],
    PUNCH_CARD_RACE: [503, 'Try that visit again in a second.'],
    // Visits as a second currency (migration-029). NOTE the matcher below is a
    // SUBSTRING scan over these keys, so no key here may contain, or be
    // contained by, another. Checked: none of these collide with
    // INSUFFICIENT_POINTS or REWARD_NOT_FOUND.
    INSUFFICIENT_VISITS: [400, 'Not enough visits for this reward yet.'],
    REWARD_NOT_POINTS_PRICED: [400, 'This reward can’t be bought with points.'],
    REWARD_NOT_VISITS_PRICED: [400, 'This reward can’t be bought with visits.'],
    BAD_CURRENCY: [400, 'Choose points or visits.'],
    // Vendor campaigns (migration-032). Same substring-scan caveat as above:
    // checked, none of these contains or is contained by another key.
    CAMPAIGN_QUOTA: [429, 'You’ve used all your sends this week. The limit is what keeps students from muting every spot at once.'],
    CAMPAIGN_TITLE_INVALID: [400, 'Give the deal a headline (up to 60 characters).'],
    CAMPAIGN_BODY_INVALID: [400, 'Write the message (up to 140 characters).'],
    CAMPAIGN_KIND_INVALID: [400, 'Pick a valid deal type.'],
    CAMPAIGN_AUDIENCE_INVALID: [400, 'Pick a valid audience.'],
    // Receipt claims (migration-038). Same substring-scan caveat as above:
    // checked, none of these contains or is contained by another key (the
    // TOTAL_ pair share only a prefix; nothing else in this map says RECEIPT).
    RECEIPT_IMAGE_INVALID: [400, 'That photo didn’t come through. Try again with a JPEG or PNG.'],
    RECEIPT_UNREADABLE: [400, 'Couldn’t read that receipt. Lay it flat, fill the frame, and try again in good light.'],
    // Only reachable with the AI reader configured (lib/gemini-receipt.js) —
    // tesseract can't judge authenticity, so with no GEMINI_API_KEY set this
    // code is simply never thrown.
    RECEIPT_NOT_GENUINE: [400, 'That doesn’t look like a photo of an original printed receipt. Photograph the paper receipt itself — screenshots and photos of a screen don’t count.'],
    RECEIPT_VENDOR_UNKNOWN: [404, 'Couldn’t match this receipt to a participating spot.'],
    RECEIPT_TOTAL_MISSING: [400, 'Couldn’t read the total on this receipt. Make sure the TOTAL line is visible.'],
    RECEIPT_TOTAL_TOO_LARGE: [400, 'That total is over the $200 per-receipt limit.'],
    RECEIPT_DATETIME_MISSING: [400, 'Couldn’t read the date and time printed on this receipt — both need to be visible.'],
    RECEIPT_TOO_OLD: [400, 'Receipts only count for 7 days. This one is too old.'],
    RECEIPT_IN_FUTURE: [400, 'That receipt is dated in the future — that can’t be right.'],
    RECEIPT_CLAIMED: [409, 'This receipt has already been claimed.'],
    RECEIPT_ALREADY_EARNED: [409, 'Looks like you already earned points for this purchase at the counter.'],
    RECEIPT_DAILY_LIMIT: [429, 'You’ve claimed 3 receipts today — come back tomorrow.'],
    RECEIPT_BUSY: [503, 'Receipt scanning is busy right now, try again in a minute.'],
    // Incentives + referrals (migration-039). Same substring-scan caveat as
    // above, and it BIT here: the obvious name for the first one was
    // REFERRAL_CODE_INVALID, which contains CODE_INVALID (declared far earlier)
    // and would have shown a student "Ask the customer to refresh their code".
    // Checked: none of the keys below contains, or is contained by, another.
    REFERRAL_BAD_CODE: [404, 'That invite code doesn’t exist. Check it and try again.'],
    REFERRAL_SELF: [400, 'That’s your own invite code. Share it with a friend instead!'],
    REFERRAL_ALREADY_SET: [409, 'You’ve already used an invite code.'],
    REFERRAL_TOO_LATE: [409, 'Invite codes only work on a new account, before you start earning.'],
    REFERRAL_INACTIVE: [404, 'There’s no invite bonus running right now.'],
    REFERRAL_LIMIT: [409, 'Your friend has already invited as many people as this bonus allows.'],
    GRANT_POINTS_INVALID: [400, 'That isn’t a valid number of points.'],
    GRANT_STUDENT_UNKNOWN: [404, 'No student account with that email.'],
    GRANT_BUDGET_EXHAUSTED: [409, 'This incentive has paid out its whole budget. Raise the budget to keep it running.'],
    GRANT_ALREADY_PAID: [409, 'That bonus has already been paid.'],
    // Point pools (migration-044). Same substring-scan caveat as above, and it
    // needed real care here because the map already carries CODE_INVALID and
    // three VENDOR_* keys. Checked, in both directions: no key below contains
    // an existing key, and no existing key contains one of these.
    // CODE_WRONG_LOCATION is the near miss worth naming — it does NOT contain
    // CODE_INVALID (…WRONG… vs …INVALID), so a sibling's code can't be answered
    // with "ask the customer to refresh their code", which is advice that would
    // never work. VENDOR_IN_POOL likewise doesn't collide with VENDOR_INELIGIBLE.
    // They are appended LAST on purpose: the scan returns the first key in
    // insertion order that matches, so adding keys at the end cannot change
    // which message any existing error already resolves to.
    //
    // Wrong counter, right chain. The route attaches a publicMessage naming the
    // spot the code was minted for (see resolveRedeemCode); this line is the
    // fallback for when it couldn't be named. 409, not CODE_INVALID's 401: the
    // code is real and live, it just isn't this counter's.
    CODE_WRONG_LOCATION: [409, 'That code was made for another location of this business. Ask the customer for a code for this location.'],
    // The rest are thrown by pool RPCs that land in a later migration, declared
    // now so the first deploy that has them doesn't answer 500 'Something went
    // wrong' to an operator mid pool-edit. Unreachable until then.
    REVERSAL_OVERSPENT: [409, 'Those points have already been spent at another location, so this can no longer be undone.'],
    POOL_RATE_MISMATCH: [409, 'Locations that share points must use the same points per dollar. Match the rates first.'],
    POOL_PIN_MISSING: [409, 'Set a staff PIN at this location before it shares points.'],
    POOL_NOT_EMPTY: [409, 'This pool still holds customer points. Take its locations out first, which gives the points back.'],
    POOL_HAS_MEMBERS: [409, 'This pool still has locations in it. Remove them before deleting it.'],
    POOL_NOT_FOUND: [404, 'That points pool no longer exists.'],
    POOL_LAST_ACTIVE_MEMBER: [409, 'This is the last active location in the pool. Add another, or delete the pool.'],
    POOL_MEMBER_HAS_POOL: [409, 'That location already shares points with another group. Remove it from that one first.'],
    VENDOR_IN_POOL: [409, 'This location shares points with others. Take it out of the pool before changing this.'],
  };
  const key = Object.keys(known).find((k) => err.message?.includes(k));
  if (key) {
    const [status, message] = known[key];
    // A route may attach a more specific line for the SAME code — the one case
    // today is CODE_WRONG_LOCATION naming which spot the code was minted for,
    // which is the difference between a dead end and an instruction. The map
    // still decides the code AND the status, so this can only ever refine copy;
    // it can never invent an error the map doesn't know. Nothing else in the
    // codebase sets publicMessage, so every other error answers exactly as before.
    return res.status(status).json({ error: key, message: err.publicMessage || message });
  }
  console.error(err);
  // Unexpected failure → record it so it shows up on the /admin dashboard...
  //
  // requestContext carries what the request was FOR (query + body fields,
  // redacted; who was signed in; which vendor; which page it came from). Without
  // it a 500 in the log reads "Cannot read properties of undefined" against a
  // path, and the operator has no way to tell which customer, vendor or amount
  // it happened on.
  await logError({
    source: 'server',
    message: err?.message,
    stack: err?.stack,
    path: req?.originalUrl,
    method: req?.method,
    status: 500,
    userId: req?.user?.id ?? null,
    userAgent: req?.headers?.['user-agent'],
    context: requestContext(req),
  });
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong.' });
});

// ---- Socket.IO: live balance pushes to students ----
const server = http.createServer(app);
const io = new Server(server);

// Authenticate each socket with the student's Supabase access token, then drop
// them into a room keyed by their user id so awards/redeems can target them.
//
// Verified locally (src/lib/jwt.js) — a hundred students arriving at lunch used
// to mean a hundred GoTrue calls from one campus IP, on top of their HTTP ones.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('NO_TOKEN'));
    const user = await resolveUserFromToken(token);
    if (!user) return next(new Error('BAD_TOKEN'));
    socket.data.userId = user.id;
    next();
  } catch {
    next(new Error('AUTH_ERROR'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  // Foreground/background, reported by the student app on visibilitychange.
  // The campaign worker skips students who are looking at the app right now:
  // the deal already reached them over this socket, so spending one of their
  // two daily notification slots to say it again is pure cost. Assume visible
  // until told otherwise, since that only ever DEFERS a notification.
  socket.data.visible = true;
  socket.on('visible', (v) => { socket.data.visible = v !== false; });
});

setIo(io);

// Exported so tests can mount the app on an ephemeral port without booting the
// real listener. `app` is the Express handler; `server` is the HTTP+Socket.IO
// server used when run directly.
export { app, server };

// Only start listening when run directly (`node server.js`), not when imported
// by a test that just wants the `app` handler.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`WeRewards running on http://localhost:${port}`));

  // How access tokens are being checked. Worth a line: if this ever reads
  // "GoTrue getUser on every request", every authenticated call is paying a
  // network round-trip again and the campus-Wi-Fi rate-limit ceiling is back.
  console.log(`Auth: ${authVerificationMode()}`);

  // Say which receipt reader is live. Worth a line: with no key set the app
  // still scans receipts perfectly well, it just can't spot a forged one, and
  // that difference is invisible from the outside.
  console.log(geminiConfigured()
    ? `Receipt reading: ${geminiModel()} (AI + forgery check), tesseract fallback`
    : 'Receipt reading: tesseract only — set GEMINI_API_KEY to enable the forgery check');

  // Say whether mail is live, and why it matters that you can tell. With no key
  // the app is unchanged except that four things silently stop: applicants hear
  // nothing back, accepted vendors are never told they can sign in, self-serve
  // password resets mint no code at all, and deal emails (the only way most iOS
  // students can be reached) never send. All four fail QUIETLY by design, so
  // this line is the only place the difference is visible.
  console.log(emailEnabled
    ? `Email: Resend as ${emailFrom()}${process.env.RESEND_WEBHOOK_SECRET ? ' (bounce webhook on)' : ' — no RESEND_WEBHOOK_SECRET, bounces are not being pruned'}`
    : 'Email: off — set RESEND_API_KEY and EMAIL_FROM to enable vendor mail and deal emails');

  // Same reason as the line above: PostHog forwarding fails quietly by design,
  // so boot is the one place its state is visible. client_events is unaffected
  // either way — this only says whether the MIRROR is running.
  console.log(posthogEnabled
    ? `Analytics: mirroring client_events to PostHog (${new URL(batchUrl()).origin})`
    : 'Analytics: client_events only — set POSTHOG_API_KEY to mirror to PostHog');

  // The operator's terminal login (src/lib/terminal-admin.js). Same reason the
  // three lines above exist: with the env vars unset the app is unchanged and
  // the feature simply isn't there, which is invisible from the outside — and
  // with them set this is one password in front of EVERY shop's till, which is
  // worth seeing written down on every boot. Never throws and never blocks the
  // listener; a provisioning failure just leaves the account absent and says so.
  ensureTerminalAdmin({
    supabaseAdmin,
    // Only so it can warn about reusing a dashboard address; the two grants are
    // otherwise unrelated and neither implies the other. Parsed here rather than
    // imported because middleware/auth.js keeps its copy private on purpose.
    adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
  })
    .then((line) => console.log(line))
    .catch((err) => console.log(`Terminal admin: OFF — ${err.message}`));

  // Pre-build the OCR worker (receipt scanning) so the first student's scan
  // doesn't also pay the ~2-4s wasm init. Still worth warming when the AI
  // reader is configured: tesseract is exactly the thing that has to be ready
  // the instant Google stops answering. Best-effort — a failure here just
  // means the first real scan builds it instead.
  warmOcr();

  // Vendor campaign delivery (migration-032). Started only when run directly,
  // so importing `app` in a test never spins up a background loop. No-op
  // without VAPID keys: campaigns still queue and still show in every targeted
  // student's in-app list, they just never interrupt anyone.
  startCampaignWorker();

  // Referral settlement (migration-039). Deliberately a background sweep rather
  // than a hook on the award path: a referral payout must never be able to fail
  // the transaction a cashier is standing over. Started only when run directly,
  // for the same reason the campaign worker is.
  startReferralWorker();

  // Graceful shutdown. Heroku sends SIGTERM on every deploy and cycles dynos
  // ~daily, then SIGKILLs after ~30s. Draining first lets in-flight awards /
  // redeems finish instead of being cut mid-request. io.close() disconnects the
  // Socket.IO clients and closes the underlying HTTP server, firing the callback
  // once existing connections drain; the unref'd timer is a hard backstop if a
  // keep-alive connection never idles out before Heroku's grace period ends.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — draining connections and shutting down`);
    stopCampaignWorker();   // don't claim a batch we won't live to deliver
    stopReferralWorker();   // the sweep is idempotent; the next boot picks it up
    io.close(async () => {
      // Last call for queued analytics. capture() batches in memory to keep a
      // third-party hop off the request path, which means SIGTERM — the one
      // shutdown Heroku actually announces, on every deploy and every dyno
      // cycle — is where that queue would otherwise be lost. Awaited inside the
      // drain callback so it runs after connections are done but before exit,
      // and it can neither throw nor hang past its own 5s fetch timeout. The
      // 10s backstop below still wins if anything here misbehaves.
      if (posthogEnabled) {
        const flushed = await flushPostHog();
        if (flushed.sent) console.log('flushed ' + flushed.sent + ' analytics event(s) to PostHog');
      }
      console.log('server closed cleanly');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('forced shutdown after grace period');
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
