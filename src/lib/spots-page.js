/**
 * The PUBLIC, server-rendered partner pages: `/spots` and `/spots/<slug>`.
 *
 * WHY THESE EXIST. Until now every word on this site a search engine could read
 * lived on two pages: the landing hero at `/` and the vendor pitch at `/join`.
 * Everything else sits behind a Google sign-in, which a crawler cannot pass.
 * That is a hard ceiling on what the site can ever rank for: with no page that
 * names a single local business, it cannot answer "does <the coffee place on
 * Pugh> have a rewards card", which is the question a student actually types.
 * These pages give every partner a real URL carrying its real name, its address
 * and what its points buy.
 *
 * WHY RENDERED HERE AND NOT IN THE PWA. Googlebot runs JavaScript but will not
 * sign in, so anything the student app draws after `/api/me/balances` is
 * invisible to it forever. These are plain documents built on the server from
 * the SAME cached catalogue the app reads, so they need no session and add no
 * second source of truth.
 *
 * WHAT IS PUBLISHED. Business name, address, cuisine tags, and the reward menu.
 * Every one of those is already shown to any student who opens the app, and a
 * partner signs up precisely in order to be found. No contact details, no owner
 * name, no per-vendor numbers.
 *
 * AND DELIBERATELY NOT THE VENDOR'S LOGO. legal/vendor-standard-agreement.html
 * grants a licence to display it "solely for identifying the Vendor within the
 * WeRewards app", and the founding agreement says "within the WeRewards app and
 * platform". A page built to be indexed by Google and unfurled in a group chat
 * is not obviously inside either grant, and a logo is the one field here that is
 * somebody else's intellectual property rather than a fact about their business.
 * Names, addresses and reward menus are not made confidential by either
 * agreement, so those ship. Putting logos back is a licence question first and a
 * code change second: widen the grant at the next agreement revision, or add an
 * opt-in column, and only then restore the <img> and the ImageObject.
 *
 * `contact_name` and `phone` are likewise never rendered. They are not even in
 * the catalogue's select list (migration-049 marks both operator-facing only),
 * which is the structural guard rather than this comment.
 *
 * COPY RULE: no em dashes in anything a visitor reads. Comments are exempt.
 */

import { loadVendorCatalogue } from './cache.js';
import { CUISINES } from './cuisines.js';
import { CANONICAL_ORIGIN, absoluteUrl } from './seo.js';
import {
  layout, escapeHtml, organizationJsonLd, breadcrumbJsonLd, LOCALITY, REGION, COUNTRY,
} from './page-shell.js';

/** cuisine slug -> the label the pickers show. An unknown tag renders as-is. */
const CUISINE_LABEL = new Map(CUISINES.map((c) => [c.value, c.label]));
export function cuisineLabel(value) {
  return CUISINE_LABEL.get(value) || String(value ?? '').replace(/-/g, ' ');
}

/**
 * Strip a trailing town/state/zip from a vendor-typed address.
 *
 * The form asks for a street address and the student card shows one, but people
 * type what they like, so a fair share arrive as "129 S Pugh St, State College,
 * PA 16801". Left alone that duplicates the locality this module is about to
 * add, and a PostalAddress whose streetAddress repeats the city reads as a
 * different place to a parser. Anything that does not match is returned
 * untouched, which is the safe direction to fail.
 */
