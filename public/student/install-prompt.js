/* WeRewards — smart PWA install prompt
   =====================================================================
   The trigger / eligibility layer around the existing #install-modal
   instruction sheet. This module OWNS: capturing the deferred native
   prompt, deciding *whether* and *how* to nudge (platform routing +
   suppression rules), the 5 trigger points, and the install funnel
   analytics. app.js just calls the trigger methods at the right moments.

   Exposed as window.InstallPrompt (this front-end has no bundler; the
   script is loaded before app.js). See the design notes inline.
   ===================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'werewards.install.v1';
  var DAY = 86400000;
  var SESSION_GAP = 30 * 60 * 1000;   // 30-min inactivity = a new "session"
  var COOLDOWN = 14 * DAY;            // wait this long after a dismissal
  var LIFETIME_CAP = 3;              // never show more than this many prompts, ever

  // Priority 1 (highest) → 5. Only ONE prompt fires per session; when several
  // triggers are live in the same session the lowest `priority` number wins, and
  // a higher-priority request preempts a lower one still waiting out its delay.
  var TRIGGERS = {
    redemption:   { priority: 1, delayMs: 1500, surface: 'sheet' },
    threshold:    { priority: 2, delayMs: 800,  surface: 'sheet' },
    thirdSession: { priority: 3, delayMs: 600,  surface: 'sheet' },
    firstPoints:  { priority: 4, delayMs: 4000, surface: 'banner' },
    manual:       { priority: 5, delayMs: 0,    surface: 'sheet', bypass: true },
  };

  /* ---------- module state (survives across the SPA, not across reloads) ---------- */
  var deferredPrompt = null;   // captured beforeinstallprompt event (Chromium only)
  var installedLatch = false;  // appinstalled fired this run
  var userId = null;           // current signed-in user (suppression is keyed per-user)
  var track = function () {};  // analytics sink, injected by init()
  var pending = null;          // { name, priority, timer } — the queued/showing prompt
  var eligibleFired = false;   // install_eligible is once per session
  var dom = null;              // cached #install-modal elements (lazily wired)

  /* ---------- persisted store (one JSON key, easy to inspect + reset) ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (!s || s.v !== 1) return { v: 1, installed: false, users: {} };
      if (!s.users) s.users = {};
      return s;
    } catch (e) {
      return { v: 1, installed: false, users: {} };
    }
  }
  function save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode / full */ }
  }
  // Per-user suppression record, created on first access.
  function userRec(s, uid) {
    var key = uid || 'anon';
    if (!s.users[key]) {
      s.users[key] = {
        shownCount: 0, lastShownAt: 0, lastDismissedAt: 0, dismissedCount: 0,
        accepted: false, redemptionFired: false, thresholdFired: false,
        firstPointsFired: false, thirdSessionFired: false,
        session: { count: 0, lastSeenAt: 0 }, lastPromptSession: -1,
      };
    }
    return s.users[key];
  }

  /* ---------- session counting (30-min inactivity gap = new session) ----------
     Called once when the user is known (setUser). Bumps the counter when the gap
     since last activity exceeds 30 min; the counter doubles as the session id
     that "one prompt per session" is measured against. */
  function bumpSession() {
    var s = load();
    var rec = userRec(s, userId);
    var now = Date.now();
    if (!rec.session.lastSeenAt || now - rec.session.lastSeenAt > SESSION_GAP) {
      rec.session.count += 1;
    }
    rec.session.lastSeenAt = now;
    save(s);
    return rec.session.count;
  }
  // Keep the session's "last seen" fresh on meaningful activity so a long-but-busy
  // visit stays one session (the gap is about inactivity, not wall-clock age).
  function touchSession() {
    if (userId == null) return;
    var s = load();
    var rec = userRec(s, userId);
    rec.session.lastSeenAt = Date.now();
    save(s);
  }

  /* ---------- already-installed detection (checked on every eligibility call) ---------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;   // iOS Safari's own flag
  }
  function isInstalled() {
    if (installedLatch || isStandalone()) return true;
    return load().installed === true;             // persisted latch from a prior appinstalled
  }

  /* ---------- platform routing ---------- */
  // In-app browsers can't add to the home screen — students hit these constantly
  // from Instagram/Snap DMs. Detected by UA token so we can route them to a
  // "open in Safari" screen instead of instructions they can't follow.
  var INAPP_RE = /(FBAN|FBAV|FB_IAB|Instagram|Snapchat|Line\/|Twitter|TikTok|musical_ly|BytedanceWebview|Pinterest|LinkedInApp|GSA\/|\bWKWebView\b)/i;
  function isInApp(ua) { return INAPP_RE.test(ua); }

  // 'chromium' | 'ios-safari' | 'ios-inapp' | 'android' | 'desktop'
  function resolvePlatform() {
    var ua = navigator.userAgent || '';
    var iOS = /iPad|iPhone|iPod/.test(ua)
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);  // iPadOS reports desktop UA

    if (iOS) {
      // Real Safari only: Chrome (CriOS) / Firefox (FxiOS) / in-app webviews on iOS
      // all lack the install API and must be sent to Safari.
      var realSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua) && !isInApp(ua);
      return realSafari ? 'ios-safari' : 'ios-inapp';
    }
    // Chromium exposed a deferred prompt → we can fire the real one-tap install.
    if (deferredPrompt) return 'chromium';
    // Android without a deferred event (e.g. Firefox) → manual steps still help.
    if (/Android/.test(ua)) return 'android';
    return 'desktop';   // nothing to nudge
  }

  /* ---------- eligibility (recomputed on every call, never cached) ---------- */
  // Returns { eligible, reason, platform }. `bypass` (manual entry point) skips
  // the cap/session/cooldown gates but still honours installed + platform.
  function getEligibility(bypass) {
    var platform = resolvePlatform();
    if (isInstalled())        return { eligible: false, reason: 'installed', platform: platform };
    if (platform === 'desktop') return { eligible: false, reason: 'unsupported', platform: platform };

    if (bypass) return { eligible: true, reason: 'manual', platform: platform };

    var s = load();
    var rec = userRec(s, userId);
    if (rec.shownCount >= LIFETIME_CAP)          return { eligible: false, reason: 'lifetime-cap', platform: platform };
    if (rec.lastPromptSession === rec.session.count) return { eligible: false, reason: 'already-this-session', platform: platform };
    if (rec.lastDismissedAt && Date.now() - rec.lastDismissedAt < COOLDOWN) {
      return { eligible: false, reason: 'cooldown', platform: platform };
    }
    return { eligible: true, reason: 'eligible', platform: platform };
  }

  /* ---------- trigger resolver ----------
     Every trigger point routes through here. Schedules the prompt after the
     trigger's delay; a higher-priority request lands during that window and
     preempts a lower one (so a redemption beats a same-moment "near threshold",
     and neither lets the low-priority first-points banner sneak in). */
  function request(name, payload) {
    var t = TRIGGERS[name];
    if (!t) return;
    var elig = getEligibility(t.bypass);
    if (!elig.eligible) {
      if (window.__WR_INSTALL_DEBUG) console.debug('[install] skip', name, elig.reason);
      return;
    }
    if (!eligibleFired) { eligibleFired = true; track('install_eligible', { platform: elig.platform }); }

    // Manual always shows now — it ignores the pending queue entirely.
    if (t.bypass) { show(name, payload, elig.platform); return; }

    if (pending && pending.priority <= t.priority) return;  // equal/higher already queued → keep it
    if (pending) clearTimeout(pending.timer);               // preempt a lower-priority pending one

    var timer = setTimeout(function () {
      pending = null;
      // Re-check: state may have changed during the delay (e.g. just installed).
      var re = getEligibility(false);
      if (!re.eligible) return;
      show(name, payload, re.platform);
    }, t.delayMs);
    pending = { name: name, priority: t.priority, timer: timer };
  }

  /* ---------- showing a prompt ---------- */
  function markShown(name) {
    var t = TRIGGERS[name];
    // The manual entry point (bypass) must not eat into the lifetime cap or the
    // once-per-session budget meant for the automatic triggers — it only reports.
    if (!t || !t.bypass) {
      var s = load();
      var rec = userRec(s, userId);
      rec.shownCount += 1;
      rec.lastShownAt = Date.now();
      rec.lastPromptSession = rec.session.count;   // enforces "one prompt per session"
      save(s);
    }
    track('install_prompt_shown', { trigger: name });
  }

  function show(name, payload, platform) {
    var t = TRIGGERS[name];
    // Chromium: fire the real prompt directly, skip our sheet entirely.
    if (platform === 'chromium') { markShown(name); fireNative(); return; }

    if (t.surface === 'banner') { markShown(name); showBanner(payload); return; }

    // iOS Safari / Android → instruction sheet; iOS in-app → "open in Safari".
    markShown(name);
    openSheet(platform, name, payload);
  }

  // Copy tuned per trigger (falls back to a generic line for manual/unknown).
  function copyFor(name, payload) {
    var reward = (payload && payload.reward) ? payload.reward : 'a free reward';
    switch (name) {
      case 'redemption':
        return { title: 'Nice work, that’s yours', desc: 'Add WeRewards to your home screen so it’s one tap next time.' };
      case 'threshold':
        return { title: 'You’re 1 visit away', desc: 'You’re 1 visit from ' + reward + '. Keep WeRewards on your home screen so you don’t lose track.' };
      case 'thirdSession':
        return { title: 'Welcome back', desc: 'Add WeRewards to your home screen. Your code and points, one tap away.' };
      default:
        return { title: 'Add WeRewards to your phone', desc: 'Pop it on your home screen and it opens like a real app: full screen, and your code is one tap away.' };
    }
  }

  /* ---------- native (Chromium) prompt ---------- */
  function fireNative() {
    var e = deferredPrompt;
    if (!e) return;
    deferredPrompt = null;   // each captured event is single-use
    e.prompt();
    Promise.resolve(e.userChoice).then(function (choice) {
      if (choice && choice.outcome === 'accepted') {
        markAccepted();
        track('install_accepted', { via: 'native' });
      } else {
        recordDismiss();
        track('install_prompt_dismissed', { via: 'native' });
      }
    }).catch(function () { /* dismissed */ });
  }

  /* ---------- the instruction sheet (reuses the existing #install-modal DOM) ---------- */
  var IOS_STEPS = [
    ['⬆️', 'Tap the <strong>Share</strong> button in the bar at the bottom of the screen.'],
    ['➕', 'Scroll down and tap <strong>Add to Home Screen</strong>.'],
    ['✅', 'Tap <strong>Add</strong> and WeRewards lands on your home screen.'],
  ];
  var ANDROID_STEPS = [
    ['⋮', 'Tap the <strong>menu</strong> (three dots) in the top-right.'],
    ['➕', 'Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>).'],
    ['✅', 'Tap <strong>Add</strong> and WeRewards lands on your home screen.'],
  ];

  function els() {
    if (dom) return dom;
    var $ = function (id) { return document.getElementById(id); };
    dom = {
      overlay: $('install-modal'), card: $('install-card'),
      emoji: $('install-emoji'), title: $('install-title'), desc: $('install-desc'),
      ask: $('install-ask'), yes: $('install-yes'), no: $('install-no'),
      steps: $('install-steps'), lead: $('install-steps-lead'), list: $('install-steps-list'),
      done: $('install-done'), close: $('install-close'),
      inapp: $('install-inapp'), copy: $('install-copy'), copied: $('install-copied'),
      banner: $('install-banner'), bannerText: $('install-banner-text'),
      bannerAdd: $('install-banner-add'), bannerClose: $('install-banner-close'),
    };
    wireDom();
    return dom;
  }

  var sheetPlatform = null;   // platform the currently-open sheet is for
  function wireDom() {
    var d = dom;
    if (d.close) d.close.addEventListener('click', function () { dismissSheet(); });
    if (d.no) d.no.addEventListener('click', function () { dismissSheet(); });
    if (d.done) d.done.addEventListener('click', function () { closeSheet(); });   // "Got it" = followed steps, not a dismissal
    if (d.yes) d.yes.addEventListener('click', function () { showSteps(sheetPlatform); });
    if (d.overlay) d.overlay.addEventListener('click', function (e) { if (e.target === d.overlay) dismissSheet(); });
    if (d.copy) d.copy.addEventListener('click', copyLink);
    if (d.bannerAdd) d.bannerAdd.addEventListener('click', onBannerAdd);
    if (d.bannerClose) d.bannerClose.addEventListener('click', function () { hideBanner(); recordDismiss(); track('install_prompt_dismissed', { via: 'banner' }); });
  }

  function openSheet(platform, name, payload) {
    var d = els();
    if (!d.overlay) return;
    sheetPlatform = platform;
    var c = copyFor(name, payload);
    d.title.textContent = c.title;
    d.desc.textContent = c.desc;

    if (platform === 'ios-inapp') {
      d.emoji.textContent = '🧭';   // compass
      d.title.textContent = 'Open in Safari to add it';
      d.desc.textContent = 'In-app browsers (like Instagram) can’t add to your home screen. Open WeRewards in Safari, then tap Share → Add to Home Screen.';
      d.ask.hidden = true; d.steps.hidden = true; d.inapp.hidden = false;
      if (d.copied) d.copied.hidden = true;
    } else {
      d.emoji.textContent = '📲';
      d.ask.hidden = false; d.steps.hidden = true; d.inapp.hidden = true;
    }
    d.overlay.hidden = false;
    void d.overlay.offsetWidth;              // reflow so the slide-up transition runs
    d.overlay.classList.add('is-open');
  }

  function showSteps(platform) {
    var d = dom;
    var steps = platform === 'ios-safari' ? IOS_STEPS : ANDROID_STEPS;
    d.lead.textContent = platform === 'ios-safari' ? 'In Safari:' : 'In Chrome:';
    d.list.innerHTML = '';
    steps.forEach(function (pair) {
      var li = document.createElement('li');
      // Fixed developer strings (no user input) → innerHTML is safe here.
      li.innerHTML = '<span class="step-ico" aria-hidden="true">' + pair[0] + '</span><span>' + pair[1] + '</span>';
      d.list.appendChild(li);
    });
    d.ask.hidden = true;
    d.steps.hidden = false;
  }

  function closeSheet() {
    var d = dom;
    if (!d || !d.overlay || d.overlay.hidden || !d.overlay.classList.contains('is-open')) return;
    d.overlay.classList.remove('is-open');
    setTimeout(function () { d.overlay.hidden = true; }, 360);   // wait out the slide-down
  }
  // Closing via X / "Not now" / backdrop = an explicit dismissal → arm the cooldown.
  function dismissSheet() {
    closeSheet();
    recordDismiss();
    track('install_prompt_dismissed', { via: 'sheet' });
  }

  function copyLink() {
    var d = dom;
    var url = window.location.origin + '/';
    var done = function () { if (d.copied) { d.copied.hidden = false; } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { legacyCopy(url); done(); });
    } else { legacyCopy(url); done(); }
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'absolute'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) { /* best effort */ }
  }

  /* ---------- first-points inline banner (low-priority fallback surface) ---------- */
  function showBanner(payload) {
    var d = els();
    if (!d.banner) return;
    d.banner.hidden = false;
    void d.banner.offsetWidth;
    d.banner.classList.add('is-open');
  }
  function hideBanner() {
    var d = dom;
    if (!d || !d.banner) return;
    d.banner.classList.remove('is-open');
    setTimeout(function () { d.banner.hidden = true; }, 300);
  }
  function onBannerAdd() {
    hideBanner();
    var platform = resolvePlatform();
    if (platform === 'chromium') { fireNative(); return; }
    // Banner → tap "Add" → same instruction sheet, but without re-charging the
    // lifetime cap (the banner already counted as the shown prompt this session).
    openSheet(platform, 'firstPoints', null);
  }

  /* ---------- accept / dismiss bookkeeping ---------- */
  function markAccepted() {
    var s = load();
    var rec = userRec(s, userId);
    rec.accepted = true;
    save(s);
  }
  function recordDismiss() {
    var s = load();
    var rec = userRec(s, userId);
    rec.lastDismissedAt = Date.now();
    rec.dismissedCount += 1;
    save(s);
  }
  function markInstalled() {
    installedLatch = true;
    var s = load();
    s.installed = true;
    save(s);
  }

  /* ---------- native event capture (once per run) ---------- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();              // stop Chrome's own mini-infobar; we choose the moment
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    markInstalled();
    track('install_accepted', { via: 'appinstalled' });
    closeSheet();
    hideBanner();
  });

  /* ===================================================================
     Public API — app.js drives these at the right moments.
     =================================================================== */
  var InstallPrompt = {
    // Wire the analytics sink + fire pwa_launched. Call once at boot.
    init: function (opts) {
      if (opts && typeof opts.track === 'function') track = opts.track;
      if (isStandalone()) { markInstalled(); track('pwa_launched', {}); }
    },

    // The signed-in user is now known: key suppression to them + count the session.
    setUser: function (uid) {
      userId = uid || null;
      bumpSession();
    },
    clearUser: function () { userId = null; },

    // Trigger 1 — first successful redemption (highest priority).
    onRedemption: function () {
      touchSession();
      var s = load(); var rec = userRec(s, userId);
      if (rec.redemptionFired) return;   // "first" only
      rec.redemptionFired = true; save(s);
      request('redemption', null);
    },

    // Triggers 2 & 4 — fired after a scan (a balance gain). `info` carries the
    // vendor that earned + the balance delta so we can decide "within 1 visit".
    onPointsEarned: function (info) {
      touchSession();
      info = info || {};
      var s = load(); var rec = userRec(s, userId);

      // Trigger 2 — approaching a reward threshold. "Within 1 visit" = the gap to
      // the cheapest not-yet-affordable reward is no more than what this scan just
      // earned (so one more visit like this one would cross it).
      if (!rec.thresholdFired && info.vendor && info.earned > 0) {
        var near = nearestThreshold(info.vendor, info.newBalance, info.earned);
        if (near) {
          rec.thresholdFired = true; save(s);
          request('threshold', { reward: near.title });
          return;   // don't also queue the lower-priority first-points banner
        }
      }

      // Trigger 4 — first points ever earned. Low-priority inline banner, and only
      // if a higher trigger isn't already about to fire this interaction/session.
      if (!rec.firstPointsFired) {
        rec.firstPointsFired = true; save(s);
        request('firstPoints', null);
      }
    },

    // Trigger 3 — third session. Call after the home screen has rendered.
    onAppReady: function () {
      var s = load(); var rec = userRec(s, userId);
      if (rec.thirdSessionFired) return;
      if (rec.session.count < 3) return;   // not a returning-enough user yet
      rec.thirdSessionFired = true; save(s);
      request('thirdSession', null);
    },

    // Trigger 5 — permanent manual entry point (settings row). Bypasses cooldown,
    // cap, and once-per-session; only "installed" and platform can stop it.
    openManual: function () {
      request('manual', null);
    },

    // For the settings row: hide it once installed.
    isInstalled: isInstalled,

    // Dev helpers (wired to the dev-only reset button + console poking).
    reset: function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      installedLatch = false; pending && clearTimeout(pending.timer); pending = null; eligibleFired = false;
    },
    getState: function () { return load(); },
    debug: function (on) { window.__WR_INSTALL_DEBUG = on !== false; },
  };

  // Cheapest reward the user can't afford yet at this vendor, if the shortfall is
  // within one visit's earn. Returns { title, cost, gap } or null.
  function nearestThreshold(vendor, balance, earned) {
    var rewards = (vendor && vendor.rewards) || [];
    var best = null;
    for (var i = 0; i < rewards.length; i++) {
      var r = rewards[i];
      var cost = Number(r.cost_in_points);
      // !cost also covers a visits-only reward (cost_in_points null → 0), which
      // no amount of spending brings closer, so it is never a points threshold.
      if (!cost || balance >= cost) continue;        // already affordable → not a "threshold"
      var gap = cost - balance;
      if (gap > earned) continue;                    // more than one visit away
      if (!best || cost < best.cost) best = { title: r.title, cost: cost, gap: gap };
    }
    return best;
  }

  window.InstallPrompt = InstallPrompt;
})();
