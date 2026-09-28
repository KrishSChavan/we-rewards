// Outbound email via Resend — the stack's first and only mail transport.
//
// Modelled deliberately on src/lib/push.js, because the two solve the same
// problem for different channels and every lesson push taught us applies here:
//
//   • FULLY OPTIONAL. With no RESEND_API_KEY the whole module degrades to a
//     silent no-op, so a local checkout with no keys runs unchanged and nothing
//     on a request path fails because mail is unconfigured.
//   • NEVER THROWS. Every send resolves to { ok, ... }. A vendor application
//     must not 500 because a mail API had a bad minute — the row is already
//     written, and the operator's push alert already fired.
//   • DEAD ADDRESSES ARE PRUNED. push.js drops an endpoint on 404/410/401/403
//     because paying for a send that can never land is worse than not sending.
//     The email equivalent is the suppression list: a hard bounce or a spam
//     complaint (delivered by Resend's webhook, src/routes/webhooks.js) writes
//     a row here and every later send to that address is refused locally,
//     without a network call.
//
// ---- Why raw fetch and not the `resend` SDK ----
// Same call this repo already makes to Google (src/lib/gemini-receipt.js): one
// POST with a bearer token and a JSON body. The SDK adds a dependency, a
// release cadence, and its own error taxonomy to wrap in ours anyway.
//
// ---- The two classes of mail, and why they are not the same ----
// TRANSACTIONAL  — a password reset code, "your application was accepted".
//   The recipient asked for it by doing something. It is sent even to someone
//   who unsubscribed from marketing, and it carries no unsubscribe footer,
//   because "stop telling me my password changed" is not an option we offer.
// MARKETING      — deal emails to students.
//   Sent only to a live opt-in, always carries List-Unsubscribe (both the
//   mailto and the one-click POST form — Gmail and Yahoo require them of bulk
//   senders, and their absence is by itself a spam-folder signal), and is
//   refused for any address on the suppression list at any scope.
//
// The distinction lives in `category`, and getting it wrong is a real harm in
// one direction (marketing to someone who opted out) and a broken product in
// the other (swallowing a reset code because they muted deals). It is therefore
// a required-by-convention argument with a transactional default: the safe
// failure is sending a password reset, not sending an advert.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

const API_URL = 'https://api.resend.com/emails';

const API_KEY = process.env.RESEND_API_KEY || '';
// Resend requires a verified domain. `WeRewards <hello@we-rewards.com>` — the
// display name matters more than it looks: a bare address in the From line is
// one of the cheapest spam signals there is.
const FROM = process.env.EMAIL_FROM || '';
// Where a vendor's reply goes. Optional, and worth setting: a transactional
// address that bounces replies teaches people the sender is a robot they cannot
// reach, which is exactly when they reach for "report spam" instead.
const REPLY_TO = process.env.EMAIL_REPLY_TO || '';
// Public origin for links inside an email. Unlike the QR-poster code this has
// NO request to fall back on — the campaign worker sends from a timer — so an
// unset APP_ORIGIN is a real misconfiguration, warned about at boot.
const ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/+$/, '');

// Tighter than Gemini's because nothing is waiting on the answer: every caller
// here either already responded or is a background worker. A slow mail API
// should cost one queued email, not a held request.
const TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS) || 10_000;

/** Config gate. Both halves are needed — a key with no From address cannot send. */
export const emailEnabled = Boolean(API_KEY && FROM);

if (emailEnabled && !ORIGIN) {
  console.warn('[email] APP_ORIGIN is unset — links in outgoing mail will be relative and will not work. Set it.');
}

/**
 * Does this look like something Resend will accept in `from` / `reply_to`?
 *
 * Both forms are legal and both are in use: a bare `hello@we-rewards.com`, and a
 * display name with the address in angle brackets, `WeRewards <hello@we-rewards.com>`
 * (which is the one we want — see the FROM note above about bare addresses being
 * a cheap spam signal). The inner address test is deliberately the same loose
 * shape sendEmail applies to a recipient below: the authority on whether an
 * address exists is Resend, not us, and all we are trying to catch here is a
 * typo, a stray quote, or a value someone pasted with the variable name attached.
 *
 * The last two of those three need their own guards, because the shape tests
 * below cannot see them — see the comments inside. Both guards only ever turn a
 * silent pass into the boot warning below, never the reverse, so neither can
 * suppress a warning that fires today.
 */
