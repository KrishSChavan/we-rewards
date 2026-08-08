// Client asset build: lower every served .js and .css to what an old iPad's
// Safari can actually parse.
//
// WHY THIS EXISTS. Everything under public/ is hand-authored modern JS, and
// supabase-js (which we now self-host, see below) is built for evergreen
// browsers. On Safari older than 14 every one of those bundles dies with a
// SyntaxError at parse time, before a single statement runs — optional chaining
// (Safari 13.1), numeric separators like `86_400_000` (Safari 13), and
// supabase-js's `||=` / `&&=` / `??=` (Safari 14). The failure is silent and
// total: the student PWA is left with its boot splash stuck on screen forever
// because app.js is the only thing that removes it, and the vendor terminal
// shows a white page because every <section class="screen"> ships `hidden` and
// terminal.js is the only thing that unhides one. Nothing reaches
// /api/client-error either, since the crash reporter lives inside the file that
// failed to parse. A vendor's counter iPad just looks broken.
//
// The fix is to stop shipping syntax those devices can't read. This mirrors each
// app directory into .build/ , running every .js and .css through esbuild on the
// way, and server.js serves the mirror instead of public/ . Sources stay exactly
// as authored; nothing here edits a file under public/ .
//
// EVERYONE gets the lowered bundle, not just old devices. UA-sniffing a legacy
// variant would mean two bundles, two service-worker caches and two sets of
// asset hashes, and iPadOS lies about its UA anyway (see needsLegacyCapable in
// server.js). Modern browsers run the lowered output no differently.
//
// Output is NOT minified, on purpose: it stays close enough to the source to
// read in devtools, so debugging production doesn't need source maps.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// The floor we compile to. These two knobs decide which devices can run the
// apps; anything below them is caught by public/*/boot-guard.js, which shows a
// readable "this device is too old" screen instead of a blank one.
//
// JS is targeted by ECMAScript EDITION, not by browser version, and that is
// deliberate. esbuild's Safari compat table flags destructuring as buggy in
// every Safari up to 13 and then refuses the build outright ("Transforming
// destructuring to the configured target environment is not supported yet"), so
// `safari12` cannot be used here at all. `es2017` gets what we actually need —
// optional chaining, nullish coalescing, logical assignment and numeric
// separators all lowered, plus object spread, which is ES2018 — and es2017 is
// where async/await survives untouched (Safari 10.1+). It also lowers away
// supabase-js's dynamic `import("@opentelemetry/api")`; that import is optional
// telemetry already wrapped in `.catch()`, so its lowered form failing at
// runtime is harmless.
export const JS_TARGET = ['es2017'];

// public/scan is the fallback POS screen for a device even older than the
// es2017 floor above (built Aug 2026 for an iPad mini stuck on iOS 12.5.7,
// below the iOS 13.4-14.2 floor [[browser-support-floor]] testing had already
// established for /terminal). Unlike JS_TARGET this is a real BROWSER VERSION,
// which buys genuine lowering of optional chaining / nullish coalescing /
// logical assignment / spread into code Safari 12 can run, not just "leave the
// syntax alone and hope the edition covers it". The one thing esbuild refuses
// outright at this target is destructuring ("Transforming destructuring to the
// configured target environment is not supported yet") — confirmed by probing
// esbuild directly, not assumed — so public/scan/scan.js must never use
// `const {a} = b` / `const [a] = b`, including destructured function params.
// That is also why scan.js cannot load supabase-js: the vendored UMD bundle
// fails this same target with 209 destructuring errors, checked the same way.
// It talks to Supabase Auth's REST endpoints directly with fetch instead (see
// scan.js) — the same email+password grant supabase-js itself wraps, so the
// login method is unchanged, just not routed through a library that can't
// parse on this device.
export const SCAN_JS_TARGET = ['safari12'];

// CSS has to be targeted by browser version — an ECMAScript edition means
// nothing to the CSS lowerer. This is what rewrites `inset: 0` into the four
// longhands (Safari only understood the shorthand from 14.1), which is the bug
// that left the student app's boot splash shrink-wrapped in the top-left corner.
// Unlike the JS path this can't hard-fail: esbuild lowers what it knows and
// leaves the rest alone. safari11 is already below the safari12 JS floor above,
// so public/scan reuses it rather than needing a third constant.
export const CSS_TARGET = ['safari11'];

