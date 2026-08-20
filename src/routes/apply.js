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
import { normalizeCuisine, normalizePriceLevel } from '../lib/cuisines.js';
import { validLogo } from '../lib/logo.js';

const router = Router();

const NAME_MAX = 80;
const EMAIL_MAX = 254;
const ADDRESS_MAX = 300;   // same cap as vendors.address (admin.js / vendor.js)
const LABEL_MAX = 40;      // same cap as vendors.location_label (admin.js / vendor.js)
const MESSAGE_MAX = 500;
// One application can name several locations (migration-043). The cap is a
// sanity bound on a public, unauthenticated endpoint, not a product limit: a
// chain with more stores than this applies twice, and the second application
// links to the same login the first one made.
const MAX_LOCATIONS = 12;
// bcrypt only reads the first 72 bytes — refuse longer instead of silently truncating.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const PHONE_RE = /^[\d\s()+.-]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;



/**
 * Validate ONE additional location (locations[1..]) → { location } or { error }.
 * Location one is the application's own columns and is validated inline below;
 * these are the extra branches a multi-location owner named on the same form.
 *
 * Only `name` is required, for the same reason it is the only required field on
 * location one: the operator can fill a gap from /admin after accepting, and an
 * applicant must never be bounced off a public form over a field that only
 * decides which filter chips their spot answers to.
 *
 * WHAT THE SHOP SELLS IS INHERITED. cuisine, price level and logo fall back to
 * location one's when the caller doesn't send them, because a chain is a chain:
 * the branches of one business sell the same food at the same prices under the
 * same artwork, and /join asks for all three exactly once as a result. Sending
 * them explicitly still overrides, so a genuinely different second brand under
 * one login is expressible; and the operator can edit any of it afterwards.
 *
 * @param {number} i  zero-based index within `locations`, so the message can say
 *   WHICH one is wrong, counting the application's own location as 1.
 * @param {object} parent  location one's already-validated cuisine/price/logo
 */
function validLocation(raw, i, parent) {
  const at = `Location ${i + 2}`;   // +2: zero-based, and location one is the row itself
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} is not filled in.` };

  const name = String(raw.name ?? '').trim();
  const label = String(raw.locationLabel ?? '').trim();
  const address = String(raw.address ?? '').trim();
  // hasOwnProperty, not a null check: null and '' are how a caller says "this
  // branch has no logo", which must not silently inherit location one's.
  const ownLogo = Object.prototype.hasOwnProperty.call(raw, 'logo');
  const logo = ownLogo ? validLogo(raw.logo) : { value: parent.logo };

  if (!name || name.length > NAME_MAX) return { error: `${at}: enter a business name (max ${NAME_MAX} characters).` };
  if (label.length > LABEL_MAX) return { error: `${at}: the location name must be ${LABEL_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `${at}: the address must be ${ADDRESS_MAX} characters or fewer.` };
  if (logo.error) return { error: `${at}: ${logo.error}` };

  return {
    location: {
      name,
      locationLabel: label || null,
      address: address || null,
      logo: logo.value,
      cuisine: raw.cuisine != null ? normalizeCuisine(raw.cuisine) : parent.cuisine,
      priceLevel: raw.priceLevel !== undefined ? normalizePriceLevel(raw.priceLevel) : parent.priceLevel,
    },
  };
}

/**
 * Validate the raw body → { fields } ready to insert, or { error } to 400.
 *
 * Exported for the unit tests, which hold it to parity with validNewVendor in
 * src/routes/admin.js — the two doors onto the same onboarding must not drift
 * into accepting different things.
 */
