/* WeRewards — PostHog session replay + client analytics.
   =====================================================================
   ONE source, fanned out into every app that records (see POSTHOG_APPS in
   scripts/build-client.js) exactly the way public/shared/boot-guard.js is,
   so the copies cannot drift. public/shared is not an app root and is never
   served directly.

   WHAT THIS IS FOR. src/lib/posthog.js already mirrors our named server-side
   events into PostHog, but a server can never produce a SESSION REPLAY —
   a replay is a recording of the DOM, and only the browser has one. That is
   what this file adds: posthog-js runs in the page and records the session,
   and identify() below is what makes a recording searchable as "this student"
   rather than as an anonymous id nobody can act on.

   HOW IT IS CONFIGURED. There is no inline <script> anywhere in these shells
   and there cannot be — the CSP is script-src 'self' with no 'unsafe-inline'
   (server.js) — so the project key arrives as a <meta> tag that serveShell
   stamps into the served HTML. A meta tag is not script, so nothing about the
   CSP has to be loosened to read one. No round trip either: recording starts
   on the first line of this file rather than one fetch of /api/public-config
   later, which matters because the beginning of a session is usually the part
   you wanted to watch.

   The value in that tag is the PostHog PROJECT key (phc_...). It is public by
   design — a write-only ingestion token, the same one PostHog's own install
   snippet puts in your HTML — and it is the same value the server uses. It
   cannot read anything back out of the project.

   INERT BY DEFAULT. No meta tag (no POSTHOG_API_KEY, or POSTHOG_SESSION_REPLAY
   turned off) means this file defines the same window.Analytics shape and does
   nothing at all, so a local checkout with no keys behaves identically and no
   caller has to know whether analytics is configured.

   LOAD ORDER. This file must load AFTER posthog.js and BEFORE the app's own
   script. All three are plain (non-defer) <script> tags at the end of <body>,
   which run in document order; a deferred script would run AFTER app.js and
   miss the identify() call app.js makes while restoring a session. See the
   script block at the bottom of each shell.
   ===================================================================== */