function looksLikeSenderLine(value) {
  const s = String(value ?? '').trim();
  // PASTED WITH THE VARIABLE NAME STILL ATTACHED — `EMAIL_FROM=hello@we-rewards.com`
  // or `EMAIL_FROM=WeRewards <hello@we-rewards.com>`. Neither is visible to the two
  // regexps that follow: in the bare form `EMAIL_FROM=hello` is just a local part
  // with no whitespace and no '@' in it, and in the angled form the display-name
  // group [^<>]* happily swallows the `EMAIL_FROM=` prefix before the address group
  // is reached. Anchored to an identifier-then-'=' rather than a bare /=/ test so it
  // cannot fire on a legal (if odd) address whose local part contains '=' — RFC 5322
  // atext permits it — and because a display name never starts that way either. A
  // false warning here would be a lie in the one place this module is trusted: the
  // Heroku boot log.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(s)) return false;
  const angled = /^[^<>]*<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/.exec(s);
  // A STRAY QUOTE around a bare address — `"hello@we-rewards.com"` — likewise slips
  // through: the quotes sit inside the [^\s@]+ runs on either side of the '@'. Only
  // the bare branch is screened, because a quoted display name IS legal in the angled
  // form (`"WeRewards, Inc." <hello@we-rewards.com>`) and must keep passing.
  if (!angled && /["']/.test(s)) return false;
  const address = angled ? angled[1] : s;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

// A MALFORMED SENDER IS A SILENT, TOTAL MAIL OUTAGE, SO SAY SO AT BOOT.
//
// This deliberately does NOT throw and does NOT feed into emailEnabled: the
// module's contract is that mail never fails a request path, and flipping the
// gate would change what every `{ ok: false, reason }` in the app means. But it
// must not stay quiet either. EMAIL_FROM and EMAIL_REPLY_TO go to Resend exactly
// as the environment hands them over — FROM is only truthiness-checked above and
// REPLY_TO is never checked at all — and Resend answers a bad one with a 422
// whose body reads "Invalid `from` field. ...". That is indistinguishable at the
// HTTP layer from a bad recipient, every caller swallows a failed send, and so
// the only symptom of one typo'd config var is every password reset and sign-in
// code in the system quietly never arriving. One loud line in the Heroku log at
// boot is the whole difference between a five-minute fix and a multi-hour outage
// nobody can explain. Both checks are gated on emailEnabled so a local checkout
// with no keys still boots silently, as the header promises.
if (emailEnabled && !looksLikeSenderLine(FROM)) {
  console.warn(`[email] EMAIL_FROM is not a usable sender line (${JSON.stringify(FROM)}) — Resend will reject EVERY send with a 422 and no mail will be delivered. Use "WeRewards <hello@we-rewards.com>" or a bare address on the verified domain.`);
}
if (emailEnabled && REPLY_TO && !looksLikeSenderLine(REPLY_TO)) {
  console.warn(`[email] EMAIL_REPLY_TO is not a usable address (${JSON.stringify(REPLY_TO)}) — it is sent verbatim, so Resend will reject EVERY send with a 422. Unset it or fix it.`);
}

/** The verified From line, or null when mail is off. Used by scripts/check-resend.js. */
export function emailFrom() {
  return emailEnabled ? FROM : null;
}

/**
 * Absolute URL for a path, for use inside an email.
 *
 * `req` is accepted so a request-path caller (an application confirmation) can
 * reuse the origin the browser actually reached us on, exactly as vendor.js does
 * for QR links. Background callers pass nothing and get APP_ORIGIN.
 */
export function emailUrl(pathname = '/', req = null) {
  const base = ORIGIN || (req ? `${req.protocol}://${req.get('host')}` : '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${p}`;
}

/**
 * `k****n@gmail.com`. Server logs are read by people debugging deliverability,
 * who need to tell two recipients apart without the log itself becoming a
 * mailing list — the same reason gemini-receipt.js may not log a receipt.
 */
export function maskEmail(address) {
  const s = String(address ?? '');
  const at = s.indexOf('@');
  if (at < 1) return '(invalid)';
  const user = s.slice(0, at);
  const domain = s.slice(at);
  if (user.length <= 2) return `${user[0]}*${domain}`;
  return `${user[0]}${'*'.repeat(Math.min(user.length - 2, 5))}${user[user.length - 1]}${domain}`;
}

/* ---------- the suppression list ---------- */

// 'all'       — the address is dead or its owner reported us. Nothing goes to
//               it again, transactional included: a hard bounce means there is
//               no mailbox, and continuing to send to one is precisely what
//               burns a sending domain's reputation.
// 'marketing' — no deals, but transactional mail still lands. Written when a
//               student uses one-click unsubscribe from a mail client, which is
//               a statement about adverts, not about their account.
const SCOPE_ALL = 'all';

/**
 * Is this address refused, for this class of mail?
 *
 * One indexed primary-key lookup per send. Deliberately not cached: the whole
 * point of the list is that a complaint stops the NEXT send, and a five-minute
 * cache would mean five more minutes of mailing someone who just told a mail
 * provider we are spam. Volume here is hundreds a day, not millions.
 *
 * A failed lookup returns false — send anyway. The alternative (fail closed)
 * would let one database hiccup silently mute every password reset in the
 * system, which is a far worse outcome than one email to a stale address.
 */
export async function isSuppressed(address, { marketing = false } = {}) {
  const email = String(address ?? '').trim().toLowerCase();
  if (!email) return false;
  const { data, error } = await supabaseAdmin
    .from('email_suppressions')
    .select('scope')
    .eq('email', email)
    .maybeSingle();
  if (error) {
    console.warn(`[email] suppression lookup failed for ${maskEmail(email)}: ${error.message}`);
    return false;
  }
  if (!data) return false;
  return data.scope === SCOPE_ALL || marketing;
}

/**
 * Add an address to the list. Idempotent, and ESCALATING: a row already at
 * 'all' is never downgraded to 'marketing' by a later unsubscribe, because a
 * bounce is a fact about the mailbox and an unsubscribe is a preference — the
 * fact wins.
 */
export async function suppress(address, reason, scope = SCOPE_ALL) {
  const email = String(address ?? '').trim().toLowerCase();
  if (!email) return false;
  const { error } = await supabaseAdmin.rpc('email_suppress', {
    p_email: email,
    p_reason: String(reason ?? 'unknown').slice(0, 80),
    p_scope: scope === SCOPE_ALL ? SCOPE_ALL : 'marketing',
  });
  if (error) {
    console.warn(`[email] could not suppress ${maskEmail(email)}: ${error.message}`);
    return false;
  }
  return true;
}

/* ---------- one-click unsubscribe ---------- */

// HMAC over the user id, so an unsubscribe link needs no table, survives a
// restart, and cannot be walked from one student to the next by editing a uuid
// in the URL. Rotating the secret invalidates every outstanding link, which is
// the intended lever if one is ever abused.
//
// Falls back to the service-role key because that value is already required,
// already secret, and already fatal to leak — a deployment cannot accidentally
// end up with an *empty* signing key this way, which is the failure that would
// make every token forgeable.
const UNSUB_SECRET = process.env.EMAIL_UNSUB_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** Stable per-student token. Same input, same token, forever. */
export function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update(`unsub:${userId}`)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * Constant-time check. Type-gated, shape-gated and then BYTE-length-guarded, because
 * crypto.timingSafeEqual THROWS a RangeError on a length mismatch rather than
 * returning false.
 *
 * THE GUARD HAS TO BE ON THE BYTES, NOT ON String#length, and the difference is
 * not academic. String#length counts UTF-16 code units; timingSafeEqual compares
 * the utf8 buffers. `'A'.repeat(31) + 'é'` is 32 characters and 33 bytes, so the
 * old `got.length !== expected.length` guard waved it through and the RangeError
 * escaped — into src/routes/unsubscribe.js authorize(), which has no try/catch of
 * its own, so both the GET and the one-click POST handler passed it to next(err).
 * The global handler in server.js has no branch for a RangeError, so it landed in
 * logError: an error_logs insert AND a web-push alert to every subscribed
 * operator, then a 500 JSON body. That 500 is wrong twice over — the human GET
 * path meant to render a 400 HTML page, and on the RFC 8058 one-click POST path a
 * non-2xx is exactly what makes Gmail record the unsubscribe as broken and stop
 * offering the button (see the List-Unsubscribe-Post note in sendEmail below).
 * And /unsubscribe mounts ahead of every limiter — generalLimiter is scoped to
 * /api — so a 33-byte query string was an unauthenticated, unthrottled way to
 * page every admin as fast as curl can loop.
 *
 * AND THE TYPE GATE COMES BEFORE THE COERCION, for the same harm by a second
 * route. The first version of this fix put the shape test after
 * `String(token ?? '')`, which left that identical 500 reachable one frame
 * earlier: express 4's default query parser is qs.parse(str, { allowPrototypes:
 * true }) (node_modules/express/lib/utils.js), so `?t[toString]=x` arrives as the
 * OBJECT { toString: 'x' } — an own, non-callable property shadowing
 * Object.prototype.toString — and `String(...)` on it throws "TypeError: Cannot
 * convert object to primitive value" before any guard here runs. Precisely which
 * shapes do that is worth being exact about, because it is the whole reason the
 * gate is a `typeof` and not a truthiness check: an own non-callable `toString`
 * is the throwing case, and so is a genuinely null-prototype object (there is no
 * inherited toString/valueOf left to call) — but qs does NOT hand you one of
 * those. On the installed qs 6.15.3, `?t[__proto__]=x` comes back as an ORDINARY
 * object with Object.prototype and no own keys, and every other object shape
 * (`?t[valueOf]=x`, `?t[a]=x`) coerces quietly to "[object Object]", which would
 * have failed the regexp below as a wrong token rather than throwing.
 *
 * So this function refuses a non-string outright, on its first line, before
 * touching either argument: it is total for every input — BOTH parameters are gated, not
 * just the token, because `unsubscribeToken` interpolates userId into a template
 * literal and that coercion throws on exactly the shapes above. After the gates
 * the only things left are real strings. src/routes/unsubscribe.js authorize()
 * also drops non-string query params to '' — belt and braces, because the route
 * is the frame that actually lands in logError, and because nothing should be
 * able to re-open that hole by adding one more coercion in front of a call to
 * this function.
 *
 * The shape test is a cheap first gate that leaks nothing timing-wise: the
 * token's length and its base64url alphabet are both public, stated by every
 * link we send. Only the comparison against the real HMAC is timing-sensitive,
 * and that still happens in constant time.
 */
export function verifyUnsubscribeToken(userId, token) {
  // No coercion above this line. See the TYPE GATE note above: coercing an object
  // with an own non-callable `toString` — or a null-prototype one — throws a
  // TypeError, and this function exists precisely so that a hostile value can
  // never throw anything at its callers. userId is gated too, not just token:
  // unsubscribeToken() below coerces it inside `unsub:${userId}`, so a non-string
  // there throws from a frame that has no guard of its own. Every live caller
  // (authorize() in src/routes/unsubscribe.js) already requires a uuid, so
  // refusing a non-string userId rejects nothing legitimate.
  if (typeof token !== 'string' || typeof userId !== 'string') return false;
  const got = token;
  // 32 characters from the base64url alphabet — exactly what unsubscribeToken()
  // produces. This also means both buffers below are single-byte-per-character.
  if (!/^[A-Za-z0-9_-]{32}$/.test(got)) return false;
  const a = Buffer.from(unsubscribeToken(userId));
  const b = Buffer.from(got);
  // Kept even though the regexp above already forces equal byte lengths: this is
  // the invariant timingSafeEqual actually needs, and no later change to the
  // token format should be able to silently remove it.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The link that goes in a deal email's footer and its List-Unsubscribe header. */
export function unsubscribeUrl(userId) {
  return emailUrl(`/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`);
}

/* ---------- the send ---------- */

// WHICH 422 IS THE RECIPIENT'S FAULT, AND WHICH IS OURS.
//
// Resend names the offending field in the message, and the FIELD NAME is what we
// key on rather than the surrounding prose, because the prose overlaps. Its
// sender error is "Invalid `from` field. The email address needs to follow the
// `email@example.com` or `Name <email@example.com>` format." — note "to follow",
// which a bare /\bto\b/ would have read as a recipient error and so re-created
// exactly the bug this narrowing exists to close. `reply_to` is excluded for the
// same reason and by its own name: the substring "to" inside it means nothing.
const RECIPIENT_FIELD_RE = /`to`|"to"|'to'|\bto field\b|\brecipients?\b/i;
const SENDER_FIELD_RE = /`from`|"from"|'from'|\bfrom field\b|`reply_to`|\breply[_-]?to\b/i;

/**
 * Send one email. Never throws; resolves to { ok, id } or { ok, reason }.
 *
 * @param {object}  msg
 * @param {string}  msg.to        recipient address
 * @param {string}  msg.subject
 * @param {string}  msg.html
 * @param {string}  msg.text      plain-text alternative. NOT optional in
 *   practice: a multipart message with no text part is scored as spam by
 *   basically every filter, so templates always produce both.
 * @param {'transactional'|'marketing'} [msg.category]
 * @param {string}  [msg.unsubscribeUrl]  marketing only; adds List-Unsubscribe
 * @param {string}  [msg.idempotencyKey]  Resend de-dupes on this for 24h, which
 *   is what makes a retried accept (or a double-clicked button) safe to send.
 * @param {string[]} [msg.tags]   Resend tag values for its own dashboard
 * @returns {Promise<{ok: boolean, id?: string, reason?: string, status?: number}>}
 */
export async function sendEmail(msg) {
  const to = String(msg?.to ?? '').trim().toLowerCase();
  const marketing = msg?.category === 'marketing';

  if (!emailEnabled) return { ok: false, reason: 'disabled' };
  // A local guard, not a validator: Resend rejects a malformed address anyway,
  // but doing it here means a typo'd row costs no API call and no rate budget.
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, reason: 'invalid_to' };
  if (!msg?.subject || !msg?.html) return { ok: false, reason: 'empty' };

  if (await isSuppressed(to, { marketing })) {
    return { ok: false, reason: 'suppressed' };
  }

  const headers = { ...(msg.headers ?? {}) };
  if (marketing && msg.unsubscribeUrl) {
    // Both forms, because they do different jobs. The mailto is the fallback
    // every client has understood for twenty years; List-Unsubscribe-Post is
    // what turns Gmail's header into a one-tap "Unsubscribe" button that never
    // opens our page — and its absence is what makes people press "Report spam"
    // to achieve the same thing.
    headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const body = {
    from: FROM,
    to: [to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text ?? '',
  };
  if (REPLY_TO) body.reply_to = REPLY_TO;
  if (Object.keys(headers).length) body.headers = headers;
  if (msg.tags?.length) {
    // Resend's tag values are restricted to ASCII letters, digits, _ and -.
    body.tags = msg.tags.slice(0, 5).map((t) => ({
      name: 'category',
      value: String(t).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60),
    }));
  }

  const reqHeaders = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (msg.idempotencyKey) reqHeaders['Idempotency-Key'] = String(msg.idempotencyKey).slice(0, 256);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // A 422 that actually NAMES THE RECIPIENT is the address itself: Resend
      // validates syntax and known-invalid domains before accepting, so the
      // student typed it wrong at signup, it will never work, and retrying it
      // forever is how a domain's bounce rate climbs. Suppress that one.
      //
      // Requiring the recipient to be named is load-bearing, not tidiness. `to`
      // was already validated locally above, BEFORE any request was made, so a
      // 422 arriving here is far more likely to be about the shape of the
      // REQUEST than about the mailbox: `from` is raw EMAIL_FROM and `reply_to`
      // is raw EMAIL_REPLY_TO, both sent verbatim (which is why they are now
      // format-warned at boot, next to emailEnabled). Resend's answer to a bad
      // sender is a 422 containing the word "Invalid", so the old
      // wording-only test matched it — and one typo'd env var then suppressed at
      // scope 'all' EVERY address mailed while the config was wrong. That is
      // effectively permanent: both deletes of email_suppressions are filtered
      // to scope='marketing', and prune_email_suppressions is not scheduled
      // anywhere, so nothing ever removes those rows. Callers swallow the failure
      // (vendor-recover still answers ACCEPTED, student-email still returns
      // ok:true), so the only symptom was password resets and sign-in codes
      // dying silently, for good, for real people.
      //
      // Narrowing it costs us nothing real, and this is the reason it is safe:
      // the AUTHORITATIVE signal that a mailbox is dead is the hard bounce or
      // spam complaint Resend delivers to our webhook (src/routes/webhooks.js),
      // which calls suppress() itself and is the only other caller. This branch
      // was never more than a cheap head start on that webhook.
      if (
        res.status === 422
        && /invalid|not.*valid/i.test(detail)
        && RECIPIENT_FIELD_RE.test(detail)
        && !SENDER_FIELD_RE.test(detail)
      ) {
        await suppress(to, 'invalid_address', SCOPE_ALL);
      }
      console.warn(`[email] send failed (${res.status}) to ${maskEmail(to)}: ${detail.slice(0, 300)}`);
      return { ok: false, reason: 'http', status: res.status };
    }

    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network';
    console.warn(`[email] send ${reason} to ${maskEmail(to)}: ${err?.message ?? err}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
