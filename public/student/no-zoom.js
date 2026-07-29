/* Zoom off — the app should feel like an app, not a zoomable web page.
   Three layers, because no single one covers every browser:

     1. <meta viewport user-scalable=no>  — Android Chrome, and iOS once the
        PWA is installed (standalone mode honours it).
     2. touch-action: pan-x pan-y on <html> (see styles.css) — kills pinch and
        double-tap-to-zoom while leaving scrolling alone. Unlike a touchend
        preventDefault() hack this can't swallow the click on a fast double
        tap, so buttons keep working.
     3. this file — iOS Safari in a *browser tab* has ignored user-scalable
        since iOS 10, and doesn't let touch-action block pinch on the root.
        Cancelling the proprietary gesture* events is what actually stops it
        there.

   External rather than inline because the page CSP forbids inline scripts. */
(function () {
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