export const BUILD_DIR = path.join(ROOT, '.build');

// Source dir -> build dir, keyed by the app folder name under public/.
// Keep in step with the `shells` list in server.js. 'scan' gets SCAN_JS_TARGET
// instead of JS_TARGET — see the constant above.
const APPS = ['student', 'vendor', 'admin', 'join', 'scan'];
const SCAN_APP = 'scan';

// supabase-js used to come from jsDelivr pinned with an SRI hash. It is now
// copied out of node_modules and lowered like everything else, which is both the
// only way to fix the syntax floor (we can't transpile someone else's CDN) and
// one less third-party origin trusted with a page that handles auth tokens. The
// version follows package.json instead of a URL that has to be bumped by hand.
//
// Each app gets its own copy rather than a shared /lib mount, so the ?v= asset
// hashing, the per-app service-worker cache and the mount-relative <script src>
// all keep working exactly as they do for the QR libraries already vendored this
// way into both public/student and public/vendor.
const SUPABASE_SRC = path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
// Deliberately NOT 'scan': the UMD bundle cannot be lowered to SCAN_JS_TARGET
// at all (209 destructuring errors), which is exactly why scan.js talks to
// Supabase Auth's REST API directly instead of loading this file.
const SUPABASE_APPS = ['student', 'vendor', 'admin'];
const SUPABASE_FILE = 'supabase.js';

// The boot guard is fanned out the same way, from a single source, so the apps
// can't drift. It is the screen a device too old even for the lowered bundles
// gets instead of a white page. public/shared is not an app root and is never
// served directly; it exists only to feed this copy. 'scan' is included even
// though it targets an older browser than the others — boot-guard.js is ES5,
// so it runs there too, and it's the only way to see a parse failure on a
// device we have no way to test against directly.
const GUARD_SRC = path.join(ROOT, 'public/shared/boot-guard.js');
const GUARD_APPS = ['student', 'vendor', 'admin', 'scan'];
const GUARD_FILE = 'boot-guard.js';

const LOADERS = { '.js': 'js', '.css': 'css' };

