# Native push on iOS (APNs) — the plan

Written 2026-10-12 alongside migration-064. That migration gave reminders and
announcements an email fallback, which is what reaches lapsed students **today**
on every platform. This file is the other half: the reason the iOS app needs
native push at all, and what it takes. Nothing here is built yet.

---

## 1. Why the iOS app receives zero notifications today

Not a bug, and not a configuration mistake. It is structural, and it is worth
being precise about because the symptom ("notifications don't work on the app")
invites a hunt through VAPID keys and migrations that will find nothing.

- The only push mechanism in the codebase is **Web Push over VAPID**:
  `web-push` in `package.json`, `src/lib/push.js`, a service worker at
  `public/student/sw.js`, and endpoints in `push_subscriptions`.
- Web Push needs the `PushManager` API. On iOS, Safari exposes it **only to a
  web app installed to the Home Screen** (iOS 16.4+), never to a plain tab and
  never inside a `WKWebView`.
- The App Store build is a Capacitor shell whose `capacitor.config.json` sets
  `server.url` to `https://we-rewards.com`, so the student app runs inside a
  `WKWebView` loading production. `PushManager` is simply absent there.
- The client already detects this and degrades honestly:
  `public/student/app.js` bails out of `initPush` when `PushManager` is missing,
  and `isIosSafariTab()` exists precisely because "iOS gates PushManager behind
  an installed PWA".

So every student on the App Store build is unreachable by push, permanently, no
matter how often they open the app or how many times they tap Allow. Reaching
them needs **APNs**, which is a different transport with a different credential,
a different payload and a different token shape.

Two consequences worth stating plainly:

1. **Email is the only channel that reaches iOS app users at all**, until this
   lands. That is the whole reason migration-064 exists and why it was built
   first.
2. **A student can be reachable on the web and not in the app**, with the same
   account. A Home-Screen PWA on the same phone *does* get Web Push. So "does
   this student have an endpoint" is about a browser, not about a person.

---

## 2. What has to change

### 2.1 The dependency and the native shell

- Add `@capacitor/push-notifications` to `dependencies`. It must be a real
  dependency, not a dev one, for the reason the `_comment:capacitor-deps` note
  in `package.json` gives about `@capacitor/core`: `server.js` runs
  `buildClientAssets()` at import, the dyno installs with `--omit=dev`, and
  `scripts/build-client.js` copies browser bundles straight out of
  `node_modules` by path. Anything the client imports must be installed at boot.
- `npx cap sync ios`, then in Xcode add the **Push Notifications** capability
  and **Background Modes → Remote notifications** to the App target.
- Register in the web layer, guarded so nothing changes off-iOS. The existing
  `window.Capacitor` detection in `public/student/app.js` (around the
  "The native shell injects window.Capacitor into this remotely-loaded page"
  comment) is the right place to branch: native shell → APNs registration,
  everything else → the current `PushManager` path, unchanged.

⚠ **`server.url` means the client fix needs a production deploy.** The app loads
`https://we-rewards.com`, so the registration code has to be live in production
before any installed build can use it. This is the same constraint recorded for
the off-origin OAuth work.

### 2.2 Apple-side credentials

- An **APNs Auth Key** (`.p8`, Keys → Apple Push Notification service) is the
  right choice over a certificate: one key signs for every app and never
  expires. You need the key file, its Key ID, and the Team ID.
- Three new environment variables, mirroring how VAPID is handled so the feature
  is optional in exactly the same way: `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_KEY_P8` (the PEM body, newline-escaped — a file path will not survive a
  dyno restart), plus `APNS_TOPIC` = `com.werewards.app`.
- `src/lib/push.js` computes `pushEnabled` from the presence of VAPID keys at
  module scope. The APNs path should compute its own `apnsEnabled` the same way,
  and **`pushEnabled` must become "either transport is live"** wherever it gates
  a claim, or an APNs-only deployment would never claim anybody. The same shape
  migration-064 applied to `emailEnabled` in the two workers.

### 2.3 The schema

`push_subscriptions` is web-push shaped: `endpoint` (unique, the upsert key),
`p256dh`, `auth`. An APNs registration has none of those — it is a device token
and nothing else. Two options:

