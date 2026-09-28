// Runs the client build on its own, without importing server.js.
//
//   npm run build:client
//
// WHY THIS EXISTS. server.js calls buildClientAssets() at module top level
// (right before it mounts the five app shells), so until now the only way to
// produce .build/ was to import the server — which also constructs the Express
// app, a socket.io Server and the Supabase admin client as a side effect.
// Capacitor needs the built web assets and nothing else: `npx cap sync` copies
// webDir (.build/student, per capacitor.config.json) into the native project,
// and it should not have to boot an app server to get them.
//
// This is the same buildClientAssets() call server.js makes, with no Express,
// no socket.io and no port bound. build-client.js imports only esbuild and
// node builtins, so nothing here reaches the network or needs env vars.
//
// SAME HAZARD AS THE REAL BUILD, because it IS the real build: it begins with
//
//     fs.rmSync(BUILD_DIR, { recursive: true, force: true })
//
// so it deletes the whole .build/ mirror and writes it again. Never run it
// while `npm run dev` is up — see the long note at the top of check-client.js
// for the deploy this exact race once stopped. Use `npm run check:client` when
// you only want to know whether public/ still compiles; that one writes
// nothing and cannot race anything.
import { buildClientAssets } from './build-client.js';

buildClientAssets({ log: (msg) => console.log(msg) });
