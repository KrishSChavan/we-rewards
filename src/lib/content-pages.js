/**
 * The two evergreen public pages: `/how-it-works` and `/faq`.
 *
 * WHY THEY ARE SEPARATE PAGES rather than more sections on the landing page.
 * The landing page has one job, which is to get a student to press "Continue
 * with Google", and every paragraph added to it works against that. But the
 * questions below are the ones people actually type ("is we rewards free", "how
 * do you get free food at penn state"), and a query is answered by a PAGE, not
 * by a paragraph two thirds of the way down a different one. Splitting them
 * gives each question a URL that can rank, a title that matches the question,
 * and a place to link out to /spots and /join from.
 *
 * THE ANSWERS MUST STAY TRUE TO THE PRODUCT. Everything asserted here is
 * checked against how the app actually behaves. Two in particular:
 *   • "no app to download" is true because the student side is a PWA served at
 *     `/` and signed into with Google (public/student/index.html).
 *   • points are per vendor (`point_balances` is keyed on user AND vendor), with
 *     a shared community pool as the exception (migration-044), so the answer
 *     about where points can be spent says exactly that and not more.
 * If either stops being true, these strings are wrong and must change with it.
 *
 * COPY RULE: no em dashes in anything a visitor reads. Comments are exempt.
 */

import {
  layout, escapeHtml, organizationJsonLd, webSiteJsonLd, breadcrumbJsonLd, faqJsonLd,
} from './page-shell.js';

/* ============================================================
 * /how-it-works
 * ============================================================ */

const STEPS = [
  {
    title: 'Sign in once, on your phone',
    body: 'Open we-rewards.com and continue with your Google account. That is the whole setup. There is no app to download from the App Store or Google Play, and nothing to install unless you want to add the site to your home screen.',
  },
  {
    title: 'Show your code when you pay',
    body: 'Your personal QR code is the first thing on the screen. Show it at the counter when you pay and the shop scans it. If scanning is not an option that day, read out the short code printed under it instead.',
  },
  {
    title: 'Points land right away',
    body: 'Points appear on your phone the moment the shop awards them, not overnight. Every spot sets its own earning rate and its own rewards, so a coffee shop and a pizza place can run completely different programs.',
  },
  {
    title: 'Trade them in for free food',
    body: 'When you have enough points, open the reward you want, show the redeem code, and say what you are claiming. The shop confirms it on their end and the points come off. That is the entire loop.',
  },
];

export function howItWorksHtml() {
  const body = `    <p class="crumbs"><a href="/">Home</a> / How it works</p>
    <h1>How WeRewards works</h1>
    <p class="lede">WeRewards (often typed as We Rewards) is a free rewards program for students at local restaurants, cafes and food spots around Penn State. You earn points where you already eat in State College, then trade them for free food.</p>

    <h2>Four steps, start to finish</h2>
    <ol class="steps">
${STEPS.map((s) => `      <li><strong>${escapeHtml(s.title)}</strong>${escapeHtml(s.body)}</li>`).join('\n')}
    </ol>

    <h2>What it costs a student</h2>
    <p>Nothing. WeRewards is free for students, there is no subscription, and you are never asked for a card to earn points. The businesses fund their own rewards because a returning regular is worth more to them than a one time customer.</p>

    <h2>Where your points work</h2>
    <p>Points are earned and spent at the spot that gave them, so your balance at one cafe is separate from your balance at another. Some spots also take part in a shared community pool, and those are marked in the app. You can see every partner spot, its address and what its points buy on the <a href="/spots">spots page</a>.</p>

    <h2>Do you need to download anything?</h2>
    <p>No. WeRewards runs in your browser. If you want it to feel like an app you can add it to your home screen from Safari or Chrome, but that is optional and it works the same either way.</p>

    <h2>Run a spot near campus?</h2>
    <p>Local businesses join WeRewards to bring students back more often, and setup takes one application. Read the pitch and apply on the <a href="/join">partner page</a>.</p>
    <a class="cta" href="/">Start earning points</a>`;

  return layout({
    path: '/how-it-works',
    title: 'How WeRewards works | Earn points at Penn State spots',
    description:
      'How to earn and redeem WeRewards points at local spots around Penn State. Sign in with Google, show your QR code when you pay, and trade points for free food. Free for students, no app download.',
    body,
    jsonLd: [
      organizationJsonLd(),
      webSiteJsonLd(),
      breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'How it works', path: '/how-it-works' }]),
      {
        '@context': 'https://schema.org',
        '@type': 'HowTo',
        name: 'How to earn and redeem WeRewards points',
        description:
          'Earn points at local spots around Penn State with WeRewards and redeem them for free food.',
        totalTime: 'PT2M',
        estimatedCost: { '@type': 'MonetaryAmount', currency: 'USD', value: '0' },
        step: STEPS.map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.title,
          text: s.body,
        })),
      },
    ],
  });
}