// supabase-js reaches for optional OpenTelemetry instrumentation through a
// dynamic import(). Safari only got dynamic import in 11.1, and an ECMAScript
// EDITION target (unlike a browser-version one) does not lower it — so it would
// be the single parse-time landmine left in an otherwise ES2017 file, which is
// precisely the class of bug this build exists to remove. supabase already wraps
// it in `.catch()` and treats a failure as "no telemetry", so a rejected promise
// is a faithful stand-in.
const OTEL_IMPORT = /import\s*\(\s*(['"`])@opentelemetry\/api\1\s*\)/g;
// Deliberately not anchored to opentelemetry: this is the invariant we actually
// care about, so a future supabase release that adds some OTHER dynamic import
// fails the build here instead of silently shipping a file old Safari can't read.
const ANY_DYNAMIC_IMPORT = /(^|[^.\w$])import\s*\(/;

function stripDynamicImports(code, label) {
  const out = code.replace(OTEL_IMPORT, "Promise.reject(new Error('opentelemetry disabled'))");
  if (ANY_DYNAMIC_IMPORT.test(out)) {
    throw new Error(
      `build-client: ${label} still contains a dynamic import() after lowering. ` +
      'Safari below 11.1 cannot parse it, which takes down the whole file. ' +
      'Add it to the strip list above or bundle the dependency in.'
    );
  }
  return out;
}

// ---- flex `gap` fallback ----
//
// `gap` inside a FLEX container is Safari 14.1. (In a grid container it works
// from Safari 12, so grid rules are left alone.) Below that it is simply
// ignored, and there is no shorthand to lower it to — so on an older iPad every
// one of the ~250 gapped flex rows in these stylesheets collapses to zero
// spacing and the terminal's buttons end up touching each other. That is a
// mis-tap risk on a device someone takes payments with, not just an ugly layout.
//
// So: synthesise margin-based equivalents. Each qualifying rule gets a companion
// `> * + *` (or `> *` when the row can wrap) rule emitted at the end of the
// stylesheet, all of them behind `:root.no-flex-gap`, a class that
// public/shared/boot-guard.js adds only when it measures that this browser lacks
// flex gap. A browser that has flex gap never matches any of this, so the risk to
// modern devices is nil and the worst case on an old one is spacing that is
// approximate instead of absent.
//
// The fiddly part is that a gap is rarely declared once. These stylesheets set a
// flex gap in a base rule and then revise it at a breakpoint, and a naive
// "emit a companion rule wherever I see display:flex + gap" would leave the base
// margins standing at every one of those breakpoints. Two cases in terminal.css
// make that concrete, and both are on the phone layout an old iPad may well hit:
//
//   .tabs      base is `display: flex; flex-wrap: wrap; gap: 0.5rem`, and the
//              phone media query pins it to the bottom as the tab bar with
//              `gap: 0`. Stale margins would push the tabs apart in the one
//              place the design wants them flush.
//   .pad-actions  base is flex with `gap: 1.2rem`; a media query turns it into
//              `display: grid`. A leftover margin-left on a grid item is not a
//              near-miss, it is a broken layout.
//
// So this walks every block for a given selector IN DOCUMENT ORDER, carries the
// resolved display / direction / wrap / gap forward, and re-emits whenever the
// answer changes — including emitting explicit zeroes when a selector stops
// being a gapped flex container. Each selector's emissions all list the same set
// of margin properties, so a later state always fully overwrites an earlier one
// instead of leaving half of it behind.
//
// What it does NOT resolve is one selector overriding a different one
// (`.pad-screen .pad-actions` revising `.pad-actions`). Those inherit the base
// selector's margins, so the spacing is the base value rather than the override:
// approximate, never absent, and never applied to a non-flex container.
const FLEX_GAP_CLASS = 'no-flex-gap';

// Split a shorthand value on top-level whitespace only, so `clamp(0.4rem, 1.2vh,
// 0.75rem)` survives as one value instead of becoming three.
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

// Flatten esbuild's output into an ordered list of style rules. Its formatting is
// strictly one declaration per line and one brace per line, which is why this can
// be line-based instead of a real CSS parser.
function readRules(css) {
  const rules = [];
  const stack = [];          // enclosing preludes, innermost last
  let decls = null;

  for (const line of css.split('\n')) {
    const text = line.trim();
    if (text.endsWith('{')) {
      stack.push(text.slice(0, -1).trim());
      decls = stack[stack.length - 1].startsWith('@') ? null : new Map();
      continue;
    }
    if (text === '}') {
      const prelude = stack.pop();
      if (decls && prelude && !prelude.startsWith('@')) {
        rules.push({ prelude, decls, atRules: stack.filter((p) => p.startsWith('@')) });
      }
      decls = null;
      continue;
    }
    if (decls) {
      const idx = text.indexOf(':');
      if (idx > 0) decls.set(text.slice(0, idx).trim(), text.slice(idx + 1).replace(/;$/, '').trim());
    }
  }
  return rules;
}

// The margin properties standing in for a gap, given a selector's resolved state.
// Empty when the container isn't a gapped flex box, which is what cancels a
// previously emitted fallback.
function gapMargins(state) {
  if (state.display !== 'flex' && state.display !== 'inline-flex') return {};
  if (state.rowGap == null && state.columnGap == null) return {};

  const column = /^column/.test(state.direction || '');
  const wraps = /^wrap/.test(state.wrap || '');
  const margins = {};
  if (wraps) {
    // A wrapping row spaces its children on both axes, and `+ *` cannot see where
    // the line breaks — so every child carries the margin and the last one on each
    // line keeps a trailing edge. Slightly generous beats not spaced at all.
    if (state.columnGap != null) margins['margin-right'] = state.columnGap;
    if (state.rowGap != null) margins['margin-bottom'] = state.rowGap;
  } else if (column) {
    if (state.rowGap != null) margins['margin-top'] = state.rowGap;
  } else if (state.columnGap != null) {
    margins['margin-left'] = state.columnGap;
  }
  return margins;
}

function applyDecls(state, decls) {
  if (decls.has('display')) state.display = decls.get('display');
  if (decls.has('flex-direction')) state.direction = decls.get('flex-direction');
  if (decls.has('flex-wrap')) state.wrap = decls.get('flex-wrap');
  if (decls.has('gap')) {
    // `gap: <row> <column>`; a single value sets both.
    const parts = splitTopLevel(decls.get('gap'));
    state.rowGap = parts[0];
    state.columnGap = parts[1] ?? parts[0];
  }
  if (decls.has('row-gap')) state.rowGap = decls.get('row-gap');
  if (decls.has('column-gap')) state.columnGap = decls.get('column-gap');
}

function wrapInAtRules(body, atRules) {
  return atRules.reduceRight(
    (inner, at) => `${at} {\n${inner.split('\n').map((l) => '  ' + l).join('\n')}\n}`,
    body
  );
}

function flexGapFallbacks(css) {
  // Group by exact selector text, keeping document order within each group.
  const groups = new Map();
  for (const rule of readRules(css)) {
    if (!groups.has(rule.prelude)) groups.set(rule.prelude, []);
    groups.get(rule.prelude).push(rule);
  }

  const out = [];
  for (const [prelude, rules] of groups) {
    const state = { display: null, direction: null, wrap: null, rowGap: null, columnGap: null };
    const steps = [];
    let previous = '';
    for (const rule of rules) {
      applyDecls(state, rule.decls);
      const margins = gapMargins(state);
      const fingerprint = JSON.stringify(margins) + (/^wrap/.test(state.wrap || '') ? '|w' : '');
      if (fingerprint === previous) continue;         // nothing changed at this breakpoint
      previous = fingerprint;
      steps.push({ margins, wraps: /^wrap/.test(state.wrap || ''), atRules: rule.atRules });
    }
    if (!steps.some((s) => Object.keys(s.margins).length)) continue;   // never a gapped flex box

    // Every emission for this selector lists the same properties and covers the
    // same child selectors, so a later state fully overwrites an earlier one
    // rather than leaving half of it in place.
    //
    // A selector that wraps at one breakpoint and not at another needs both child
    // forms, and only the one matching the current state carries values; the other
    // is zeroed. '> *' is emitted first because it and '> * + *' have identical
    // specificity, so on a tie the later rule has to be the narrower one.
    const allProps = [...new Set(steps.flatMap((s) => Object.keys(s.margins)))];
    const allChildren = [...new Set(steps.map((s) => (s.wraps ? '> *' : '> * + *')))]
      .sort((a, b) => a.length - b.length);

    for (const step of steps) {
      const stepChild = step.wraps ? '> *' : '> * + *';
      for (const child of allChildren) {
        const selector = prelude
          .split(',')
          .map((s) => `:root.${FLEX_GAP_CLASS} ${s.trim()} ${child}`)
          .join(',\n');
        const body = allProps
          .map((prop) => `  ${prop}: ${child === stepChild ? (step.margins[prop] ?? '0') : '0'};`)
          .join('\n');
        out.push(wrapInAtRules(`${selector} {\n${body}\n}`, step.atRules));
      }
    }
  }
  return out;
}

function withFlexGapFallbacks(css) {
  const rules = flexGapFallbacks(css);
  if (!rules.length) return css;
  return `${css}\n/* flex-gap fallbacks for browsers below Safari 14.1 (see scripts/build-client.js) */\n${rules.join('\n')}\n`;
}

function transpile(code, loader, label, jsTarget) {
  let out;
  try {
    out = esbuild.transformSync(code, {
      loader,
      target: loader === 'css' ? CSS_TARGET : (jsTarget || JS_TARGET),
      // Keep it readable in devtools; see the header note.
      minify: false,
      legalComments: 'inline',
    }).code;
  } catch (err) {
    // A syntax error here means a source file is broken, not that the target is
    // too low — esbuild lowers what it can and only throws on genuinely
    // unparseable input. Fail the boot loudly rather than serve a half-built app.
    throw new Error(`build-client: failed to transpile ${label}\n${err.message}`);
  }
  return loader === 'css' ? withFlexGapFallbacks(out) : stripDynamicImports(out, label);
}

function buildFile(srcFile, outFile, jsTarget) {
  const ext = path.extname(srcFile).toLowerCase();
  const loader = LOADERS[ext];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (!loader) {
    fs.copyFileSync(srcFile, outFile);       // icons, manifests, anything else
    return;
  }
  const code = fs.readFileSync(srcFile, 'utf8');
  fs.writeFileSync(outFile, transpile(code, loader, path.relative(ROOT, srcFile), jsTarget), 'utf8');
}

function mirrorDir(srcDir, outDir, jsTarget) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const out = path.join(outDir, entry.name);
    if (entry.isDirectory()) mirrorDir(src, out, jsTarget);
    else buildFile(src, out, jsTarget);
  }
}

/** Absolute path of the built mirror for an app folder name. */
export function buildRoot(app) {
  return path.join(BUILD_DIR, app);
}

// Lower one shared file once and drop the result into several app roots under a
// fixed name. Used for the two files that live outside any single app but have
// to be reachable at a mount-relative URL: supabase-js and the boot guard.
// Copies rather than a shared /lib mount so that the ?v= asset hashing, the
// per-app service-worker cache and the plain <script src> in each shell all keep
// working the way they already do for the QR libraries vendored into both
// public/student and public/vendor.
function fanOut(srcFile, apps, outName, label) {
  const lowered = transpile(fs.readFileSync(srcFile, 'utf8'), 'js', label);
  for (const app of apps) {
    const out = path.join(buildRoot(app), outName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lowered, 'utf8');
  }
}

/**
 * Rebuild everything from scratch. Called once at server boot (see server.js) so
 * a fresh dyno always serves bytes that match the source it was deployed with,
 * and so `node --watch server.js` picks changes up on restart.
 */
export function buildClientAssets({ log = () => {} } = {}) {
  const started = process.hrtime.bigint();
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  for (const app of APPS) {
    const srcDir = path.join(ROOT, 'public', app);
    if (!fs.existsSync(srcDir)) continue;
    mirrorDir(srcDir, buildRoot(app), app === SCAN_APP ? SCAN_JS_TARGET : undefined);
  }

  if (!fs.existsSync(SUPABASE_SRC)) {
    throw new Error(
      `build-client: ${path.relative(ROOT, SUPABASE_SRC)} is missing. ` +
      'The shells load supabase from this file now, not from a CDN. Run `npm install`.'
    );
  }
  fanOut(SUPABASE_SRC, SUPABASE_APPS, SUPABASE_FILE, 'supabase-js (umd)');

  fanOut(GUARD_SRC, GUARD_APPS, GUARD_FILE, path.relative(ROOT, GUARD_SRC));

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  log(`client build: ${APPS.length} apps lowered to ${JS_TARGET.join(',')}/${CSS_TARGET.join(',')} ` +
    `(scan: ${SCAN_JS_TARGET.join(',')}) in ${ms.toFixed(0)}ms`);
}

/**
 * Development freshness. The mirror is built once at boot, which would otherwise
 * mean an edit to app.js or styles.css no longer shows up on reload the way it
 * did when express.static served public/ directly. This re-transpiles a single
 * file on demand when its source is newer than its build output.
 *
 * Only wired up off production (see server.js) — on a real deploy the mirror is
 * built once from immutable bytes and never needs re-checking.
 */
export function ensureFresh(app, relPath) {
  // relPath comes from a URL. Resolve it and confirm it stays inside the app's
  // source dir, so a traversal ('../../.env') can't make us read and publish an
  // arbitrary file into the served mirror.
  const srcDir = path.join(ROOT, 'public', app);
  const srcFile = path.join(srcDir, relPath);
  if (path.relative(srcDir, srcFile).startsWith('..')) return;

  const outFile = path.join(buildRoot(app), relPath);
  let srcStat;
  try { srcStat = fs.statSync(srcFile); }
  catch { return; }                       // no such source file — let static 404 it
  if (!srcStat.isFile()) return;

  let outStat = null;
  try { outStat = fs.statSync(outFile); } catch { /* not built yet */ }
  if (outStat && outStat.mtimeMs >= srcStat.mtimeMs) return;

  buildFile(srcFile, outFile, app === SCAN_APP ? SCAN_JS_TARGET : undefined);
}
