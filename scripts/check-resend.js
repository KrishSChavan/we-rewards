// Verify RESEND_API_KEY / EMAIL_FROM against the live API before trusting mail
// to it.
//
//   npm run check:resend                       # key, From address, domain status
//   npm run check:resend -- you@example.com    # ...and send one of each template
//
// Worth running for the same reason scripts/check-gemini.js is: a misconfigured
// key fails INVISIBLY. Nothing 500s, no student sees an error, and every one of
// these simply stops happening —
//
//   • an applicant hears nothing back after submitting on /join,
//   • an accepted vendor is never told they can sign in,
//   • a locked-out vendor taps "Email me a code" and gets the same reassuring
//     "a code is on its way" as everyone else, forever,
//   • deal emails, the only channel that reaches an iOS student who never
//     installed the PWA, silently deliver to nobody.
//
// All four are best-effort by design (src/lib/email.js never throws), which is
// exactly why the failure has to be surfaced deliberately, here.

import 'dotenv/config';
import { emailEnabled, emailFrom, sendEmail } from '../src/lib/email.js';
import {
  applicationReceived, applicationAccepted, vendorResetCode, dealDigest,
} from '../src/lib/email-templates.js';

let failed = false;

function fail(msg, hint) {
  failed = true;
  console.error(`\n  FAIL  ${msg}`);
  if (hint) console.error(`        ${hint}`);
}

function ok(msg) {
  console.log(`  ok    ${msg}`);
}

function warn(msg, hint) {
  console.log(`  warn  ${msg}`);
  if (hint) console.log(`        ${hint}`);
}

/**
 * The From line has to be a verified sender on a verified domain. Two mistakes
 * are common enough to be worth naming separately: a bare address with no
 * display name (a real deliverability signal, not a style note), and an
 * onboarding@resend.dev left in from the quickstart, which can only ever mail
 * the account owner and looks fine right up until a real vendor applies.
 */
function checkFrom() {
  const from = emailFrom();
  const match = /<([^>]+)>\s*$/.exec(from) || [null, from];
  const address = String(match[1] ?? '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    fail(`EMAIL_FROM is not a usable address: ${from}`, 'Expected something like: WeRewards <hello@we-rewards.com>');
    return null;
  }
  if (!/</.test(from)) {
    warn(`EMAIL_FROM has no display name: ${from}`,
         'A bare address in the From line is a cheap spam signal. Prefer: WeRewards <' + address + '>');
  } else {
    ok(`From: ${from}`);
  }
  if (/@resend\.dev$/i.test(address)) {
    fail('EMAIL_FROM is still on resend.dev',
         'That sandbox domain can only mail the Resend account owner. Verify your own domain and use an address on it.');
  }
  return address.split('@')[1];
}

/**
 * Ask Resend what it thinks of the domain. A sending-only API key is not
 * allowed to list domains, which is a perfectly good way to run production —
 * so a 401/403 here is reported as "cannot check", never as a failure.
 */
async function checkDomain(domain) {
  if (!domain) return;
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (res.status === 401) {
      return fail('The API key was rejected (401)', 'Check RESEND_API_KEY. Keys start with re_.');
    }
    if (res.status === 403 || res.status === 422) {
      return warn('This key cannot list domains, so the domain was not checked',
                  'Normal for a sending-only key. Confirm the domain reads "Verified" in the Resend dashboard.');
    }
    if (!res.ok) {
      return warn(`Could not list domains (HTTP ${res.status})`, 'Confirm the domain is verified in the Resend dashboard.');
    }

    const body = await res.json();
    const found = (body?.data ?? []).find((d) => String(d.name).toLowerCase() === domain.toLowerCase());
    if (!found) {
      return fail(`${domain} is not a domain on this Resend account`,
                  'Add and verify it, or point EMAIL_FROM at one that is. Sending from an unverified domain is refused.');
    }
    if (found.status !== 'verified') {
      return fail(`${domain} is on the account but reads "${found.status}"`,
                  'Finish the DNS records (SPF/DKIM) in the Resend dashboard. Nothing sends until it is verified.');
    }
    ok(`${domain} is verified`);
  } catch (err) {
    fail(`Could not reach the Resend API: ${err?.message ?? err}`);
  }
}