export function streetOnly(address) {
  const text = String(address ?? '').trim();
  if (!text) return '';
  const trimmed = text
    .replace(/,?\s*state\s+college\s*,?\s*(pa|pennsylvania)?\s*,?\s*\d{0,5}(-\d{4})?\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
  return trimmed || text;
}

/**
 * Cuisine tags as a phrase a sentence can contain: "coffee spot",
 * "sandwiches and coffee spot", "pizza, wings and subs spot".
 *
 * Worth the few lines. The description these feed is the snippet under a search
 * result, and "a sandwiches, coffee in State College" is the kind of sentence
 * that reads as machine-generated to a person deciding which result to click.
 */
export function cuisinePhrase(cuisines) {
  const labels = cuisines.map((c) => cuisineLabel(c).toLowerCase());
  if (!labels.length) return 'local spot';
  if (labels.length === 1) return `${labels[0]} spot`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} spot`;
}

/** "250 points" / "8 visits", the way the app prices a reward. */
export function rewardCost(reward) {
  if (reward.cost_in_visits > 0) {
    return `${reward.cost_in_visits} ${reward.cost_in_visits === 1 ? 'visit' : 'visits'}`;
  }
  const pts = reward.cost_in_points ?? 0;
  return `${pts} ${pts === 1 ? 'point' : 'points'}`;
}

/**
 * Active spots in the shape these pages render.
 *
 * Alphabetical rather than the catalogue's newest-first: a directory is read by
 * eye, and "which of these do I know" is answered faster by name than by signup
 * date. A vendor with no slug is skipped rather than linked, because a page that
 * 404s from its own index is a worse failure than a spot missing for one cache
 * turn (the column is `not null unique`, so this should never fire).
 */
export async function publicSpots() {
  const vendors = await loadVendorCatalogue();
  return vendors
    .filter((v) => v && v.slug && v.name)
    .map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      address: streetOnly(v.address),
      latitude: v.latitude,
      longitude: v.longitude,
      hasLogo: Boolean(v.has_logo),
      cuisine: Array.isArray(v.cuisine) ? v.cuisine : [],
      priceLevel: v.price_level ?? null,
      punchEnabled: Boolean(v.punch_enabled),
      rewards: (Array.isArray(v.rewards) ? v.rewards : [])
        .filter((r) => r && r.active && r.title)
        .sort((a, b) => (a.cost_in_points ?? 0) - (b.cost_in_points ?? 0)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** One spot by slug, or null. Off the same cached catalogue as the index. */
export async function publicSpot(slug) {
  const spots = await publicSpots();
  return spots.find((s) => s.slug === slug) || null;
}

/**
 * One spot as a LocalBusiness.
 *
 * `Restaurant` when the vendor has tagged a cuisine, `LocalBusiness` otherwise.
 * Every partner is an eatery by the product's own definition, but a Restaurant
 * node with no `servesCuisine` says less than a correctly typed generic one, and
 * a wrong specific type is the kind of thing that gets structured data ignored
 * wholesale.
 */
function spotJsonLd(spot) {
  const isRestaurant = spot.cuisine.length > 0;
  const node = {
    '@context': 'https://schema.org',
    '@type': isRestaurant ? 'Restaurant' : 'LocalBusiness',
    '@id': `${CANONICAL_ORIGIN}/spots/${spot.slug}#business`,
    name: spot.name,
    url: absoluteUrl(`/spots/${spot.slug}`),
  };
  if (spot.address) {
    node.address = {
      '@type': 'PostalAddress',
      streetAddress: spot.address,
      addressLocality: LOCALITY,
      addressRegion: REGION,
      addressCountry: COUNTRY,
    };
  }
  if (typeof spot.latitude === 'number' && typeof spot.longitude === 'number') {
    node.geo = { '@type': 'GeoCoordinates', latitude: spot.latitude, longitude: spot.longitude };
  }
  if (isRestaurant) node.servesCuisine = spot.cuisine.map(cuisineLabel);
  if (spot.priceLevel > 0) node.priceRange = '$'.repeat(Math.min(4, spot.priceLevel));
  // The reward menu is the one thing this page knows that no other listing of
  // this business does. Offers is the honest schema for it: each is something a
  // customer can obtain here, priced in points rather than dollars.
  if (spot.rewards.length) {
    node.makesOffer = spot.rewards.map((r) => ({
      '@type': 'Offer',
      name: r.title,
      description: rewardCost(r),
    }));
  }
  return node;
}

function spotCard(spot) {
  const tags = spot.cuisine.length
    ? `<ul class="tags">${spot.cuisine.map((c) => `<li>${escapeHtml(cuisineLabel(c))}</li>`).join('')}</ul>`
    : '';
  const reward = spot.rewards.length
    ? `<p>Rewards from ${escapeHtml(rewardCost(spot.rewards[0]))}</p>`
    : '';
  return `      <li class="card">
        <h3><a href="/spots/${escapeHtml(spot.slug)}">${escapeHtml(spot.name)}</a></h3>
        ${spot.address ? `<p>${escapeHtml(spot.address)}, ${LOCALITY}, ${REGION}</p>` : ''}
        ${reward}
        ${tags}
      </li>`;
}

