import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import studentRoutes from './src/routes/student.js';
import vendorRoutes from './src/routes/vendor.js';
import vendorRecoverRoutes from './src/routes/vendor-recover.js';
import adminRoutes from './src/routes/admin.js';
import applyRoutes from './src/routes/apply.js';
import { supabaseAuth, supabaseAdmin } from './src/lib/supabase.js';
import { setIo } from './src/lib/realtime.js';
import { logError } from './src/lib/errors.js';
import { logEvent } from './src/lib/events.js';
import { recordServerError } from './src/lib/alerts.js';
import { isUuid } from './src/lib/ids.js';
import { startCampaignWorker, stopCampaignWorker } from './src/lib/campaigns.js';
import { requireJson } from './src/middleware/require-json.js';
import { warmOcr } from './src/lib/ocr.js';
import { geminiConfigured, geminiModel } from './src/lib/gemini-receipt.js';
import { buildClientAssets, buildRoot, ensureFresh } from './scripts/build-client.js';
import { TERMS_DOCUMENTS } from './src/lib/terms.js';
import {
  verifyPunchToken, mintPunchBinding, PUNCH_BINDING_COOKIE, PUNCH_HOLD_TTL_SECONDS,
} from './src/lib/punch.js';

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
app.use('/api', generalLimiter);
app.use('/api/vendor/verify-pin', pinLimiter);
app.use('/api/vendor/recover', recoverLimiter);
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
  app.use(mount, express.static(root, { index: false }));
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
    if (!PUBLIC_LEGAL_FILES.has(file)) {
      return res.status(404).type('txt').send('Not found');
    }
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
  let userId = null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      const { data } = await supabaseAuth.auth.getUser(token);
      userId = data?.user?.id ?? null;
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
  'install_eligible', 'install_prompt_shown', 'install_prompt_dismissed',
  'install_accepted', 'pwa_launched',
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
      const { data } = await supabaseAuth.auth.getUser(token);
      userId = data?.user?.id ?? null;
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
app.get('/api/vendor-logo/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).end();
    const { data, error } = await supabaseAdmin
      .from('vendors').select('logo, active').eq('id', req.params.id).maybeSingle();
    if (error || !data?.active || !data.logo) return res.status(404).end();
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data.logo);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(m[2], 'base64'));
  } catch {
    res.status(404).end();
  }
});

// Safe-to-expose config for browser clients (anon key is public by design; RLS protects data)
app.get('/api/public-config', (_req, res) =>
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY })
);

// Central error handler — routes call next(err)
app.use((err, req, res, _next) => {
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
  };
  const key = Object.keys(known).find((k) => err.message?.includes(k));
  if (key) {
    const [status, message] = known[key];
    return res.status(status).json({ error: key, message });
  }
  console.error(err);
  // Unexpected failure → record it so it shows up on the /admin dashboard...
  logError({
    source: 'server',
    message: err?.message,
    stack: err?.stack,
    path: req?.originalUrl,
    method: req?.method,
    status: 500,
    userId: req?.user?.id ?? null,
    userAgent: req?.headers?.['user-agent'],
  });
  // ...and push the operator if these are spiking (throttled, best-effort).
  recordServerError();
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong.' });
});

// ---- Socket.IO: live balance pushes to students ----
const server = http.createServer(app);
const io = new Server(server);

// Authenticate each socket with the student's Supabase access token, then drop
// them into a room keyed by their user id so awards/redeems can target them.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('NO_TOKEN'));
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return next(new Error('BAD_TOKEN'));
    socket.data.userId = data.user.id;
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

  // Say which receipt reader is live. Worth a line: with no key set the app
  // still scans receipts perfectly well, it just can't spot a forged one, and
  // that difference is invisible from the outside.
  console.log(geminiConfigured()
    ? `Receipt reading: ${geminiModel()} (AI + forgery check), tesseract fallback`
    : 'Receipt reading: tesseract only — set GEMINI_API_KEY to enable the forgery check');

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
    io.close(() => {
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
