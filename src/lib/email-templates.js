// Every email this app sends, as pure functions: input -> { subject, html, text }.
//
// Pure on purpose. Composition is the half of email that can be tested without
// a network, an API key, or a mailbox, so it lives apart from the transport
// (src/lib/email.js) exactly as composeNotification lives apart from web-push.
// test/email-templates.test.js holds them to it.
//
// ---- Why the HTML looks like 2004 ----
// Email clients are not browsers. Outlook renders through Word, Gmail strips
// <style> blocks in some contexts and rewrites classes, and nothing can be
// relied on beyond tables and inline styles. So: one 600px table, inline
// styles, no flexbox, no grid, no external CSS, no web fonts, no images.
//
// No images at all is a deliberate choice rather than a shortcut. Remote images
// are blocked by default in most clients, so a logo-led design renders as a
// broken box on first open, and the alternative (a base64 data URI) is dropped
// outright by Gmail. A wordmark set in system fonts always renders.
//
// ---- Copy ----
// Repo rule, same as the notification bodies in src/lib/campaigns.js: no em
// dashes. Subject lines stay under ~50 characters so they survive a phone's
// inbox list, and the preheader is the text a client previews next to the
// subject, so it must never be left to default to "View this email in...".

const BRAND = '#12294b';
const ACCENT = '#96bee6';
const INK = '#101d33';
const MUTED = '#5b6a80';
const PAGE = '#f4f6fa';
const EDGE = '#dde3ec';

/**
 * HTML-escape everything interpolated into a template. Vendor names, deal
 * titles and student names are all attacker-influenced text: a business that
 * applies as `<table>` must not be able to take the layout apart, and one that
 * applies with a quote character must not break out of an attribute.
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shared shell.
 *
 * @param {object} o
 * @param {string} o.title       the <h1> inside the card
 * @param {string} o.preheader   inbox preview text; never optional (see header)
 * @param {string} o.body        already-escaped HTML for the card's middle
 * @param {string} [o.footer]    small print under the card, already escaped
 */
