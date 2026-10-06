/**
 * `/support` — the public support page.
 *
 * WHY IT EXISTS AT ALL. App Store Connect requires a working support URL for a
 * submitted build, and it is checked by a human during review. A 404 there is a
 * rejection. That is also why this page asks for nothing: no sign in, no
 * JavaScript, no cookie, no query parameter. A reviewer pastes the URL into a
 * desktop browser with no session and must see the whole thing.
 *
 * WHY IT DOES NOT USE layout() FROM page-shell.js, which /faq and
 * /how-it-works do use. That shell is light by default (its dark palette is
 * behind a prefers-color-scheme query) and its header is a plain `WE REWARDS`
 * text brand. The student app's default theme is DARK (see theme-init.js: dark
 * unless the visitor has explicitly chosen light), and its header is the
 * `We[Rewards]` pill. A support page that a student reaches from the app and a
 * reviewer reaches from App Store Connect has to look like the product they
 * just looked at, so this page links the app's real stylesheet instead and
 * borrows .nav, .wordmark and the whole .footer block from it verbatim. Nothing
 * in the palette is restated here; every colour below is a var() that
 * styles.css already defines, in both themes.
 *
 * WHY data-theme IS HARD-CODED. theme-init.js is what normally stamps this
 * attribute, and it reads localStorage, which makes it a script. This page
 * ships no script, so it takes the app's documented default (dark) as a literal.
 * A student who has switched the app to light will see this one page dark. That
 * is the cost of having no JavaScript, and it is the right trade for a page
 * whose job is to render for a stranger on the first try.
 *
 * TWO THINGS THIS PAGE DELIBERATELY DOES NOT INHERIT from the app shell:
 *   • the viewport lock. index.html ships `maximum-scale=1, user-scalable=no`
 *     and styles.css sets `html { touch-action: pan-x pan-y }`, both to stop a
 *     mis-tap zooming the app. This is a page of prose that someone may well
 *     need to enlarge, including the reviewer, so the viewport stays scalable
 *     and touch-action is handed back to the browser below. The override has to
 *     sit in this page's own <style> (after the stylesheet link) because it is
 *     overriding an `html` rule and only source order can win that.
 *   • no-zoom.js, install-prompt.js, app.js and the rest. None is loaded.
 *
 * COPY RULE, stricter here than anywhere else in the codebase: no em dashes, no
 * en dashes, and NO HYPHENS AT ALL in anything a visitor reads. The brand is
 * never written with the domain's hyphen, and the town is "State College",
 * never "Penn State" or "PSU". Comments are exempt. Points are never described
 * as having cash value: they are redeemed for rewards, and the FAQ says so in
 * as many words because the App Store treats a points balance that sounds like
 * stored money as a very different kind of app.
 */

import { absoluteUrl } from './seo.js';

/** The one address a student or a reviewer can write to. */
const SUPPORT_EMAIL = 'contactwerewards@gmail.com';

/** The same address with the one break opportunity the button is allowed to use. */
const SUPPORT_EMAIL_WRAPPABLE = SUPPORT_EMAIL.replace('@', '<wbr />@');

/**
 * The FAQ, as data.
 *
 * Every answer is checked against what the app actually does:
 *   • earning is a counter scan of the student's code (public/student/app.js),
 *   • balances are per vendor (`point_balances` is keyed on user AND vendor), so
 *     the "one spot at another" answer is a flat no,
 *   • the deletion steps are the real ones: Account tab -> Your data ->
 *     Delete my account -> the confirmation sheet, which POSTs /api/me/delete
 *     (public/student/index.html and app.js). Apple requires an in-app deletion
 *     path for an account-based app, so this entry is load-bearing for review
 *     and must change the day that flow moves.
 * If any of that stops being true these strings are wrong and must change with it.
 */
const FAQ = [
  {
    q: 'How do I earn points?',
    a: 'Show your WeRewards code at the counter when you pay at a participating spot. Staff scans it, and your points land on your phone right away.',
  },
  {
    q: "My scan didn't give me points. What do I do?",
    a: 'Email us with the spot name, plus the date and time of your visit, and we will put it right.',
  },
  {
    q: 'How do I redeem a reward?',
    a: 'Once you have enough points at a spot, show your code at the counter and say what you are claiming. Staff confirms it and the points come off your balance.',
  },
  {
    q: 'Can I use points from one spot at another?',
    a: 'No. Each spot has its own points balance.',
  },
  {
    q: 'Do points have cash value?',
    a: 'No. Points can only be redeemed for rewards at participating spots.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Open the app and sign in, tap Account in the bottom bar, then scroll down to Your data and tap Delete my account. A confirmation screen appears, and tapping Yes, delete my account removes your profile, your points, and your codes for good.',
  },
];

