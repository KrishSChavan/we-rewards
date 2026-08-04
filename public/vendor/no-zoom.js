/* Zoom off — the terminal is a fixed-layout kiosk screen; a stray pinch on a
   counter iPad leaves staff staring at a zoomed-in corner mid-transaction.
   Three layers, because no single one covers every browser:

     1. <meta viewport user-scalable=no>  — Android Chrome, and iOS once the
        PWA is installed (standalone mode honours it).
     2. touch-action: pan-x pan-y on <html> (see terminal.css) — kills pinch
        and double-tap-to-zoom while leaving scrolling alone. Unlike a touchend
        preventDefault() hack this can't swallow the click on a fast double
        tap, so the keypad still registers repeated digits.
     3. this file — iOS Safari in a *browser tab* has ignored user-scalable
        since iOS 10, and doesn't let touch-action block pinch on the root.
        Cancelling the proprietary gesture* events is what actually stops it
        there.

   External rather than inline because the page CSP forbids inline scripts.
   Kept as its own copy per app: each shell is served from its own static root
   (/, /terminal, /admin), so there is no shared asset path to point at. */
(function () {
  /* Self-heal a stale shell's viewport meta.
     The phone layout needs `viewport-fit=cover`, or iOS keeps the page out of
     the home-indicator strip entirely: the tab bar and even a
     `position: fixed; inset: 0` overlay stop ~93px short of the screen edge.
     That tag lives in index.html, which is the one asset here that goes stale
     (server.js memoises the rendered shell, and a cached document still pulls
     CURRENT terminal.css/terminal.js because the server ignores the ?v= stamp)
     — so an old shell pairs the new stylesheet with a viewport that can't
     support it.
     This script is loaded from <head>, directly after the meta and before the
     body is parsed, so a correction here still lands in the first layout.
     A no-op on an up-to-date shell. */
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp && !/viewport-fit\s*=\s*cover/i.test(vp.content)) {
    vp.setAttribute('content', `${vp.content}, viewport-fit=cover`);
  }

  // Non-passive, or preventDefault() is a no-op and the pinch goes through.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  // Trackpad pinch arrives as a wheel event with ctrlKey set. Keyboard zoom
  // (⌘/Ctrl + +/-) is deliberately left working — that's an accessibility
  // affordance, and it isn't what makes the app feel broken.
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
})();
