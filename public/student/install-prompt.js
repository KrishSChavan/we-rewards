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
  var STORE_V = 2;                    // see migrate()
  var DAY = 86400000;
  var SESSION_GAP = 30 * 60 * 1000;   // 30-min inactivity = a new "session"
  var COOLDOWN = 14 * DAY;            // wait this long after a dismissal
  var CARD_COOLDOWN = 14 * DAY;       // and this long before the Home card comes back
  var LIFETIME_CAP = 3;              // never show more than this many prompts, ever

  // Priority 1 (highest) → 5. Only ONE prompt fires per session; when several
  // triggers are live in the same session the lowest `priority` number wins, and
  // a higher-priority request preempts a lower one still waiting out its delay.
  //
  // These four automatic triggers now fire on CHROMIUM ONLY (see getEligibility),
  // where firing means Chrome's own one-tap install dialog. Everywhere else the
  // best we could do unasked is an instruction sheet nobody sent for, so the
  // permanent surfaces -- the Home card and the Account row -- carry it instead
  // and `manual` is the trigger they both come through.
  var TRIGGERS = {
    redemption:   { priority: 1, delayMs: 1500 },
    threshold:    { priority: 2, delayMs: 800  },
    thirdSession: { priority: 3, delayMs: 600  },
    firstPoints:  { priority: 4, delayMs: 4000 },
    manual:       { priority: 5, delayMs: 0, bypass: true },
  };

  /* ---------- module state (survives across the SPA, not across reloads) ---------- */
  var deferredPrompt = null;   // captured beforeinstallprompt event (Chromium only)
  var installedLatch = false;  // appinstalled fired this run
  var userId = null;           // current signed-in user (suppression is keyed per-user)
  var track = function () {};  // analytics sink, injected by init()
  var onChange = function () {};   // 'what we can offer just changed', injected by init()
  var pending = null;          // { name, priority, timer } — the queued/showing prompt
  var eligibleFired = false;   // install_eligible is once per session
  var dom = null;              // cached #install-modal elements (lazily wired)

  /* ---------- persisted store (one JSON key, easy to inspect + reset) ---------- */
  function blank() { return { v: STORE_V, installed: false, users: {} }; }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (!s || !s.v || s.v > STORE_V) return blank();   // absent, or written by a newer build
      if (!s.users) s.users = {};
      if (s.v < STORE_V) migrate(s);
      return s;
    } catch (e) {
      return blank();
    }
  }
  function save(s) {
    s.v = STORE_V;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode / full */ }
  }

  // v1 -> v2: give back the lifetime-cap budget that never bought a prompt.
  // Until fireNative learned to wait for a gesture, every automatic trigger on
  // Chromium counted itself as shown and then threw, so students were being
  // suppressed by prompts that had never appeared. dismissedCount is the honest
  // floor: a prompt can only be dismissed if the student actually saw it, so
  // capping shownCount to it drops the phantoms and keeps every real one. The
  // cooldown, the accepted flag and the per-trigger latches are untouched.
  function migrate(s) {
    if (s.v < 2) {
      for (var key in s.users) {
        if (!Object.prototype.hasOwnProperty.call(s.users, key)) continue;
        var rec = s.users[key];
        rec.shownCount = Math.min(rec.shownCount || 0, rec.dismissedCount || 0);
        rec.lastPromptSession = -1;   // don't hold the session they're in right now
      }
    }
    save(s);
  }
  // Per-user suppression record, created on first access.
  function userRec(s, uid) {
    var key = uid || 'anon';
    if (!s.users[key]) {
      s.users[key] = {
        shownCount: 0, lastShownAt: 0, lastDismissedAt: 0, dismissedCount: 0,
        accepted: false, redemptionFired: false, thresholdFired: false,
        firstPointsFired: false, thirdSessionFired: false, cardDismissedAt: 0,
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

    // Automatic triggers are Chromium-only. There, firing costs the student one
    // tap on a dialog Chrome draws itself. Anywhere else the only thing we could
    // put on screen unasked is a sheet explaining a menu they did not open --
    // which is an interruption, not an install -- so those platforms are served
    // by the permanent Home card and Account row, which they choose to tap.
    if (platform !== 'chromium') return { eligible: false, reason: 'manual-only', platform: platform };

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
     and neither lets the low-priority first-points nudge sneak in). */
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
    // Chromium: fire the real prompt directly, skip our sheet entirely. The
    // shown bookkeeping is charged inside, at the moment the prompt appears --
    // it may first have to wait for a tap (see fireNative).
    if (platform === 'chromium') { fireNative(name); return; }

    // iOS Safari: no install API exists on the platform at all -- Add to Home
    // Screen lives in the Share sheet, which a page cannot open. The closest
    // thing to a button that installs is a pointer at the button that does.
    if (platform === 'ios-safari') { markShown(name); openGuide(); return; }

    // Android without a deferred prompt (Firefox) → menu steps.
    // iOS in-app (Instagram, Snapchat, iOS Chrome) → "open in Safari" + copy link.
    markShown(name);
    openSheet(platform);
  }


  /* ---------- native (Chromium) prompt ----------
     Chrome will only prompt() a captured beforeinstallprompt event while the
     page holds TRANSIENT USER ACTIVATION - i.e. from inside a real tap. Four of
     the five triggers fire from a setTimeout after a scan or a redemption,
     where the activation is long gone, and prompt() there throws NotAllowedError
     synchronously ("must be called with a user gesture"). That is what every
     automatic Chromium trigger did: a crash report instead of an install
     prompt, and (because markShown ran first) a lifetime-cap slot burned for a
     prompt the student never saw. Three of those and they were suppressed for
     good, having never been asked once.

     So the event is never fired from a timer now. With no activation we ARM
     instead: a document-level listener holds the event until the student's very
     next tap or key press ANYWHERE on the page, and fires it from inside that
     gesture. Nothing is drawn while armed, and the bookkeeping is only charged
     when the prompt actually appears - an arm that never gets a tap costs the
     student nothing and is retried next session.

     The listeners sit on the BUBBLE phase deliberately. In capture we would run
     ahead of the app's own click handlers, so a tap on the settings "Add to
     home screen" row would fire the native prompt here and THEN let openManual()
     run against a now-spent event, which resolves to the Android platform and
     opens the instruction sheet on top of the native one. In bubble the app's
     handler goes first, prompts, and we find the event already gone and stand
     down. */

  var GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
  var GESTURE_WINDOW = 5 * 60 * 1000;   // give up waiting for a tap after this long
  var armed = false;          // document listeners are attached
  var armedTrigger = null;    // trigger the armed prompt will be charged/reported as
  var armedAt = 0;
  var deferReported = false;  // install_prompt_deferred is once per page

  // Whether prompt() would be allowed this instant. Engines without the API get
  // an optimistic yes - promptNow() re-arms if the call turns out to throw.
  function hasActivation() {
    var ua = navigator.userActivation;
    return !ua || ua.isActive === true;
  }

  function fireNative(name) {
    if (!deferredPrompt) return;
    if (hasActivation()) promptNow(name);
    else armGesture(name);
  }

  // `name` is the trigger to charge this prompt to, or null when the surface
  // that led here was already counted (the Home card's own Add button).
  function promptNow(name) {
    var e = deferredPrompt;
    if (!e) return;
    deferredPrompt = null;             // each captured event is single-use
    var choice;
    try {
      choice = e.prompt();
    } catch (err) {
      // No activation after all. Chrome throws before it consumes the event, so
      // put it back and wait for a gesture rather than losing the install.
      deferredPrompt = e;
      armGesture(name);
      return;
    }
    if (name) markShown(name);         // only now has anything been shown
    Promise.resolve(e.userChoice || choice).then(function (res) {
      if (res && res.outcome === 'accepted') {
        markAccepted();
        track('install_accepted', { via: 'native' });
      } else {
        recordDismiss();
        track('install_prompt_dismissed', { via: 'native' });
      }
    }).catch(function () { /* dismissed */ });
  }

  function armGesture(name) {
    armedTrigger = name;               // a later, higher-priority trigger renames it
    if (armed) return;
    armed = true;
    armedAt = Date.now();
    for (var i = 0; i < GESTURE_EVENTS.length; i++) {
      document.addEventListener(GESTURE_EVENTS[i], onGesture, false);
    }
    if (!deferReported) {
      deferReported = true;
      track('install_prompt_deferred', { trigger: name || 'card' });
    }
  }

  function disarmGesture() {
    if (!armed) return;
    armed = false;
    armedTrigger = null;
    for (var i = 0; i < GESTURE_EVENTS.length; i++) {
      document.removeEventListener(GESTURE_EVENTS[i], onGesture, false);
    }
  }

  // Esc and the bare modifiers never grant activation, and neither does every
  // member of a tap sequence (a touch pointerdown, say) - the hasActivation()
  // gate lets those through untouched so the NEXT event in the same tap fires it.
  var DEAD_KEYS = { Escape: 1, Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1 };
  function onGesture(ev) {
    if (!ev || ev.isTrusted === false) return;   // el.click() grants no activation
    if (ev.type === 'keydown' && DEAD_KEYS[ev.key]) return;
    if (!deferredPrompt) { disarmGesture(); return; }        // fired elsewhere meanwhile
    if (Date.now() - armedAt > GESTURE_WINDOW) { disarmGesture(); return; }
    if (!hasActivation()) return;                            // not the activating event
    var name = armedTrigger;
    disarmGesture();
    promptNow(name);
  }

  /* ---------- the instruction sheet (reuses the existing #install-modal DOM) ----------
     Only two kinds of browser still land here, and neither of them CAN be
     installed from a button: Android without a deferred prompt (Firefox), and
     the iOS in-app browsers. iOS Safari used to share this sheet and now gets
     the pointer overlay below instead, which beats a numbered list at the only
     thing that is actually hard -- finding the Share button. */
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
      steps: $('install-steps'), lead: $('install-steps-lead'), list: $('install-steps-list'),
      done: $('install-done'), close: $('install-close'),
      inapp: $('install-inapp'), copy: $('install-copy'), copied: $('install-copied'),
      banner: $('install-banner'), bannerAdd: $('install-banner-add'),
      bannerClose: $('install-banner-close'),
      guide: $('install-guide'),
    };
    wireDom();
    return dom;
  }

  function wireDom() {
    var d = dom;
    if (d.close) d.close.addEventListener('click', function () { dismissSheet(); });
    if (d.done) d.done.addEventListener('click', function () { closeSheet(); });   // "Got it" = followed steps, not a dismissal
    if (d.overlay) d.overlay.addEventListener('click', function (e) { if (e.target === d.overlay) dismissSheet(); });
    if (d.copy) d.copy.addEventListener('click', copyLink);
    if (d.bannerAdd) d.bannerAdd.addEventListener('click', onCardAdd);
    if (d.bannerClose) d.bannerClose.addEventListener('click', dismissCard);
    // The guide is a pointer at Safari's own toolbar, so ANY tap dismisses it --
    // the student's next move is on the browser chrome, outside this page, and a
    // full-screen scrim they have to aim at an X to clear would be in the way.
    if (d.guide) d.guide.addEventListener('click', function () { dismissGuide(); });
  }

  function openSheet(platform) {
    var d = els();
    if (!d.overlay) return;
    d.title.textContent = 'Add WeRewards to your phone';
    d.desc.textContent = 'Pop it on your home screen and it opens like a real app: full screen, and your code is one tap away.';

    if (platform === 'ios-inapp') {
      d.emoji.textContent = '🧭';   // compass
      d.title.textContent = 'Open in Safari to add it';
      d.desc.textContent = 'In-app browsers (like Instagram) can’t add to your home screen. Open WeRewards in Safari, then tap Share → Add to Home Screen.';
      d.steps.hidden = true; d.inapp.hidden = false;
      if (d.copied) d.copied.hidden = true;
    } else {
      // Every route into this sheet is now an explicit tap on an "Add to Home
      // Screen" control, so the old "Yes, show me how" stage was asking a
      // question the student had already answered with the tap that got them
      // here. The steps are up on open.
      d.emoji.textContent = '📲';
      d.inapp.hidden = true;
      showSteps();
    }
    d.overlay.hidden = false;
    void d.overlay.offsetWidth;              // reflow so the slide-up transition runs
    d.overlay.classList.add('is-open');
  }

  // Chrome-with-a-deferred-prompt never reaches here (it installs outright), so
  // this is Firefox and the other Android engines: name the menu, not the browser.
  function showSteps() {
    var d = dom;
    d.lead.textContent = 'In your browser menu:';
    d.list.innerHTML = '';
    ANDROID_STEPS.forEach(function (pair) {
      var li = document.createElement('li');
      // Fixed developer strings (no user input) → innerHTML is safe here.
      li.innerHTML = '<span class="step-ico" aria-hidden="true">' + pair[0] + '</span><span>' + pair[1] + '</span>';
      d.list.appendChild(li);
    });
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

  /* ---------- the permanent Home card ----------
     Was the first-points trigger's fallback surface; it is now one of the two
     places a student can ask to install (the other is the Account row), and it
     is up whenever an install is possible and they have not waved it away.

     The card is a rung of .home-stack, so putting it up or taking it down
     changes the home screen's height by a whole block -- which is exactly what
     app.js's syncHomeDensity() decides the earn actions' shape from. Guarded
     because this file also runs before app.js has finished booting. */
  function remeasureHome() {
    if (typeof window.syncHomeDensity === 'function') window.syncHomeDensity();
  }

  // Anything to offer at all? False once installed, and on desktop browsers with
  // no deferred prompt, where every route we have is a dead end -- a button that
  // cannot do the thing it names is worse than no button.
  function canOffer() {
    if (isInstalled()) return false;
    return resolvePlatform() !== 'desktop';
  }

  // Called on boot, on sign-in, and whenever the answer can have changed (a
  // captured beforeinstallprompt, an install). Cheap and idempotent.
  function syncCard() {
    var d = els();
    if (!d.banner) return;
    var rec = userRec(load(), userId);
    var dismissed = rec.cardDismissedAt
      && Date.now() - rec.cardDismissedAt < CARD_COOLDOWN;
    if (canOffer() && !dismissed) showCard();
    else hideCard();
  }

  function showCard() {
    var d = els();
    if (!d.banner || !d.banner.hidden) return;   // already up: don't restart the transition
    d.banner.hidden = false;
    void d.banner.offsetWidth;
    d.banner.classList.add('is-open');
    remeasureHome();
  }

  function hideCard() {
    var d = dom;
    if (!d || !d.banner || d.banner.hidden) return;
    d.banner.classList.remove('is-open');
    setTimeout(function () { d.banner.hidden = true; remeasureHome(); }, 300);
  }

  // The X. Distinct from a prompt dismissal in one direction only: it also holds
  // the card down for a fortnight. It still records the dismissal, because
  // "no thanks" to the card is "no thanks" to the automatic prompt too, and
  // firing Chrome's dialog at someone who just closed this would be a bait.
  function dismissCard() {
    var s = load();
    var rec = userRec(s, userId);
    rec.cardDismissedAt = Date.now();
    save(s);
    hideCard();
    recordDismiss();
    track('install_prompt_dismissed', { via: 'card' });
  }

  // The card's Add button, and the Account row, both land here -- INSIDE the
  // click, which is what lets Chromium prompt outright instead of arming.
  function onCardAdd() {
    request('manual', null);
  }

  /* ---------- iOS Safari: point at the Share button ----------
     There is no install API on iOS. Add to Home Screen exists only inside
     Safari's Share sheet, which a page can neither open nor detect, so the
     honest best is to aim the student at the exact control they need and say
     what to tap once it opens.

     Where that control is depends on the device, and getting it wrong makes the
     overlay worse than nothing: on iPhone the Share button is the middle icon
     of the five in the toolbar along the BOTTOM, and on iPad it sits up in the
     TOP-right of the address bar. Same UA family, opposite ends of the screen. */
  function isIpad() {
    var ua = navigator.userAgent || '';
    // iPadOS 13+ ships a desktop UA, so the touch-point count is the only tell.
    return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  // role="dialog" with no close button of its own: the scrim takes any tap,
  // and a keyboard (an iPad with one attached) gets Esc. app.js owns a global
  // Esc chain but it is a list of sheet closers -- this is neither a sheet nor
  // reachable on the platforms that chain was written for, so it stays here.
  function onGuideKey(ev) {
    if (ev && ev.key === 'Escape') dismissGuide();
  }

  function openGuide() {
    var d = els();
    if (!d.guide) return;
    document.addEventListener('keydown', onGuideKey);
    // Bottom-centre by default (iPhone); top-right for the iPad address bar.
    if (isIpad()) d.guide.classList.add('is-ipad');
    else d.guide.classList.remove('is-ipad');
    d.guide.hidden = false;
    void d.guide.offsetWidth;
    d.guide.classList.add('is-open');
  }

  function closeGuide() {
    var d = dom;
    document.removeEventListener('keydown', onGuideKey);
    if (!d || !d.guide || d.guide.hidden) return;
    d.guide.classList.remove('is-open');
    setTimeout(function () { d.guide.hidden = true; }, 260);
  }

  // Tapping the overlay away is not a refusal: on iOS the next tap has to land
  // on Safari's own toolbar, so clearing the scrim is part of following the
  // instructions. Charging it to the cooldown would punish the students who did
  // exactly what it asked, so it is only reported.
  function dismissGuide() {
    closeGuide();
    track('install_prompt_dismissed', { via: 'guide' });
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
    // This is the moment 'desktop' becomes 'chromium' and a dead entry point
    // becomes a live one-tap install, so both permanent surfaces have to be
    // re-asked. It lands whenever Chrome feels like it, often after first paint.
    syncCard();
    onChange();
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    disarmGesture();
    markInstalled();
    track('install_accepted', { via: 'appinstalled' });
    closeSheet();
    closeGuide();
    hideCard();
    onChange();                      // and the Account row goes away with it
  });

  /* ===================================================================
     Public API — app.js drives these at the right moments.
     =================================================================== */
  var InstallPrompt = {
    // Wire the analytics sink + fire pwa_launched. Call once at boot.
    // `opts.onChange` fires when what we can offer changes under app.js's feet
    // -- Chrome handing over a deferred prompt, or the app being installed --
    // so the Account row can be re-synced without polling for it.
    init: function (opts) {
      if (opts && typeof opts.track === 'function') track = opts.track;
      if (opts && typeof opts.onChange === 'function') onChange = opts.onChange;
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
          return;   // don't also queue the lower-priority first-points prompt
        }
      }

      // Trigger 4 — first points ever earned. Lowest priority, and only if a
      // higher trigger isn't already about to fire this interaction/session.
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

    // The two permanent entry points -- the Account row and the Home card's Add
    // button -- both come through here. MUST be called synchronously from the
    // click handler: that gesture is the whole reason Chromium can install
    // outright instead of arming and waiting (see fireNative).
    openManual: function () {
      request('manual', null);
    },

    // Put the Home card up or take it down. Call whenever the app re-renders
    // the home screen for a (possibly different) user.
    syncCard: function () { syncCard(); },

    // For the settings row: hide it once installed, and on desktop browsers
    // where every route we have is a dead end.
    isInstalled: isInstalled,
    canOffer: canOffer,

    // Dev helpers (wired to the dev-only reset button + console poking).
    reset: function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      installedLatch = false; pending && clearTimeout(pending.timer); pending = null; eligibleFired = false;
      disarmGesture(); deferReported = false;
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
