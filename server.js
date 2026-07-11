import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import studentRoutes from './src/routes/student.js';
import vendorRoutes from './src/routes/vendor.js';
import { supabaseAuth } from './src/lib/supabase.js';
import { setIo } from './src/lib/realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind a proxy in prod (Render/Fly/etc.) so express-rate-limit sees real IPs.
app.set('trust proxy', 1);

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
      'connect-src': ["'self'", supabaseOrigin, 'ws:', 'wss:'].filter(Boolean),
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'upgrade-insecure-requests': null, // don't force https in local dev
    },
  },
  // Google avatars are cross-origin; don't let COEP/CORP block them.
  crossOriginEmbedderPolicy: false,
}));

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
app.use('/api', generalLimiter);
app.use('/api/vendor/verify-pin', pinLimiter);
app.use('/api/vendor/redeem-preview', redeemLimiter);

// Static: student PWA at / , vendor terminal at /terminal
app.use('/', express.static(path.join(__dirname, 'public/student')));
app.use('/terminal', express.static(path.join(__dirname, 'public/vendor')));

// Per-user API data must always be fresh — no ETag/304 revalidation, which was
// letting the browser serve a stale cached balance.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// API
app.use('/api/me', studentRoutes);      // student-authenticated endpoints
app.use('/api/vendor', vendorRoutes);   // vendor-authenticated endpoints

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Safe-to-expose config for browser clients (anon key is public by design; RLS protects data)
app.get('/api/public-config', (_req, res) =>
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY })
);

// Central error handler — routes call next(err)
app.use((err, _req, res, _next) => {
  const known = {
    INSUFFICIENT_POINTS: [400, 'Not enough points for this reward.'],
    REWARD_NOT_FOUND: [404, 'Reward not found or inactive.'],
    CODE_INVALID: [401, 'That code is expired or invalid. Ask the customer to refresh their code.'],
    CODE_SPACE_EXHAUSTED: [503, 'Too many active codes right now — try again in a moment.'],
  };
  const key = Object.keys(known).find((k) => err.message?.includes(k));
  if (key) {
    const [status, message] = known[key];
    return res.status(status).json({ error: key, message });
  }
  console.error(err);
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

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`WeRewards running on http://localhost:${port}`));
