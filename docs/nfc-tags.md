# NFC tags at the counter

Rewritable NFC stickers, one per partner spot, placed beside the terminal. A
student taps one with their phone and lands on that spot in the app. The tag
holds nothing but a URL; everything that makes the tap feel native is in the
app, on the server and in Apple's account settings, which is why this file
exists.

What the repo carries: the Associated Domains entitlement
(`ios/App/App/App.entitlements`, wired into both target configs of
`ios/App/App.xcodeproj/project.pbxproj`), the server's
`/.well-known/apple-app-site-association`, the `/t` landing route, and the
in-app routing of a delivered `/t/...` URL. What only the owner can do is §3.

---

## 1. What this is

### The URL contract

| Written on the tag | Opens |
| --- | --- |
| `https://we-rewards.com/t/<vendor-slug>` | that spot |
| `https://we-rewards.com/t/<vendor uuid>` | that spot; accepted, but prefer the slug, which a human can read and check |
| `https://we-rewards.com/t` | the app's Home, for a generic campus tag that belongs to no spot |

The slug is the one in the spot's public page, `https://we-rewards.com/spots/<slug>`,
so read it off the site rather than the database. Every vendor has one (the
column is required), and `/t` resolves slug and uuid alike against the same
public catalogue, so a spot that is paused or not yet approved cannot be tagged
either way until it is live; until then its tag renders the generic page.

Write the origin exactly as `https://we-rewards.com`. The app's entitlement
covers the apex only, so `http://` or `www.` never triggers the Universal Link:
the tap opens Safari instead, every time, with nothing in any log.

### Writing a tag

1. Install **NFC Tools** (free, iPhone and Android).
2. Write → Add a record → **URL/URI** → paste the full `https://...` URL →
   Write, then hold the phone on the tag until it confirms.
3. Use a **URI record, not a Text record**. iOS reacts only to URL records; a
   Text record that happens to contain a URL is ignored.
4. Keep the URL record **first** on the tag. iOS reads the first URL record and
   stops, so anything written in front of it hides the link.
5. Keep the tag **NDEF-formatted**. NFC Tools formats a blank tag on its first
   write; a tag that was used for something else gets Erase first. Do not lock
   the tag: it is meant to be rewritten when a spot changes slug or leaves.

Any NTAG213 or larger sticker works; the URL fits the smallest one many times
over.

---

## 2. What a tap does, per platform

The honest version. Each row is the ceiling for that platform, not a bug list.

| Phone | Result |
| --- | --- |
| iPhone with the App Store app installed | Opens the app on that spot. That is a Universal Link, which §3 sets up. Background tag reading (screen on, no app open) needs iPhone XS or later; older iPhones read tags only through the Control Center NFC reader. |
| iPhone without it | Safari opens the landing page. An installed home-screen PWA can never be opened from a URL on iOS; Apple provides no way, so the PWA is never the target. |
| Android with the PWA installed | Chrome hands the URL to the installed PWA, when Chrome is the default browser. Any other default browser: the landing page. |
| Everything else | The landing page in the phone's browser. |

The landing page offers **Get the app** and **Continue on the web** on every
tap. That is the owner's decision: no cookie remembers the choice (the only cookie
the page sets is the anonymous visitor nonce that counts taps, section 7), so a student
who picked the web once is offered the app again next time.

---

## 3. One-time Apple setup (owner)

The repo already carries the entitlement and the Xcode wiring. The steps below
live in Apple's account and in App Store Connect, so they cannot be committed.

1. **Enable the capability on the App ID.** developer.apple.com → Certificates,
   Identifiers & Profiles → Identifiers → `com.werewards.app` → tick
   **Associated Domains** → Save. Automatic signing usually does this for you
   the first time Xcode sees the entitlement, but check: a provisioning profile
   without it fails at archive time with an error naming the entitlement.
2. **Check Xcode agrees.** Target App → Signing & Capabilities should now list
   Associated Domains with `applinks:we-rewards.com`, read from
   `App/App.entitlements`. If it does not, add the capability there and type
   the same domain: Xcode writes the same entitlements file and the same
   `CODE_SIGN_ENTITLEMENTS` setting, so the result is identical to the repo's.
