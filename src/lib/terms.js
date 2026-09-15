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
// 2026-09-06: session recording (Policy §2.8, §2.13, a new §2.14, and a new
// processor in §4). Material on both of the tests the bumps above were made
// against, and the first one is the plainest yet: §2.8 did not merely fail to
// mention analytics, it stated "WeRewards does not use tracking cookies,
// advertising cookies, or any third-party analytics" — while PostHog is now
// sent a masked RECORDING of the app's screens as a student used them, keyed
// to their user id, and sets an identifier in their browser. Second, §4 lists
// every third party student data reaches and PostHog was not on it (it should
// have been added when the server-side event mirror shipped; recording makes
// the gap much larger than a missing row).
//
// Everything a student types is masked before the recording leaves the device
// and no request bodies are captured — but "we record your screen" is not a
// thing to tell people after the fact, whatever the masking. The Policy also
// now promises that Do Not Track switches it off, which public/shared/
// analytics.js honours with respect_dnt; that promise is part of what is being
// consented to here.
// 2026-09-13: linking a student email, and joining two accounts (ToS §3 and
// §4.7, Policy new §2.15). Material on the plainest of the tests above — the
// prior ToS did not merely fail to mention this, it said the OPPOSITE in so
// many words: a signup promotion "does not apply, and it cannot be applied
// afterwards". That sentence is exactly what migration-057 exists to make
// false, and a student operating under the old text would have no reason to
// look for the feature at all.
//
// Two further things would each be enough on their own. First, we now store a
// SECOND email address, and a record of every address ever linked that outlives
// both the link and the account it belonged to — kept deliberately, because it
// is the only thing stopping one mailbox collecting a one-time bonus forever.
// That is a new, permanent category of data about a person and §2 has to say
// so. Second, joining two accounts is irreversible and destroys one of them;
// consenting to a service that can do that on your instruction is not the same
// as consenting to one that cannot.
//
// ⚠ THE PAYOUT-SURFACE WARNING ABOVE STILL APPLIES, and this bump adds one more
// thing that runs for every existing student at re-accept: the
// EMAIL_LINKED_ELSEWHERE check. It is guarded on the profile NOT existing, so an
// existing student re-accepting can never trip it — which is the whole reason
// that guard is there rather than the check being unconditional. Removing it
// would lock out every student who had linked their own second address.
// 2026-09-14: the invite bonus pays BOTH sides at signup (ToS §4.7, Policy
// §2.12 and the §4 purposes table). Material on the plainest of the tests
// above — the prior text did not fail to mention this, it said the OPPOSITE in
// bold: "Your own bonus is credited only after the person you invited earns
// points at a participating vendor", and the Policy told the invited student
// "Your purchase triggers their payment". migration-058 makes both false, and a
// student operating under the old text would believe they still controlled
// whether their friend got paid — which, read the other way, is the disclosure
// that actually matters here: signing up is now itself the act that pays
// somebody else. That is a different thing to consent to than a purchase they
// were going to make anyway.
//
// The Policy's §4 purposes table also listed "whether the invited account has
// earned points at any vendor" as data used to decide a payout. We no longer
// look at it for that, and a table that over-states what we read is as wrong as
// one that under-states it.
//
// ⚠ THE PAYOUT-SURFACE WARNING ABOVE APPLIES WITH TEETH THIS TIME. Re-accepting
// runs POST /api/me/accept-terms for every existing student, and a referral is
// now paid the moment it is attributed rather than at some later purchase. The
// referral path is NOT reached from accept-terms — attribution is its own route,
// POST /api/me/referral, called once per stashed code — so the bump itself pays
// nobody directly. What it does is put every existing student back through the
// consent modal, and render() claims a stashed code on the way out of it.
//
// That backlog is small, and it is worth knowing WHY rather than assuming it:
// attributeReferral still refuses an account older than config.signupWindowDays
// (14 by default) and still refuses one that has ever earned. A code can be
// stashed for 30 days (PENDING_REF_TTL_MS), so the students who can actually
// claim on the way back in are the narrow band who signed up inside the window
// and have never earned anything — the same people who could have claimed
// yesterday. The difference is only that each claim now pays a referrer at once
// instead of waiting. Not a spike; just no longer deferred.
//
// The real backlog is in the DATABASE, not here: every referral sitting at
// status='pending' was pending because the purchase never came, and
// migration-058 makes all of them payable on the next 45-second sweep. That
// number is knowable before you ship — see the header of migration-058, which
// is where the warning belongs since it is the paste that spends the money.
export const TERMS_VERSION = '2026-09-14';

// Shown in the consent modal. `path` is served by the static mount in server.js;
// these open in a new tab so a student never loses their place in the flow.
export const TERMS_DOCUMENTS = [
  { key: 'tos',     label: 'Terms of Service', path: '/legal/student-terms-of-service.html' },
  { key: 'privacy', label: 'Privacy Policy',   path: '/legal/student-privacy-policy.html'   },
];
