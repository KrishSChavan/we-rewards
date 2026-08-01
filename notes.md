# WeRewards — Product Notes: Snackpass comparison & viability

_Analysis snapshot — 2026-07-27. Compares the current WeRewards model against
Snackpass, assesses viability, and lists what to add / improve / change / cut._

---

## What WeRewards actually is (as built)

A **per-vendor loyalty-points layer that sits on top of a merchant's existing
register** — not an ordering or payments app.

- **Student PWA** — Google sign-in, rotating 6-digit identity code, per-vendor
  point balances, a cross-vendor engagement "tier," redeem flow, history, data
  export/delete.
- **Vendor terminal** (loaner tablet, web app) — cashier manually enters the
  **dollar amount** of a normal purchase → scans the student's code → awards
  `floor(amount × points_per_dollar × tier_multiplier)`. Also: redeem,
  void/undo, self-service items, PIN-gated settings, per-vendor analytics.
- **Admin dashboard** — platform analytics, vendor kill-switch/delete,
  application queue, error log.
- **Revenue model** — flat **monthly SaaS subscription per vendor** (founding
  vendors free through Sept 30 2026, convert to paid Oct 1 2026). Loaner device
  at no charge. **No transaction/commission cut, no payment processing.**
- **Notable original idea** — `src/lib/tiers.js` scores students on **breadth
  (how many different local vendors they visit)**, depth, and spend, paying a
  1x / 1.5x / 2x multiplier — deliberately rewarding *spreading spend across the
  local network* over whaling one shop.

**Defining fact: WeRewards never touches the transaction.** It's a loyalty
overlay, not the checkout.

## Snackpass, for contrast

Same campus-first origin (Yale, skip-the-line), now a **full restaurant
operating system**: in-app **mobile ordering + payments** (pickup/delivery/
dine-in QR), native iOS/Android **marketplace** app, integrated **loyalty**, a
heavy **social/viral layer** (gifting food to friends, streaks, leaderboards,
referrals), **customer marketing** (SMS/push campaigns, promos), and a full
**POS/kiosk/KDS hardware stack**. Revenue = **commission/take-rate per order +
POS SaaS + hardware**. Because Snackpass *is* the checkout, it captures every
transaction automatically and owns the customer relationship.

## The two models side by side

| Dimension | WeRewards (us) | Snackpass |
|---|---|---|
| Core job | Loyalty points overlay | Ordering + payments + POS + loyalty |
| Owns the transaction? | **No** — cashier hand-enters $ | **Yes** — captured at checkout |
| How points are captured | Manual dollar entry per sale | Automatic from the order |
| Revenue | Flat monthly SaaS/vendor | Commission per order + SaaS + hardware |
| Loyalty scope | **Cross-vendor network** (breadth tiers) | Per-restaurant |
| Social / viral | None | Gifting, streaks, leaderboards — the growth engine |
| Customer re-engagement | None (push is admin-only) | SMS/push marketing campaigns |
| Client | PWA (no app store) | Native apps + web |
| Merchant hardware | Thin web terminal on a loaner tablet | Full POS / kiosk / KDS |
| Adoption friction | **Very low** (no POS/payment change) | High (rip-and-replace POS) |
| Revenue ceiling per vendor | Low, fixed | High, volume-scaling |

---

## Viability verdict (honest)

**Viable as a focused, bootstrappable niche product — not as a head-on Snackpass
competitor, and we shouldn't try to be one.**

**Genuine strengths**
- Near-zero adoption friction (no payment integration, no PCI, no POS
  replacement — a vendor just plugs in a tablet).
- Clean, unusually well-secured codebase (atomic money RPCs, idempotency, PIN
  lockout, DB-level write guard, consent gating, real tests).
- One legitimately novel idea nobody else ships well: a **shared cross-vendor
  loyalty network with breadth-rewarding tiers**.

**Structural risks**
1. **Loyalty-only is a crowded, low-margin category.** Square Loyalty, Toast
   Loyalty, Fivestars/SumUp, Thanx, Punchh — and Snackpass/Toast/Square all
   *bundle loyalty free* with the POS we're sitting next to. A standalone
   loyalty tablet must justify a monthly fee against free bundled alternatives.
2. **Manual dollar entry is the weak joint.** The cashier has no incentive to do
   it, can fat-finger it, or skip it. Snackpass never has this problem because it
   owns checkout. This caps data quality and trust in the tiers.
3. **Flat SaaS = low ceiling, no volume upside.** Fine for a lean campus
   business; hard to make venture-scale without eventually touching transactions.
4. **Cold-start / density.** The best feature (cross-vendor tiers) only *matters*
   once many vendors in one town are on it. Below critical density it's just a
   worse per-vendor punch card.

**The wedge that makes it work:** don't be "Snackpass." Be **"the shared rewards
network for [one college town]'s independent eateries"** — one identity, points
everywhere, tiers that make students explore local spots. Win one geography to
density, then repeat. That's a real product Snackpass/Square structurally don't
offer.

---

## ➕ ADD (highest-leverage first)

1. **A student-facing reason to open the app when not buying.** Today the app is
   inert between purchases. Add the network layer: a **map/discovery feed of
   participating vendors**, "points near you," featured/limited rewards. This
   converts a punch card into a habit.
