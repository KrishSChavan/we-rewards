/* WeRewards — public vendor application form (/join).
   Plain unauthenticated page: collects the application, shrinks an optional
   logo to a ~128px data-URL client-side (same pipeline as the terminal
   Settings), and POSTs it all as JSON to /api/apply. Accept/reject happens
   later on the operator's /admin dashboard. */

const $ = (id) => document.getElementById(id);

let logoValue = null;   // data-URL or null

/* ---- logo: pick a file, shrink it to a ~128px square data-URL ---- */

const LOGO_MAX_PX = 128;                 // stored icon size
const LOGO_MAX_FILE = 8 * 1024 * 1024;   // reject huge source files up front

function setLogoPreview(dataUrl) {
  const box = $('logo-preview');
  box.style.backgroundImage = dataUrl ? `url('${dataUrl}')` : 'none';
  box.classList.toggle('is-empty', !dataUrl);
  $('logo-remove').hidden = !dataUrl;
  $('logo-error').hidden = true;
}

async function onLogoPick(e) {
  const file = e.target.files?.[0];
  e.target.value = '';                   // let the same file be re-picked later
  if (!file) return;
  if (file.size > LOGO_MAX_FILE) {
    showLogoError('That image is too large. Pick one under 8 MB.');
    return;
  }
  try {
    const { dataUrl } = await shrinkImage(file, LOGO_MAX_PX);
    logoValue = dataUrl;
    setLogoPreview(logoValue);
  } catch {
    showLogoError('Couldn’t read that image. Try a PNG or JPG, since HEIC and PDF files aren’t supported.');
  }
}

function showLogoError(msg) {
  $('logo-error').textContent = msg;
  $('logo-error').hidden = false;
}

// Decode a picked File into something drawable. createImageBitmap is the most
// robust path (large images, EXIF orientation, off the main thread); fall back
// to an <img> where it's missing. Neither reads HEIC/PDF — clear error above.
async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