- **Preferred: one table, a nullable discriminator.** Add
  `transport text not null default 'webpush'` and `device_token text`, relax the
  `not null` on `p256dh`/`auth`, and make the uniqueness `(transport, coalesce(endpoint, device_token))`.
  Everything downstream — `studentSubscriptions`, the `role` filter, the claim
  functions' `exists (push_subscriptions …)` reachability tests, the
  device-label log plumbing from migration-062 — keeps working with no change,
  which is the real argument for it. The claims care only *whether a row
  exists*, not what is in it.
- Rejected: a second table. It would double every reachability test in
  migrations 047, 051, 060, 061 and 064, and those tests are duplicated between
  each claim's driving query and its in-loop re-check. Eight more places to keep
  in sync for no gain.

Note the prune path: `src/lib/push.js` deletes a row on 401/403/404/410 from a
push service. APNs signals a dead token with `410 Unregistered` (and
`BadDeviceToken` 400), so the pruning rule needs an APNs branch — a 400 from
APNs is sometimes fatal for the token and sometimes a payload bug, and deleting
on the wrong one silently unsubscribes working devices.

### 2.4 The send path

`web-push` cannot talk to APNs. Options, in order of preference:

1. **Send APNs yourself over HTTP/2** with a signed JWT (`ES256`, the `.p8` key,
   10-minute expiry, cached). No new dependency beyond a JWT signer — the repo
   already has `src/lib/jwt.js`. Node's `http2` is in core. This is maybe 80
   lines and keeps `node_modules` flat.
2. `@parse/node-apn` if hand-rolling HTTP/2 proves fiddly. It is mature but it
   is another dependency in the dyno's boot path.

`sendToSubscriptionsDetailed` in `src/lib/push.js` is the right seam: it already
takes a list of rows and returns a per-device result, and every caller
(`campaigns.js`, `reminders.js`, `broadcasts.js`) reads only `accepted` and
`devices`. Branch **inside** it on `row.transport` so no caller changes and the
notification log keeps its per-device shape.

The payload differs: Web Push takes arbitrary JSON the service worker reads,
APNs wants `{aps: {alert: {title, body}, sound, badge}}` plus custom keys for
the deep link. `composeNotification`/`composeReminder`/`composeBroadcast` should
keep returning what they return — the translation belongs next to the transport,
not in the composers, so the copy stays testable as a pure function.

### 2.5 What does NOT change

Worth saying, because it is most of the system. The shared budget, quiet hours,
the caps, the per-vendor fence, the claims, the notification log, the admin
Notifications tab, and every line of policy in §7.4 are all transport-agnostic.
APNs adds a way to *reach* a student; it adds no new message, no new record and
no new consent question — so **it needs no `TERMS_VERSION` bump**. §7.4 already
describes "a push notification" without naming a technology, and migration-064's
revision generalised the channel wording further.

---

## 3. Order of work

1. Ship migration-064 and the email fallback. **Done** — that is what reaches
   these students in the meantime, and it is not wasted work once APNs lands:
   email stays the fallback for everyone whose device refuses a push.
2. Apple-side: create the APNs Auth Key, add the capability, note Key ID and
   Team ID. Nothing in the repo blocks on this, so it can start immediately and
   in parallel.
3. Schema migration (065): `transport`, `device_token`, relaxed constraints,
   new uniqueness.
4. `src/lib/push.js`: `apnsEnabled`, the JWT, the HTTP/2 sender, the transport
   branch in `sendToSubscriptionsDetailed`, the APNs prune codes.
5. Client registration behind the `window.Capacitor` branch, plus a
   `POST /api/me/push/subscribe` that accepts a device token. **Deploy to
   production before shipping a build**, per §2.1.
6. New iOS build, TestFlight, verify on a physical device. The simulator cannot
   receive APNs.

## 4. Open questions for later

- Permission prompt timing. iOS shows one system prompt and `requestPermission`
  is one-shot, the same trap `askNotificationPermission` documents for the web.
  The current client asks only once a deal exists, which is good practice worth
  keeping rather than re-deriving.
- Whether a student with both a Home-Screen PWA and the app should get two
  pushes. Today two browser endpoints both receive; that is arguably correct for
  two devices and clearly wrong for two shells on one phone. Deduping needs
  something stabler than a device label, so this is a product call, not a
  lookup.
