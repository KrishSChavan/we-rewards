// PostHog session replay — the browser half (public/shared/analytics.js, the
// vendored bundle, and the <meta> tags server.js stamps into the app shells).
//
// WHY THESE PARTICULAR ASSERTIONS. Replay has an unusually bad failure mode: it
// breaks SILENTLY and looks healthy while broken. posthog-js loads, reports no
// error, `status` says "active", the server logs "Session replay: on" — and
// nothing is recorded. Nobody notices until someone opens the replay list weeks
// later. So what is locked in here is specifically the set of things that would
// each produce exactly that:
//
//   • the vendored bundle actually containing the RECORDER. posthog-js ships
//     several builds and the small, obvious one lazy-loads the recorder from
//     us-assets.i.posthog.com — which this app's CSP blocks. Swapping the build
//     in scripts/build-client.js would leave every other test passing.
//   • the two <script> tags being in the right ORDER, and before the app's own
//     script. analytics.js after app.js means window.Analytics does not exist
//     when app.js identifies the student, so recordings are filed under nobody.
//   • analytics.js being precached, because app.js and terminal.js call
//     Analytics.* unguarded.
//   • replay being OFF, and leaking nothing into the HTML or the CSP, on a
//     deployment with no key.
//
// Runs in the default suite (no DB). Importing ../server.js runs the client
// build, which is why .build can be read below — and why the test script pins
// --test-concurrency=1 (see the note in package.json).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { app } from '../server.js';
import { buildRoot, assertRecorderBundle, JS_TARGET } from '../scripts/build-client.js';
import {
  sessionReplayEnabled, posthogClientConfig, posthogConnectOrigins, posthogUiHost,
} from '../src/lib/posthog.js';

const LIB = pathToFileURL(path.resolve('src/lib/posthog.js')).href;
const RECORDING_APPS = ['student', 'vendor', 'join'];