// Shrink the image to fit maxPx and return a PNG data-URL (keeps transparency).
async function shrinkImage(file, maxPx) {
  const src = await decodeImage(file);
  const scale = Math.min(1, maxPx / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  src.close?.();   // release the ImageBitmap if that's what we got
  return { dataUrl: canvas.toDataURL('image/png') };
}

/* ---- what the shop sells (migration-042) ----
   The vocabulary comes from the server (/api/cuisines) rather than being
   hardcoded here, so a new tag is one edit in src/lib/cuisines.js and reaches
   this form, the admin editors, and the students' filter chips without three
   separate releases.

   BEST-EFFORT BY DESIGN. If the request fails the fieldset simply stays hidden
   and the application submits without cuisine tags — this is an optional field
   that affects filtering, and no applicant should be blocked from reaching us
   because a fetch didn't land. */

let cuisineMax = 3;

function pickedCuisine() {
  return [...document.querySelectorAll('#f-cuisine input:checked')].map((el) => el.value);
}

// Past the cap, disable what ISN'T ticked rather than refusing the tick or
// silently dropping it on submit — the limit is then visible on the control
// itself, before the applicant has invested anything in the choice.
function syncCuisineCap() {
  const atCap = pickedCuisine().length >= cuisineMax;
  document.querySelectorAll('#f-cuisine input').forEach((el) => {
    el.disabled = atCap && !el.checked;
    el.closest('.tag-opt')?.classList.toggle('is-disabled', el.disabled);
  });
}

async function loadCuisines() {
  let list = [];
  try {
    const res = await fetch('/api/cuisines');
    if (!res.ok) return;
    const body = await res.json();
    list = Array.isArray(body?.cuisines) ? body.cuisines : [];
    if (Number.isInteger(body?.max) && body.max > 0) cuisineMax = body.max;
  } catch {
    return;                       // offline or a bad response — leave it hidden
  }
  if (!list.length) return;

  const box = $('f-cuisine');
  box.innerHTML = '';
  list.forEach((c) => {
    const label = document.createElement('label');
    label.className = 'tag-opt';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = c.value;
    const span = document.createElement('span');
    // textContent, not innerHTML: the labels are ours today, but this is a
    // response body being written into the DOM and it costs nothing to keep it
    // un-injectable.
    span.textContent = c.label;
    label.append(input, span);
    box.append(label);
  });
  $('cuisine-max').textContent = String(cuisineMax);
  box.addEventListener('change', syncCuisineCap);
  $('cuisine-field').hidden = false;
}

/* ---- more locations (migration-043) ----
   One application, one login, one vendors row per location. Each added row asks
   only for what actually DIFFERS between branches: what the shop sells, its
   price range and its logo are collected once above and carried onto every
   location by the server, because a chain is a chain.

   The locations stay independent vendors once accepted (own points, items,
   deals, stats and staff PIN); what they share is the sign-in, and the store
   switcher at the top of the terminal moves between them. */

const MAX_LOCATIONS = 12;   // keep in sync with src/routes/apply.js

const locationRows = () => [...document.querySelectorAll('#extra-locations .loc-row')];

// Renumber the headings, show/hide the bits of location one that only make
// sense when it has siblings, and stop the list at the cap.
function syncLocations() {
  const rows = locationRows();
  $('loc1-heading').hidden = rows.length === 0;
  $('loc1-label-field').hidden = rows.length === 0;
  rows.forEach((row, i) => { row.querySelector('[data-loc-heading]').textContent = `Location ${i + 2}`; });
  $('add-location').disabled = rows.length + 1 >= MAX_LOCATIONS;
}

function addLocation() {
  if (locationRows().length + 1 >= MAX_LOCATIONS) return;
  const row = $('location-template').content.firstElementChild.cloneNode(true);
  // Locations of a chain share a business name, so prefill it. Someone opening
  // a genuinely different brand under the same login types over it.
  row.querySelector('[data-loc-name]').value = $('f-business').value.trim();
  row.querySelector('[data-loc-remove]').addEventListener('click', () => {
    row.remove();
    syncLocations();
  });
  $('extra-locations').appendChild(row);
  syncLocations();
  row.querySelector('[data-loc-label]').focus();
}

function collectLocations() {
  return locationRows().map((row) => ({
    name: row.querySelector('[data-loc-name]').value.trim(),
    locationLabel: row.querySelector('[data-loc-label]').value.trim(),
    address: row.querySelector('[data-loc-address]').value.trim(),
  }));
}

/* ---- submit ---- */

function showFormError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Client-side pre-checks mirror the server's rules so most mistakes are caught
// before the round-trip; the server re-validates everything regardless.
function firstProblem() {
  if (!$('f-business').value.trim()) return 'Enter your business name.';
  if (!$('f-contact').value.trim()) return 'Enter a contact person.';
  if (!/^[\d\s()+.-]{7,20}$/.test($('f-phone').value.trim())) return 'Enter a valid phone number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('f-email').value.trim())) return 'Enter a valid email address.';
  if ($('f-password').value.length < 8) return 'Password must be at least 8 characters.';
  if ($('f-password').value.length > 72) return 'Password must be 72 characters or fewer.';
  // Counting from 2: location one is the form above these rows.
  const blank = collectLocations().findIndex((l) => !l.name);
  if (blank >= 0) return `Enter a business name for location ${blank + 2}.`;
  return null;
}

async function submit(e) {
  e.preventDefault();
  $('form-error').hidden = true;

  const problem = firstProblem();
  if (problem) { showFormError(problem); return; }

  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: $('f-business').value.trim(),
        contactName: $('f-contact').value.trim(),
        phone: $('f-phone').value.trim(),
        email: $('f-email').value.trim(),
        password: $('f-password').value,
        address: $('f-address').value.trim(),
        locationLabel: $('f-location-label').value.trim(),
        // Everything after the first location. [] is the single-shop
        // application, which is what this endpoint has always taken.
        locations: collectLocations(),
        message: $('f-message').value.trim(),
        logo: logoValue,
        // '' when they skipped it (or when the fieldset never loaded), which
        // the server reads as "not said" rather than as a price of zero.
        cuisine: pickedCuisine(),
        priceLevel: $('f-price').value || null,
      }),
    });

    if (res.ok) {
      const count = collectLocations().length + 1;
      if (count > 1) {
        const note = $('done-locations');
        note.textContent = `All ${count} locations are on this one sign-in. Once you're approved, a store switcher at the top of the terminal moves between them, and each one keeps its own points, items and stats.`;
        note.hidden = false;
      }
      $('form-card').hidden = true;
      $('done-card').hidden = false;
      window.scrollTo({ top: 0 });
      return;
    }

    let msg = 'Something went wrong, please try again.';
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch { /* non-JSON error body — keep the generic message */ }
    showFormError(msg);
  } catch {
    showFormError('No connection, check your internet and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit application';
  }
}

/* ---- boot ---- */

$('logo-pick').addEventListener('click', () => $('logo-file').click());
$('logo-file').addEventListener('change', onLogoPick);
$('logo-remove').addEventListener('click', () => { logoValue = null; setLogoPreview(null); });
$('apply-form').addEventListener('submit', submit);
$('add-location').addEventListener('click', addLocation);
syncLocations();
void loadCuisines();
