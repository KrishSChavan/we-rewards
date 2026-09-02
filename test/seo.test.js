// What this site tells a search engine about itself: robots.txt, the sitemap,
// and the server-rendered public pages (src/lib/seo.js, page-shell.js,
// spots-page.js, content-pages.js).
//
// WHAT IS WORTH LOCKING IN HERE, and it is not "the tags exist". Three things
// can silently destroy search visibility, and none of them shows up in a browser:
//
//   • a `noindex` that escapes onto production, or fails to appear on staging.
//     Both are one typo away and both are invisible until traffic disappears.
//   • a canonical URL built from the request's host, which would have the
//     staging dyno declare itself the canonical copy of every page.
//   • a JSON-LD block broken by the data inside it. Vendor names are
//     user-authored and land inside a <script> element, where a literal
//     `</script` ends the block early and turns the rest into markup. That is
//     both a broken rich result and an XSS.
//
// Runs in the default suite (no DB): everything below is either a pure function
// or a route whose Supabase read is allowed to fail.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { robotsTxt, sitemapXml, absoluteUrl, CANONICAL_ORIGIN, STATIC_SITEMAP_PATHS } from '../src/lib/seo.js';
import { layout, organizationJsonLd, webSiteJsonLd } from '../src/lib/page-shell.js';
import { spotsIndexHtml, spotPageHtml, streetOnly, cuisinePhrase, rewardCost, isIndexable } from '../src/lib/spots-page.js';
import { howItWorksHtml, faqHtml, _FAQ } from '../src/lib/content-pages.js';
import { app } from '../server.js';

/** Every application/ld+json block on a page, parsed. Throws if one is broken. */
function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
}

/** A spot in the shape publicSpots() produces. */
function fixtureSpot(over = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Irvings',
    slug: 'irvings',
    address: '110 E College Ave',
    latitude: 40.7959,
    longitude: -77.8608,
    hasLogo: true,
    cuisine: ['sandwiches', 'coffee'],
    priceLevel: 2,
    punchEnabled: true,
    rewards: [
      { title: 'Free bagel', cost_in_points: 120, emoji: '🥯', active: true },
      { title: 'Free coffee', cost_in_visits: 8, active: true },
    ],
    ...over,
  };
}

/* ================= robots.txt ================= */

describe('robots.txt', () => {
  test('production invites crawlers in and keeps them out of the staff apps', () => {
    const txt = robotsTxt({ isTestEnv: false });
    assert.match(txt, /^User-agent: \*$/m);
    assert.match(txt, /^Allow: \/$/m);
    for (const closed of ['/admin', '/terminal', '/scan', '/api/', '/r/', '/unsubscribe']) {
      assert.match(txt, new RegExp(`^Disallow: ${closed.replace(/\//g, '\\/')}$`, 'm'), `must close ${closed}`);
    }
    // /api/ is closed with no exceptions. There was a carve-out for
    // /api/vendor-logo/ while the spot pages showed vendor artwork; they no
    // longer do (see the licence note in src/lib/spots-page.js), so it is gone.
    assert.ok(!/vendor-logo/.test(txt), 'nothing public needs to reach /api any more');
    assert.match(txt, /^Sitemap: https:\/\/we-rewards\.com\/sitemap\.xml$/m);
    // The whole point of the production file is that it does NOT say this.
    assert.ok(!/^Disallow: \/$/m.test(txt), 'production must never disallow the whole site');
  });

  test('a test deployment stays crawlable so its noindex header can be read', () => {
    // Deliberately NOT `Disallow: /`. That would stop the fetch, and the
    // X-Robots-Tag: noindex header is inside the response the fetch would have
    // returned, so a linked staging URL would end up indexed as a bare address
    // instead of not indexed at all.
    const txt = robotsTxt({ isTestEnv: true });
    assert.match(txt, /^Allow: \/$/m);
    assert.ok(!/^Disallow: \/$/m.test(txt), 'blocking the crawl hides the noindex header');
    assert.ok(!/Sitemap:/.test(txt), 'there is nothing on a test deployment to submit');
  });
});

/* ================= sitemap ================= */

