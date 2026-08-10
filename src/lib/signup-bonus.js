// The signup bonus (migration-040) — incentive kind #2.
//
// "Sign up with a .psu.edu address between these dates and get N community
// points." Everything that moves points came from migration-039; this file only
// decides who qualifies.
//
// WHY THIS IS CHEAP. Penn State accounts federate with Google, so a student who
// signs in with their university address arrives with profiles.email already
// holding it, verified by Google. This stack sends no email and has no way to
// verify an address itself — that federation is the only reason this is a
// domain comparison rather than a whole verification subsystem.
//
// ⚠ THE FLIPSIDE, and it needs to be in the copy: a student who signs in with a
// personal Gmail gets nothing, and there is no way for them to fix it after the
// fact short of deleting the account. So the landing page has to say "use your
// PSU email" BEFORE they pick a Google account, not after. See the
// #signup-bonus-note block in public/student/index.html, which is driven by
// publicSignupBonus() below.

import { supabaseAdmin } from './supabase.js';

/** What the admin form starts from. Only a pre-fill; a saved program keeps its own. */
export const SIGNUP_DEFAULTS = {
  points: 10,
  domains: ['psu.edu'],
};

const POINTS_MAX = 5000;
const DOMAINS_MAX = 5;
// Deliberately strict: a domain is compared against the tail of an email
// address, so anything that isn't a plain hostname is either a typo or an
// attempt to widen the match.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Fold whatever the operator typed into a clean domain list, or an error.
 * Accepts "psu.edu, alumni.psu.edu" and "@psu.edu" — the leading @ is what
 * everyone types first.
 */
export function parseDomains(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  if (!list.length) return { error: 'Enter at least one email domain, e.g. psu.edu' };
  if (list.length > DOMAINS_MAX) return { error: `At most ${DOMAINS_MAX} domains.` };
  const bad = list.find((d) => !DOMAIN_RE.test(d));
  if (bad) return { error: `“${bad}” isn’t a valid email domain. Use something like psu.edu` };

  return { domains: [...new Set(list)] };
}

/** Validate the admin form's knobs. Never throws; the caller turns error into a 400. */
export function validSignupConfig(raw) {
  const body = raw ?? {};
  const points = body.points === '' || body.points == null ? SIGNUP_DEFAULTS.points : Number(body.points);
  if (!Number.isInteger(points) || points < 1 || points > POINTS_MAX) {
    return { error: `The bonus must be a whole number of points from 1 to ${POINTS_MAX}.` };
  }
  const parsed = parseDomains(body.domains ?? SIGNUP_DEFAULTS.domains);
  if (parsed.error) return { error: parsed.error };

  return { config: { points, domains: parsed.domains } };
}

/**
 * Does this address belong to one of the program's domains? Matches the domain
 * itself and any subdomain of it, so `psu.edu` also covers `med.psu.edu` — a
 * university hands out addresses on subdomains and an operator should not have
 * to enumerate them. Compared against the tail with an explicit dot so
 * `notpsu.edu` cannot match `psu.edu`.
 */
export function emailMatchesDomains(email, domains) {
  const at = String(email ?? '').lastIndexOf('@');
  if (at < 0) return false;
  const host = String(email).slice(at + 1).trim().toLowerCase();
  if (!host) return false;
  return (domains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * The one live signup program, or null. migration-039's partial unique index
 * guarantees at most one active row per kind, so the first match is the only
 * one there could be. The date window is applied here rather than in SQL so the
 * admin tab can show an expired program still marked active — which is the
 * truth — while it quietly stops paying.
 */
export async function activeSignupProgram() {
  const { data, error } = await supabaseAdmin
    .from('incentives')
    .select('id, name, active, starts_at, ends_at, budget_points, spent_points, config')
    .eq('kind', 'signup_domain')
    .eq('active', true)
    .limit(1);
  if (error) throw error;

  const row = data?.[0];
  if (!row) return null;
  const now = Date.now();
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return null;
  if (row.ends_at && new Date(row.ends_at).getTime() <= now) return null;
  return row;
}

/**
 * What the signed-OUT landing page needs to know, or null. Served through
 * /api/public-config, which the app already fetches at boot — one field on an
 * existing unauthenticated call rather than a new endpoint. Deliberately says
 * nothing about budget or spend: this is marketing copy, not the ledger.
 */
export async function publicSignupBonus() {
  try {
    const program = await activeSignupProgram();
    if (!program) return null;
    const cfg = { ...SIGNUP_DEFAULTS, ...(program.config ?? {}) };
    return { points: cfg.points, domains: cfg.domains };
  } catch {
    // The landing page must render whether or not this read works. No note is
    // strictly better than a broken page.
    return null;
  }
}

/**
 * Pay the signup bonus if this student qualifies. Called from
 * POST /api/me/accept-terms — the moment the profile is created, which since
 * migration-022 is what "signing up" actually means here.
 *
 * BEST EFFORT, ALWAYS. Consent is the thing that must succeed; a bonus that
 * doesn't pay is a support ticket, a consent write that fails is a student who
 * cannot use the app. Every path returns rather than throwing.
 *
 * @returns {Promise<number>} points actually paid (0 if they didn't qualify)
 */
export async function maybeAwardSignupBonus({ userId, email, profileCreatedAt }) {
  try {
    const program = await activeSignupProgram();
    if (!program) return 0;

    const cfg = { ...SIGNUP_DEFAULTS, ...(program.config ?? {}) };
    if (!emailMatchesDomains(email, cfg.domains)) return 0;

    // The student must have SIGNED UP inside the window, not merely be accepting
    // terms inside it. accept-terms is also hit by existing students whenever
    // TERMS_VERSION is bumped, and without this every one of them with a
    // matching address would qualify the first time the program ran.
    //
    // profiles.created_at IS the signup moment: migration-022 made consent the
    // thing that creates the profile.
    const created = new Date(profileCreatedAt ?? Date.now()).getTime();
    if (program.starts_at && created < new Date(program.starts_at).getTime()) return 0;
    if (program.ends_at && created >= new Date(program.ends_at).getTime()) return 0;

    // ref_id = the student. 039's UNIQUE (ref_id, kind) makes this once per
    // account for good, so a re-accept, a retry or a double-submit cannot pay
    // twice even if every check above were wrong.
    const { error } = await supabaseAdmin.rpc('grant_community_points', {
      p_user_id: userId,
      p_points: cfg.points,
      p_kind: 'signup_domain',
      p_reason: `Signup bonus (${cfg.domains.join(', ')})`,
      p_incentive_id: program.id,
      p_ref_id: userId,
      p_granted_by: 'system',
    });
    if (error) {
      const msg = String(error.message ?? '');
      // Already paid is the expected outcome on a terms re-acceptance, not a
      // fault; an exhausted budget is an operator problem, worth one line.
      if (!msg.includes('GRANT_ALREADY_PAID')) {
        console.warn(`[signup-bonus] not paid for ${userId}: ${msg}`);
      }
      return 0;
    }
    return cfg.points;
  } catch (err) {
    console.warn(`[signup-bonus] threw for ${userId}: ${err?.message ?? err}`);
    return 0;
  }
}
