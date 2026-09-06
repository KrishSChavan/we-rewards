// Parse check for everything under public/: does every .js and .css still lower
// cleanly to the floor the old iPads need?
//
//   npm run check:client
//
// WHY THIS EXISTS SEPARATELY FROM build-client.js. The deploy scripts need to
// know that public/ compiles before they push — a file esbuild cannot parse
// takes the dyno down at boot, and `npm test` never looks at public/. The
// obvious way to check that is to run the real build, and that turns out to be
// actively harmful: buildClientAssets() begins with
//
//     fs.rmSync(BUILD_DIR, { recursive: true, force: true })
//
// so it DELETES the whole .build/ mirror and writes it again. A dev server
// running from that same mirror (`npm run dev`, which rebuilds it at boot and
// per-request via ensureFresh) is then racing the deploy script over one
// directory, and whichever loses gets a bare
//
//     ENOENT: no such file or directory, open '.build\student\app.js'
//
// which looks like a broken build and is really two processes tidying up after
// each other. That is not theoretical; it stopped a real deploy.
//
// So this writes NOTHING. esbuild transforms in memory, the result is thrown
// away, and only the diagnostics matter. It cannot race anything, it does not
// disturb a running dev server, and it answers the only question the deploy
// actually has.
//
// The targets are imported rather than restated, so this can never drift from
// what the real build ships.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JS_TARGET, SCAN_JS_TARGET, CSS_TARGET, POSTHOG_SRC, assertRecorderBundle,
} from './build-client.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same list, and the same scan exception, as build-client.js's APPS/SCAN_APP.
const APPS = ['student', 'vendor', 'admin', 'join', 'scan'];
const SCAN_APP = 'scan';
const LOADERS = { '.js': 'js', '.css': 'css' };

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

const failures = [];
let checked = 0;

for (const app of APPS) {
  const srcDir = path.join(ROOT, 'public', app);
  if (!fs.existsSync(srcDir)) continue;
  const jsTarget = app === SCAN_APP ? SCAN_JS_TARGET : JS_TARGET;

  for (const file of walk(srcDir)) {
    const loader = LOADERS[path.extname(file).toLowerCase()];
    if (!loader) continue;                   // icons, manifests: nothing to parse
    const rel = path.relative(ROOT, file);
    try {
      esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
        loader,
        target: loader === 'css' ? CSS_TARGET : jsTarget,
        // Named so an esbuild diagnostic points at the real file rather than
        // "<stdin>", which is useless when 60 files are being checked.
        sourcefile: rel,
      });
      checked += 1;
    } catch (err) {
      failures.push({ rel, message: err.message });
    }
  }
}

// The files build-client.js fans out rather than mirrors. They are served by
// every app, so a parse failure in any of them is the same crashed dyno — and
// none lives under public/<app>/, so the walk above never sees them.
// fanOut() lowers them all at the default JS target, so check them the same way.
//
// posthog.js carries a `verify` as well as a parse check, and that is the point
// of listing it here. Swapping posthog-js for one of its other builds parses
// perfectly and then records NOTHING, with no error anywhere — see
// assertRecorderBundle. buildClientAssets() already refuses it, but that runs at
// dyno boot, i.e. after the push. This is the gate that runs BEFORE one.
for (const [label, file, verify] of [
  ['public/shared/boot-guard.js', path.join(ROOT, 'public/shared/boot-guard.js')],
  ['public/shared/analytics.js', path.join(ROOT, 'public/shared/analytics.js')],
  ['supabase-js (umd, from node_modules)', path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')],
  ['posthog-js (from node_modules)', POSTHOG_SRC, assertRecorderBundle],
]) {
  if (!fs.existsSync(file)) {
    failures.push({ rel: label, message: 'Missing. Run `npm install`.' });
    continue;
  }
  try {
    const out = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
      loader: 'js', target: JS_TARGET, sourcefile: label,
    });
    verify?.(out.code, label);
    checked += 1;
  } catch (err) {
    failures.push({ rel: label, message: err.message });
  }
}

if (failures.length) {
  console.error(`client check: ${failures.length} file(s) will not build\n`);
  for (const f of failures) console.error(`  ${f.rel}\n${f.message}\n`);
  process.exit(1);
}

console.log(`client check: ${checked} files parse and lower cleanly ` +
  `(${JS_TARGET.join(',')} / ${CSS_TARGET.join(',')}, scan: ${SCAN_JS_TARGET.join(',')})`);
