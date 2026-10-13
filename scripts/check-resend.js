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

// DYNAMIC, and wrapped, for one reason: src/lib/email.js imports
// src/lib/supabase.js at module scope (the suppression list lives in the
// database), and supabase.js THROWS AT IMPORT when SUPABASE_URL and friends are
// unset. With a static import here, the only thing a developer without a .env
// ever sees from this script is a Supabase stack trace that names neither this
// script nor the thing it actually wants -- which sends people to look at the
// database when the answer is "copy .env.example". Top-level await is available
// (this package is type: module).
//
// check-gemini, check-posthog and check-stripe do not need this: their modules
// reach nothing that reads the database.
let emailEnabled; let emailFrom; let sendEmail;
let applicationReceived; let applicationAccepted; let vendorResetCode; let dealDigest;
let pointsReminder; let announcement;
try {
  ({ emailEnabled, emailFrom, sendEmail } = await import('../src/lib/email.js'));
  ({
    applicationReceived, applicationAccepted, vendorResetCode, dealDigest,
    pointsReminder, announcement,
  } = await import('../src/lib/email-templates.js'));
} catch (err) {
  console.error('\nResend configuration\n');
  console.error(`  FAIL  Could not load the mail modules: ${err?.message ?? err}`);
  console.error('        This script reads the same env the server does, so a missing .env stops it');
  console.error('        before any check runs. If the message above names SUPABASE_*, that is all');
  console.error('        this is: cp .env.example .env and fill it in.');
  console.error('');
  console.error('        To check PROD config without a local .env:');
  console.error('          set -a; eval "$(heroku config -s -a we-rewards)"; set +a');
  console.error('          npm run check:resend');
  console.error('');
  console.error('        That shell then holds prod secrets. Do not run npm test or a deploy from');
  console.error('        it: POSTHOG_API_KEY being set fails a test, and the deploy preflight runs');
  console.error('        the tests, so it would block the deploy for a reason nothing explains.\n');
  // Safe here, unlike at the foot of this file: no fetch is in flight yet, so
  // there are no handles mid-unwind to trip the libuv assertion that note
  // describes.
  process.exit(1);
}

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
 * The From line has to be a verified sender on a verified domain. Three
 * mistakes are common enough to be worth naming separately: a bare address with
 * no display name (a real deliverability signal, not a style note), an
 * onboarding@resend.dev left in from the quickstart, which can only ever mail
 * the account owner and looks fine right up until a real vendor applies, and a
 * noreply sender with nowhere for a reply to go.
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

  // A NOREPLY SENDER WITH NO REPLY-TO, which is the one combination that makes
  // mail measurably more likely to be filtered rather than less. Replies are a
  // positive engagement signal, and src/lib/email.js says so where REPLY_TO is
  // read: an address that bounces replies "teaches people the sender is a robot
  // they cannot reach, which is exactly when they press Report spam instead".
  //
  // A FAIL rather than a warn, because this is silent and permanent. Nothing
  // errors, no student or vendor sees anything, and the only symptom is a slow
  // reputation decline on the domain every password reset also goes out on.
  // Setting EMAIL_REPLY_TO to any monitored mailbox clears it; the address does
  // not have to be on the sending domain.
  if (/^(no-?reply|do-?not-?reply|noreply)@/i.test(address)) {
    const replyTo = (process.env.EMAIL_REPLY_TO || '').trim();
    if (!replyTo) {
      fail(`EMAIL_FROM is a noreply address with no EMAIL_REPLY_TO: ${address}`,
           'Set EMAIL_REPLY_TO to a mailbox somebody reads. A sender nobody can reply to is read as bulk mail.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
      fail(`EMAIL_REPLY_TO is not a usable address: ${replyTo}`,
           'It is the only way a reply reaches a human, because EMAIL_FROM is a noreply address.');
    } else {
      ok(`Reply-To: ${replyTo} (required, because From is a noreply address)`);
    }
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
      locationCount: 2, terminalUrl: `${process.env.APP_ORIGIN ?? ''}/terminal/`,
    })],
    ['vendor reset code', vendorResetCode({
      businessName: 'Blue Bird Cafe', code: 'K7M2-NP94',
      terminalUrl: `${process.env.APP_ORIGIN ?? ''}/terminal/`, selfServe: true,
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
    // migration-064. The 'close' tier because it is the one with a shortfall in
    // it, which is the sentence most worth reading in a real inbox.
    ['points reminder', pointsReminder({
      name: 'Alex', kind: 'close', vendorName: 'Noodle Bar',
      rewardTitle: 'a free bowl', shortfall: 40,
      appUrl: `${process.env.APP_ORIGIN ?? ''}/?spot=sample`,
      unsubscribeUrl: `${process.env.APP_ORIGIN ?? ''}/unsubscribe?u=sample&t=sample`,
    })],
    ['announcement', announcement({
      name: 'Alex', title: 'Six new spots just joined',
      body: 'Four cafes and two sandwich places are giving points from today.',
      appUrl: `${process.env.APP_ORIGIN ?? ''}/?spots=1`,
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
// Set the code rather than calling process.exit(): exiting while the fetch
// handles are still unwinding trips a libuv assertion on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), which prints a
// scary crash after a perfectly good report AND replaces the exit code with 9 —
// so a PASSING check reads as a failing one. scripts/check-gemini.js already
// carries this note; this script and check-posthog.js were the two that had not
// been given the same treatment.
process.exitCode = failed ? 1 : 0;