3. **Deploy the server change to PRODUCTION FIRST**, then verify it:
   `curl -I https://we-rewards.com/.well-known/apple-app-site-association`
   must return `200`, `content-type: application/json` and **no redirect**.
   iOS never reads the file from us directly; it reads Apple's CDN copy at
   `https://app-site-association.cdn-apple.com/a/v1/we-rewards.com`, which can
   lag hours behind the deploy. `curl` that too, and do not debug a phone until
   the two match.
4. **New build, archive, upload.** The entitlement exists only in a binary
   built after step 1, and iOS fetches the association file when that binary
   is installed. Raise `CURRENT_PROJECT_VERSION` first (it is `2` today, in BOTH
   target configs of `ios/App/App.xcodeproj/project.pbxproj`, or in Xcode's
   General tab) or App Store Connect refuses the upload as a duplicate build,
   then go through TestFlight or review as usual. This is a NEW binary: the App
   Review Notes text from `docs/app-review-notes.md` §3 goes back into App Store
   Connect for this version, and the build cannot ride on the pending Resolution
   Center reply, which needs no build.
5. **Optional: test on a device before Apple's CDN catches up.** In Xcode add
   a second entry, `applinks:we-rewards.com?mode=developer`, to the capability;
   on the phone turn on Developer Mode (Settings → Privacy & Security) and, in
   Settings → Developer, Associated Domains Development; then run a Debug
   build from Xcode. In that mode the phone fetches the file straight from
   we-rewards.com. Remove the entry before archiving; never ship it.

---

## 4. Verifying on a phone

iPhone:

1. Paste the tag's URL into Notes and long-press it. The menu should offer
   **Open in WeRewards**. If it offers only Safari, the association has not
   reached the phone: re-check §3 steps 3 and 4, then delete and reinstall the
   app, which forces a fresh fetch.
2. If iOS once learned to open Safari for this domain (it learns that when
   someone picks Safari from this menu, or taps the domain breadcrumb at the
   top right after the app opened), long-press the link and choose the app.
   That resets the preference.
3. Tap a real tag. The app should open on the spot with no Safari in between.

Android:

