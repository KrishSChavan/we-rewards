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
// 2026-10-01: weekly reminder pushes (Policy §2.6, §7.4; migration-060).
// Material on the same ground as the 2026-08-20 bump above, and for the two
// reasons that bump names. First, it is a NEW CLASS of push notification sent by
// WeRewards itself rather than by a vendor, and the prior §7.4 enumerated the
// kinds of message a student can receive — a list a reminder is not on, which
// makes it a promise this feature breaks rather than a gap it fills. Second,
// students are opted in BY DEFAULT (reminder_opt_in defaults true, same as the
// other three switches), so the consent has to come from somewhere, and per the
// rule at the top of this file that somewhere is a bump.
//
// It also records one more thing about each student — last_reminder_at, the
// cadence gate — which §2.6 now names alongside the existing counters.
//
// ⚠ DELIVERY IS NOT LIVE THE MOMENT THIS SHIPS. The reminder worker no-ops
// without VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, and claim_reminder_pushes does not
// exist until migration-060 is applied by hand. So this bump can reach students
// BEFORE the feature it discloses does. That ordering is deliberate and is the
// safe direction: disclosing early costs one consent prompt, disclosing late
// means having already sent something §7.4 did not cover. If you need to defer
// the interruption, revert this one line and the Policy's "Last Updated" date
// together — never one without the other.
// 2026-10-02: operator broadcasts (Policy §2.6, §7.4; migration-061). A new
// class of push, sent by US to a group of accounts WE choose, with arbitrary
// copy. Material on the same ground as the three bumps above: §7.4 enumerated
// the kinds of message a student can receive and this was not one of them, and
// students are reached through a switch (Deal alerts) they set before this
// existed.
//
// §7.4 WAS REWRITTEN GENERICALLY RATHER THAN EXTENDED, and that is the point of
// this revision. The old section listed features; the new one describes two
// CATEGORIES — reminders about your own points, and announcements about the
// service — and says in so many words that a future kind of house message is
// covered by the same limits and the same switch. Three bumps in three
// revisions were each "we added one more kind of notification", and every one
// of them interrupted every student. This should be the last bump that sentence
// describes.
//
// What did NOT change, deliberately, is the promise the frequency section
// makes. A broadcast spends the same student_notify_state budget as a vendor
// deal, a nearby alert and a reminder (claim_admin_broadcast_pushes, see
// migration-061), so "two per day… whatever the reason" stays true with our own
// reasons included. An exempt broadcast would have been the easy build and
// would have made that sentence false.
// 2026-10-03: the notification log (Policy §2.6, §3, §5, §7.1; migration-062).
// No new kind of message, and the frequency promise is untouched, so this is
// NOT the "one more kind of notification" bump the 2026-10-02 entry hoped to be
// the last of. It is material for a different reason: what we KEEP about the
// messages changed, and the prior §2.6 described the old records narrowly
// enough that the new ones contradict it. It said the per-account counters were
// kept "purely" to enforce the frequency limits — they are now also shown to
// the operator to explain why a message is waiting — and it named deal and
// announcement records only. It said nothing of a reminder history, of failure
// and refusal reasons, of account emails (a reset or link-code email now leaves
// a row, subject line only), of the device type and push-service answer per
// alert, or of the operator reading all of it on an admin screen next to the
// student's name. Each of those is a disclosure about stored personal data, and
// §2.6 is the section a student would read to find out.
//
// The wording is deliberately narrow about what is NOT kept: the subject only,
// never the body or a code (code-bearing emails log a fixed logSubject, and
// redactSecrets in src/lib/notification-log.js scrubs the code as a backstop
// should a subject ever carry one), and the device TYPE
// only, never the push endpoint. If either of those ever changes, the Policy
// is wrong again and this needs another bump, not a quiet code change.
//
// ⚠ LIKE 2026-10-01, THIS CAN REACH STUDENTS BEFORE THE FEATURE DOES. Nothing
// is recorded until migration-062 is applied by hand (the log degrades to a
// no-op without its table), so for a while the Policy discloses records that
// do not exist yet. Same reasoning as that entry: early costs one prompt, late
// means having kept something §2.6 did not cover. Revert this line and the
// Policy's "Last Updated" date together, never one without the other.
// 2026-10-12: reminders and announcements may now arrive by EMAIL (Policy §2.6,
// §7.4; migration-064). No new kind of message, no change to the frequency
// promise, and nothing new recorded — this bump is about the CHANNEL, which is
// the one axis the 2026-10-02 rewrite did not generalise.
//
// Material on the plainest of the tests above, because the prior §7.4 did not
// merely fail to mention it: it said the opposite in so many words. "Both kinds
// are sent only to accounts we can reach with a push notification" was a promise
// that a reminder and an announcement could not reach a mailbox, and the email
// bullet above it scoped email to telling students "about a deal". The Deal
// emails switch said the same thing in its name. All three are now false.
//
// It is also the 2026-08-20 bump's own reasoning applied to a second feature:
// "the same number of messages, arriving somewhere new" is still a change in
// what students agreed to, even though no student receives one extra message.
//
// WHY THIS IS WORTH INTERRUPTING EVERYONE FOR, given it reaches the people who
// are NOT interrupted. Push can only be granted from inside the app, so a
// student who drifted away has no endpoint and the reminder built to fetch them
// back was the one message that could never reach them. Email has no such
// precondition — and it is the only channel that works at all on the iOS build,
// which is a Capacitor WKWebView and exposes no PushManager (see
// docs/apns-plan.md for the real fix there). The students this bump is for are
// precisely the ones who will see the consent modal LAST, which is the right way
// round: the disclosure lands before the first message does.
//
// §7.4 WAS GENERALISED ALONG THE CHANNEL AXIS, deliberately, exactly as
// 2026-10-02 generalised it along the message-kind axis. It now says we choose
// what to send, when, and by which of the two channels, and that a future kind
// of house message needs no new switch and no new version of the Policy. Between
// that sentence and 2026-10-02's, this should be the last notification bump.
//
// WHAT WAS DELIBERATELY NOT WRITTEN, and this is the important half. A blanket
// clause — "using the app means consenting to all alerts from us at our
// discretion" — was considered and rejected. Three reasons, any one sufficient.
// First, it would contradict this same document twice over: the frequency limits
// in §7.4 ("two per day is the total number of times WeRewards will interrupt
// you, whatever the reason") and the per-feature switches, both of which are
// enforced in SQL by the shared student_notify_state budget that all four claim
// functions spend. A Policy that promises unlimited discretion while the code
// enforces two a day is not a broader permission, it is an inaccurate
// disclosure. Second, a working opt-out for marketing email is not ours to waive
// by wording: src/routes/unsubscribe.js, the suppression list and the
// List-Unsubscribe header exist because that is the obligation, and a clause
// claiming otherwise removes nothing but our own accuracy. Third, App Store
// review expects push to be opt-in and revocable, and nothing is approved yet.
// The generalisation above gets the whole of what a blanket clause was wanted
// for — never needing another bump for a new kind or a new channel — and gives
// up only the part that was never ours to take.
//
// ⚠ THE PAYOUT-SURFACE WARNING AT THE TOP OF THIS FILE STILL APPLIES. Every
// existing student goes back through the consent modal, which runs POST
// /api/me/accept-terms and claims a stashed referral code on the way out. See
// the 2026-08-10 and 2026-09-14 entries for why that is bounded; nothing in this
// bump widens it.
//
// ⚠ AND LIKE 2026-10-01 AND 2026-10-03, THIS CAN REACH STUDENTS BEFORE THE
// FEATURE DOES. migration-064 is applied by hand and the fallback is inert
// without it (the claims simply never return out_reach:'email'), so for a while
// the Policy discloses a channel nothing is using. Same reasoning as those
// entries: early costs one prompt, late means having already mailed something
// §7.4 did not cover. Revert this line and both documents' "Last Updated" dates
// together, never one without the other.
// 2026-10-18: a vendor deal can reach EVERY student, not only that vendor's
// customers (Policy §7.4 and the §4 purposes table; migration-069). Material on
// the plainest of the tests above, because the prior §7.4 said the opposite in
// so many words: "Participating vendors can send offers ("deals") to students
// who have earned points at that vendor." A student who has never set foot in a
// spot had every reason to believe that spot could not message them, and an
// approved all-student request makes that false.
//
// What did NOT change, and is the reason this is safe to disclose rather than a
// promise to walk back: the vendor still cannot do it alone (the operator
// approves each request, and §7.4 now says so); the vendor still learns nobody's
// identity; and the frequency limits, quiet hours, the switches and the
// unsubscribe link all apply unchanged, because an approved request is delivered
// as an ordinary campaign through claim_campaign_pushes. The 2026-10-02 and
// 2026-10-12 generalisations covered new kinds of HOUSE message and new
// channels; neither covered a vendor reaching students outside its own
// customers, which is why this needs its own bump.
//
// ⚠ EVERYONE_DEALS_TERMS_VERSION BELOW IS THE GATE, NOT THIS LINE. Approving a
// request (src/lib/deal-requests.js reviewDealRequest) refuses while
// TERMS_VERSION is older than it, so if this bump is deferred at ship time
// (revert this line and both documents' "Last Updated" dates together), the
// feature cannot send anything while the POSTED text is the old one. Requests
// can still be made and denied; nothing reaches a student.
//
// What the gate does NOT check is what each student has personally accepted.
// No send path reads profiles.terms_version (the 2026-10-12 entry's precedent:
// the disclosure is posted before the first message, and a lapsed student who
// has not reopened the app since is still reached), so a student who has not
// re-accepted can receive an approved all-student deal. That is deliberate and
// consistent with every notification feature here, not an oversight.
//
// ⚠ THIS BUMP ALSO RE-PROMPTS FOR EVERY OTHER UNBUMPED EDIT ALREADY IN THE
// DOCUMENTS (spot reviews, the one-point rate, rank tiers were each written with
// TERMS_VERSION deliberately left alone). One interruption covering all of them
// is the point; it does mean students accept that text at the same time.
//
// ⚠ THE PAYOUT-SURFACE WARNING AT THE TOP OF THIS FILE STILL APPLIES, and
// nothing in this bump widens it.
export const TERMS_VERSION = '2026-10-18';

// The first documents that disclose all-student deals. Not an alias of
// TERMS_VERSION: that one moves with every future revision, while this one must
// stay pinned to the revision that made the disclosure.
export const EVERYONE_DEALS_TERMS_VERSION = '2026-10-18';

// Shown in the consent modal. `path` is served by the static mount in server.js;
// these open in a new tab so a student never loses their place in the flow.
export const TERMS_DOCUMENTS = [
  { key: 'tos',     label: 'Terms of Service', path: '/legal/student-terms-of-service.html' },
  { key: 'privacy', label: 'Privacy Policy',   path: '/legal/student-privacy-policy.html'   },
];