function layout({ title, preheader, body, footer = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<!-- Preheader: shown next to the subject in the inbox list, hidden in the body.
     The trailing whitespace run stops clients from pulling the first line of
     real copy in after it. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <tr><td style="padding:0 0 18px 0;text-align:center;">
    <span style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;letter-spacing:3px;color:${BRAND};">WEREWARDS</span>
  </td></tr>

  <tr><td style="background:#ffffff;border:1px solid ${EDGE};border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.3;color:${INK};">${esc(title)}</h1>
    ${body}
  </td></tr>

  <tr><td style="padding:18px 8px 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${MUTED};text-align:center;">
    ${footer}
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** A paragraph in the card. `html` must already be escaped. */
function p(html, extra = '') {
  return `<p style="margin:0 0 14px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK};${extra}">${html}</p>`;
}

/**
 * A "bulletproof" button: a padded table cell wrapping the anchor, not a styled
 * <a>. Outlook drops padding on inline anchors, which turns a call to action
 * into an unclickable coloured word.
 *
 * `flush` drops the button's own margins for use inside stack(), which owns the
 * vertical rhythm itself — a margin here on top of a stack gap is exactly the
 * kind of double spacing that makes one gap in an email look wrong next to the
 * others. Default is the old margin, so the templates that don't stack are
 * untouched.
 */
function button(href, label, { flush = false } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${flush ? '0' : '6px 0 18px 0'};">
  <tr><td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
    <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
}

/** A boxed monospace code, sized to be read off a phone at a counter. */
function codeBlock(code) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 18px 0;">
  <tr><td align="center" bgcolor="${PAGE}" style="border:2px solid ${ACCENT};border-radius:10px;padding:18px;">
    <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:bold;letter-spacing:5px;color:${BRAND};">${esc(code)}</span>
  </td></tr>
</table>`;
}

/* ---------- even vertical rhythm ---------- */
//
// The problem these solve: every block in this file used to carry its own
// bottom margin (p 14px, button 6/18px, codeBlock 6/18px), so the gap between
// any two blocks was whatever their two margins happened to add up to — 14px
// between paragraphs, 20px above a button, 18px below it. Nobody can name the
// rule because there isn't one, and on a long email the unevenness reads as
// sloppiness even to someone who could not say why.
//
// So: blocks below carry NO margin of their own, and stack() owns every gap.
// Two values, used everywhere — GAP_TIGHT inside a section, GAP_SECTION between
// sections. Change one constant, the whole email re-spaces evenly.

const GAP_SECTION = 26;   // between the titled sections of a card
const GAP_TIGHT = 12;     // between lines and list rows inside one section

/**
 * Stack blocks with ONE gap between them and none after the last.
 *
 * A single table with one row per block, not nested tables: Outlook renders
 * this as plain table cells with padding, which is the one box model every
 * client agrees on. The "none after the last" half is what keeps a section's
 * own trailing space from adding to the gap that follows it.
 */
function stack(blocks, gap = GAP_SECTION) {
  const rows = blocks.filter(Boolean);
  if (!rows.length) return '';
  const cells = rows.map((html, i) =>
    `<tr><td style="padding:0 0 ${i === rows.length - 1 ? 0 : gap}px 0;">${html}</td></tr>`
  ).join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${cells}
</table>`;
}

/** A line of body copy carrying no margin. Spacing comes from stack(). */
function line(html, extra = '') {
  return `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK};${extra}">${html}</p>`;
}

/** A section heading inside the card. Sized between the h1 and body copy. */
function h2(text) {
  return `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:bold;line-height:1.35;color:${INK};">${esc(text)}</p>`;
}

/**
 * A numbered list, as a two-column table rather than an <ol>.
 *
 * Outlook and Gmail both mangle list indentation (Outlook applies Word's list
 * margins, Gmail rewrites the padding), and a step list whose numbers do not
 * line up with their text is exactly the kind of small wrongness that makes a
 * nervous reader stop following instructions. A table cannot drift.
 *
 * Numbers are real content here, not decoration: these steps must be done in
 * order, and someone reading them off a screen at a counter needs to be able to
 * say "I'm on four".
 */
function steps(items) {
  const rows = items.filter(Boolean).map((html, i, all) => {
    const pad = i === all.length - 1 ? 0 : GAP_TIGHT;
    return `
  <tr>
    <td valign="top" style="padding:0 10px ${pad}px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;line-height:1.6;color:${BRAND};">${i + 1}.</td>
    <td valign="top" style="padding:0 0 ${pad}px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK};">${html}</td>
  </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

/** An unordered list, same table reasoning as steps(). Order carries nothing. */
function bullets(items) {
  const rows = items.filter(Boolean).map((html, i, all) => {
    const pad = i === all.length - 1 ? 0 : GAP_TIGHT;
    return `
  <tr>
    <td valign="top" style="padding:0 10px ${pad}px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BRAND};">&bull;</td>
    <td valign="top" style="padding:0 0 ${pad}px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK};">${html}</td>
  </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

/** A tinted aside for a caveat that must not read as part of the main flow. */
function note(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td bgcolor="${PAGE}" style="border:1px solid ${EDGE};border-radius:8px;padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${MUTED};">${html}</td></tr>
</table>`;
}

/** Standard small print. `extra` is appended as its own line when given. */
function footerLines(extra = '') {
  const base = `WeRewards &middot; points at the spots around campus`;
  return extra ? `${extra}<br />${base}` : base;
}

/* ==================== vendor lifecycle ==================== */

/**
 * Sent the instant a /join application lands, before any human has looked at it.
 *
 * Its only job is to close the loop: someone just typed their business, their
 * phone number and a password they chose into a form on the internet and got a
 * 201 back. Without this, the next thing they hear from us is either nothing or
 * an acceptance days later, and in between the reasonable assumption is that it
 * did not go through. It therefore states plainly what happens next and does
 * NOT promise a decision date we cannot keep.
 */
export function applicationReceived({ businessName, contactName, locationCount = 1 } = {}) {
  const name = esc(contactName || 'there');
  const biz = esc(businessName || 'your business');
  const many = locationCount > 1;

  const body = [
    p(`Hi ${name},`),
    p(`We’ve got your application for <strong>${biz}</strong>${many ? ` and its ${locationCount} locations` : ''}. It’s in the queue.`),
    p(`Someone on the WeRewards team reads every application by hand. We’ll email you either way once we’ve looked at yours. If we need anything else first, we’ll call the number you gave us.`),
    p(`Nothing to do in the meantime. You picked your password when you applied, and it’s the one you’ll sign in with the moment you’re approved.`, `color:${MUTED};font-size:14px;`),
  ].join('\n');

  const text = [
    `Hi ${contactName || 'there'},`,
    '',
    `We've got your application for ${businessName || 'your business'}${many ? ` and its ${locationCount} locations` : ''}. It's in the queue.`,
    '',
    `Someone on the WeRewards team reads every application by hand. We'll email you either way once we've looked at yours. If we need anything else first, we'll call the number you gave us.`,
    '',
    `Nothing to do in the meantime. You picked your password when you applied, and it's the one you'll sign in with the moment you're approved.`,
    '',
    'WeRewards',
  ].join('\n');

  return {
    subject: `We got your WeRewards application`,
    html: layout({
      title: 'Application received',
      preheader: `${businessName || 'Your application'} is in the queue. We’ll email you either way.`,
      body,
      footer: footerLines('You’re getting this because you applied at WeRewards.'),
    }),
    text,
  };
}

/**
 * Sent on accept, from /admin. This is the email that has to actually get
 * someone signed in, so the sign-in address is stated explicitly rather than
 * left as "the email you applied with" — a chain owner may have applied with
 * one address and read mail at another.
 *
 * `linkedExisting` is the case where the address already had a WeRewards
 * account (migration-035 links it instead of creating one). Saying "use the
 * password you already have" is the entire difference between that vendor
 * signing in and that vendor phoning for a reset code on day one, because the
 * password they chose on the application form is NOT the one that works.
 */
export function applicationAccepted({
  businessName, contactName, email, linkedExisting = false, locationCount = 1, terminalUrl = '/terminal/',
} = {}) {
  const name = esc(contactName || 'there');
  const biz = esc(businessName || 'your business');
  const many = locationCount > 1;

  // What we ask them to TYPE, not what the button links to. 'https://' and a
  // trailing slash are both noise to someone copying an address off a screen
  // onto a Post-it, and the trailing slash in particular gets read as a full
  // stop and dropped, which teaches them the address we gave them is wrong.
  const typeAddress = esc(String(terminalUrl).replace(/^https?:\/\//, '').replace(/\/+$/, ''));

  const passwordLine = linkedExisting
    ? `This email already had a WeRewards account, so we linked it rather than making a second one. <strong>Sign in with the password you already use</strong>, not the one you typed on the application form.`
    : `Sign in with the password you chose when you applied.`;

  const body = stack([

    stack([
      line(`Hi ${name},`),
      line(`<strong>${biz}</strong> is approved and live on WeRewards.${many ? ` All ${locationCount} locations are set up, and you switch between them from the name at the top of the terminal.` : ''}`),
    ], GAP_TIGHT),

    stack([
      h2('Signing in'),
      line(`Sign in as <strong>${esc(email || '')}</strong>. ${passwordLine}`),
      button(terminalUrl, 'Open your terminal', { flush: true }),
    ], GAP_TIGHT),

    // The install steps. Written for someone who has never been told what a
    // browser is, so every step names a thing they can SEE on the screen rather
    // than a thing they would have to already know the word for. Deliberately
    // free of version numbers: an iPad owner cannot reliably say whether they
    // are on iPadOS 17 or 26, and a step that starts by asking them to find out
    // is a step they stop at. Where the interface genuinely differs, the step
    // names both possibilities and tells them to tap whichever one is there.
    stack([
      h2('Putting the terminal on your iPad'),
      line(`This gives you a proper app icon on the iPad home screen, so nobody has to type an address at the start of a shift.`),
      // Ahead of the steps, not after them: it is a precondition, and a vendor
      // who reads it only at the end has already installed an icon whose
      // scanner cannot work and now has to be told to delete it again.
      note(`<strong>If this iPad is an older one, check this before you start.</strong> Open Settings, then General, then About, and find Software Version. If it is 14.3 or higher, carry on. If it is lower, do not add the icon: on those iPads the barcode scanner cannot use the camera from a home screen icon. Open <strong>${typeAddress}</strong> in Safari instead, and everything works normally.`),
      steps([
        `On the iPad, open <strong>Safari</strong>. It is the blue compass icon on the home screen. Chrome will not do this, and neither will a page that opened by itself from another app.`,
        `Type <strong>${typeAddress}</strong> into the long box across the top, then tap Go. Do not sign in yet.`,
        `At the <strong>right-hand end</strong> of that same box, tap the small <strong>square with an arrow pointing up out of it</strong>. If you cannot see one, tap the <strong>three dots</strong> at that end instead, then tap <strong>Share</strong>.`,
        `A menu drops down. Slide it upwards to scroll, because it is longer than it looks, and tap <strong>Add to Home Screen</strong>. Do not tap Add Bookmark, which sounds right and does nothing useful here.`,
        `Type a short name, your shop name is ideal, then tap <strong>Add</strong> in the <strong>top-right corner</strong> of the little box.`,
        `Go back to the home screen and tap your new icon. If the page fills the whole screen and there is no address box along the top, it worked. Sign in there and it will remember you.`,
      ]),
    ], GAP_TIGHT),

    stack([
      h2('First things worth doing'),
      bullets([
        `Set a staff PIN. It is what stops a customer redeeming a reward themselves.`,
        `Check your points rate, so customers earn what you meant them to.`,
        `Print your QR poster from the terminal and put it by the till.`,
      ]),
    ], GAP_TIGHT),

    line(`If anything looks wrong, reply to this email or write to us at <strong>contactwerewards@gmail.com</strong> and a person will get back to you.`, `color:${MUTED};font-size:14px;`),

  ]);

  const text = [
    `Hi ${contactName || 'there'},`,
    '',
    `${businessName || 'Your business'} is approved and live on WeRewards.${many ? ` All ${locationCount} locations are set up, and you switch between them from the name at the top of the terminal.` : ''}`,
    '',
    'SIGNING IN',
    '',
    `Sign in as ${email || ''}. ${linkedExisting
      ? 'This email already had a WeRewards account, so we linked it rather than making a second one. Sign in with the password you already use, not the one you typed on the application form.'
      : 'Sign in with the password you chose when you applied.'}`,
    '',
    `Open your terminal: ${terminalUrl}`,
    '',
    'PUTTING THE TERMINAL ON YOUR IPAD',
    '',
    'This gives you a proper app icon on the iPad home screen, so nobody has to type an address at the start of a shift.',
    '',
    `If this iPad is an older one, check this before you start. Open Settings, then General, then About, and find Software Version. If it is 14.3 or higher, carry on. If it is lower, do not add the icon: on those iPads the barcode scanner cannot use the camera from a home screen icon. Open ${typeAddress.replace(/&amp;/g, '&')} in Safari instead, and everything works normally.`,
    '',
    '1. On the iPad, open Safari. It is the blue compass icon on the home screen. Chrome will not do this, and neither will a page that opened by itself from another app.',
    `2. Type ${typeAddress.replace(/&amp;/g, '&')} into the long box across the top, then tap Go. Do not sign in yet.`,
    '3. At the right-hand end of that same box, tap the small square with an arrow pointing up out of it. If you cannot see one, tap the three dots at that end instead, then tap Share.',
    '4. A menu drops down. Slide it upwards to scroll, because it is longer than it looks, and tap "Add to Home Screen". Do not tap "Add Bookmark", which sounds right and does nothing useful here.',
    '5. Type a short name, your shop name is ideal, then tap Add in the top-right corner of the little box.',
    '6. Go back to the home screen and tap your new icon. If the page fills the whole screen and there is no address box along the top, it worked. Sign in there and it will remember you.',
    '',
    'FIRST THINGS WORTH DOING',
    '',
    '- Set a staff PIN. It is what stops a customer redeeming a reward themselves.',
    '- Check your points rate, so customers earn what you meant them to.',
    '- Print your QR poster from the terminal and put it by the till.',
    '',
    'If anything looks wrong, reply to this email or write to us at contactwerewards@gmail.com and a person will get back to you.',
    '',
    'WeRewards',
  ].join('\n');

  return {
    subject: `${businessName || 'Your business'} is live on WeRewards`,
    html: layout({
      title: 'You’re approved',
      preheader: `Sign in at ${email || 'your email'}, then put the terminal on your iPad.`,
      body,
      footer: footerLines(),
    }),
    text,
  };
}

/**
 * The password reset code.
 *
 * Read the constraints off src/lib/reset-codes.js: the code is grouped
 * XXXX-XXXX because it was designed to be dictated down a phone, and the
 * alphabet already drops every glyph that looks like another. Rendering it big,
 * monospaced and letter-spaced is the same idea for a screen: someone is
 * copying this into a terminal on a counter, often from a phone, in a hurry.
 *
 * It is NOT a magic link. A click-to-reset URL in email would move the entire
 * security boundary into the mailbox, and the flow this stack has (type the
 * code, choose the password, five guesses, thirty minutes) already works from
 * a device that is not the one holding the mail.
 */
export function vendorResetCode({ businessName, code, ttlMinutes = 30, terminalUrl = '/terminal/', selfServe = false } = {}) {
  const biz = esc(businessName || 'your WeRewards account');

  const body = [
    p(selfServe
      ? `Someone asked to reset the password for <strong>${biz}</strong>. Here’s the code.`
      : `Here’s the one-time code to reset the password for <strong>${biz}</strong>.`),
    codeBlock(code),
    p(`Open the terminal, tap <strong>Forgot password?</strong>, and type this code with your new password.`),
    button(terminalUrl, 'Open the terminal'),
    p(`The code works once and expires in ${ttlMinutes} minutes. Five wrong tries and it stops working.`, `color:${MUTED};font-size:14px;`),
    p(selfServe
      ? `If this wasn’t you, you can ignore this email. Your password hasn’t changed, and nobody can use this code without reading it here.`
      : `If you didn’t ask for this, ignore it. Your password hasn’t changed.`, `color:${MUTED};font-size:14px;`),
  ].join('\n');

  const text = [
    selfServe
      ? `Someone asked to reset the password for ${businessName || 'your WeRewards account'}.`
      : `Here's the one-time code to reset the password for ${businessName || 'your WeRewards account'}.`,
    '',
    `    ${code}`,
    '',
    `Open the terminal (${terminalUrl}), tap "Forgot password?", and type this code with your new password.`,
    '',
    `The code works once and expires in ${ttlMinutes} minutes. Five wrong tries and it stops working.`,
    '',
    `If you didn't ask for this, ignore it. Your password hasn't changed.`,
    '',
    'WeRewards',
  ].join('\n');

  return {
    subject: `Your WeRewards reset code: ${code}`,
    html: layout({
      title: 'Password reset code',
      // The code goes in the subject AND the preheader on purpose: a vendor at a
      // counter can then read it straight off the notification without opening
      // anything. It is single-use and short-lived, which is what makes that an
      // acceptable trade rather than a leak.
      preheader: `${code} — expires in ${ttlMinutes} minutes.`,
      body,
      footer: footerLines('Sent because a password reset was requested for this login.'),
    }),
    text,
  };
}

/* ==================== student deals ==================== */

/** English list, no em dashes. Same helper as src/lib/campaigns.js, same rules. */
function nameList(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The deal email. This is the ONLY marketing message in the system, and it is
 * sent only where a push notification could not be (see src/lib/campaigns.js),
 * so it carries the same bundle a notification would have carried.
 *
 * One card per vendor rather than a single blob, because the bundle is the
 * point: a student who hears from us once a day should see all four spots that
 * had something on, not the first one with "and 3 more" swallowing the rest.
 *
 * @param {Array<{campaignId, vendor, title, body}>} items
 */
export function dealDigest({ name, items = [], appUrl = '/', unsubscribeUrl = '' } = {}) {
  const list = items.filter(Boolean);
  if (!list.length) return null;

  const vendors = list.map((c) => c.vendor);
  const one = list.length === 1;

  const cards = list.map((c) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;">
    <tr><td style="border:1px solid ${EDGE};border-left:4px solid ${ACCENT};border-radius:8px;padding:16px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${MUTED};margin:0 0 6px 0;">${esc(c.vendor)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:bold;color:${INK};margin:0 0 6px 0;">${esc(c.title)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:${INK};">${esc(c.body)}</div>
    </td></tr>
  </table>`).join('\n');

  const greeting = name ? `Hi ${esc(String(name).split(' ')[0])},` : 'Hi,';

  const body = [
    p(greeting),
    p(one
      ? `<strong>${esc(vendors[0])}</strong> has something on.`
      : `${esc(nameList(vendors.slice(0, 4)))} have something on.`),
    cards,
    button(appUrl, one ? 'See the deal' : 'See what’s on'),
  ].join('\n');

  const text = [
    name ? `Hi ${String(name).split(' ')[0]},` : 'Hi,',
    '',
    one ? `${vendors[0]} has something on.` : `${nameList(vendors.slice(0, 4))} have something on.`,
    '',
    ...list.map((c) => `${c.vendor}\n${c.title}\n${c.body}\n`),
    `See it in the app: ${appUrl}`,
    '',
    unsubscribeUrl ? `Stop deal emails: ${unsubscribeUrl}` : '',
    'WeRewards',
  ].filter((l) => l !== '').join('\n');

  const footer = unsubscribeUrl
    ? `You’re getting this because deal emails are on for your WeRewards account, and we couldn’t reach this device with a notification.<br /><a href="${esc(unsubscribeUrl)}" style="color:${MUTED};">Turn deal emails off</a><br />${footerLines()}`
    : footerLines();

  return {
    subject: one ? `${vendors[0]}: ${list[0].title}` : `${list.length} spots have something on`,
    html: layout({
      // Raw, not escaped: layout() escapes the title itself, and an
      // already-escaped string here renders '&amp;' to the reader.
      title: one ? list[0].title : 'What’s on today',
      preheader: one ? `${vendors[0]}: ${list[0].body}` : `${nameList(vendors.slice(0, 3))}. Tap to see what’s on.`,
      body,
      footer,
    }),
    text,
  };
}