/* ============================================================
 * /faq
 *
 * One list, rendered as the visible page AND as the FAQPage node. Google
 * requires the markup to match what a visitor can read, and the only way to
 * guarantee that permanently is to build both from the same array.
 *
 * Worth being honest about the ceiling: Google narrowed FAQ rich results to
 * government and health sites in 2023, so these are unlikely to draw the
 * expandable answers under a result any more. They still earn their place, as
 * plain crawlable answers to real questions and as another statement of who this
 * organisation is.
 * ============================================================ */

const FAQ = [
  {
    q: 'What is WeRewards?',
    a: 'WeRewards is a free rewards program for students at local restaurants, cafes and food spots around Penn State in State College, Pennsylvania. You earn points where you already eat and trade them in for free food. It is also often written as We Rewards or we-rewards.com.',
  },
  {
    q: 'Is WeRewards free for students?',
    a: 'Yes. It is completely free for students. There is no subscription and no card to buy. Local businesses fund their own rewards, because a regular who comes back is worth more to them than a one time customer.',
  },
  {
    q: 'Do I have to download an app?',
    a: 'No. WeRewards runs in your phone browser at we-rewards.com. Sign in with Google and your code is on screen. You can add it to your home screen if you want it to open like an app, but nothing needs installing from the App Store or Google Play.',
  },
  {
    q: 'How do I earn points?',
    a: 'Show your personal QR code at the counter when you pay and the shop scans it. Points land on your phone right away. If scanning is not working that day you can read out the short code printed under the QR instead.',
  },
  {
    q: 'Where can I use my points?',
    a: 'At the spot that gave them to you. Balances are kept per business, so points earned at one cafe are separate from points earned at another. Some spots also take part in a shared community pool, and those are marked in the app. Every partner spot is listed on the spots page.',
  },
  {
    q: 'Which schools and towns does WeRewards cover?',
    a: 'WeRewards is built for Penn State students and the local businesses in State College, Pennsylvania that feed them.',
  },
  {
    q: 'How do I get my business on WeRewards?',
    a: 'Apply on the partner page. Tell us about your business, choose the email and password you will use at the counter, and we review every application. Once you are approved you can sign in to your terminal right away.',
  },
  {
    q: 'What does WeRewards do with my data?',
    a: 'You sign in with Google, and what the program stores is what it needs to keep your points straight. The full detail is in the privacy policy, which is public and linked from every page.',
  },
];

export function faqHtml() {
  const body = `    <p class="crumbs"><a href="/">Home</a> / FAQ</p>
    <h1>WeRewards questions and answers</h1>
    <p class="lede">The things students and local businesses ask most about WeRewards, the free rewards program for Penn State and State College.</p>
${FAQ.map((f) => `    <h2>${escapeHtml(f.q)}</h2>\n    <p>${escapeHtml(f.a)}</p>`).join('\n')}
    <h2>Still stuck?</h2>
    <p>Email contactwerewards@gmail.com and a person will answer. You can also browse <a href="/spots">every partner spot</a> or read <a href="/how-it-works">how it works</a>.</p>
    <a class="cta" href="/">Start earning points</a>`;

  return layout({
    path: '/faq',
    title: 'WeRewards FAQ | Free student rewards at Penn State',
    description:
      'Answers about WeRewards, the free rewards program for Penn State students in State College. What it is, what it costs, how points work, and how local businesses join.',
    body,
    jsonLd: [
      organizationJsonLd(),
      webSiteJsonLd(),
      breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'FAQ', path: '/faq' }]),
      faqJsonLd(FAQ),
    ],
  });
}

export { FAQ as _FAQ, STEPS as _STEPS };