describe('sitemap.xml', () => {
  test('is a well-formed urlset of absolute production URLs', () => {
    const xml = sitemapXml(STATIC_SITEMAP_PATHS);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    // The namespace is load-bearing: a urlset on any other one is ignored.
    assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
    for (const p of STATIC_SITEMAP_PATHS) {
      assert.ok(xml.includes(`<loc>https://we-rewards.com${p}</loc>`), `must list ${p}`);
    }
    // Relative locs are invalid, and a host that is not production would hand
    // the sitemap to the wrong site entirely.
    assert.ok(!/<loc>\/[^<]*<\/loc>/.test(xml), 'every loc must be absolute');
    assert.ok(!/herokuapp/.test(xml));
  });

  test('a slug carrying XML metacharacters cannot break the document', () => {
    const xml = sitemapXml(['/spots/a&b<c>']);
    assert.ok(xml.includes('&amp;'), 'ampersand must be escaped');
    assert.ok(!/<loc>[^<]*<c>/.test(xml), 'a raw < must never reach the document');
  });

  test('every static path in the sitemap is a route this app actually serves', async () => {
    // A sitemap advertising a 404 is worse than one that omits the page: it is
    // the single clearest "this site is unmaintained" signal Search Console
    // reports. Legal docs are skipped, they are files on disk.
    const listener = app.listen(0);
    try {
      const port = listener.address().port;
      for (const p of STATIC_SITEMAP_PATHS.filter((x) => !x.startsWith('/legal/') && x !== '/spots')) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        assert.equal(res.status, 200, `${p} is in the sitemap but answered ${res.status}`);
      }
    } finally {
      listener.close();
    }
  });
});

/* ================= the served crawler routes ================= */

