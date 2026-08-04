/* TEMPORARY DIAGNOSTIC — see viewport-check.html. Safe to delete with it.

   External rather than inline because the page CSP is `script-src 'self'`
   (server.js, the helmet block) and forbids inline scripts.

   What this is for: the vendor terminal shows a tall empty band under the fixed
   tab bar in the INSTALLED iOS app only. Three different faults produce a band of
   the same height, and a screenshot cannot tell them apart, because the tab bar's
   own padding and the strip iOS paints outside the window are both --card white
   with no edge between them. They ARE separable from two numbers: how tall the
   window is, and what it thinks the bottom inset is.

   On a 393x852pt phone (status bar 59, home indicator 34):

     healthy full-cover window   inner 852, inset-top 59, inset-bottom 34, band 0
     legacy WebClip container    inner 793, inset-top 59, inset-bottom 34, band 93
       window is the screen minus the STATUS BAR but still pinned to y=0, so the
       app sits one status bar too high. 34pt of the band is the tab bar's own
       padding (reserved for a home indicator that is nowhere near it) and 59pt is
       strip outside the window. Selected by apple-mobile-web-app-capable.
     black-translucent strand    inner 759, inset-top 59, inset-bottom  0, band 93
       window is the SAFE height pinned to y=0. All 93pt is outside the window.
     no viewport-fit=cover       inner 759, inset-top  0, inset-bottom  0
       window sits below the status bar and stops above the home indicator.

   The keyboard shrink is a fourth cause and it hides behind whichever of the above
   is true: on iOS, focusing a field in an installed app can permanently shrink the
   window and never restore it. That one only shows up in a before/after reading,
   which is what the Measure again button is for. */
(function () {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const probeEl = document.getElementById('probe');
  const table = document.getElementById('readout');
  const verdict = document.getElementById('verdict');

  /* Captured on load, before anything can be focused. The keyboard shrink is only
     visible as a DIFFERENCE against this. */
  let launchInner = null;

  function read() {
    const probe = getComputedStyle(probeEl);
    const vv = window.visualViewport;
    /* screen.height follows orientation on iOS and the terminal is portrait-locked
       by the manifest, so the long edge is the one we want. */
    const screenH = Math.max(window.screen.height, window.screen.width);
    return {
      inner: window.innerHeight,
      screenH,
      shortfall: screenH - window.innerHeight,
      insetTop: px(probe.paddingTop),
      insetBottom: px(probe.paddingBottom),
      insetLeft: px(probe.paddingLeft),
      insetRight: px(probe.paddingRight),
      vvHeight: vv ? Math.round(vv.height) : null,
      vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
      standalone: window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches,
    };
  }

  /* Decide which of the four windows we were handed. Everything keys off two
     comparisons: is the window short at all, and does it still claim a bottom
     inset it has no room for. */
  function classify(r) {
    if (!r.standalone) {
      return { cls: '', text: 'Running in a browser tab, not the installed app. This '
        + 'reading proves nothing. Open the same address from the home screen icon.' };
    }
    if (launchInner !== null && r.inner < launchInner - 8) {
      return { cls: 'bad', text: 'KEYBOARD SHRINK. The window was ' + launchInner + 'pt at '
        + 'launch and is ' + r.inner + 'pt now, after the keyboard opened. iOS shrank it and '
        + 'did not put it back. That is the cause of the band, and it is fixable in the page '
        + 'without touching any meta tag or reinstalling.' };
    }
    if (r.shortfall <= 8) {
      return { cls: 'good', text: 'The window covers the whole screen (' + r.inner + 'pt of '
        + r.screenH + 'pt). The viewport is healthy, so any band you can see is a layout '
        + 'problem inside the page. Send this screenshot with one of the terminal.' };
    }
    if (r.insetTop === 0) {
      return { cls: 'bad', text: 'viewport-fit=cover is NOT in force: the window is short by '
        + r.shortfall + 'pt and reports no top inset, so it was placed below the status bar. '
        + 'Different fault from the two we expected. Send this screenshot.' };
    }
    /* Past here the window starts at screen y=0 (the status bar is painting over
       us), so the shortfall is all at the bottom and we can attribute it. */
    if (r.insetBottom > 8 && Math.abs(r.shortfall - r.insetTop) <= 8) {
      return { cls: 'bad', text: 'LEGACY WEBCLIP CONTAINER. The window is ' + r.inner + 'pt, '
        + 'exactly the screen minus the ' + r.insetTop + 'pt status bar, but still pinned to the '
        + 'top. The app is sitting one status bar too high. The band is ' + r.insetBottom
        + 'pt of tab bar padding plus ' + r.shortfall + 'pt outside the window. Fix: remove '
        + 'apple-mobile-web-app-capable from the shell and redeploy. No reinstall needed.' };
    }
    if (r.insetBottom === 0) {
      return { cls: 'bad', text: 'BLACK-TRANSLUCENT STRAND. The window is ' + r.inner + 'pt and '
        + 'reports no bottom inset, so iOS sized it to the safe height and pinned it to the top. '
        + 'All ' + r.shortfall + 'pt of the band is outside the window. Fix: delete the home '
        + 'screen icon and add it again.' };
    }
    return { cls: 'bad', text: 'The window is short by ' + r.shortfall + 'pt but does not match '
      + 'any expected pattern (insets ' + r.insetTop + ' top, ' + r.insetBottom + ' bottom). '
      + 'Send this screenshot.' };
  }

  function render() {
    const r = read();
    if (launchInner === null) launchInner = r.inner;

    const rows = [
      ['window.innerHeight', r.inner, true],
      ['innerHeight at launch', launchInner, true],
      ['screen.height', r.screenH],
      ['shortfall (screen - inner)', r.shortfall, true],
      ['safe-area-inset-top', r.insetTop, true],
      ['safe-area-inset-bottom', r.insetBottom, true],
      ['safe-area-inset-left / right', r.insetLeft + ' / ' + r.insetRight],
      ['visualViewport.height', r.vvHeight === null ? 'n/a' : r.vvHeight],
      ['visualViewport.offsetTop', r.vvOffsetTop === null ? 'n/a' : r.vvOffsetTop],
      ['window.outerHeight', window.outerHeight],
      ['screen.availHeight', window.screen.availHeight],
      ['devicePixelRatio', window.devicePixelRatio],
      ['innerWidth', window.innerWidth],
      ['navigator.standalone', String(window.navigator.standalone)],
      ['display-mode: standalone', String(window.matchMedia('(display-mode: standalone)').matches)],
      ['status-bar-style meta present',
        String(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') !== null)],
    ];

    table.textContent = '';
    for (const [label, value, hi] of rows) {
      const tr = table.insertRow();
      if (hi) tr.className = 'hi';
      tr.insertCell().textContent = label;
      tr.insertCell().textContent = String(value);
    }

    const v = classify(r);
    verdict.textContent = v.text;
    verdict.className = 'verdict ' + v.cls;
  }

  render();
  document.getElementById('remeasure').addEventListener('click', render);
})();
