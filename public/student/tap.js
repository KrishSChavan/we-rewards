/* WeRewards — the NFC tag landing page's script (/t and /t/<ref>).

   A passive NFC tag in a shop window holds https://we-rewards.com/t/<slug>.
   The server renders a small page there (section#tap) with two links: "Get the
   app" (data-install, the web app plus install=1) and "Continue on the web"
   (data-dest, /?spot=<ref>), and an App Store URL in data-store when there is a
   listing to send iPhones to.

   This file exists because that page cannot carry a script of its own: server.js
   sends a Content-Security-Policy whose script-src is 'self' with no
   'unsafe-inline', so an inline <script> would be refused outright. It is a real
   file for the same reason boot-guard.js is. build-client.js mirrors it into
   .build/student like every other script here, and sw.js caches it on first use
   like one (it is not precached: the landing page itself is FOREIGN there, so
   there is never an offline landing to serve it to).

   It runs BEFORE the student chooses anything, and does only two things:
     1. If the page is already running inside an installed app, go straight to
        the destination. This is the Android case: a WebAPK catches the tag URL
        at the OS level and then LOADS this page inside its standalone window, so
        offering to install the app you are already inside is the one thing this
        page must never do.
     2. Otherwise point the primary link at the right place for the platform:
        the App Store on iOS when there is a listing, the web app's own install
        guide on Android (and on iOS without a listing), and the web app itself
        on a desktop, where there is nothing to install.
   No analytics: the server logs the tap when it renders the page. */
(function () {
  var el = document.getElementById('tap');
  if (!el) return;
  var dest = el.getAttribute('data-dest') || '/';
  var installDest = el.getAttribute('data-install') || dest;
  var store = el.getAttribute('data-store') || '';

  // The same two tests install-prompt.js uses to say "already installed", guarded
  // the same way: an engine without matchMedia, or a Capacitor global that is
  // something else, must read as "not installed", never as a thrown error that
  // leaves the links untouched.
  function isStandalone() {
    try {
      return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true);   // iOS Safari's own flag
    } catch (e) { return false; }
  }
  function isNativeShell() {
    try {
      var C = window.Capacitor;
      return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
    } catch (e) { return false; }
  }
  if (isStandalone() || isNativeShell()) {
    location.replace(dest);
    return;
  }

  var app = document.getElementById('tap-app');
  if (!app) return;
  var ua = navigator.userAgent || '';
  // install-prompt.js's platform test: iPadOS reports a desktop UA, so the
  // touch-point count is what tells an iPad from a Mac.
  var iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var android = /Android/.test(ua);

  if (iOS && store) {
    app.setAttribute('href', store);          // the App Store listing
  } else if (iOS || android) {
    app.setAttribute('href', installDest);    // the web app opens its own install guide
  } else {
    app.textContent = 'Open WeRewards';       // a laptop: nothing to install
    app.setAttribute('href', dest);
  }
})();