/**
 * This page's own layout rules.
 *
 * Every selector is prefixed `sup-` on purpose. styles.css is some 3,800 lines
 * and this page is inside its cascade, so a generic class name here is a
 * collision waiting to happen. The elements that SHOULD match the landing page
 * exactly (.nav, .wordmark, .footer and friends) carry the app's own classes
 * instead of copies of them, which is why there is no palette in this block.
 *
 * The one piece of visual vocabulary restated rather than reused is the
 * uppercase letterspaced section label: in styles.css it is `.how h2`, scoped
 * inside a section that also paints itself navy and takes 4.5rem of padding.
 * Only the type is wanted, so .sup-label carries the same four declarations and
 * the same var(--accent).
 */
const STYLES = `
/* Prose, not an app surface: give zoom back (see the file header). */
html { touch-action: auto; }

/* ---------- header ----------
   .nav and .wordmark are the landing page's own classes, so the pill is the
   same pill. The only addition is a tap target: as plain inline text the link
   is the cap height of 0.95rem type, about 16px, and this is the one control in
   the header. inline-flex plus a min-height takes it to 44px without touching
   the pill's own box. */
.sup-home {
  display: inline-flex; align-items: center; min-height: 2.75rem;
  color: var(--ink); text-decoration: none;
}

.sup { max-width: 44rem; margin: 0 auto; padding: 0 1.2rem 1rem; }

.sup h1 { font-size: clamp(2.1rem, 9vw, 2.9rem); font-weight: 900; letter-spacing: -0.01em; }
.sup-lede {
  margin-top: 0.6rem; color: var(--muted);
  font-size: 1.05rem; font-weight: 500; line-height: 1.5;
}

/* The landing page's "HOW IT WORKS" treatment, type only. */
.sup-label {
  font-size: 1rem; font-weight: 900; letter-spacing: 0.22em; color: var(--accent);
}

.sup-section { margin-top: 2.75rem; }
.sup-section > .sup-label { margin-bottom: 1rem; }

/* The app's sticker card: chunky border plus a hard offset shadow, both from
   --edge so the shape survives the theme flip. */
.sup-card {
  background: var(--card);
  border: 2.5px solid var(--edge);
  border-radius: 1rem;
  box-shadow: 0 3px 0 var(--edge);
  padding: 1.25rem;
}

/* ---------- contact ---------- */

/* The one thing this page exists to offer, so it is the biggest tap target on
   it. min-height clears 44px by a wide margin even before the padding, and the
   address is allowed to break anywhere: it is long, and a 320px phone must not
   be made to scroll sideways by it. */
.sup-mail {
  display: flex; align-items: center; justify-content: center;
  min-height: 3.5rem; margin-top: 0.9rem; padding: 0.95rem 0.6rem;
  background: var(--navy); color: var(--sky);
  border: 2.5px solid var(--edge); border-radius: 0.8rem;
  box-shadow: 0 3px 0 var(--edge);
  /* The address is 26 characters of 900 weight and it must not break. At a flat
     1.05rem it wrapped after "gmail." on a 375px phone, which turns the one
     thing this page is for into something that reads like a typo. The clamp
     holds it on one line from 375px up and still caps at the intended size on a
     desktop. Below that it has to wrap, so the markup carries a single <wbr>
     before the @ and nothing here allows any other break: a narrow phone gets
     "contactwerewards" over "@gmail.com", which reads as an address, rather
     than the mid-domain "gmail." / "com" split that overflow-wrap: anywhere
     produced. <wbr> is an empty element, so the text a visitor copies and the
     mailto: target are both still the plain address. */
  font-size: clamp(0.85rem, 3.9vw, 1.05rem);
  font-weight: 900; letter-spacing: 0.01em;
  text-align: center; text-decoration: none;
}
.sup-mail:hover { background: var(--navy-press); }
.sup-mail:active { transform: translateY(3px); box-shadow: none; }
.sup-mail:focus-visible { outline: 3px solid var(--brand); outline-offset: 3px; }

.sup-reply {
  display: flex; align-items: baseline; gap: 0.5rem;
  margin-top: 0.85rem; color: var(--muted); font-weight: 500; line-height: 1.45;
}
/* A small positive tick in the app's success green, so the promise reads as a
   promise rather than as small print. aria-hidden on the element itself. */
.sup-reply-dot { color: var(--success); font-weight: 900; }

/* ---------- FAQ ---------- */

/* Native <details>: the only way to get a real disclosure widget, keyboard
   operable and announced correctly, with no script at all. */
.sup-faq { border-bottom: 1px solid var(--hairline); }
.sup-faq:first-of-type { border-top: 1px solid var(--hairline); }

.sup-faq > summary {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  min-height: 3.25rem; padding: 0.9rem 0.25rem;
  font-size: 1.02rem; font-weight: 900; line-height: 1.35;
  color: var(--ink); cursor: pointer; list-style: none;
}
/* Safari paints its own triangle and ignores list-style. */
.sup-faq > summary::-webkit-details-marker { display: none; }
.sup-faq > summary:focus-visible { outline: 3px solid var(--brand); outline-offset: -3px; }

/* The open/closed indicator. A rotating triangle, not a plus or a minus: a
   minus sign in the corner of this page would be the one dash in the copy. */
.sup-faq > summary::after {
  content: "\\25BE";
  flex: none; color: var(--brand); font-size: 0.9rem;
  transition: transform 0.18s ease;
}
.sup-faq[open] > summary::after { transform: rotate(180deg); }
.sup-faq[open] > summary { color: var(--brand); }

.sup-faq-a {
  padding: 0 0.25rem 1.1rem; max-width: 60ch;
  color: var(--muted); font-weight: 500; line-height: 1.6;
}

/* ---------- for businesses ---------- */

.sup-biz h2 { font-size: 1.3rem; font-weight: 900; line-height: 1.3; }
.sup-biz p { margin-top: 0.6rem; color: var(--muted); font-weight: 500; line-height: 1.55; }
.sup-biz-link {
  display: inline-flex; align-items: center; min-height: 2.75rem; margin-top: 0.9rem;
  color: var(--brand); font-weight: 900; text-decoration: none;
}
.sup-biz-link:hover { text-decoration: underline; }

/* ---------- footer ----------
   .footer and .footer-legal come from styles.css. Only the link row needs
   centring here, since this footer carries two links rather than the landing
   page's seven plus a brand block. */
.sup-footer .footer-inner { justify-content: center; }
/* Same 44px floor as the header link. Scoped to .sup-footer so the landing
   page's own seven-link footer is untouched. */
.sup-footer .footer-links a {
  display: inline-flex; align-items: center; min-height: 2.75rem;
}

@media (min-width: 620px) {
  .sup { padding-left: 2rem; padding-right: 2rem; }
  .sup-card { padding: 1.5rem; }
}
`;

