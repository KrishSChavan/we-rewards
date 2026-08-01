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
export const TERMS_VERSION = '2026-08-01';

// Shown in the consent modal. `path` is served by the static mount in server.js;
// these open in a new tab so a student never loses their place in the flow.
export const TERMS_DOCUMENTS = [
  { key: 'tos',     label: 'Terms of Service', path: '/legal/student-terms-of-service.html' },
  { key: 'privacy', label: 'Privacy Policy',   path: '/legal/student-privacy-policy.html'   },
];