describe('crawler routes', () => {
  async function get(pathname) {
    const listener = app.listen(0);
    try {
      const port = listener.address().port;
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return { status: res.status, headers: res.headers, body: await res.text() };
    } finally {
      listener.close();
    }
  }

  test('/robots.txt is served as plain text', async () => {
    const res = await get('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(res.body, /^User-agent: \*$/m);
  });

  test('/sitemap.xml answers 200 even when the vendor read fails', async () => {
    // There is no database in this suite, so the vendor section cannot load.
    // That must degrade to the static list, never to a 500: an error here is
    // the one response that makes Google drop the sitemap entirely.
    const res = await get('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/xml/);
    assert.ok(res.body.includes('<loc>https://we-rewards.com/</loc>'));
  });

  test('the staff apps carry a noindex header and the public pages do not', async () => {
    for (const staff of ['/terminal', '/admin', '/scan']) {
      const res = await get(staff);
      assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${staff} must be noindex`);
    }
    for (const open of ['/', '/join', '/faq', '/how-it-works']) {
      const res = await get(open);
      assert.equal(res.headers.get('x-robots-tag'), null, `${open} must stay indexable`);
    }
  });

  test('a test deployment marks EVERY response noindex, the landing page included', async () => {
    // The header middleware reads APP_ENV per request precisely so this is
    // testable without a second process.
    const before = process.env.APP_ENV;
    process.env.APP_ENV = 'staging';
    try {
      const res = await get('/');
      assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
    } finally {
      if (before == null) delete process.env.APP_ENV;
      else process.env.APP_ENV = before;
    }
  });

  test('the spot pages answer 503, not 500, when the catalogue cannot be read', async () => {
    // There is no database in this suite, so this exercises the failure path.
    // 503 plus Retry-After tells a crawler the site is briefly unwell and the
    // URL should be kept; a 500 on an indexed page counts against the site and
    // eventually drops it. A 200 with an empty list would be worse still, since
    // a truthful-looking empty directory would replace a good page in the index.
    for (const p of ['/spots', '/spots/definitely-not-a-real-vendor']) {
      const res = await get(p);
      assert.equal(res.status, 503, `${p} must be 503 while the catalogue is down`);
      assert.equal(res.headers.get('retry-after'), '120');
      assert.match(res.headers.get('cache-control'), /no-store/);
    }
  });
});

/* ================= the page shell ================= */

describe('page shell', () => {
  test('canonical and og:url agree, are absolute, and point at production', () => {
    const html = layout({ path: '/faq', title: 'T', description: 'D', body: '<p>x</p>', jsonLd: null });
    assert.ok(html.includes('<link rel="canonical" href="https://we-rewards.com/faq" />'));
    assert.ok(html.includes('<meta property="og:url" content="https://we-rewards.com/faq" />'));
    assert.equal(CANONICAL_ORIGIN, 'https://we-rewards.com');
    assert.equal(absoluteUrl('/faq'), 'https://we-rewards.com/faq');
    assert.equal(absoluteUrl('faq'), 'https://we-rewards.com/faq', 'a missing leading slash must not produce a bad URL');
  });

  test('a public page carries no robots meta, and noindex is opt-in', () => {
    const open = layout({ path: '/x', title: 'T', description: 'D', body: '', jsonLd: null });
    assert.ok(!/name="robots"/.test(open), 'a page that should rank must not ship a robots meta');
    const closed = layout({ path: '/x', title: 'T', description: 'D', body: '', jsonLd: null, noindex: true });
    assert.match(closed, /<meta name="robots" content="noindex, follow" \/>/);
  });

  test('the share card is declared with its real dimensions', () => {
    const html = layout({ path: '/', title: 'T', description: 'D', body: '', jsonLd: null });
    assert.ok(html.includes('content="https://we-rewards.com/icons/og-image.png"'));
    assert.ok(html.includes('<meta property="og:image:width" content="1200" />'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image" />'));
  });

  test('the organization node claims every spelling of the brand', () => {
    // This is the single most load-bearing assertion in the file. The brand is
    // written as one word everywhere and searched for as two, and this node is
    // the only thing that says they are the same entity.
    const org = organizationJsonLd();
    assert.equal(org.name, 'WeRewards');
    assert.ok(org.alternateName.includes('We Rewards'), 'the two-word spelling is the query to win');
    assert.ok(org.alternateName.includes('we-rewards'));
    assert.equal(org.url, 'https://we-rewards.com/');
    assert.ok(Array.isArray(org.sameAs), 'sameAs must be an array even when no profiles are configured');
    assert.equal(webSiteJsonLd().publisher['@id'], org['@id'], 'the site must point at the org node');
  });
});

/* ================= vendor-authored data in a crawler document ================= */

describe('untrusted vendor text', () => {
  const hostile = fixtureSpot({
    name: '</script><img src=x onerror=alert(1)> & "Co"',
    slug: 'hostile',
    rewards: [{ title: '</script> free <b>fries</b>', cost_in_points: 50, active: true }],
  });

  test('a business name cannot close the JSON-LD block it sits in', () => {
    for (const html of [spotsIndexHtml([hostile]), spotPageHtml(hostile)]) {
      assert.ok(!html.includes('</script><img'), 'the ld+json block was broken out of');
      // And it must still be VALID structured data, not merely safe.
      const blocks = jsonLdBlocks(html);
      assert.ok(blocks.length > 0);
      const found = JSON.stringify(blocks);
      assert.ok(found.includes('onerror'), 'the name should survive as data, just not as markup');
    }
  });

  test('a business name cannot inject markup into the visible page', () => {
    const html = spotPageHtml(hostile);
    assert.ok(!/<img src=x onerror/.test(html), 'raw markup reached the document');
    assert.ok(html.includes('&lt;/script&gt;'), 'the name must appear escaped');
  });

  test('the title and meta description are attribute-safe', () => {
    const html = spotPageHtml(fixtureSpot({ name: 'Ye "Olde" <Cafe>' }));
    const desc = html.match(/name="description" content="([^"]*)"/);
    assert.ok(desc, 'the description attribute was terminated early by a quote in the name');
    assert.ok(!desc[1].includes('"'));
  });
});

/* ================= the spot pages ================= */

describe('spot pages', () => {
  test('a spot page carries a LocalBusiness with a real postal address', () => {
    const [business] = jsonLdBlocks(spotPageHtml(fixtureSpot()));
    assert.equal(business['@type'], 'Restaurant', 'a vendor with cuisine tags is a Restaurant');
    assert.equal(business.name, 'Irvings');
    assert.equal(business.address['@type'], 'PostalAddress');
    assert.equal(business.address.addressLocality, 'State College');
    assert.equal(business.address.addressRegion, 'PA');
    assert.deepEqual(business.geo, { '@type': 'GeoCoordinates', latitude: 40.7959, longitude: -77.8608 });
    assert.deepEqual(business.servesCuisine, ['Sandwiches', 'Coffee']);
    assert.equal(business.priceRange, '$$');
    assert.equal(business.makesOffer.length, 2);
    assert.equal(business.makesOffer[0].description, '120 points');
  });

  test('a vendor logo is never published, in the markup or the structured data', () => {
    // legal/vendor-standard-agreement.html licenses the logo "solely for
    // identifying the Vendor within the WeRewards app". These pages are built to
    // be indexed and unfurled, which is not obviously inside that grant, so the
    // artwork stays in the app. Restoring it is a licence change first.
    const spot = fixtureSpot({ hasLogo: true });
    for (const html of [spotsIndexHtml([spot]), spotPageHtml(spot)]) {
      assert.ok(!html.includes('/api/vendor-logo/'), 'a vendor logo URL reached a public page');
    }
    const [business] = jsonLdBlocks(spotPageHtml(spot));
    assert.ok(!('image' in business), 'the logo must not ride along as an ImageObject either');
  });

  test('a spot with no rewards yet is served but kept out of the index', () => {
    // Thin content drags the whole /spots section down, but a 404 would break a
    // real URL for a real business mid-setup. noindex, follow is the middle.
    const bare = fixtureSpot({ rewards: [] });
    assert.equal(isIndexable(bare), false);
    assert.equal(isIndexable(fixtureSpot()), true);
    assert.match(spotPageHtml(bare), /<meta name="robots" content="noindex, follow" \/>/);
    assert.ok(!/name="robots"/.test(spotPageHtml(fixtureSpot())), 'a complete spot must stay indexable');
  });

  test('a vendor with no cuisine is a LocalBusiness and claims no cuisine', () => {
    const [business] = jsonLdBlocks(spotPageHtml(fixtureSpot({ cuisine: [], priceLevel: null })));
    assert.equal(business['@type'], 'LocalBusiness');
    assert.ok(!('servesCuisine' in business));
    assert.ok(!('priceRange' in business));
  });

  test('a spot with no address claims no address rather than an empty one', () => {
    const [business] = jsonLdBlocks(spotPageHtml(fixtureSpot({ address: '', latitude: null, longitude: null })));
    assert.ok(!('address' in business), 'an empty PostalAddress is worse than none');
    assert.ok(!('geo' in business));
  });

  test('the index links every spot and counts them honestly', () => {
    const spots = [fixtureSpot(), fixtureSpot({ name: 'Bagel Crust', slug: 'bagel-crust', id: '2' })];
    const html = spotsIndexHtml(spots);
    assert.match(html, /<title>2 local spots on WeRewards near Penn State<\/title>/);
    for (const s of spots) assert.ok(html.includes(`href="/spots/${s.slug}"`), `must link ${s.slug}`);
    const list = jsonLdBlocks(html).find((b) => b['@type'] === 'ItemList');
    assert.equal(list.numberOfItems, 2);
    // The renderer preserves the order it is handed and does not re-sort;
    // publicSpots() is the one place that decides the order (alphabetical).
    assert.deepEqual(
      list.itemListElement.map((e) => e.url),
      ['https://we-rewards.com/spots/irvings', 'https://we-rewards.com/spots/bagel-crust'],
    );
    assert.deepEqual(list.itemListElement.map((e) => e.position), [1, 2]);
  });

  test('an empty directory says so instead of rendering a bare heading', () => {
    const html = spotsIndexHtml([]);
    assert.ok(html.includes('being set up right now'));
    assert.ok(html.includes('href="/join"'));
    assert.equal(jsonLdBlocks(html).find((b) => b['@type'] === 'ItemList').numberOfItems, 0);
  });

  test('a duplicated town is stripped out of the street address', () => {
    assert.equal(streetOnly('110 E College Ave, State College, PA 16801'), '110 E College Ave');
    assert.equal(streetOnly('129 S Pugh St, State College PA'), '129 S Pugh St');
    assert.equal(streetOnly('129 S Pugh St'), '129 S Pugh St', 'a plain street address is untouched');
    assert.equal(streetOnly('State College, PA'), 'State College, PA', 'stripping everything returns the original');
    assert.equal(streetOnly(null), '');
  });

  test('cuisine tags read as a sentence, not a list dump', () => {
    assert.equal(cuisinePhrase([]), 'local spot');
    assert.equal(cuisinePhrase(['coffee']), 'coffee spot');
    assert.equal(cuisinePhrase(['sandwiches', 'coffee']), 'sandwiches and coffee spot');
    assert.equal(cuisinePhrase(['pizza', 'burgers', 'coffee']), 'pizza, burgers and coffee spot');
  });

  test('a reward is priced in whichever currency it uses, singular included', () => {
    assert.equal(rewardCost({ cost_in_points: 1 }), '1 point');
    assert.equal(rewardCost({ cost_in_points: 250 }), '250 points');
    assert.equal(rewardCost({ cost_in_visits: 1 }), '1 visit');
    assert.equal(rewardCost({ cost_in_visits: 8, cost_in_points: 99 }), '8 visits', 'visits win when both are set');
  });
});

/* ================= the evergreen pages ================= */

describe('content pages', () => {
  test('how-it-works is a complete, self-describing document', () => {
    const html = howItWorksHtml();
    assert.match(html, /<title>How WeRewards works \| Earn points at Penn State spots<\/title>/);
    assert.ok(html.includes('<link rel="canonical" href="https://we-rewards.com/how-it-works" />'));
    const types = jsonLdBlocks(html).map((b) => b['@type']);
    assert.ok(types.includes('HowTo'));
    assert.ok(types.includes('Organization'));
    // The pages that exist only to be found must link to the pages that convert.
    assert.ok(html.includes('href="/spots"') && html.includes('href="/join"'));
  });

  test('every FAQ answer in the markup is answered on the visible page', () => {
    // Google requires the structured data to match what a visitor can read, and
    // building both from one array is the only way to guarantee that stays true.
    const html = faqHtml();
    const faq = jsonLdBlocks(html).find((b) => b['@type'] === 'FAQPage');
    assert.equal(faq.mainEntity.length, _FAQ.length);
    for (const entry of faq.mainEntity) {
      assert.equal(entry['@type'], 'Question');
      assert.ok(entry.acceptedAnswer.text.length > 40, 'a one-line answer is not worth marking up');
      // The visible copy is HTML-escaped, so compare on a distinctive slice.
      const probe = entry.acceptedAnswer.text.slice(0, 30);
      assert.ok(html.includes(probe), `the answer to "${entry.name}" is marked up but not shown`);
    }
  });

  test('the FAQ answers the brand question in the words people type', () => {
    const html = faqHtml();
    assert.ok(html.includes('We Rewards'), 'the two-word spelling must appear in readable copy');
    assert.ok(/Penn State/.test(html) && /State College/.test(html));
  });
});

/* ================= the hand-authored shells ================= */

describe('the static app shells', () => {
  // These four files are edited by hand, so the assertions are about the tags
  // being present and consistent rather than about how they were produced.
  const read = async (p) => (await import('node:fs')).readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

  test('the landing page is indexable, canonical, and shareable', async () => {
    const html = await read('student/index.html');
    assert.ok(html.includes('<link rel="canonical" href="https://we-rewards.com/" />'));
    assert.ok(html.includes('property="og:image" content="https://we-rewards.com/icons/og-image.png"'));
    // The rule is not "no robots meta", it is "never noindex". The tag that IS
    // here opts into a large image preview and an uncapped snippet.
    assert.ok(!/noindex/.test(html), 'the landing page must never be noindex');
    assert.match(html, /name="robots" content="index, follow, max-image-preview:large, max-snippet:-1"/);
    const org = jsonLdBlocks(html)[0]['@graph'].find((n) => n['@type'] === 'Organization');
    assert.ok(org.alternateName.includes('We Rewards'));
  });

  test('the staff apps are all marked noindex in the markup too', async () => {
    for (const p of ['vendor/index.html', 'admin/index.html', 'scan/index.html']) {
      const html = await read(p);
      assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/, `${p} must be noindex`);
    }
  });

  test('the vendor pitch page is indexable and canonical', async () => {
    const html = await read('join/index.html');
    assert.ok(html.includes('<link rel="canonical" href="https://we-rewards.com/join" />'));
    assert.ok(!/noindex/.test(html), 'the vendor pitch page must never be noindex');
    assert.match(html, /name="robots" content="index, follow, max-image-preview:large, max-snippet:-1"/);
    assert.doesNotThrow(() => jsonLdBlocks(html), 'the ld+json block must parse');
  });

  test('the share card exists at the size the tags promise', async () => {
    const fs = await import('node:fs');
    const file = new URL('../public/student/icons/og-image.png', import.meta.url);
    assert.ok(fs.existsSync(file), 'og-image.png is referenced by every page and must exist');
    // PNG header: width and height are big-endian uint32 at bytes 16 and 20.
    const buf = fs.readFileSync(file);
    assert.equal(buf.readUInt32BE(16), 1200);
    assert.equal(buf.readUInt32BE(20), 630);
  });
});
