# App Review — Guideline 2.1 response (WeRewards, com.werewards.app)

Rejection received 2026-10-08 against v1.0 build 2. Apple asked for six things;
none of them is a code defect, five of them are writing, and one is a video only
you can shoot. This file is the source of truth for all of it — the Notes field
text below is meant to stay in App Store Connect for **every future
submission**, which is exactly what the rejection letter asked for.

Production at the time of writing is `b4ee11a`, and `staging == origin/main ==
b4ee11a`, so the shipped binary's WebView is already serving the current code.
No deploy is required to answer this rejection.

---

## 0. Do these in order

1. **Create the two demo accounts** — §1 below. Do this first; §2 and §3 both
   depend on them, and the accounts take 24 hours to become safe from the
   nightly sweep unless you do the one extra step.
2. **Shoot the screen recording** — §2. Physical iPhone, latest iOS, phone plus
   the vendor terminal on a laptop.
3. **Paste the Notes text** into App Store Connect → your app → the version →
   *App Review Information* → **Notes**, and fill in *Sign-In Required* with the
   demo credentials — §3.
4. **Reply in Resolution Center** with the full answer text — §4 — and attach
   the recording.
5. **Check the pre-flight list** — §5. Two of those (screenshots, age rating)
   are independent rejection risks that have nothing to do with this letter.

---

## 1. Demo accounts

Apple's reviewers cannot use Google sign-in reliably and will not create a real
Apple ID for you, so they need email + password. The student app does accept
email + password — it is just collapsed behind a link.

### Make **two** accounts, not one

Item 1 of the rejection requires you to demonstrate **account deletion**. If the
reviewer follows that recording and deletes the only demo account, the
credentials in App Store Connect are dead — for the rest of this review and for
every resubmission after it. So:

| Account | Purpose |
| --- | --- |
| `appreview@we-rewards.com` | The main account. Pre-loaded with points. Do not delete. |
| `appreview-delete@we-rewards.com` | Exists to be destroyed by the deletion test. |

Both go in the Notes field, clearly labelled, so the reviewer knows which one to
burn.

### How to create each one

1. Supabase Dashboard → **Authentication → Users → Add user**
   - email as above, a password you record, **Auto Confirm User: on**.
2. ⚠ **Sign in to the app with it immediately and accept the Terms.** This is
   not optional housekeeping. `prune_unconsented_signups`
   (`supabase/migrations/00000000000023_migration-023.sql`) runs daily and
   deletes any `auth.users` row older than 24 hours that has no profile, no
   `vendor_staff` link and no `terms_acceptances` row. An account created in the
   dashboard and left untouched is exactly that row. Accepting the Terms writes
   both a profile and a consent record, which exempts it permanently.
