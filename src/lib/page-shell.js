/**
 * The document shell every server-rendered PUBLIC page shares, and the one place
 * this site's crawler-facing head tags are written.
 *
 * WHO USES IT. src/lib/spots-page.js (the partner directory) and
 * src/lib/content-pages.js (how it works, FAQ). Not the five PWA shells under
 * public/: those are hand-authored files with their own boot scripts, service
 * workers and CSP-sensitive ordering, and rewriting them through a template
 * would buy nothing and risk a lot. Their head tags are maintained in place; the
 * absolute URLs here and the ones there have to agree, which is why both build
 * every URL from CANONICAL_ORIGIN.
 *
 * WHY THE STYLES ARE INLINE. helmet's `style-src` already carries
 * 'unsafe-inline' for the apps, and a document that fetches no stylesheet has
 * nothing blocking its first paint. These pages are read once, by a person who
 * arrived from a search result or by a crawler measuring how fast that happens.
 *
 * WHY THERE IS NO <script>. `script-src 'self'` forbids inline script, and none
 * of these pages needs behaviour. The only <script> emitted is
 * `application/ld+json`, which is a data block a browser never executes and CSP
 * therefore never blocks. That was verified against this exact policy rather
 * than assumed.
 *
 * COPY RULE: no em dashes in anything a visitor reads. Comments are exempt.
 */

import { CANONICAL_ORIGIN, absoluteUrl } from './seo.js';

/** HTML text escaping. Most values passed through here are vendor-authored. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The town every partner is in.
 *
 * Hard-coded because it IS the product's scope (the package describes local
 * eateries around Penn State), and because a PostalAddress with no locality is
 * close to worthless for local search. A second town makes this a column.
 */
export const LOCALITY = 'State College';
export const REGION = 'PA';
export const COUNTRY = 'US';

/** Palette lifted from public/student/styles.css so these match the app, dark mode included. */
const STYLES = `
:root {
  --ink: #101d33; --paper: #f2f5f9; --card: #ffffff; --navy: #12294b;
  --sky: #d7e5f5; --accent: #96bee6; --muted: #5a6678; --edge: #101d33;
  --hairline: #e5eaf2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eef7; --paper: #0f1826; --card: #1c2b45; --navy: #17335c;
    --sky: #cfe1f5; --accent: #96bee6; --muted: #94a3ba; --edge: #35496a;
    --hairline: #2a3a56;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Archivo", system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.55; -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap { max-width: 760px; margin: 0 auto; padding: 0 20px 64px; }
header.site { background: var(--navy); color: #fff; padding: 18px 0; margin-bottom: 28px; }
header.site .wrap { padding-bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.brand { font-weight: 900; font-size: 1.15rem; letter-spacing: 0.04em; text-decoration: none; color: #fff; }
.brand span { color: var(--accent); }
header.site nav a { color: var(--sky); text-decoration: none; font-weight: 700; font-size: 0.9rem; margin-left: 16px; }
header.site nav a:hover { text-decoration: underline; }
h1 { font-size: 2rem; line-height: 1.15; margin: 8px 0 10px; font-weight: 900; }
h2 { font-size: 1.2rem; margin: 34px 0 8px; font-weight: 800; }
h3 { font-size: 1.02rem; margin: 22px 0 4px; font-weight: 800; }
p { margin: 8px 0; }
.lede { color: var(--muted); font-size: 1.05rem; margin: 0 0 8px; max-width: 62ch; }
.crumbs { font-size: 0.85rem; color: var(--muted); margin: 0 0 4px; }
.crumbs a { color: var(--muted); }
.grid { list-style: none; padding: 0; margin: 24px 0 0; display: grid; gap: 14px; }
@media (min-width: 620px) { .grid { grid-template-columns: 1fr 1fr; } }
.card {
  background: var(--card); border: 2px solid var(--edge); border-radius: 16px;
  padding: 16px 18px; box-shadow: 3px 3px 0 var(--edge);
}
.card h3 { margin: 0 0 4px; font-size: 1.05rem; font-weight: 800; }
.card h3 a { text-decoration: none; }
.card h3 a:hover { text-decoration: underline; }
.card p { margin: 2px 0; color: var(--muted); font-size: 0.92rem; }
.steps { counter-reset: step; list-style: none; padding: 0; margin: 20px 0 0; }
.steps li { position: relative; padding: 0 0 18px 46px; }
.steps li::before {
  counter-increment: step; content: counter(step);
  position: absolute; left: 0; top: 0; width: 32px; height: 32px; border-radius: 50%;
  background: var(--navy); color: #fff; font-weight: 900;
  display: flex; align-items: center; justify-content: center;
}
.steps strong { display: block; font-size: 1.02rem; }
.tags { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
.tags li {
  font-size: 0.75rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
  background: var(--sky); color: var(--navy); border-radius: 999px; padding: 3px 10px;
}
.logo { width: 44px; height: 44px; border-radius: 10px; object-fit: contain; background: var(--sky); float: right; margin-left: 12px; }
.rewards { list-style: none; padding: 0; margin: 10px 0 0; }
.rewards li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--hairline); }
.rewards li:last-child { border-bottom: 0; }
.rewards .cost { font-weight: 800; color: var(--navy); white-space: nowrap; }
@media (prefers-color-scheme: dark) { .rewards .cost { color: var(--accent); } }
.cta {
  display: inline-block; margin-top: 22px; background: var(--navy); color: #fff;
  font-weight: 800; text-decoration: none; padding: 13px 22px; border-radius: 12px;
}
footer.site { border-top: 1px solid var(--hairline); margin-top: 48px; padding-top: 20px; font-size: 0.85rem; color: var(--muted); }
footer.site a { color: var(--muted); margin-right: 14px; }
`;

