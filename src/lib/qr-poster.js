// The "scan here" QR poster: one file the operator uploads in /admin, that every
// vendor terminal can download from Settings and print for the counter.
//
// It lives in Supabase Storage rather than the database or the repo:
//   • a print-ready PDF/ZIP is megabytes of binary, which is exactly what a
//     bytea column and a git checkout are both bad at (and the vendor logo's
//     base64-in-a-column trick only works because logos are 128px);
//   • the file changes on the operator's schedule, not on a deploy.
//
// There is NO migration and no new table. The bucket is created on first upload
// (createBucket is idempotent here — an existing bucket is not an error), and
// the object's own listing is the metadata: name, size, mime type, upload time.
// That keeps the whole feature inside code that ships with the dyno, which
// matters because the production project can't be reached by the Supabase CLI
// (see mds/prod-transfer.md) and every migration there is a manual SQL paste.
//
// The bucket is PRIVATE. Terminals never get a Supabase URL — the server reads
// the bytes with the service key and streams them back to an authenticated
// vendor, so the poster can't be hotlinked or enumerated by anyone else.

import { supabaseAdmin } from './supabase.js';

export const POSTER_BUCKET = 'marketing';
export const POSTER_PREFIX = 'qr-poster';

// 10 MB of print-ready artwork is generous (a 300-dpi poster PDF is ~1-2 MB).
// Keep in sync with the JSON body limit mounted for the upload route in
// server.js — base64 inflates by 4/3, so that parser must allow ~14 MB.
export const POSTER_MAX_BYTES = 10 * 1024 * 1024;

// Extension → content type. The EXTENSION decides, not the browser's declared
// type: a file picker's `file.type` is guessed from the same extension anyway,
// it's absent for .zip on some platforms, and it's attacker-controlled. Anything
// not in this table is refused, which is also what keeps .html/.svg (inline
// script) and .exe out of a file other people are told to open.
const TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export const POSTER_EXTENSIONS = [...TYPES.keys()];

const NAME_MAX = 100;

/**
 * A filename safe to use as a storage key and as a Content-Disposition filename:
 * no directory traversal, no quotes or control characters, no leading dot.
 * Returns { name, contentType } or { error }.
 */
export function validPosterName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop().trim();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
  const contentType = TYPES.get(ext);
  if (!contentType) {
    return { error: `Use one of these file types: ${POSTER_EXTENSIONS.join(', ')}.` };
  }
  const stem = base
    .slice(0, dot)
    .replace(/[^A-Za-z0-9._ -]+/g, '-')   // keep it readable, drop everything exotic
    .replace(/^[.\s-]+|[\s-]+$/g, '')     // no leading dot (hidden file) or edge padding
    .slice(0, NAME_MAX);
  if (!stem) return { error: 'Give the file a name before uploading it.' };
  return { name: `${stem}${ext}`, contentType };
}

/** Supabase storage objects list with a placeholder row in empty folders. */
const isRealObject = (o) => o?.name && o.name !== '.emptyFolderPlaceholder';

async function ensureBucket() {
  const { data } = await supabaseAdmin.storage.getBucket(POSTER_BUCKET);
  if (data) return;
  const { error } = await supabaseAdmin.storage.createBucket(POSTER_BUCKET, {
    public: false,
    fileSizeLimit: POSTER_MAX_BYTES,
  });
  // Two operators uploading at once both see "no bucket" and both create it;
  // the loser's duplicate error is the success case, not a failure.
  if (error && !/exist/i.test(error.message ?? '')) throw error;
}

/**
 * The poster currently on offer, or null when the operator hasn't uploaded one.
 * Newest wins: a replace deletes the old object, but a crash between the two
 * writes must not resurrect last month's artwork.
 */