/** The full document. */
export function supportHtml() {
  const url = absoluteUrl('/support');
  const title = 'WeRewards Support';
  const description =
    'Get help with WeRewards. Email our support team, read answers about earning and redeeming points, and find out how to delete your account.';

  const faq = FAQ.map((it) => `        <details class="sup-faq">
          <summary>${it.q}</summary>
          <p class="sup-faq-a">${it.a}</p>
        </details>`).join('\n');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${url}" />
  <meta name="theme-color" content="#0f1826" />
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
  <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  <meta property="og:site_name" content="WeRewards" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${url}" />
  <meta name="twitter:card" content="summary" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css" />
  <style>${STYLES}</style>
</head>
<body>
  <header class="nav">
    <a class="wordmark sup-home" href="/">We<em>Rewards</em></a>
  </header>

  <main class="sup">
    <h1>Support</h1>
    <p class="sup-lede">Questions, problems, or feedback? We read everything.</p>

    <section class="sup-section">
      <h2 class="sup-label">EMAIL US</h2>
      <div class="sup-card">
        <a class="sup-mail" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL_WRAPPABLE}</a>
        <p class="sup-reply">
          <span class="sup-reply-dot" aria-hidden="true">&#10004;</span>
          <span>We usually reply within one business day.</span>
        </p>
      </div>
    </section>

    <section class="sup-section">
      <h2 class="sup-label">COMMON QUESTIONS</h2>
${faq}
    </section>

    <section class="sup-section sup-card sup-biz">
      <h2>Run a spot in State College?</h2>
      <p>Local spots join WeRewards to bring students back more often, and signing up takes one application.</p>
      <a class="sup-biz-link" href="/join">Join the WeRewards community</a>
    </section>
  </main>

  <footer class="footer sup-footer">
    <div class="footer-inner">
      <nav class="footer-links" aria-label="Footer">
        <a href="/legal/student-terms-of-service.html">Terms of Service</a>
        <a href="/legal/student-privacy-policy.html">Privacy Policy</a>
      </nav>
    </div>
    <p class="footer-legal">&copy; 2026 WeRewards LLC</p>
  </footer>
</body>
</html>
`;
}
