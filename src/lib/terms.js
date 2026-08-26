// The student-facing legal documents and the version students consent to.
//
// TERMS_VERSION is the single source of truth for "which documents are current."
// A student may use the app only if profiles.terms_version equals this value —
// see requireConsent in ../middleware/auth.js. Bumping it re-prompts everyone.
//
// WHEN YOU REVISE A DOCUMENT: bump TERMS_VERSION to the new "Last Updated" date
// and update the matching date in the HTML. Leaving it unbumped means students
// keep operating under a consent record that points at text they never saw.
// Only bump for material changes — every bump interrupts every user.

// 2026-08-01: vendor deal notifications. The prior Policy said in so many words
// that we send students no push notifications, and promised to update it and
// provide an opt-out before that changed (Privacy Policy §7.4). That is a
// material change to what students agreed to, so it re-prompts.
//
// 2026-08-10: promotions (ToS §4.7, Policy §2.11-2.12). Two things here are
// material rather than cosmetic. First, an invite links TWO accounts and one
// student's purchase is what causes a payment to the other, which is a
// disclosure about someone else's data that the prior Policy did not make.
// Second, a signup promotion treats the email domain already on the account as
// a qualifying attribute. Both re-prompt.
//
// ⚠ A BUMP IS A PAYOUT SURFACE NOW. Re-accepting runs POST /api/me/accept-terms
// for every existing student, which is where the signup bonus is evaluated. It
// is safe — the payout is keyed to the student in community_grants so it can
// only happen once ever, and the program's starts_at is checked against
// profiles.created_at, which for an existing student is long past. Both guards
// are covered by test/sql/behavior-040.sql and the e2e. Do not remove either
// one on the assumption that accept-terms only runs for new accounts.
// 2026-08-20: deal EMAILS (Policy §2.6, §7.4, and a new processor in §4).
// Material for three separate reasons, any one of which would be enough.
// First, the Policy said in so many words "We do not send marketing emails to
// students" — a promise that this feature breaks, and the same shape of promise
// the 2026-08-01 bump above was made to honour. Second, students are opted in by
// default, so consent has to come from somewhere and this is where. Third, it
// names a new processor (Resend) that receives student email addresses; §4 lists
// every third party that data reaches, and an unlisted one is a disclosure gap
// rather than an omission.
//
// The channel itself is a fallback only (see supabase/migrations/…migration-047),
// so nobody receives more messages than the caps already allowed — but "the same
// number of messages, arriving somewhere new" is still a change in what students
// agreed to.
// 2026-08-26: nearby spot alerts (Policy §2.9, §2.13, §7.4). Material, and by
// the plainest test available — the prior Policy did not merely fail to mention
// this, it said the OPPOSITE, twice. §2.9 ended "This is the only feature in
// WeRewards that touches your location, and it does nothing until you ask it
// to", and §2.13 listed precise GPS location under Information We Do NOT
// Collect. The feature makes the first sentence false and needs the second
// qualified, which is the same shape of broken promise the 2026-08-01 and
// 2026-08-20 bumps above were made to honour.
//
// Students are also opted in by default (nearby_opt_in defaults true), so as
// with deal emails the consent has to come from somewhere, and this is where.
//
// The coordinates genuinely never reach us — the proximity test runs on the
// phone — but a granted claim writes a row saying this student was next to that
// spot at that time, and that is coarse location data we did not previously
// hold. Disclosing it is not optional and neither is re-consenting to it.
export const TERMS_VERSION = '2026-08-26';

// Shown in the consent modal. `path` is served by the static mount in server.js;
// these open in a new tab so a student never loses their place in the flow.
export const TERMS_DOCUMENTS = [
  { key: 'tos',     label: 'Terms of Service', path: '/legal/student-terms-of-service.html' },
  { key: 'privacy', label: 'Privacy Policy',   path: '/legal/student-privacy-policy.html'   },
];