/** Load src/lib/posthog.js in a child process with env set, and return `body`'s result. */
function withEnv(env, body) {
  const src = `
    const ph = await import(${JSON.stringify(LIB)});
    console.log('__RESULT__' + JSON.stringify(await (${body})(ph)));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

async function get(pathname) {
  const listener = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${listener.address().port}${pathname}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' },
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    listener.close();
  }
}

/* ---------- the vendored bundle ---------- */

describe('the posthog-js build we self-host', () => {
  const src = fs.readFileSync('node_modules/posthog-js/dist/array.full.no-external.js', 'utf8');

  test('contains the session recorder, not a loader for one', () => {
    // THE assertion in this file, and it took two attempts to write correctly —
    // which is the whole argument for having it. The obvious version looks for
    // 'rrweb' and '$snapshot'. Both appear in EVERY posthog-js build, including
    // the ones that cannot record: the SDK names the extension it means to load
    // and the event it means to emit whether or not the code to do either is
    // there. Measured across all four builds, the non-recording ones scored 7
    // and 2 on those strings, so the obvious check passes and catches nothing.
    //
    // These two are rrweb's implementation rather than posthog's intentions,
    // and are exactly 0 in every lazy-loading build.
    assert.ok(src.includes('MutationObserver'), 'a DOM recorder must observe mutations');
    assert.ok(src.includes('IncrementalSnapshot'), 'and emit incremental snapshots');
  });

  test('the build guard accepts this build and refuses every other one', () => {
    // The matrix, encoded. Each of these is one word away in build-client.js,
    // parses cleanly, passes every other test, and records nothing.
    const lower = (f) => esbuild.transformSync(
      fs.readFileSync(path.join('node_modules/posthog-js/dist', f), 'utf8'),
      { loader: 'js', target: JS_TARGET, minify: true },
    ).code;

    for (const [file, why] of [
      ['array.js', 'the plain default — lazy-loads the recorder'],
      ['array.no-external.js', 'small and no-external, but no recorder in it'],
      ['array.full.js', 'has the recorder, but can still fetch a remote script'],
    ]) {
      assert.throws(() => assertRecorderBundle(lower(file), file),
        /does not contain the session recorder|can load a remote script/,
        `${file} must be refused (${why})`);
    }

    // ...and the one we actually ship passes, so the guard is not simply
    // refusing everything.
    assert.doesNotThrow(() => assertRecorderBundle(lower('array.full.no-external.js'), 'shipped'));
  });

  test('never reaches for a remote script', () => {
    // Two independent ways it could: a hard-coded assets host, or building a
    // <script> element at runtime. script-src is 'self' — either one is a
    // blocked request and a feature that quietly does nothing.
    assert.ok(!src.includes('assets.i.posthog.com'), 'no assets host may be baked in');
    assert.ok(!/createElement\((['"])script\1\)/.test(src), 'no runtime <script> injection');
    assert.ok(!/(^|[^.\w$])import\s*\(/.test(src),
      'a dynamic import() would also be a parse-time landmine below Safari 11.1');
  });

  test('is lowered and fanned out to exactly the apps that record', () => {
    for (const app_ of RECORDING_APPS) {
      for (const file of ['posthog.js', 'analytics.js']) {
        const built = path.join(buildRoot(app_), file);
        assert.ok(fs.existsSync(built), `${app_}/${file} must be built`);
      }
      const built = fs.readFileSync(path.join(buildRoot(app_), 'posthog.js'), 'utf8');
      assert.ok(built.includes('rrweb'), `${app_}/posthog.js must still carry the recorder after lowering`);
    }
    // Deliberately not these: /admin is an operator tool, and /scan targets
    // safari12 on a device already too old for the main terminal.
    for (const app_ of ['admin', 'scan']) {
      assert.ok(!fs.existsSync(path.join(buildRoot(app_), 'posthog.js')),
        `${app_} must not ship posthog-js`);
    }
  });
});

/* ---------- the shells ---------- */

describe('how the shells load it', () => {
  const shells = {
    student: { file: 'public/student/index.html', prefix: '/', appScript: '/app.js' },
    vendor: { file: 'public/vendor/index.html', prefix: '/terminal/', appScript: '/terminal/terminal.js' },
    join: { file: 'public/join/index.html', prefix: '/join/', appScript: '/join/join.js' },
  };

  for (const [name, { file, prefix, appScript }] of Object.entries(shells)) {
    test(`${name}: posthog, then analytics, then the app script`, () => {
      const html = fs.readFileSync(file, 'utf8');
      const at = (src_) => html.indexOf(`<script src="${src_}"></script>`);
      const posthog = at(`${prefix}posthog.js`);
      const analytics = at(`${prefix}analytics.js`);
      const appJs = at(appScript);

      assert.ok(posthog > -1, 'must load posthog.js');
      assert.ok(analytics > -1, 'must load analytics.js');
      assert.ok(appJs > -1, 'must still load its own script');
      // Order, not merely presence. analytics.js reads window.posthog, and the
      // app script calls window.Analytics — a deferred or reordered tag makes
      // both undefined at the moment they are used.
      assert.ok(posthog < analytics, 'posthog.js must come before analytics.js');
      assert.ok(analytics < appJs, `analytics.js must come before ${appScript}`);
      assert.ok(!/<script[^>]*\b(defer|async)\b[^>]*(posthog|analytics)\.js/.test(html),
        'neither may be deferred: deferred scripts run after the classic ones at the end of <body>');
    });

    test(`${name}: carries the slot server.js stamps the key into`, () => {
      assert.ok(fs.readFileSync(file, 'utf8').includes('<!--POSTHOG-->'),
        'without the slot the shell is served with no key and records nothing');
    });
  }

  test('the two apps with a service worker precache analytics.js', () => {
    // app.js and terminal.js call Analytics.identify()/reset() unguarded, so
    // that file has to be as reliable as the rest of the shell.
    for (const [sw, file] of [
      ['public/student/sw.js', '/analytics.js'],
      ['public/vendor/sw.js', '/terminal/analytics.js'],
    ]) {
      const shellList = /const SHELL = \[[\s\S]*?\];/.exec(fs.readFileSync(sw, 'utf8'))?.[0] ?? '';
      assert.ok(shellList.includes(`'${file}'`), `${sw} must precache ${file}`);
    }
  });

  test('the student app masks the one piece of PII it keeps on screen', () => {
    const html = fs.readFileSync('public/student/index.html', 'utf8');
    assert.match(html, /id="account-email"[^>]*data-ph-mask/,
      'the account email must be masked, or every recording of that screen carries it');
  });
});

/* ---------- the configuration gate ---------- */

describe('replay configuration', () => {
  // These two run against whatever the developer's own .env says, because
  // server.js loads it. That is deliberate: the invariant worth locking in is
  // that the HTML and the CSP AGREE with the configured state, in both
  // directions. A machine with a key exercises the on-path; CI without one
  // exercises the off-path; neither can pass by doing nothing.
  test('the shells carry a key exactly when replay is configured', async () => {
    assert.equal(posthogClientConfig('student') === null, !sessionReplayEnabled);

    for (const url of ['/', '/terminal', '/join']) {
      const res = await get(url);
      assert.equal(res.status, 200);
      assert.equal(res.body.includes('name="posthog-key"'), sessionReplayEnabled,
        `${url} must carry a key iff replay is on (it is ${sessionReplayEnabled ? 'on' : 'off'})`);
      // The slot is REPLACED either way, not left behind — an unsubstituted
      // marker would mean serveShell never looked at this shell at all.
      assert.ok(!res.body.includes('<!--POSTHOG-->'), `${url} must have the slot substituted`);
      // ...and the SDK is loaded either way. analytics.js finding no key is
      // what makes that inert, which is why an unconfigured checkout needs no
      // separate code path.
      assert.ok(res.body.includes('posthog.js'), `${url} must load the SDK`);
    }
  });

  test('/admin never carries a key, however this deployment is configured', async () => {
    const res = await get('/admin');
    assert.ok(!res.body.includes('posthog-key'), 'the operator dashboard is deliberately not recorded');
    assert.ok(!res.body.includes('posthog.js'), 'and does not even load the SDK');
  });

  test('the CSP names a posthog origin exactly when replay is on', async () => {
    const csp = (await get('/')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/,
      'the SDK is same-origin; analytics must never cost this app a third-party script origin');
    assert.equal(csp.includes('posthog'), sessionReplayEnabled,
      'connect-src must name the ingestion host iff the browser will post to it');
    if (sessionReplayEnabled) {
      for (const origin of posthogConnectOrigins()) {
        assert.ok(csp.includes(origin), `connect-src must allow ${origin}`);
      }
    }
  });

  test('a key turns replay on and hands the browser the project key', () => {
    const cfg = withEnv({ POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: '' },
      '(ph) => ({ enabled: ph.sessionReplayEnabled, cfg: ph.posthogClientConfig("student") })');
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.cfg, {
      key: 'phc_test',
      host: 'https://us.i.posthog.com',
      uiHost: 'https://us.posthog.com',
      app: 'student',
    });
  });

  test('POSTHOG_SESSION_REPLAY switches recording off without stopping the event mirror', () => {
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      const out = withEnv({ POSTHOG_API_KEY: 'phc_test', POSTHOG_SESSION_REPLAY: off },
        '(ph) => ({ replay: ph.sessionReplayEnabled, mirror: ph.posthogEnabled, cfg: ph.posthogClientConfig("student") })');
      assert.equal(out.replay, false, `"${off}" must disable replay`);
      assert.equal(out.mirror, true, `"${off}" must NOT disable the server-side mirror`);
      assert.equal(out.cfg, null, 'and no key may reach the browser');
    }
  });

  test('the boot line tells the truth when the PROJECT has replay switched off', () => {
    // The second switch, and the one this repo cannot see: replay enabled in
    // PostHog itself. With it off, the build is fine, the SDK loads, and
    // nothing records — so the boot log must not go on claiming replay is on.
    const stubbed = (body) => withEnv(
      { POSTHOG_API_KEY: 'phc_test' },
      `async (ph) => { globalThis.fetch = async () => ({ ok: true, json: async () => (${body}) });`
      + ' return await ph.describeReplayProject(); }',
    );

    assert.match(stubbed('{ sessionRecording: false }'), /OFF IN THE POSTHOG PROJECT/,
      'a project with replay off must be named outright');
    assert.match(stubbed('{}'), /OFF IN THE POSTHOG PROJECT/,
      'an absent sessionRecording block means the same thing');
    assert.match(stubbed('{ sessionRecording: { endpoint: "/s/" } }'), /confirmed on/);

    // On, but configured to throw recordings away afterwards. Each of these
    // produces "the list is emptier than expected" and no error at all.
    assert.match(stubbed('{ sessionRecording: { sampleRate: "0.1" } }'), /sampled at 0\.1/);
    assert.match(stubbed('{ sessionRecording: { minimumDurationMilliseconds: 2000 } }'), /under 2000ms dropped/);
    assert.match(stubbed('{ sessionRecording: { urlBlocklist: ["/x"] } }'), /1 URL\(s\) blocked/);
    assert.match(stubbed('{ sessionRecording: { linkedFlag: "beta" } }'), /feature flag/);
  });

  test('an unreachable PostHog is reported as unknown, not guessed either way', () => {
    const line = withEnv({ POSTHOG_API_KEY: 'phc_test' },
      'async (ph) => { globalThis.fetch = async () => { throw new Error("offline"); };'
      + ' return await ph.describeReplayProject(); }');
    assert.match(line, /could not reach/i);
    assert.ok(!/confirmed on/.test(line), 'must not claim success it did not verify');
    assert.ok(!/OFF IN THE POSTHOG PROJECT/.test(line), 'and must not cry wolf over a network blip');
  });

  test('the CSP origins follow the region, and self-hosted gets no invented sibling', () => {
    assert.deepEqual(posthogConnectOrigins('https://us.i.posthog.com'),
      ['https://us.i.posthog.com', 'https://us-assets.i.posthog.com']);
    assert.deepEqual(posthogConnectOrigins('https://eu.i.posthog.com'),
      ['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com']);
    // A self-hosted instance serves its own /array config; there is no -assets
    // host to allow, and inventing one would be a CSP entry for a dead name.
    assert.deepEqual(posthogConnectOrigins('https://ph.example.com'), ['https://ph.example.com']);
    assert.equal(posthogUiHost('https://eu.i.posthog.com'), 'https://eu.posthog.com');
    assert.equal(posthogUiHost('https://ph.example.com'), 'https://ph.example.com');
  });
});

/* ---------- what analytics.js promises ---------- */

describe('public/shared/analytics.js', () => {
  const src = fs.readFileSync('public/shared/analytics.js', 'utf8');

  test('honours Do Not Track, which the Privacy Policy promises it does', () => {
    // §2.14 tells students DNT switches recording off and that we cannot
    // override it. posthog-js defaults this to false.
    assert.match(src, /respect_dnt:\s*true/);
  });

  test('masks every input and captures no request bodies', () => {
    assert.match(src, /maskAllInputs:\s*true/);
    assert.match(src, /recordHeaders:\s*false/);
    assert.match(src, /recordBody:\s*false/);
    assert.match(src, /maskTextSelector:\s*'\[data-ph-mask\]'/);
  });

  test('creates no person for an anonymous visitor', () => {
    // The same rule src/lib/posthog.js applies server-side. Anonymous sessions
    // are still recorded; they just do not mint a person.
    assert.match(src, /person_profiles:\s*'identified_only'/);
  });

  test('reports a session that should be recording and is not', () => {
    // The runtime half of the same problem the build guard covers: replay can
    // also stop working for reasons no build check can see (the project switch,
    // a blocked request, an exhausted quota). posthog-js names the state, so
    // analytics.js waits it out and reports once if it never reaches 'active'.
    assert.match(src, /var HEALTH_DELAY_MS = \d+/);
    assert.match(src, /client-error/, 'it has to actually report somewhere');
  });

  test("'disabled' stays reportable — it is the project-switch signal", () => {
    // The subtle one, and the easiest to "tidy up" into uselessness. posthog-js
    // reports 'disabled' BOTH when the student opted out and when replay is off
    // in the PostHog project. Adding it to the quiet list would silence the
    // main failure this check exists for. Do Not Track is excluded a line
    // earlier instead, by asking posthog whether capture was opted out.
    const quiet = /var EXPECTED_QUIET = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
    assert.ok(quiet.length, 'the quiet list must still exist');
    assert.ok(!/\bdisabled\s*:/.test(quiet),
      "'disabled' must NOT be treated as expected — it is how a project-wide switch-off looks");
    assert.match(src, /has_opted_out_capturing\(\)/,
      'the opt-out (Do Not Track) case must be excluded explicitly, not by silencing disabled');
    assert.match(quiet, /sampled\s*:/, 'a project sample rate IS expected and must stay quiet');
  });

  test('rate-limits itself, so one misconfiguration is not a flood', () => {
    // If replay is off project-wide then every session is a failing session.
    // Per-session reporting would replace a silent failure with a useless one.
    assert.match(src, /var DAY_MS = 86400000/);
    assert.match(src, /localStorage\.setItem\(HEALTH_KEY/);
    // ...and a browser that cannot remember it reported must not report at all.
    assert.match(src, /return true;/, 'unreadable storage must fail closed');
  });

  test('never reports from /join, whose source the database would reject', () => {
    // error_logs.source is CHECK ('server','student','vendor','admin')
    // (migration-013). logError swallows a failed insert, so reporting 'join'
    // would be a silent write into nothing — the exact bug this check exists to
    // remove, reintroduced by the check itself.
    assert.match(src, /app !== 'student' && app !== 'vendor'/);
    const migration = fs.readFileSync('supabase/migrations/00000000000013_migration-013.sql', 'utf8');
    const constraint = /source\s+text not null check \(source in \(([^)]*)\)\)/.exec(migration)?.[1] ?? '';
    assert.ok(!constraint.includes("'join'"),
      'if a migration ever adds join, analytics.js may report from there too');
  });

  test('the app scripts identify and reset through it', () => {
    const student = fs.readFileSync('public/student/app.js', 'utf8');
    const terminal = fs.readFileSync('public/vendor/terminal.js', 'utf8');
    assert.match(student, /Analytics\.identify\(/);
    assert.match(terminal, /Analytics\.identify\(/);
    // A shared counter iPad without this files the next operator's recording
    // under the last one's account.
    assert.match(terminal, /Analytics\.reset\(\)/);
    // ...and on the student app the reset must be guarded, or every signed-out
    // page load starts a new session id and chops a visit into fragments.
    assert.match(student, /if \(!wasSignedOut\) Analytics\.reset\(\)/);
  });
});
