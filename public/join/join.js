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
    showLogoError('That image is too large — pick one under 8 MB.');
    return;
  }
  try {
    const { dataUrl } = await shrinkImage(file, LOGO_MAX_PX);
    logoValue = dataUrl;
    setLogoPreview(logoValue);
  } catch {
    showLogoError('Couldn’t read that image. Try a PNG or JPG — HEIC and PDF files aren’t supported.');
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
        message: $('f-message').value.trim(),
        logo: logoValue,
      }),
    });

    if (res.ok) {
      $('form-card').hidden = true;
      $('done-card').hidden = false;
      window.scrollTo({ top: 0 });
      return;
    }

    let msg = 'Something went wrong — please try again.';
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch { /* non-JSON error body — keep the generic message */ }
    showFormError(msg);
  } catch {
    showFormError('No connection — check your internet and try again.');
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
