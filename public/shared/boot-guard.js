/* Boot guard: turn a dead page into an explanation.
   =================================================

   SOURCE OF TRUTH. This one file is copied into every app's build output by
   scripts/build-client.js (the same way supabase-js is), and loads as
   /boot-guard.js, /terminal/boot-guard.js and /admin/boot-guard.js. Edit it
   here; nothing under public/student, public/vendor or public/admin holds a copy.

   WHY. scripts/build-client.js lowers every bundle so old Safari can parse it,
   but "old" has no floor: some device will always be older than the target. When
   a script fails to parse, the failure is total and completely silent. The
   student PWA sits on its boot splash forever, because app.js is the only thing
   that removes it. The vendor terminal shows white, because every
   <section class="screen"> ships `hidden` and terminal.js is the only thing that
   unhides one. And nothing is reported: the crash reporter that would have
   posted to /api/client-error lives at the top of the very file that failed to
   parse, so error_logs stays empty and the app looks healthy from our side. A
   vendor stands at a counter with a white iPad and no way to tell us why.

   This file is deliberately the dumbest thing on the page: ES5 only, no
   optional chaining, no arrow functions, no const/let, no template literals, no
   Promise, no fetch. It has to run on a browser too old for the app itself, so
   it must not need anything the app needed. The build lowers it like everything
   else, but there should be nothing left to lower.

   ES5 ONLY. If you edit this, keep it ES5. A modern construct here fails exactly
   where it is needed and nowhere else, so no test and no modern device will
   catch it.

   COPY RULE: no em dashes in user-visible text. See public/student/index.html. */

