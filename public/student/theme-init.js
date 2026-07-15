/* Apply the saved (or system) theme before first paint to avoid a flash.
   Kept as a separate file (not inline) so the page's CSP can forbid inline
   scripts. Must stay a blocking <script> in <head> — no defer. */
(function () {
  try {
    var t = localStorage.getItem('psu-theme');
    if (t !== 'dark' && t !== 'light') {
      t = 'dark';   // dark is the default until the user explicitly chooses
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