export async function getPoster() {
  const { data, error } = await supabaseAdmin.storage
    .from(POSTER_BUCKET)
    .list(POSTER_PREFIX, { limit: 100, sortBy: { column: 'updated_at', order: 'desc' } });

  // A missing bucket is "nothing uploaded yet", not an error the operator or a
  // terminal should ever see — it's the state of a project before the first upload.
  if (error) {
    if (/not found|does not exist|bucket/i.test(error.message ?? '')) return null;
    throw error;
  }

  const file = (data ?? []).filter(isRealObject)[0];
  if (!file) return null;
  return {
    name: file.name,
    path: `${POSTER_PREFIX}/${file.name}`,
    size: file.metadata?.size ?? null,
    contentType: file.metadata?.mimetype ?? TYPES.get(`.${file.name.split('.').pop()?.toLowerCase()}`) ?? 'application/octet-stream',
    updatedAt: file.updated_at ?? file.created_at ?? null,
  };
}

/** Replace the poster with `bytes`. Returns the new poster's metadata. */
export async function putPoster({ name, contentType, bytes }) {
  await ensureBucket();
  const path = `${POSTER_PREFIX}/${name}`;

  const { error } = await supabaseAdmin.storage
    .from(POSTER_BUCKET)
    .upload(path, bytes, { contentType, upsert: true, cacheControl: '300' });
  if (error) throw new Error(`poster upload failed: ${error.message}`);

  // Only now clear out whatever was there before: the old file stays downloadable
  // until the new one is committed, and a name change (poster-v2.pdf) can't leave
  // two live posters behind. Best-effort — a stale object is cosmetic, since
  // getPoster reads the newest.
  try {
    const { data } = await supabaseAdmin.storage.from(POSTER_BUCKET).list(POSTER_PREFIX, { limit: 100 });
    const stale = (data ?? [])
      .filter(isRealObject)
      .map((o) => `${POSTER_PREFIX}/${o.name}`)
      .filter((p) => p !== path);
    if (stale.length) await supabaseAdmin.storage.from(POSTER_BUCKET).remove(stale);
  } catch { /* leftovers don't affect what gets served */ }

  return (await getPoster()) ?? { name, path, size: bytes.length, contentType, updatedAt: new Date().toISOString() };
}

/** The poster's bytes, or null when there isn't one. */
export async function readPoster() {
  const poster = await getPoster();
  if (!poster) return null;
  const { data, error } = await supabaseAdmin.storage.from(POSTER_BUCKET).download(poster.path);
  if (error || !data) return null;
  return { ...poster, bytes: Buffer.from(await data.arrayBuffer()) };
}

/** Remove the poster entirely. Returns true if there was one to remove. */
export async function deletePoster() {
  const { data, error } = await supabaseAdmin.storage.from(POSTER_BUCKET).list(POSTER_PREFIX, { limit: 100 });
  if (error) {
    if (/not found|does not exist|bucket/i.test(error.message ?? '')) return false;
    throw error;
  }
  const paths = (data ?? []).filter(isRealObject).map((o) => `${POSTER_PREFIX}/${o.name}`);
  if (!paths.length) return false;
  const { error: rmErr } = await supabaseAdmin.storage.from(POSTER_BUCKET).remove(paths);
  if (rmErr) throw rmErr;
  return true;
}

/**
 * Decode the base64 payload the dashboard sends. The upload is JSON, not
 * multipart, because every request body in this API is JSON (see
 * middleware/require-json.js) and adding a multipart parser for one operator-only
 * route would widen the parser surface the gate exists to keep narrow.
 *
 * Returns { bytes } or { error } — never throws on bad input.
 */
export function decodePosterBody(body) {
  const b = body ?? {};
  const named = validPosterName(b.filename);
  if (named.error) return { error: named.error };

  const raw = typeof b.data === 'string' ? b.data : '';
  // Accept both a bare base64 string and a data: URL, since FileReader produces
  // the latter and hand-testing with curl produces the former.
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!base64 || !/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(base64)) {
    return { error: 'That file didn’t upload cleanly. Pick it again.' };
  }

  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return { error: 'That file is empty.' };
  if (bytes.length > POSTER_MAX_BYTES) {
    // No measured size in the copy: a file a kilobyte over the cap rounds to
    // "10.0 MB. The limit is 10 MB", which reads like a bug. The dashboard shows
    // the real size from the file picker before it ever uploads.
    return { error: `That file is too large. The limit is ${POSTER_MAX_BYTES / 1048576} MB.` };
  }
  return { name: named.name, contentType: named.contentType, bytes };
}