/** Spot-check the webhook config. Not fatal, but its absence is worth saying. */
function checkWebhook() {
  if (process.env.RESEND_WEBHOOK_SECRET) {
    ok('Bounce webhook secret is set');
  } else {
    warn('RESEND_WEBHOOK_SECRET is unset, so bounces and spam complaints are not being recorded',
         'Add a webhook in Resend pointing at /api/webhooks/resend (events: email.bounced, email.complained).');
  }
}

/** Absent APP_ORIGIN means every link in every email is relative, so broken. */
function checkOrigin() {
  const origin = process.env.APP_ORIGIN;
  if (!origin) {
    return fail('APP_ORIGIN is unset',
                'Emails are composed by a background worker with no request to infer an origin from, so every link in them would be relative.');
  }
  if (!/^https?:\/\//.test(origin)) {
    return fail(`APP_ORIGIN is not a URL: ${origin}`, 'Expected e.g. https://we-rewards.com');
  }
  ok(`Links will point at ${origin}`);
}

/** One of each template, to a real inbox, so the rendering can be eyeballed. */
async function sendSamples(to) {
  const samples = [
    ['application received', applicationReceived({ businessName: 'Blue Bird Cafe', contactName: 'Sam', locationCount: 2 })],
    ['application accepted', applicationAccepted({
      businessName: 'Blue Bird Cafe', contactName: 'Sam', email: to,
      locationCount: 2, terminalUrl: `${process.env.APP_ORIGIN ?? ''}/vendor/`,
    })],
    ['vendor reset code', vendorResetCode({
      businessName: 'Blue Bird Cafe', code: 'K7M2-NP94',
      terminalUrl: `${process.env.APP_ORIGIN ?? ''}/vendor/`, selfServe: true,
    })],
    ['deal digest', dealDigest({
      name: 'Alex',
      items: [
        { campaignId: 'c1', vendor: 'Taco Stand', title: 'Half price tacos', body: 'Today only, until we run out.' },
        { campaignId: 'c2', vendor: 'Noodle Bar', title: 'Free drink', body: 'With any bowl, all week.' },
      ],
      appUrl: `${process.env.APP_ORIGIN ?? ''}/?deals=1`,
      unsubscribeUrl: `${process.env.APP_ORIGIN ?? ''}/unsubscribe?u=sample&t=sample`,
    })],
  ];

  console.log(`\nSending ${samples.length} sample emails to ${to} ...`);
  for (const [label, msg] of samples) {
    const res = await sendEmail({
      to,
      subject: `[test] ${msg.subject}`,
      html: msg.html,
      text: msg.text,
      // Transactional for all four, INCLUDING the digest: a sample sent by hand
      // is not marketing, and routing it through the marketing path would let a
      // stale 'marketing' suppression silently swallow the one email you are
      // running this script to see.
      category: 'transactional',
      tags: ['check'],
    });
    if (res.ok) ok(`sent "${label}" (${res.id})`);
    else fail(`could not send "${label}": ${res.reason}${res.status ? ` (HTTP ${res.status})` : ''}`);
  }
  console.log('\nOpen them on a phone as well as a laptop. What to look for: the code is\n'
    + 'readable at arm\'s length, the buttons are tappable, and nothing renders as a\n'
    + 'broken image (there should be no images at all).');
}

/* ---------- run ---------- */

console.log('\nResend configuration\n');

if (!emailEnabled) {
  fail('Email is OFF',
       'Set RESEND_API_KEY and EMAIL_FROM. Without both, applications go unacknowledged, accepted vendors are never told, self-serve resets mint nothing, and deal emails never send.');
} else {
  ok('RESEND_API_KEY and EMAIL_FROM are both set');
  const domain = checkFrom();
  checkOrigin();
  checkWebhook();
  await checkDomain(domain);

  const to = process.argv[2];
  if (to) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) fail(`Not a valid address to send to: ${to}`);
    else await sendSamples(to);
  } else {
    console.log('\n  (pass an address to send one of each template: npm run check:resend -- you@example.com)');
  }
}

console.log(failed ? '\nFAILED\n' : '\nOK\n');
process.exit(failed ? 1 : 0);