(function () {
  'use strict';

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    var v = el && el.getAttribute('content');
    return v ? v.trim() : '';
  }

  var key = meta('posthog-key');
  var apiHost = meta('posthog-host') || 'https://us.i.posthog.com';
  var uiHost = meta('posthog-ui-host') || '';
  var app = meta('posthog-app') || 'unknown';

  var live = false;

  /* ---------- the shape callers use, live or not ----------
     Every method is safe to call before init has finished, after a failure,
     and on a deployment with no key at all. An app must never have to ask
     whether analytics is on. */
  var Analytics = {
    /** Is a real posthog-js instance behind these calls? */
    get enabled() { return live; },

    /**
     * Attach this session — and the replay of it — to a person. Called on
     * every render of a signed-in state, not just at the moment of sign-in:
     * a silent token refresh re-enters that path, and on the vendor terminal
     * an operator switching stores has to land on the right account at once.
     *
     * posthog-js no-ops a repeat identify() with the same id, so calling it
     * often costs nothing and calling it rarely costs a recording filed under
     * nobody.
     *
     * @param {string} id      the Supabase user id — the SAME id
     *                         src/lib/posthog.js sends as distinct_id, so the
     *                         server's events and this replay land on one
     *                         person instead of two
     * @param {object} [props] small, non-sensitive person properties
     */
    identify: function (id, props) {
      if (!live || !id) return;
      try { window.posthog.identify(String(id), props || {}); } catch (e) { /* never break a sign-in */ }
    },

    /**
     * Forget who this was. MUST be called on sign-out, and the vendor terminal
     * is why it is not optional: it is a shared iPad behind a counter, so
     * without a reset the next operator's recording is filed under the last
     * one's account. It also starts a fresh session id, so two shifts are two
     * recordings rather than one long one.
     */
    reset: function () {
      if (!live) return;
      try { window.posthog.reset(); } catch (e) { /* nothing useful to do */ }
    },

    /**
     * A named event, from the client, on the same person as the replay.
     * Deliberately thin: client_events (via /api/client-event, migration-024)
     * stays the system of record for the funnels this app already measures,
     * and this is for things only the browser can see.
     */
    capture: function (event, props) {
      if (!live || !event) return;
      try { window.posthog.capture(String(event), props || {}); } catch (e) { /* best effort */ }
    },

    /** The id this browser is recording under, for pairing with a bug report. */
    sessionId: function () {
      if (!live) return null;
      try { return window.posthog.get_session_id() || null; } catch (e) { return null; }
    },

    /** A deep link to the replay in progress, if this posthog-js build offers one. */
    replayUrl: function () {
      if (!live) return null;
      try { return window.posthog.get_session_replay_url({ withTimestamp: true }); } catch (e) { return null; }
    },
  };

  window.Analytics = Analytics;

  if (!key || !window.posthog || typeof window.posthog.init !== 'function') return;

  try {
    window.posthog.init(key, {
      api_host: apiHost,
      // Only used to build the dashboard links get_session_replay_url() returns;
      // no request is ever sent here. Empty is fine — posthog-js falls back.
      ui_host: uiHost || undefined,

      /* ---- what we record ---- */

      // The whole point of this file. Note the faster lever if a recording ever
      // has to stop in a hurry: the project switch in PostHog (Settings ->
      // Replay) turns it off for every client immediately, with no redeploy of
      // three service-worker-cached bundles.
      disable_session_recording: false,

      session_recording: {
        // posthog-js masks <input> values by default and ALWAYS masks a
        // password field. Both are re-stated rather than assumed: this records
        // a public vendor application form and a point-of-sale login, and a
        // default that quietly changes in a minor release is not something to
        // find out about from a recording.
        maskAllInputs: true,
        // Text is otherwise recorded as it appears, which is what makes a
        // replay worth watching at all. Anything genuinely private on screen
        // carries data-ph-mask and arrives as asterisks — see #account-email.
        maskTextSelector: '[data-ph-mask]',
        // ...and data-ph-block drops an element from the recording entirely,
        // for anything that should not leave even a shape behind.
        blockSelector: '[data-ph-block]',
        // Network timings only — never headers, never bodies. Both default to
        // off; being explicit matters here because every authenticated request
        // this app makes carries a Supabase access token in an Authorization
        // header, and a recording that captured one would be a live credential
        // sitting in an analytics vendor's storage for the whole retention
        // window.
        recordHeaders: false,
        recordBody: false,
      },

      /* ---- what we deliberately do NOT record ---- */

      // Autocapture would file a $autocapture event, carrying the element's own
      // text, for every click in the app. This project's analytics are named
      // events chosen on purpose (client_events), and the replay already shows
      // what was tapped. Turn it on if the Session Replay list ever needs
      // event-based filtering more than it needs to stay quiet.
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,

      // Surveys, the toolbar and site apps are features we do not use, and each
      // of them wants to pull code or config from a host that is not ours. The
      // bundle we serve is posthog-js's "no-external" build for exactly that
      // reason (see scripts/build-client.js); this says the same thing in
      // config, so a future build that COULD reach out still would not.
      disable_surveys: true,
      disable_external_dependency_loading: true,
      opt_in_site_apps: false,

      /* ---- who gets a person profile ---- */

      // The same rule src/lib/posthog.js applies server-side
      // ($process_person_profile), for the same reason: an anonymous visitor
      // must not mint a person and corrupt every person-based metric in the
      // project. Anonymous sessions are still RECORDED — a replay does not need
      // a person — they are filed under an anonymous id until identify() runs,
      // at which point PostHog stitches the session onto the real account.
      person_profiles: 'identified_only',

      // localStorage first, with a cookie only for the ids that have to survive
      // a storage clear. The cookie cannot be the primary store: Safari caps a
      // script-set cookie at 7 days, which is shorter than the gap between two
      // visits to a student rewards app.
      persistence: 'localStorage+cookie',

      // NOT the posthog-js default, and load-bearing rather than decorative:
      // the Privacy Policy (§2.14) tells students that turning on Do Not Track
      // or their browser's tracking protection switches recording off, and that
      // we cannot override it. This line is what makes that sentence true. It
      // costs a small number of recordings; a promise in a privacy policy that
      // the code does not keep costs considerably more.
      respect_dnt: true,

      loaded: function (ph) {
        live = true;
        // Which of the apps this recording came from, on every event and on the
        // person. It is the first thing you filter the replay list by.
        try { ph.register({ app: app }); } catch (e) { /* best effort */ }
      },
    });
    // `loaded` is asynchronous on some paths and nothing above depends on it;
    // this is what actually opens the API up to callers.
    live = true;
  } catch (e) {
    // A bad key, a blocked script, a browser with site data switched off. None
    // of it is a reason for a student to see a broken app.
    live = false;
    return;
  }

  /* ==========================================================================
     Did recording actually start?
     ==========================================================================
     THE FAILURE THIS EXISTS FOR. Session replay does not break loudly. Every
     way it can fail — the wrong posthog-js build, replay switched off in the
     PostHog project, a blocked request, an exhausted recording quota, a URL
     trigger nobody remembers configuring — produces the same thing: a page that
     loads perfectly, an SDK that reports no error, and no recordings. The
     symptom is an empty replay list noticed weeks later.

     posthog-js does know, and says so in one word. Measured in a real browser
     against a deliberately-broken build:

         healthy       status 'active'        started true
         wrong build   status 'lazy_loading'  started false   (forever)
         DNT / opted out   status 'disabled'  optedOut true

     So: wait past the states that are legitimately transient, and if recording
     still is not active, say so once. This is the only check that runs where
     the failure actually happens — the build assertion and the boot log both
     run before a single student loads the page.

     REPORTED ONCE PER BROWSER PER DAY, not once per session. If replay is off
     project-wide then EVERY session is a failing session, and a per-session
     report would turn one misconfiguration into a flood of rows in error_logs
     — replacing a silent failure with a useless one. A day is long enough that
     the volume tracks "how many people use the app" rather than "how many
     pages they opened", and short enough to notice within a day of shipping. */

  var HEALTH_KEY = 'werewards.replay.reported';
  var HEALTH_DELAY_MS = 30000;   // past lazy_loading, past the first flush
  var DAY_MS = 86400000;

  // Statuses that are a deliberate decision rather than a fault. Reporting
  // these would be reporting that the system works.
  //
  // 'disabled' is deliberately NOT in this list, and that is the single most
  // important line here. It is what posthog-js reports both when the student
  // opted out AND when replay is switched off in the PostHog project — the
  // second being the exact failure this check exists to catch. Listing it would
  // silence the main case to spare the other. The opt-out is separated out
  // above instead, by asking posthog directly (has_opted_out_capturing), which
  // answers true for Do Not Track; so anything still reading 'disabled' by the
  // time we get here is the project, not the person.
  var EXPECTED_QUIET = {
    sampled: 1,             // the project's sample rate excluded this session
    trigger_pending: 1,     // a URL/event trigger is configured and hasn't fired
    trigger_disabled: 1,
  };

  function reportedRecently() {
    try {
      var last = Number(localStorage.getItem(HEALTH_KEY) || 0);
      return last > 0 && (Date.now() - last) < DAY_MS;
    } catch (e) {
      // Site data blocked. Without a memory we cannot rate-limit ourselves, and
      // an un-rate-limited reporter is worse than no reporter.
      return true;
    }
  }

  function recordingStatus() {
    try {
      var s = window.posthog.sessionRecording && window.posthog.sessionRecording.status;
      if (s) return String(s);
    } catch (e) { /* fall through */ }
    // Older/newer builds may not expose that; sessionRecordingStarted() is the
    // coarser but more stable signal. 'unknown' means we could read neither,
    // which is not evidence of a fault and is not reported.
    try {
      return window.posthog.sessionRecordingStarted() ? 'active' : 'not-started';
    } catch (e) {
      return 'unknown';
    }
  }

  function checkRecordingHealth() {
    var status;
    try {
      if (window.posthog.has_opted_out_capturing()) return;   // their choice, working as intended
      status = recordingStatus();
    } catch (e) {
      return;
    }
    if (status === 'active' || status === 'unknown') return;
    if (EXPECTED_QUIET[status]) return;
    if (reportedRecently()) return;

    try { localStorage.setItem(HEALTH_KEY, String(Date.now())); } catch (e) { return; }

    // error_logs.source has a CHECK constraint of ('server','student','vendor',
    // 'admin') — migration-013. 'join' is not in it, and logError swallows the
    // insert failure, so reporting from there would be a silent write into
    // nothing: exactly the class of bug this whole check exists to remove. The
    // join page is covered indirectly anyway — it runs the same bundle with the
    // same config, so whatever breaks it breaks the student app too, and that
    // one can speak.
    if (app !== 'student' && app !== 'vendor') return;

    try {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          source: app,
          message: 'session replay not recording (status: ' + status + ')',
          url: location.pathname,
          context: {
            replayStatus: status,
            // What to check first, per status. Written here rather than left to
            // whoever reads the row at 2am.
            likelyCause:
              status === 'disabled' ? 'replay is switched off in the PostHog project (this browser did NOT opt out)'
              : status === 'lazy_loading' ? 'the recorder never loaded — wrong posthog-js build, or its fetch was blocked'
              : status === 'missing_config' || status === 'awaiting_config' ? 'the remote config never arrived — CSP connect-src, or a content blocker'
              : status === 'rrweb_error' ? 'the recorder threw'
              : status === 'buffering' || status === 'paused' ? 'still not flushing 30s in'
              : 'unrecognised status — check posthog-js release notes',
          },
        }),
      }).catch(function () { /* best effort, like every other reporter here */ });
    } catch (e) { /* never break a page over a health check */ }
  }

  try {
    var t = setTimeout(checkRecordingHealth, HEALTH_DELAY_MS);
    // Never hold a page open on our account.
    if (t && typeof t.unref === 'function') t.unref();
  } catch (e) { /* no timers, no check */ }
})();