2. ~~**Vendor→customer marketing (re-engagement).**~~ **SHIPPED** (migration-032,
   terminal DEALS tab). Vendors send offers to their top 100 / lapsed /
   close-to-a-reward customers; students get a push plus an in-app Deals list.
   The hard part was not the sending. Every vendor's "top 100" is largely the
   SAME 100 students — the tier model pays for breadth, so the regulars at one
   spot are regulars at five — which makes a Friday-evening pile-up the default
   case, not an edge case, and one `Block` kills the channel permanently. So
   delivery is queued rather than sent: per-student cooldown + daily/weekly caps
   are the guarantee, a few minutes of hold lets simultaneous campaigns coalesce
   into one digest, and the in-app list carries anything the throttle suppresses.
   See the README section and the header of `supabase/migration-032.sql`.
   Still open from this item: **operator**-sent messages (the platform speaking
   to all students at once), which would want its own audience and its own quota
   rather than borrowing a vendor's.
3. **A light social/referral hook.** Not the whole gifting economy — just
   **referral bonuses** ("bring a friend, both get points") and maybe **gift a
   reward to a friend.** Gives the viral loop a PWA otherwise lacks (no app-store
   discovery). Cheap to build, big on cold-start.
4. **Auto-capture the amount instead of manual entry — even optionally.** A "scan
   the printed receipt total" step, a read-only Square/Toast/Clover integration,
   or a QR-on-receipt would kill the manual-entry weakness. Even one POS
   integration materially de-risks the whole model.
5. **Punch-card / visit-based rewards, not just spend-based.** Many local shops
   think "buy 10, get 1 free," not points-per-dollar. Supporting a visit-count
   reward type widens the addressable merchant set considerably.
6. **Vendor self-serve onboarding + billing.** Self-serve signup, Stripe
   subscription billing, a "manage plan" screen. Today onboarding is a CLI/admin
   flow and billing is a paper agreement — won't scale past hand-held pilots.
7. **Expiration / breakage policy for points** (currently deferred). Points that
   never expire are an unbounded liability on vendors' books and a common reason
   merchants distrust loyalty. Make it configurable.

## 🔧 IMPROVE

1. **The scan flow.** Manual 6-digit entry *both directions* is slow and
   error-prone at a busy register. Move to **QR (student shows QR, terminal
   camera scans)** or NFC — faster, fewer mistakes, and what students expect.
2. **Cashier incentive/compliance.** Lean harder into one-tap quick-amounts;
   consider a student-side self-claim within N minutes so awards don't silently
   get skipped.
3. **Analytics at scale.** The 10k/20k row truncation is already flagged — a busy
   vendor will undercount. Push aggregation into SQL/materialized views before
   real volume.
4. **iOS PWA push reality.** PWA push on iOS is weak/flaky; if re-engagement
   notifications become core, evaluate a thin native wrapper (or be honest about
   the ceiling) before betting the roadmap on push.
5. **Branding coherence.** Folder `psu-rewards`, product "WeRewards", domain
   `we-rewards.com`, auth keys `psu-*`. Pick one before real vendors/students
   see it.

## 🔁 CHANGE

1. **Reposition from "loyalty app" to "local rewards network."** Same code,
   different center of gravity: sell the *network* (points everywhere in town,
   breadth tiers) to students, and *foot traffic from the network + marketing
   tools* to vendors. The only story that beats free bundled POS loyalty.
2. **Rethink flat SaaS-only pricing.** Tiered plans (free basic loyalty to get
   density, paid for marketing/analytics/multi-location) so you land vendors
   free, hit density, and monetize the ones who get value.
3. **Make the founding→paid conversion (Oct 1 2026) a real product moment,** not
   just a contract clause — vendors need to *see* ROI (customers returned,
   revenue attributed) in the terminal before the bill hits, or churn at
   conversion will be brutal.

## ➖ GET RID OF / DE-PRIORITIZE

1. **Don't build toward a full POS / ordering / payments stack.** That's
   Snackpass's/Toast's game — capital-intensive, PCI-heavy, and it throws away
   the one real advantage: zero adoption friction. Stay an overlay.
2. **Manual exact-dollar entry as the *only* capture method** — keep it as a
   fallback, stop treating it as the primary long-term path (see ADD #4 /
   IMPROVE #1).
3. **Base64 logos in Postgres rows** (~375KB each, already flagged) — move to
   object storage before more than a handful of vendors; bloats queries/backups.
4. **Operator-manual vendor lifecycle** (CLI onboarding, hand-run migrations,
   paper billing) — fine for a 5-vendor pilot, but a growth ceiling; replace
   with self-serve, don't carry forward.

---

## Bottom line

Well-built and genuinely viable **as a lean, campus-focused, cross-vendor
loyalty network** — low friction and the breadth-tier idea are real edges. **Not**
viable as a Snackpass-style all-in-one, and the trap is drifting toward
ordering/POS. The three things that most determine success:

1. **Solve cold-start density** in one geography.
2. **Give vendors customer-marketing / re-engagement tools** they'll pay for.
3. **Remove the manual-entry friction** at the register.