(function () {
  'use strict';

  /* ---------- flex gap detection ----------
     `gap` inside a flex container is Safari 14.1, and unlike the syntax problems
     this file exists for, it cannot be lowered: below that version every gapped
     flex row in the stylesheets collapses to zero spacing, which on the vendor
     terminal means buttons that touch each other. scripts/build-client.js
     synthesises margin equivalents for those rows behind `.no-flex-gap` on
     <html>, and this is what decides whether to switch them on.

     It has to measure rather than sniff a version, and it runs here because this
     is the only script guaranteed to load first in all three apps. <head> has no
     <body> to append to yet, so the probe goes on <html> - it needs to be in the
     document to get laid out at all. Inline styles only, so it does not depend on
     a stylesheet that may not have arrived. */
  function hasFlexGap() {
    var probe = document.createElement('div');
    probe.style.display = 'flex';
    probe.style.flexDirection = 'column';
    probe.style.rowGap = '1px';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.appendChild(document.createElement('div'));
    probe.appendChild(document.createElement('div'));
    document.documentElement.appendChild(probe);
    // Two zero-height children: the box is 1px tall only if the row gap applied.
    var supported = probe.scrollHeight === 1;
    probe.parentNode.removeChild(probe);
    return supported;
  }

  try {
    if (!hasFlexGap()) {
      document.documentElement.className += (document.documentElement.className ? ' ' : '') + 'no-flex-gap';
    }
  } catch (e) { /* if the probe itself fails, leave the layout alone */ }

  // Set by app.js / terminal.js / admin.js as their first statement. It means
  // "my script parsed and is executing", NOT "the app finished loading" - the
  // question here is only whether the browser could read the file at all.
  var booted = false;
  var firstError = null;
  var shown = false;

  window.__wrBooted = function () { booted = true; };

  // window.onerror, not addEventListener('error'). Both catch a parse failure,
  // but the apps use addEventListener for their own reporter, so taking the
  // onerror slot means the two never fight over the same channel and a runtime
  // error after boot is still reported once, by the app, with its own context.
  var previous = window.onerror;
  window.onerror = function (message, source, line, column, error) {
    if (!firstError) {
      firstError = {
        message: String(message || 'unknown error'),
        source: String(source || ''),
        line: line || 0,
        stack: error && error.stack ? String(error.stack) : '',
      };
    }
    if (previous) { return previous.apply(this, arguments); }
    return false;
  };

  // Which app this is, from the URL rather than a data- attribute or an inline
  // script (the CSP forbids inline scripts, which is why theme-init.js is a file
  // too). Must match the CLIENT_ERROR_SOURCES set in server.js. /scan reports as
  // 'vendor' too — it's the same vendor-facing app, just a second entry point,
  // and reusing the value avoids widening the server-side allowlist for it.
  function appSource() {
    var p = window.location.pathname;
    if (p.indexOf('/terminal') === 0) { return 'vendor'; }
    if (p.indexOf('/scan') === 0) { return 'vendor'; }
    if (p.indexOf('/admin') === 0) { return 'admin'; }
    return 'student';
  }

  // A parse failure and a missing file both leave `booted` false, but they are
  // not the same news for the person holding the device: one means this browser
  // can never run the app, the other means try again. Only claim the former when
  // the browser actually said so.
  function isSyntaxError() {
    if (!firstError) { return false; }
    return /SyntaxError|Unexpected token|Unexpected identifier|Parse error/i.test(firstError.message);
  }

  function report() {
    // XHR, not fetch: fetch is Safari 10.1+ and this has to work below that.
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/client-error', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({
        source: appSource(),
        message: 'boot failed: ' + (firstError ? firstError.message : 'no script ran and no error fired'),
        stack: firstError ? firstError.stack : '',
        url: window.location.href,
        context: {
          reason: isSyntaxError() ? 'unsupported-browser' : 'boot-timeout',
          script: firstError ? firstError.source : '',
          line: firstError ? firstError.line : 0,
          userAgent: navigator.userAgent,
        },
      }));
    } catch (e) { /* the report is a bonus, never the point */ }
  }

  function render() {
    var tooOld = isSyntaxError();

    // Built with DOM calls and inline styles so it owes nothing to styles.css or
    // terminal.css, which may themselves be half-applied on a browser this old.
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'left:0', 'z-index:2147483647',
      'background:#f2f5f9', 'color:#101d33', 'overflow:auto',
      '-webkit-overflow-scrolling:touch',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
    ].join(';');

    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:32rem;margin:0 auto;padding:2.5rem 1.5rem;text-align:left';

    var brand = document.createElement('p');
    brand.style.cssText = 'font-weight:700;letter-spacing:0.12em;font-size:0.85rem;color:#12294b;margin:0 0 1.5rem';
    brand.appendChild(document.createTextNode('WEREWARDS'));

    var h = document.createElement('h1');
    h.style.cssText = 'font-size:1.5rem;line-height:1.25;margin:0 0 0.85rem';
    h.appendChild(document.createTextNode(
      tooOld ? 'This device is too old to run WeRewards' : 'WeRewards did not finish loading'
    ));

    var p = document.createElement('p');
    p.style.cssText = 'font-size:1rem;line-height:1.5;margin:0 0 1.25rem;color:#5a6678';
    p.appendChild(document.createTextNode(tooOld
      ? 'This browser cannot read the app. If this device can be updated, '
        + 'try Settings, then General, then Software Update. Otherwise open '
        + 'we-rewards.com on a newer phone, tablet, or computer.'
      : 'Something stopped the app from starting. Check the connection and try again.'));

    inner.appendChild(brand);
    inner.appendChild(h);
    inner.appendChild(p);

    if (!tooOld) {
      var again = document.createElement('button');
      again.style.cssText = 'font:inherit;font-weight:700;padding:0.8rem 1.4rem;border:none;'
        + 'border-radius:0.6rem;background:#12294b;color:#fff;cursor:pointer';
      again.appendChild(document.createTextNode('Try again'));
      again.onclick = function () { window.location.reload(); };
      inner.appendChild(again);
    }

    // The detail line is for whoever we ask to read it back to us over the phone.
    var detail = document.createElement('p');
    detail.style.cssText = 'margin:2rem 0 0;font-size:0.75rem;color:#8a93a3;word-break:break-word';
    detail.appendChild(document.createTextNode(
      firstError ? (firstError.message + (firstError.line ? ' (line ' + firstError.line + ')' : '')) : 'no error reported'
    ));
    inner.appendChild(detail);

    box.appendChild(inner);

    // Clear the shell first. The student app's splash is a fixed, full-screen
    // sheet at z-index 100 painted straight from the stylesheet, so leaving it
    // in place would put its spinner over this message.
    if (document.body) {
      while (document.body.firstChild) { document.body.removeChild(document.body.firstChild); }
      document.body.appendChild(box);
    }
  }

  function check() {
    if (booted || shown) { return; }
    shown = true;
    render();
    report();
  }

  // `load` fires after every blocking <script> has been fetched and run (or
  // failed to parse), so by then `booted` is settled. The extra beat is slack
  // for a script that defers its own first statement. It also fires on the
  // browsers this targets, which is more than can be said for newer lifecycle
  // events.
  if (window.addEventListener) {
    window.addEventListener('load', function () { window.setTimeout(check, 1200); }, false);
  } else if (window.attachEvent) {
    window.attachEvent('onload', function () { window.setTimeout(check, 1200); });
  }
})();