export function validApplication(body) {
  const b = body ?? {};
  const businessName = String(b.businessName ?? '').trim();
  const contactName = String(b.contactName ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const address = String(b.address ?? '').trim();
  const locationLabel = String(b.locationLabel ?? '').trim();
  const message = String(b.message ?? '').trim();
  const logo = validLogo(b.logo);

  if (!businessName || businessName.length > NAME_MAX) return { error: `Business name is required (max ${NAME_MAX} characters).` };
  if (!contactName || contactName.length > NAME_MAX) return { error: `Contact name is required (max ${NAME_MAX} characters).` };
  if (!PHONE_RE.test(phone)) return { error: 'Enter a valid phone number.' };
  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) return { error: 'Enter a valid email address.' };
  if (password.length < PASSWORD_MIN) return { error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { error: `Password must be ${PASSWORD_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
  if (locationLabel.length > LABEL_MAX) return { error: `The location name must be ${LABEL_MAX} characters or fewer.` };
  if (message.length > MESSAGE_MAX) return { error: `Message must be ${MESSAGE_MAX} characters or fewer.` };
  if (logo.error) return { error: logo.error };

  // Locations two and up (migration-043). Absent or [] is the single-location
  // application this endpoint has always taken, and lands as the column default.
  const extra = b.locations ?? [];
  if (!Array.isArray(extra)) return { error: 'Locations must be a list.' };
  if (extra.length + 1 > MAX_LOCATIONS) {
    return { error: `You can apply for up to ${MAX_LOCATIONS} locations at once. Send the rest as a second application with this same email.` };
  }
  // What location one sells, for the branches that don't say (see validLocation).
  const parent = {
    cuisine: normalizeCuisine(b.cuisine),
    priceLevel: normalizePriceLevel(b.priceLevel),
    logo: logo.value,
  };
  const locations = [];
  for (let i = 0; i < extra.length; i++) {
    const l = validLocation(extra[i], i, parent);
    if (l.error) return { error: l.error };
    locations.push(l.location);
  }

  return {
    fields: {
      business_name: businessName,
      contact_name: contactName,
      phone,
      email,
      address: address || null,
      message: message || null,
      logo: logo.value,
      // Optional, and never a reason to bounce an application (migration-042).
      // Everything above this line is something we need in order to reach the
      // applicant or create their login; these two only decide which filter
      // chips their spot answers to, and an applicant who skips them — or an
      // older cached /join page that doesn't ask — still onboards fine and can
      // be tagged from /admin afterwards.
      cuisine: parent.cuisine,
      price_level: parent.priceLevel,
      // Which branch the row above IS, and every other branch the same owner is
      // applying for in one go (migration-043). Both stay null/[] for the
      // single-location application that is still the common case.
      location_label: locationLabel || null,
      locations,
    },
    password,
  };
}

/** POST /api/apply — submit a vendor application. */
router.post('/', async (req, res, next) => {
  try {
    const v = validApplication(req.body);
    if (v.error) return res.status(400).json({ error: 'BAD_APPLICATION', message: v.error });

    // An email that already has an account is no longer a dead end: since
    // migration-035 the accept flow LINKS the existing account as the vendor
    // login instead of failing at createUser (dual-role accounts — a student
    // can run a vendor with the same email, and a multi-location owner can
    // apply again). So the old email_has_account bounce is gone; the unique
    // index on pending applications still stops duplicate submissions below.
    const { error } = await supabaseAdmin
      .from('vendor_applications')
      .insert({ ...v.fields, password_hash: await bcrypt.hash(v.password, 10) });
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'DUPLICATE_APPLICATION', message: 'An application with this email is already pending, hang tight!' });
      }
      throw error;
    }

    // Wait for the best-effort delivery attempt. Returning while this promise
    // was still loose could abandon an alert when a process stopped after 201.
    // Say how big it is: a five-location chain is a different review from a
    // single shop, and the count is the one thing the title can't imply.
    const count = v.fields.locations.length + 1;
    await notifyAdmins({
      title: 'New vendor application',
      body: count > 1
        ? `${v.fields.business_name} · ${v.fields.contact_name} · ${count} locations`
        : `${v.fields.business_name} · ${v.fields.contact_name}`,
      url: '/admin/',
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
