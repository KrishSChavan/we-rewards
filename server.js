import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import studentRoutes from './src/routes/student.js';
import vendorRoutes from './src/routes/vendor.js';
import adminRoutes from './src/routes/admin.js';
import { supabaseAuth } from './src/lib/supabase.js';
import { setIo } from './src/lib/realtime.js';
import { logError } from './src/lib/errors.js';
import { requireJson } from './src/middleware/require-json.js';

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
// CSP is allow-listed to exactly what the two apps load: supabase-js from
// jsDelivr, Google Fonts, Google avatar images, and Supabase REST/auth/realtime
// + socket.io over ws/wss. Misconfiguring this breaks the apps — keep in sync
// with the <script>/<link> tags and the SUPABASE_URL.
const supabaseOrigin = (() => {
  try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ''; }
})();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.jsdelivr.net'],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https://*.googleusercontent.com'],
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

app.use(express.json());

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
  message: { error: 'RATE_LIMITED', message: 'Too many requests — try again shortly.' },
});
// The staff PIN is a 4-digit secret (10k combos) → the real brute-force target.
// Low legitimate volume (once per shift), so cap hard.
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many PIN attempts — wait a few minutes.' },
});
// 4-digit redeem codes are also enumerable; cap moderately (well above a busy
// vendor's real redemption rate, well below what makes enumeration practical).
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts — wait a minute and try again.' },
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
app.use('/api', generalLimiter);
app.use('/api/vendor/verify-pin', pinLimiter);
app.use('/api/vendor/redeem-preview', redeemLimiter);
app.use('/api/client-error', clientErrorLimiter);

// Static: student PWA at / , vendor terminal at /terminal , operator dash at /admin
app.use('/', express.static(path.join(__dirname, 'public/student')));
app.use('/terminal', express.static(path.join(__dirname, 'public/vendor')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Per-user API data must always be fresh — no ETag/304 revalidation, which was
// letting the browser serve a stale cached balance.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// API
app.use('/api/me', studentRoutes);      // student-authenticated endpoints
app.use('/api/vendor', vendorRoutes);   // vendor-authenticated endpoints
app.use('/api/admin', adminRoutes);     // operator-only (ADMIN_EMAILS) analytics + errors

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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
    CODE_SPACE_EXHAUSTED: [503, 'Too many active codes right now — try again in a moment.'],
    TX_NOT_FOUND: [404, 'That transaction was not found for this vendor.'],
    ALREADY_REVERSED: [409, 'That transaction was already undone.'],
    CANNOT_REVERSE_REVERSAL: [400, 'That entry is itself an undo — nothing to reverse.'],
    REVERSAL_EXPIRED: [403, 'Too late to undo — undo is only available for one minute after a transaction.'],
  };
  const key = Object.keys(known).find((k) => err.message?.includes(k));
  if (key) {
    const [status, message] = known[key];
    return res.status(status).json({ error: key, message });
  }
  console.error(err);
  // Unexpected failure → record it so it shows up on the /admin dashboard.
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
}