3. For the main account only: give it points so the reviewer does not land on
   empty screens. Open `/terminal`, sign in as a vendor (or with
   `TERMINAL_ADMIN_EMAIL`, which can open any vendor's till), have the phone show
   its code, and award. Do this at **two or three different spots** so the Home
   screen has more than one card and at least one reward is actually
   affordable — a reviewer who cannot reach the Redeem button cannot review the
   redeem flow.

### The sign-in tap the reviewer has to make

On the sign-in screen the three options are:

```
[ Continue with Google ]
[  Continue with Apple  ]

Vendor? Sign in with your terminal email and password   ← tap this
```

Vendors and customers share one Supabase auth pool, so that form is the app's
general email + password sign-in; the label just names its usual audience. The
Notes text in §3 spells the tap out for the reviewer verbatim, which is what
matters.

---

## 2. The screen recording (item 1)

Physical iPhone, latest iOS, **not** the simulator — Apple says so explicitly.
Start the recording *before* you launch the app, keep it in one unbroken take if
you can, and keep it under about 5 minutes. Silent is fine; narration is better.

Set-up: iPhone in hand with the App Store / TestFlight build installed, laptop
beside you with `https://we-rewards.com/terminal` open and signed in as a vendor.
Film the phone's screen (iOS Control Centre → Screen Recording); when the
terminal needs to act, say what you are doing out loud rather than cutting away.

### Shot list

| # | What to show | Why Apple asked |
| --- | --- | --- |
| 1 | Tap the app icon on the Home Screen. Let the splash and sign-in screen appear. | "must begin with launching the app" |
| 2 | **Registration.** Tap *Continue with Apple* (or Google) with a fresh account → the system sheet → the "One quick thing" consent screen → tick the box → *Agree & create my account* → land on Home. | account registration flow |
| 3 | Account tab → *Sign out*. Then sign back in with the demo email + password: tap *Vendor? Sign in with your terminal email and password*, type them, *Sign in*. | login flow, and it proves the credentials in the Notes field work |
| 4 | **Home.** The rotating 6-digit identity code and its QR, the per-spot point balances. | the core screen |
| 5 | **Earning.** Hold the phone's code up to the laptop's terminal camera (or type the 6 digits into the terminal). Show the terminal awarding, then cut back to the phone as the balance updates. | the typical user flow |
| 6 | **Spots tab.** The map and the list of partner restaurants; open one spot, scroll its rewards. | shows the app is populated and real |
| 7 | **Redeeming.** On a reward you can afford, tap *Redeem with points* → the 4-digit redeem code appears with its countdown → type it into the terminal → show the terminal confirming and the phone's balance dropping. | "accessing paid content or features" — show there is nothing to buy |
| 8 | **Receipt scan.** Home → the receipt entry point → *Take or choose a photo* → the camera permission prompt → photograph a receipt → *Claim my points* → the result. | the only thing a user uploads |
| 9 | **Notifications / location**, briefly: Account tab, the *Nearby spots* toggle, and the deal-alert toggle. Show that both are opt-in. | explains the two purpose strings |
| 10 | **Account deletion.** Switch to `appreview-delete@...`. Account tab → scroll to *Your data* → *Delete my account* → the ⚠ confirmation sheet → *Yes, delete my account* → it returns to the signed-out screen. | **required**; this is the one Apple checks hardest |

Also worth catching on camera if it costs you nothing: Account → *Download my
data*, and the Terms / Privacy links on the consent screen.

---

## 3. App Store Connect → App Review Information

**Sign-In Required:** ✅ on.
**User name:** `appreview@we-rewards.com` **Password:** *(the one you set)*

### Notes field — paste this

```
WeRewards is a free loyalty/rewards app for customers of independent local
restaurants. Customers pay nothing and there are no purchases of any kind in
the app.

HOW TO SIGN IN (please read — the password field is behind a link)
The app's primary sign-in buttons are "Continue with Google" and "Continue
with Apple". We have also provided an email + password account for App Review.
To use it:
  1. Launch the app.
  2. On the sign-in screen, below the two buttons, tap the link reading
     "Vendor? Sign in with your terminal email and password". (Store staff and
     customers share one account system, which is why the link is worded that
     way; it is the app's standard email + password sign-in and the account
     below is a normal customer account.)
  3. Enter the credentials below and tap Sign in.

DEMO ACCOUNTS
  Main review account - please use this one for everything except the
  deletion test. It is pre-loaded with points at several partner restaurants
  so every screen is populated:
      appreview@we-rewards.com / <PASSWORD>

  Disposable account - provided specifically so you can exercise the account
  deletion flow without destroying the account above:
      appreview-delete@we-rewards.com / <PASSWORD>

  Account deletion is at: Account tab (bottom right) > scroll to "Your data" >
  "Delete my account" > "Yes, delete my account".

WHAT THE APP DOES
Independent restaurants cannot afford the loyalty programs chains run, and
paper punch cards get lost. WeRewards gives each partner restaurant a loyalty
program with no hardware to buy: the customer shows a rotating code in the
app, a staff member scans it on a web terminal, and points land instantly.
The customer redeems those points for free items that each restaurant chooses
and prices itself. Audience: adults 18+ who eat at participating restaurants.
15 partner restaurants are live, all in State College, Pennsylvania.

MAIN FEATURES AND WHERE THEY ARE
  Home tab    - your rotating identity code (the QR staff scan) and your point
                balance at each restaurant you have visited. Also the receipt
                scanner, for restaurants that accept a receipt photo instead.
  Spots tab   - map and list of partner restaurants and the rewards each one
                offers. Tap a reward you can afford to get a 4-digit redeem
                code, which staff type into their terminal.
  Account tab - profile, notification and location toggles (both opt-in and
                off by default), Download my data, Delete my account, sign out.

NO PAID CONTENT. The app is free, contains no in-app purchases, no
subscriptions, and no paid tier. Points are earned only by visiting a partner
restaurant; they cannot be bought, have no cash value, and are not
transferable (Terms of Service, "No Cash Value"). Partner restaurants pay us
a subscription for their own staff terminal, which is a separate web product
that is not part of this app and is not reachable from it.

USER-GENERATED CONTENT. The app has none. Nothing a user submits is ever shown
to another user, so there is no feed, no profile, no messaging, and
consequently no content reporting or blocking mechanism. The only upload is a
photo of the user's own receipt, which is read for its total and then
discarded; it is not stored and not shown to anyone.

THIRD-PARTY SERVICES
  Supabase            - accounts, authentication and database
  Google Sign-In      - authentication (optional)
  Sign in with Apple  - authentication (optional)
  Google Gemini API   - reads the total off a receipt photo and checks it is a
                        genuine printed receipt. Disclosed in our Privacy
                        Policy, sections 2.10 and 4.
  Tesseract (OCR)     - runs on our own server as the fallback receipt reader
  Resend              - transactional email
  PostHog             - product analytics
  OpenStreetMap       - map tiles and one-time geocoding of partner addresses
  Web Push (VAPID)    - opt-in notifications
  Heroku              - hosting
  Stripe              - billing for partner RESTAURANTS only, on the separate
                        staff web terminal. No payment interface exists
                        anywhere in this app.
There is no AI chat, no AI content generation, and no third-party data
provider beyond those listed.

REGIONAL DIFFERENCES
None. The app is not geo-restricted, is English-only, and every feature
behaves identically in every country. The only thing that varies is content
rather than function: all 15 partner restaurants are currently in State
College, Pennsylvania, so the Spots map shows those businesses wherever the
app is opened. Nothing is hidden or disabled outside that area, and the demo
account is pre-loaded so the full experience can be reviewed from any
location. The optional "Nearby spots" setting only changes when a local alert
fires, never which features exist.

REGULATED INDUSTRY / THIRD-PARTY MATERIAL
Not applicable. WeRewards is a conventional customer loyalty program. It
involves no finance, lending, money transmission, stored value, health data,
gambling, or alcohol sales. Points cannot be purchased, have no cash value and
are redeemable only for items the issuing restaurant chooses to offer. Every
partner restaurant has signed our standard partner agreement authorizing us to
operate its rewards program and display its name and logo; countersigned
copies are available on request. All other content and branding in the app is
our own.
```

Replace `<PASSWORD>` in two places before pasting, and keep the real passwords
out of this file and out of git.

---

## 4. Resolution Center reply

Paste the Notes text above, prefixed with this:

```
Thank you for the review. A screen recording captured on a physical iPhone
running the latest iOS is attached; it begins with launching the app and covers
account registration, sign-in, the full earn-and-redeem flow, the receipt
scanner, the notification and location settings, and account deletion. The
written answers to items 2-6 follow, and we have added the same text to the
Notes field of App Review Information for future submissions.
```

Then let the Notes text answer items 2 through 6 in order. Two clarifications
worth adding at the end, because they pre-empt the follow-up questions this
particular app invites:

```
ON ITEM 1, USER-GENERATED CONTENT: the app has none, so there are no reporting
or blocking mechanisms to demonstrate. The recording does show the one thing a
user uploads - a photo of their own receipt - which is read for its total and
then discarded, never stored and never shown to another user.

ON GUIDELINE 3.2: WeRewards is a public consumer app, not an app for a specific
business or its employees. Anyone can download it, create an account with any
email address, and use every feature; there is no organizational affiliation
requirement, no employee login, and no invitation gate. Our partner restaurants
are the merchants whose rewards appear in the app, in the same way a shopping
app lists stores - they are not the app's audience. Their staff use a separate
web terminal that is not part of this submission.
```

---

## 5. Pre-flight before you resubmit

These are not in the rejection letter. The first two are independent rejection
risks worth closing in the same pass.

- [ ] **Screenshots (2.3.3).** The letter flags this generically, which usually
      means they looked. Every App Store screenshot must show the app in
      use — Home with real balances, the Spots map, a reward being redeemed.
      No splash screen, no sign-in screen, no title art.
- [ ] **Age rating.** The Terms require users to be 18 or older
      (`legal/student-terms-of-service.html`) and the consent sheet states it on
      screen. If the App Store age rating is set to 4+, that contradiction is
      its own rejection. Set the rating so it does not promise under-18 access
      the Terms refuse.
- [ ] **Both demo accounts tested from a signed-out device** the day you submit,
      not the day you created them.
- [ ] **Support URL and Privacy Policy URL** in App Store Connect resolve:
      `https://we-rewards.com/support` and
      `https://we-rewards.com/legal/student-privacy-policy.html`.
- [ ] **Privacy nutrition labels** cover what the app actually collects: email
      and name, approximate/precise location (optional), photos (receipt, not
      retained), identifiers, usage data via PostHog.
- [ ] Leave the binary alone. Nothing in this response needs a new build —
      the shell loads `we-rewards.com`, and production is current.

## 6. Things already in order

Checked while preparing this, so you do not have to re-verify them under time
pressure:

- Account deletion exists and is reachable in three taps
  (`public/student/index.html:1398`, `public/student/app.js:1485` →
  `POST /api/me/delete`), and it is described in the in-app FAQ.
- Sign in with Apple ships beside Google, as Guideline 4.8 requires.
- The "download the app" banner no longer appears inside the native shell
  (`ecea6a0`), which a reviewer could have read as pointing outside the App
  Store. The fix is live in production.
- The dev-only *Reset install prompts* row is gated to localhost
  (`public/student/app.js:1118`) and cannot appear for a reviewer.
- No purchase interface of any kind exists in the student app — Stripe appears
  only on the vendor terminal.
- Signing up is open to any email address. The `psu.edu` check only decides a
  welcome bonus; it never gates access.
- All three Info.plist purpose strings are present and specific
  (`ios/App/App/Info.plist:42-47`).
