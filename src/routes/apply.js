// Public vendor applications: POST /api/apply from the /join page. No auth — this
// is how a prospective vendor first reaches us — so everything is validated
// hard, the endpoint is tightly rate-limited (server.js), and the row lands in
// vendor_applications (service-role-only) for the operator to accept or reject
// from /admin. The chosen password is stored ONLY as a bcrypt hash; on accept
// it's forwarded to auth.admin.createUser({ password_hash }), so the applicant
// signs in with the password they picked and we never persist the plaintext.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { notifyAdmins } from '../lib/push.js';

const router = Router();

const NAME_MAX = 80;
const EMAIL_MAX = 254;
const ADDRESS_MAX = 300;   // same cap as vendors.address (admin.js / vendor.js)
const MESSAGE_MAX = 500;
// bcrypt only reads the first 72 bytes — refuse longer instead of silently truncating.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const PHONE_RE = /^[\d\s()+.-]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Keep in sync with the logo caps in src/routes/vendor.js — the /join page
// runs the same client-side shrink-to-128px pipeline as the terminal Settings.
const LOGO_MAX_CHARS = 500_000;
const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Validate the raw body → { fields } ready to insert, or { error } to 400. */
function validApplication(body) {
  const b = body ?? {};
  const businessName = String(b.businessName ?? '').trim();
  const contactName = String(b.contactName ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const address = String(b.address ?? '').trim();
  const message = String(b.message ?? '').trim();
  const logo = b.logo == null ? null : String(b.logo);

  if (!businessName || businessName.length > NAME_MAX) return { error: `Business name is required (max ${NAME_MAX} characters).` };
  if (!contactName || contactName.length > NAME_MAX) return { error: `Contact name is required (max ${NAME_MAX} characters).` };
  if (!PHONE_RE.test(phone)) return { error: 'Enter a valid phone number.' };
  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) return { error: 'Enter a valid email address.' };
  if (password.length < PASSWORD_MIN) return { error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { error: `Password must be ${PASSWORD_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
  if (message.length > MESSAGE_MAX) return { error: `Message must be ${MESSAGE_MAX} characters or fewer.` };
  if (logo !== null && (logo.length > LOGO_MAX_CHARS || !LOGO_DATA_URL.test(logo))) {
    return { error: 'Logo image looks invalid — try re-picking it.' };
  }

  return {
    fields: {
      business_name: businessName,
      contact_name: contactName,
      phone,
      email,
      address: address || null,
      message: message || null,
      logo,
    },
    password,
  };
}

/** POST /api/apply — submit a vendor application. */
router.post('/', async (req, res, next) => {
  try {
    const v = validApplication(req.body);
    if (v.error) return res.status(400).json({ error: 'BAD_APPLICATION', message: v.error });

    // If this email already has ANY account (student or vendor login — every
    // auth user gets a profiles row via handle_new_user), an application is a
    // dead end: accept would fail at createUser. Bounce it now with a clear
    // message instead of queueing something the operator can't approve.
    // (% and _ are escaped so they can't act as ilike wildcards.)
    const { data: existing, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('user_id')
      .ilike('email', v.fields.email.replace(/([%_\\])/g, '\\$1'))
      .limit(1);
    if (profErr) throw profErr;
    if (existing?.length) {
      return res.status(409).json({ error: 'EMAIL_IN_USE', message: 'An account with this email already exists.' });
    }

    const { error } = await supabaseAdmin
      .from('vendor_applications')
      .insert({ ...v.fields, password_hash: await bcrypt.hash(v.password, 10) });
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'DUPLICATE_APPLICATION', message: 'An application with this email is already pending — hang tight!' });
      }
      throw error;
    }

    // Alert the operator's subscribed devices. Fire-and-forget: the application
    // is saved either way, and push latency shouldn't delay the applicant's 201.
    notifyAdmins({
      title: 'New vendor application',
      body: `${v.fields.business_name} — ${v.fields.contact_name}`,
      url: '/admin/',
    }).catch(() => {});

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
