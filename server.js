import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import 'dotenv/config';

import studentRoutes from './src/routes/student.js';
import vendorRoutes from './src/routes/vendor.js';
import { supabaseAuth } from './src/lib/supabase.js';
import { setIo } from './src/lib/realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

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
server.listen(port, () => console.log(`We-Rewards running on http://localhost:${port}`));
