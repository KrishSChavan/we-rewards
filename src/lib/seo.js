/**
 * Everything this site tells a SEARCH ENGINE about itself, in one module.
 *
 * WHY IT EXISTS AT ALL. Five apps share one origin here, and only two of them
 * are meant to be found: the student landing page at `/` and the vendor pitch at
 * `/join`. The other three (`/terminal`, `/admin`, `/scan`) are login walls that
 * a crawler can reach, index, and then show to somebody searching for the brand
 * — "WeRewards Admin" as the first result is worse than no result. So the rules
 * about who may crawl what are a real piece of application behaviour, not a
 * static file somebody drops in a folder, and they belong next to the code that
 * knows which mounts exist.
 *
 * THE OTHER HALF IS THE STAGING DYNO. `we-rewards-staging-….herokuapp.com` runs
 * byte-identical code from the same repo and is publicly reachable. Indexed, it
 * is a duplicate of the whole site under a URL nobody should ever land on, and
 * Google gets to pick which copy is canonical. The fix is NOT `Disallow: /`
 * there, which is the tempting wrong answer: robots.txt governs the FETCH, and
 * the `X-Robots-Tag: noindex` header server.js sets on that deployment lives
 * inside the response the fetch would have returned. Block the crawl and the
 * instruction is never read, while a staging URL somebody pasted stays eligible
 * for indexing anyway and gets listed as a bare address. So robotsTxt() takes
 * the deployment as an argument and lets crawlers IN on staging, precisely so
 * they can read the header that tells them to keep nothing.
 *
 * ORIGIN. Everything a crawler consumes has to be an ABSOLUTE url (sitemaps
 * require it, `og:image` requires it, and a `rel=canonical` that is relative is
 * legal but pointless — it would resolve against whatever host served it, which
 * is exactly the staging-duplicate problem again). CANONICAL_ORIGIN is that host,
 * and it defaults to production rather than to the request's own host on
 * purpose: a canonical tag served BY staging that points AT production is the
 * correct answer, and deriving it from the request would instead have staging
 * declare itself canonical.
 */

/**
 * The one true public origin, no trailing slash.
 *
 * NOT `APP_ORIGIN`, and the two must never be merged. APP_ORIGIN is "the origin
 * THIS deployment is reached at", which is what email links and printed QR codes
 * need, and on the staging dyno it is correctly set to the herokuapp address.
 * This one is "the origin the site is canonically published at", which is the
 * same string on every deployment by definition. Point the canonical tags at
 * APP_ORIGIN and staging starts declaring itself the canonical copy of every
 * page, which is the exact duplicate-content problem this module exists to
 * prevent. Different meanings, different variables.
 *
 * Overridable by env so a fork, a rename, or a pre-launch preview can set its
 * own without editing code. Anything malformed falls back rather than throwing:
 * a typo'd env var must not take the site down at boot, it must only cost the
 * canonical tags.
 */
const DEFAULT_ORIGIN = 'https://we-rewards.com';
export const CANONICAL_ORIGIN = (() => {
  const raw = (process.env.CANONICAL_ORIGIN || '').trim();
  if (!raw) return DEFAULT_ORIGIN;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_ORIGIN;
    return u.origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
})();

/** Absolute URL for a site-root-relative path. `absoluteUrl('/join')`. */
export function absoluteUrl(pathname = '/') {
  const p = String(pathname || '/');
  return `${CANONICAL_ORIGIN}${p.startsWith('/') ? p : `/${p}`}`;
}

/**
 * The paths a crawler must never spend its budget on.
 *
 * `/r/` is not a privacy matter like the others: those are the tracked poster
 * QR codes, and every fetch of one is RECORDED AS A SCAN (src/routes/tracked-qr.js).
 * A crawler walking them would write bot traffic into the numbers a vendor uses
 * to decide whether their poster is working.
 */
const DISALLOWED = [
  '/admin',
  '/terminal',
  '/scan',
  '/api/',
  '/r/',
  '/unsubscribe',
];

/**
 * robots.txt, as a string.
 *
 * One `User-agent: *` group and nothing else, deliberately. A per-crawler group
 * (an `Applebot:` section, say) REPLACES the wildcard for that crawler rather
 * than adding to it, so every such block has to restate the whole disallow list
 * and is one edit away from silently letting Applebot into /admin. Applebot,
 * Bingbot, DuckDuckBot and the AI crawlers all honour the wildcard, and every
 * one of them is welcome on the two public pages.
 *
 * @param {object} opts
 * @param {boolean} opts.isTestEnv  true on any deployment that is not production
 */
export function robotsTxt({ isTestEnv = false } = {}) {
  if (isTestEnv) {
    // A test deployment stays CRAWLABLE, which looks backwards and is not.
    //
    // `Disallow: /` stops the FETCH, and the `X-Robots-Tag: noindex` header
    // server.js sets on this deployment is inside the response that fetch would
    // have returned. Block the crawl and the instruction never gets read, while
    // a URL somebody has linked or pasted stays eligible for indexing anyway,
    // listed as a bare address with no title and no description. That is the
    // exact outcome this is trying to avoid, arrived at by the more obvious
    // looking route.
    //
    // So: let the crawler in, and let it read the header that tells it to keep
    // nothing. No `Sitemap:` line, because there is nothing here to submit.
    return [
      '# Test deployment. The real site is https://we-rewards.com',
      '# Crawlable on purpose: every response here carries X-Robots-Tag: noindex,',
      '# and a crawler has to be allowed in to read it.',
      'User-agent: *',
      'Allow: /',
      '',
    ].join('\n');
  }

  return [
    '# WeRewards (We Rewards) - points at local spots around Penn State.',
    `# ${CANONICAL_ORIGIN}`,
    '',
    'User-agent: *',
    'Allow: /',
    ...DISALLOWED.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
    '',
  ].join('\n');
}

/** XML text escaping. Sitemaps carry vendor-authored names; those are not trusted. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A urlset sitemap from site-root-relative paths.
 *
 * No `<lastmod>`, `<changefreq>` or `<priority>`: Google ignores the last two
 * outright, and a `lastmod` it decides is untrustworthy (every URL stamped with
 * the deploy time, which is what this app could honestly produce) gets the whole
 * signal discarded. An accurate small sitemap beats a decorated one.
 */
export function sitemapXml(paths) {
  const urls = paths
    .map((p) => `  <url><loc>${escapeXml(absoluteUrl(p))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * The pages that exist regardless of how many vendors have signed up.
 *
 * `/legal/*` is included on purpose even though nobody searches for a terms of
 * service: they are real, permanent, publicly reachable pages, and an
 * "organisation that publishes its terms" is one of the small signals that
 * separates a real business from a parked domain.
 */
export const STATIC_SITEMAP_PATHS = [
  '/',
  '/how-it-works',
  '/faq',
  '/spots',
  '/join',
  '/legal/student-terms-of-service.html',
  '/legal/student-privacy-policy.html',
];