1. Install the PWA from Chrome (the in-app prompt, or Chrome's menu → Install).
2. Tap the tag. Chrome should open the installed PWA on the spot.

---

## 5. Config

| Variable | What it does |
| --- | --- |
| `IOS_APP_STORE_URL` | Where the landing page's **Get the app** sends an iPhone. Set it on **both** Heroku apps (production and staging) once the listing exists. Until then an iPhone gets the web app's add-to-home-screen guide instead, which is the intended fallback, not a bug. |
| `APPLE_TEAM_ID` | The team in the association file. Defaults to the real value, `UXXL68D688`. |
| `IOS_BUNDLE_ID` | The bundle id in the association file. Defaults to the real value, `com.werewards.app`. |

Set the last two only if the Xcode project changes. The defaults are correct
today, and a typo in either breaks every Universal Link with no error anywhere:
the phone just opens Safari.

---

## 6. What these tags cannot do

Written down so nobody re-litigates it:

- **A passive tag cannot read a phone.** It has no power of its own; the phone
  reads it, never the other way round. So it cannot see an Apple Wallet or
  Google Wallet pass either.
- **Reading wallet passes needs certified hardware.** Apple VAS and Google
  Smart Tap need a certified reader and, for Apple, an NFC pass certificate
  issued to the pass issuer by Apple. The counter iPad has no NFC hardware at
  all.
- **Web NFC does not exist on iOS.** Chrome on Android has it; Safari does not.

### The phone-tap version, for a later phase

The tag already identifies the vendor, which is the hard part. The flow would
be: student taps the tag, the app opens on the spot, they tap **Redeem**, and
the terminal shows its confirm screen without anyone scanning or typing a code.
In outline:

1. The terminal joins a Socket.IO room per vendor, authenticated on the socket
   handshake the way `requireVendor` authenticates HTTP, as `io.use` in
   `server.js` already does for students.
2. The student's reward sheet gains a **Send to counter** action, shown only
   when the app was opened from that vendor's tag.
3. It reuses the existing 4-digit redeem code: the server runs the same preview
   that `POST /api/vendor/redeem-preview` runs today and pushes the result into
   the vendor's room.
4. The terminal paints its usual confirm screen and the cashier confirms as
   now, so nothing about points, codes or expiry changes.

---

## 7. Tracking and slugs in /admin

### Where the numbers live

**/admin → QR & NFC tab → NFC tags card.** One row per spot, with the tag
URL (`/t/<slug>`), **Copy link**, **Copy permanent link**, **Traffic** and
**Edit slug**, and these figures:

| Figure | What it counts |
| --- | --- |
| Taps today / 7 days / 30 days / all | Every tap of that spot's tag that reached us, by either path below. "Today" is the campus day (America/New_York), not UTC, so a tap at dinner stays in today's column. |
| People | Distinct visitors over 30 days. The landing page sets a cookie holding a random nonce and the server keeps only a hash of it; an app tap is counted by the student account instead. Two taps from one phone are one person. |
| App share | The share of the last 30 days' taps that the iOS app reported itself. An iPhone with the app installed opens the tag's URL as a Universal Link, which never reaches the landing page, so the app sends one beacon once it has opened the spot. Without it an installed app's taps would be invisible. |
| Last tap | When the tag was last read. The quickest answer to "is this tag still working?" |

**Traffic** opens the daily and hourly bars for the last 30 days, bucketed in
the campus timezone like the poster charts. **Export all as CSV** downloads
every tap (time, spot, ref, source, known, user agent) for anything the card
does not show.

The **generic tag** (`/t`) has a row of its own. The **Unmatched** list,
shown only when it has something in it, is every ref that matched no spot,
with a count: a slug typed wrong when the tag was written, a slug the spot has
since changed, or a spot that has left. The tag is still on a wall, so these
keep arriving until someone rewrites it, and the list is where to find which
one.

A row reading 0 everywhere means no tap has reached us, not that the tag is
broken: check the URL on the tag against the row's **Copy link** value first
(§1), then tap it with a phone that has nothing installed and watch "Taps
today" move.

### Setting a spot's slug

Open the spot's **Edit** dialog from the vendor roster on the Dashboard and find **Web address and
NFC tag** (the NFC tags card's **Edit slug** button lands there directly). The
slug is the last part of both `we-rewards.com/spots/<slug>` and
`we-rewards.com/t/<slug>`; the dialog shows both as you type.

Rules: lowercase letters, digits and hyphens, no leading or trailing hyphen,
at most 60 characters, not a uuid, and not one of the words the site uses for
its own routes (`t`, `spots`, `admin`, `terminal`, `scan`, `join`, `legal`,
`api`, `r`). Two spots cannot share one; the dialog says so when the slug is
taken. A new spot gets a slug made from its name unless you type one in the
new-spot form.

⚠ Changing a slug changes the spot's web address AND every tag already written
with the old one. From the next tap on, those tags land in the Unmatched list
under the old slug until they are rewritten (§1, Writing a tag). Two things
survive a rename on their own:

- **The permanent link.** `/t/<uuid>` (**Copy permanent link** on the card)
  names the spot by its id and keeps working through any number of renames.
  Use it on a tag that will be hard to get back to; use the slug where a
  person might read the URL.
- **The history.** Taps are counted against the spot, not the slug, so the
  figures above carry over unchanged.

### Before deploying this

⚠ Migration 065 (`supabase/migrations/20261014120000_migration-065.sql`) must
be pasted into the production SQL editor BEFORE the code that reads it is
deployed. Until it is applied the card shows **Migration 065 not applied**, the
landing page and the app keep working as before, and every tap is counted only
in `client_events`, where /admin cannot see it per spot. Nothing in the
migration is used until the server asks for it, so applying it ahead of the
deploy is safe.