/** GET /spots */
export function spotsIndexHtml(spots) {
  const count = spots.length;
  const names = spots.slice(0, 6).map((s) => s.name).join(', ');
  const description = count
    ? `Every local spot around Penn State where you can earn WeRewards points and redeem them for free food. ${count} ${count === 1 ? 'spot' : 'spots'} in State College${names ? `, including ${names}` : ''}.`
    : 'Local spots around Penn State where you can earn WeRewards points and redeem them for free food.';

  const body = count
    ? `    <h1>Spots that reward you in State College</h1>
    <p class="lede">These are the local restaurants, cafes and food spots around Penn State where your We Rewards points add up. Earning is free, and there is no app to download.</p>
    <ul class="grid">
${spots.map(spotCard).join('\n')}
    </ul>
    <a class="cta" href="/">Start earning points</a>`
    : `    <h1>Spots that reward you in State College</h1>
    <p class="lede">The first partner spots are being set up right now. Check back shortly, or tell your favorite place about us.</p>
    <a class="cta" href="/join">Partner with us</a>`;

  return layout({
    path: '/spots',
    title: count
      ? `${count} local spots on WeRewards near Penn State`
      : 'Local spots on WeRewards near Penn State',
    description: description.slice(0, 300),
    body,
    jsonLd: [
      organizationJsonLd(),
      breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Spots', path: '/spots' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'WeRewards partner spots in State College, PA',
        numberOfItems: count,
        itemListElement: spots.map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: absoluteUrl(`/spots/${s.slug}`),
          name: s.name,
        })),
      },
    ],
  });
}

/**
 * Is this page worth being in the index at all?
 *
 * A page whose whole content is a name and a street is thin content, and a
 * directory that publishes dozens of them gets the WHOLE section discounted, not
 * just the empty pages. The bar is one active reward, because that is the thing
 * a searcher came for and the only field here no other listing of this business
 * carries.
 *
 * Deliberately NOT gated on `address`: it is optional at /join
 * (src/routes/apply.js writes `address: address || null` and the form labels it
 * optional), so gating on it would hide real, fully set up vendors.
 *
 * Below the bar the page is still SERVED and still linked, just `noindex,
 * follow`: the app deep link has to keep working, and `follow` means the crawler
 * still walks back out to /spots. A 404 would break a real URL for a real
 * business that simply has not finished setting up.
 */
export function isIndexable(spot) {
  return spot.rewards.length > 0;
}

/** GET /spots/:slug */
export function spotPageHtml(spot) {
  const where = spot.address ? `${spot.address}, ${LOCALITY}, ${REGION}` : `${LOCALITY}, ${REGION}`;
  const cuisines = spot.cuisine.map(cuisineLabel);
  const kind = cuisinePhrase(spot.cuisine);

  const rewards = spot.rewards.length
    ? `    <h2>What your points get you here</h2>
    <ul class="rewards">
${spot.rewards
  .map(
    (r) => `      <li><span>${r.emoji ? `${escapeHtml(r.emoji)} ` : ''}${escapeHtml(r.title)}</span><span class="cost">${escapeHtml(rewardCost(r))}</span></li>`,
  )
  .join('\n')}
    </ul>`
    : `    <h2>Rewards</h2>
    <p class="lede">This spot is setting its rewards up now. Your points keep adding up in the meantime.</p>`;

  const body = `    <p class="crumbs"><a href="/">Home</a> / <a href="/spots">Spots</a></p>
    <h1>${escapeHtml(spot.name)}</h1>
    <p class="lede">Earn points every time you buy at ${escapeHtml(spot.name)} in State College, then trade them for free food. Free for Penn State students, with no app to download.</p>
    <p><strong>Address:</strong> ${escapeHtml(where)}</p>
    ${cuisines.length ? `<ul class="tags">${cuisines.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
${rewards}
    <h2>How it works at ${escapeHtml(spot.name)}</h2>
    <p>Sign in once and a personal QR code appears. Show it when you pay, ${escapeHtml(spot.name)} scans it, and your points land right away. Once you have enough, show the redeem code and say what you are claiming.</p>
    <a class="cta" href="/">Start earning at ${escapeHtml(spot.name)}</a>
    <p class="crumbs"><a href="/spots">See every spot on We Rewards</a></p>`;

  return layout({
    path: `/spots/${spot.slug}`,
    noindex: !isIndexable(spot),
    title: `${spot.name} rewards in State College | WeRewards`,
    description:
      `Earn points at ${spot.name}, a ${kind} in State College, PA, and redeem them for free food with WeRewards. Free for Penn State students.`.slice(0, 300),
    body,
    jsonLd: [
      spotJsonLd(spot),
      breadcrumbJsonLd([
        { name: 'Home', path: '/' },
        { name: 'Spots', path: '/spots' },
        { name: spot.name, path: `/spots/${spot.slug}` },
      ]),
    ],
  });
}
