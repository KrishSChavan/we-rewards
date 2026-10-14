/**
 * The page a phone lands on after tapping an NFC tag: GET /t (a generic campus
 * tag) and GET /t/<vendor> (a tag on one counter). src/routes/tap.js decides
 * what the tag resolves to; this file only draws the result.
 *
 * WHY A PAGE AND NOT A REDIRECT. An installed app never sees this document:
 * iOS hands the URL to the native app (Universal Links, declared by the
 * apple-app-site-association route in server.js) and Android Chrome bounces
 * into the installed PWA on its own. Everyone else is a person who has not
 * installed anything, holding a phone they just tapped on a counter, and the
 * one thing worth doing with that moment is offering the install. A bare
 * redirect into the web app would spend it.
 *
 * NO COOKIE AND NO "REMEMBER MY CHOICE": the owner's decision is that this
 * screen shows on every tap. Both buttons lead into the student app at `dest`
 * (already resolved to /?spot=<id>, or / for a generic tag); the primary one
 * adds install=1 so the app opens its add-to-home-screen guide, and /tap.js
 * (public/student/tap.js) swaps that for the App Store listing on an iPhone
 * once `data-store` carries one.
 *
 * COPY RULE: no em dashes in anything a visitor reads. Comments are exempt.
 */

import { layout, escapeHtml } from './page-shell.js';

/**
 * Only what the shell's STYLES do not already cover: `.cta` and `.lede` are
 * reused, this makes the button full width and stacks the web link under it.
 * Inline because style-src carries 'unsafe-inline' for exactly these pages,
 * and a stylesheet fetch would stand between the tap and the first paint.
 */
const STYLES = `
.tap { max-width: 480px; }
.tap-kicker {
  margin: 0; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
}
.tap .cta { display: block; text-align: center; margin-top: 26px; padding: 15px 22px; font-size: 1.05rem; }
.tap-web {
  display: block; text-align: center; margin-top: 12px; padding: 12px;
  font-weight: 700; color: var(--navy);
}
@media (prefers-color-scheme: dark) { .tap-web { color: var(--accent); } }
`;

/**
 * @param {object} opts
 * @param {{ name: string, slug: string } | null} opts.spot  the resolved vendor, or null for the generic page
 * @param {string} opts.dest         where "Continue on the web" goes, e.g. /?spot=<id>
 * @param {string} opts.installDest  the same, plus install=1
 * @param {string} opts.storeUrl     the App Store listing, or '' until there is one
 */
export function tapPageHtml({ spot, dest, installDest, storeUrl }) {
  const name = spot ? spot.name : 'WeRewards';
  const lede = spot
    ? 'Earn points and free food here with WeRewards. Free for Penn State students.'
    : 'Earn points and free food at local spots with WeRewards. Free for Penn State students.';

  // Every attribute value is escaped: dest carries '&' once install=1 is on
  // it, and the vendor name is vendor-authored.
  const body = `    <style>${STYLES}</style>
    <section class="tap" id="tap" data-dest="${escapeHtml(dest)}" data-install="${escapeHtml(installDest)}" data-store="${escapeHtml(storeUrl || '')}">
      <p class="tap-kicker">You tapped a WeRewards tag</p>
      <h1>${escapeHtml(name)}</h1>
      <p class="lede">${lede}</p>
      <a id="tap-app" class="cta" href="${escapeHtml(installDest)}">Get the app</a>
      <a id="tap-web" class="tap-web" href="${escapeHtml(dest)}">Continue on the web</a>
    </section>`;

  // No jsonLd: the page is noindex, so structured data would buy nothing, and
  // keeping /tap.js the only <script> here is what the CSP note in
  // page-shell.js promises.
  return layout({
    path: spot ? `/t/${spot.slug}` : '/t',
    title: spot ? `${spot.name} on WeRewards` : 'WeRewards',
    description: lede,
    body,
    noindex: true,
    scripts: ['/tap.js'],
  });
}