/**
 * One JSON-LD block, escaped for embedding inside an HTML <script> element.
 *
 * NOT decoration. Every node below carries vendor-authored text (a business
 * name, a reward title), and an HTML parser ends a script element at the first
 * literal `</script` in it, no matter that it sits inside a JSON string. A
 * vendor called `</script><img onerror=...>` would otherwise close this block
 * and have the rest of its name parsed as markup. `<` is a legal escape in
 * a JSON string and reads back as the same character, so the structured data is
 * unchanged and the parser never sees a closing tag. `&` goes too, so the text
 * cannot be mangled by entity decoding on the way back in.
 */
function jsonLdScript(node) {
  const json = JSON.stringify(node)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * The full document.
 *
 * `canonical`, `og:url` and every JSON-LD `@id` are ABSOLUTE and built from
 * CANONICAL_ORIGIN, never from the request's host. That is precisely what stops
 * the staging dyno from claiming these pages as its own if it is ever crawled.
 */
export function layout({ path, title, description, body, jsonLd, noindex = false }) {
  const url = absoluteUrl(path);
  const ogImage = absoluteUrl('/icons/og-image.png');
  const blocks = (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
    .filter(Boolean)
    .map(jsonLdScript)
    .join('\n  ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  ${noindex ? '<meta name="robots" content="noindex, follow" />\n  ' : ''}<link rel="canonical" href="${escapeHtml(url)}" />
  <meta name="theme-color" content="#12294b" />
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
  <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  <meta property="og:site_name" content="WeRewards" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(url)}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800;900&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
  ${blocks}
</head>
<body>
  <header class="site">
    <div class="wrap">
      <a class="brand" href="/">WE<span>REWARDS</span></a>
      <nav>
        <a href="/spots">Spots</a>
        <a href="/how-it-works">How it works</a>
        <a href="/faq">FAQ</a>
        <a href="/join">For businesses</a>
      </nav>
    </div>
  </header>
  <main class="wrap">
${body}
  </main>
  <footer class="site">
    <div class="wrap">
      <p>WeRewards (We Rewards) is made in State College for Penn State students and the local spots that feed them.</p>
      <p>
        <a href="/">Home</a><a href="/spots">All spots</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a><a href="/join">Partner with us</a>
      </p>
      <p>
        <a href="/legal/student-terms-of-service.html">Terms of Service</a><a href="/legal/student-privacy-policy.html">Privacy Policy</a>
      </p>
      <p>Questions? contactwerewards@gmail.com</p>
    </div>
  </footer>
</body>
</html>
`;
}

/**
 * The publisher node every page points at rather than restating.
 *
 * `alternateName` carries the two-word spelling deliberately. The brand is
 * written WeRewards throughout the product, the domain is we-rewards.com, and
 * the query this whole effort aims at is "we rewards". Telling Google that the
 * three strings name one entity is the cheapest signal available, and there is
 * no other place in the codebase that says so.
 */
export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${CANONICAL_ORIGIN}/#organization`,
    name: 'WeRewards',
    alternateName: ['We Rewards', 'we-rewards', 'WeRewards Penn State'],
    url: `${CANONICAL_ORIGIN}/`,
    logo: {
      '@type': 'ImageObject',
      url: absoluteUrl('/icons/icon-512.png'),
      width: 512,
      height: 512,
    },
    image: absoluteUrl('/icons/og-image.png'),
    email: 'contactwerewards@gmail.com',
    description:
      'WeRewards is a free rewards program for students at local restaurants, cafes and food spots around Penn State in State College, Pennsylvania.',
    areaServed: { '@type': 'Place', name: 'State College, Pennsylvania' },
    // Filled from SOCIAL_PROFILES (comma separated URLs). Empty until the
    // accounts exist: sameAs is the property Google uses to decide that two
    // names are one entity, so a wrong URL here is worse than no URL.
    sameAs: (process.env.SOCIAL_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** The site node, so "WeRewards" and "We Rewards" resolve to one website. */
export function webSiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${CANONICAL_ORIGIN}/#website`,
    url: `${CANONICAL_ORIGIN}/`,
    name: 'WeRewards',
    alternateName: ['We Rewards', 'we-rewards.com'],
    inLanguage: 'en-US',
    publisher: { '@id': `${CANONICAL_ORIGIN}/#organization` },
  };
}

export function breadcrumbJsonLd(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: absoluteUrl(t.path),
    })),
  };
}

/** A FAQPage node from [{q, a}]. The answers must match the visible copy exactly. */
export function faqJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  };
}
