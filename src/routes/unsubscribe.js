// Public unsubscribe, for the link in the footer of every deal email and for the
// List-Unsubscribe header that turns it into Gmail's one-tap button.
//
// UNAUTHENTICATED BY NECESSITY. Someone acting on "stop emailing me" is often
// doing it from a mail client on a device that has never signed into the app,
// and a sign-in wall between a person and that decision is exactly what makes
// them press "Report spam" instead. So the link carries its own proof: an HMAC
// over the user id (src/lib/email.js), which cannot be walked from one student
// to the next by editing the uuid, and which needs no table to verify.
//
// ---- Why GET acts, rather than showing a "click here to confirm" page ----
// A GET that changes state can be triggered by a link scanner prefetching the
// message, and some corporate mail gateways do exactly that. The alternative is
// a confirm button, which costs a click at the precise moment someone is
// already annoyed. We take the scanner risk, because the failure modes are not
// symmetric: a spuriously unsubscribed student loses deal emails and can undo it
// from the page itself or from Account, while a student who cannot make the
// emails stop reports us as spam and takes the whole sending domain down with
// them. The page therefore leads with an undo.
//
// ---- Why this router mounts before requireJson ----
// One-click unsubscribe (RFC 8058) is a POST with
// `Content-Type: application/x-www-form-urlencoded` and the body
// `List-Unsubscribe=One-Click`. The global JSON-only gate in server.js would
// answer that 415, Gmail would record a failed unsubscribe, and the button
// would stop being offered. Everything this router needs is in the query
// string, so the body is never read at all.

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { verifyUnsubscribeToken, maskEmail } from '../lib/email.js';
import { isUuid } from '../lib/ids.js';

const router = Router();

const BRAND = '#12294b';
const INK = '#101d33';
const MUTED = '#5b6a80';
const PAGE = '#f4f6fa';

/** A tiny self-contained page. No build step, no assets, no JS. */
function page({ title, message, action = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title} · WeRewards</title>
</head>
<body style="margin:0;background:${PAGE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:56px 20px;text-align:center;">
    <p style="font-size:14px;font-weight:700;letter-spacing:3px;color:${BRAND};margin:0 0 28px 0;">WEREWARDS</p>
    <div style="background:#fff;border:1px solid #dde3ec;border-radius:14px;padding:32px;">
      <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:${INK};">${title}</h1>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:${MUTED};">${message}</p>
      ${action}
    </div>
  </div>
</body>
</html>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;padding:12px 24px;background:${BRAND};color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">${label}</a>`;
}

/**
 * Check the link's own proof. Returns the user id, or null.
 *
 * The uuid shape is checked first so a malformed id is a clean 400 rather than
 * a database error, matching how every other route in this app handles one.
 */
function authorize(req) {
  const userId = String(req.query.u ?? '');
  const token = String(req.query.t ?? '');
  if (!isUuid(userId) || !token) return null;
  return verifyUnsubscribeToken(userId, token) ? userId : null;
}

/**
 * Flip the student's email switch, and mirror it onto the suppression list.
 *
 * BOTH, deliberately. The flag is what the claim in migration-047 reads and what
 * the Account screen renders, so it is the authority. The suppression row is the
 * backstop: it is keyed by ADDRESS, so it keeps working if the profile row is
 * ever out of step, and it is what makes "stop" true for anything that resolves
 * a recipient by address rather than by user id.
 */
async function setEmailOptIn(userId, on) {
  const { error } = await supabaseAdmin
    .from('student_notify_state')
    .upsert({ user_id: userId, email_opt_in: on, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' });
  if (error) throw error;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('email')
    .eq('user_id', userId)
    .maybeSingle();
  const address = String(profile?.email ?? '').trim().toLowerCase();
  if (!address) return;

  if (on) {
    // Only the marketing scope. A row at 'all' is a hard bounce or a spam
    // complaint — a fact about the mailbox — and a student pressing "undo" on a
    // web page does not repair a mailbox.
    await supabaseAdmin
      .from('email_suppressions')
      .delete()
      .eq('email', address)
      .eq('scope', 'marketing');
  } else {
    await supabaseAdmin.rpc('email_suppress', {
      p_email: address,
      p_reason: 'unsubscribed',
      p_scope: 'marketing',
    });
  }
  console.log(`[email] deal emails ${on ? 'on' : 'off'} for ${maskEmail(address)}`);
}

/**
 * POST /unsubscribe?u=…&t=…
 * RFC 8058 one-click. The mail client wants a 2xx and nothing else; it renders
 * its own confirmation and never shows a body.
 */
router.post('/', async (req, res, next) => {
  try {
    const userId = authorize(req);
    // A bad token still gets a 200. The client is a mail provider, not a person:
    // a non-2xx here makes Gmail mark one-click as broken and stop offering the
    // button at all, which is a worse outcome than silently ignoring a link
    // somebody tampered with.
    if (!userId) return res.status(200).end();
    await setEmailOptIn(userId, false);
    res.status(200).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /unsubscribe?u=…&t=…[&resubscribe=1]
 * The human path: acts immediately, then offers the reverse.
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = authorize(req);
    if (!userId) {
      return res.status(400).type('html').send(page({
        title: 'That link didn’t work',
        message: 'It may have been cut in half by your email app. You can turn deal emails off in the app under Account, Notifications.',
        action: button('/', 'Open WeRewards'),
      }));
    }

    const on = req.query.resubscribe === '1';
    await setEmailOptIn(userId, on);

    if (on) {
      return res.type('html').send(page({
        title: 'Deal emails are back on',
        message: 'We’ll let you know when a spot you go to has something on. At most twice a day, never at night.',
        action: button('/', 'Open WeRewards'),
      }));
    }

    const undo = `/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(String(req.query.t))}&resubscribe=1`;
    res.type('html').send(page({
      title: 'You’re unsubscribed',
      message: 'No more deal emails. Your points, your account and anything you need to be told about them are unaffected, and deals still show up in the app.',
      action: button(undo, 'Undo, keep them coming'),
    }));
  } catch (err) {
    next(err);
  }
});

export default router;
