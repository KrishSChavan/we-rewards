# Go to market — bars and freshmen

_Written 2026-07-29. Two segments, two campaigns: how to sell WeRewards to
downtown bars, and how to acquire the incoming freshman class. Assumes the
product as built (see [`README.md`](README.md)) and the strategic read in
[`notes.md`](notes.md)._

---

## ⚠ Read this first: freshmen and bars are not one campaign

Freshmen are 18. They cannot legally be bar customers in PA. Selling bars and
acquiring freshmen are two different products aimed at two different markets,
and running them as one story makes both weaker.

- **Freshmen → food.** Late-night pizza, wings, coffee, boba, cheesesteaks,
  breakfast. This is the volume audience and the one that makes the
  cross-vendor tier in `src/lib/tiers.js` actually mean something.
- **Bars → sophomores through grad students.** Higher ticket, real marketing
  budgets, zero overlap with the freshman campaign.

**Bars are a good revenue segment and a bad launch segment.** If the fall goal
is a freshman launch, we need 8–12 downtown *food* vendors before move-in, and
bars can wait until October.

---

# Part 1 — Selling to bars

## What they want, in their priority order (not ours)

**1. Bodies on dead nights.** This is the whole thing. A State College bar's
revenue is violently bimodal — home football Saturdays, THON, Arts Fest,
Homecoming are at capacity with a line outside; Tuesdays in February are empty,
and May–August is near zero. **Loyalty is worthless to them on a Saturday.**
They don't need us when they're full. They need us on a Sunday in November.

So never open with "get more customers." Open with:

> _"You're turning people away on Saturday and empty on Tuesday. This moves
> some of that Saturday crowd to Tuesday."_

That requires a **time-boxed multiplier** — "3x points Sun–Wed" — which is
[`notes.md`](notes.md) ADD #2 and is **not built**. For bars it isn't a
nice-to-have, it's the entire product. Build it before the first bar meeting.

**2. They have no customer data at all.** A restaurant with Toast has phone
numbers and to-go orders. A bar has cash, cards, and nothing else — no idea who
its regulars are, no way to reach them. "You'll have a list of your 300 regulars
and a button that reaches them" is genuinely new to a bar in a way it isn't to a
sandwich shop. **This is the strongest non-obvious pitch we have.**

**3. Zero work for bartenders.** Turnover is brutal and anything a bartender has
to remember dies in two weeks. If the ask is "enter the dollar amount and take a
6-digit code" during a Saturday rush, the answer is no, and it should be.

**4. Not giving away liquor.** Two reasons, and one is existential — see below.

**5. Proof, in dollars, before they pay.** They will ask "how do I know it
worked." The terminal's STATS tab shows returning customers and revenue; we need
to be able to say "these 40 people came in twice this month and here's what they
spent."

**6. No contract, no lock-in, we do the setup.** They've been burned by app
salespeople before.

## Where the product is weakest at a bar — know it before they find it

**Manual dollar entry is worse at a bar than anywhere else.** Already flagged as
the weak joint in [`notes.md`](notes.md); a packed bar is where it breaks
completely. Fix by changing the mechanic, not the speed:

- **Award per visit, not per dollar,** at bars — a flat "check in, get 50
  points." Visit-based rewards are ADD #5 in `notes.md` and unbuilt. For bars
  they're the *primary* mechanic, not a widening of the merchant set.
- **Award at the door / host stand, not the bar.** The doorman is standing still
  with nothing to do. The bartender is not.
- Or **only run it Sun–Wed**, which is when we want the traffic anyway. "It's off
  on Saturdays" is a feature, not an apology.

**Points-per-dollar on alcohol is a liquor-license and PR problem.** A system
that pays students more for drinking more is a headline waiting to happen and a
real risk to a licensee. PA's liquor rules also restrict promotions and
giveaways of alcohol.

> **Open item:** get the PLCB rules reviewed by someone who actually knows them
> before signing the first bar. Nothing below is legal advice.

Design around it regardless:

- **Cap points per visit** at a bar (which also makes the visit-based model easy
  to justify).
- **Never redeem for alcohol.** Redeem for food, merch, cover charge,
  non-alcoholic drinks, skip-the-line, a reserved booth.

**Cover charge is the best redemption available for a bar**: the room already
exists, marginal cost is near zero, and it isn't liquor. Merch is next — a
koozie costs them ~$1.50 and walks around campus advertising for both of us.

## The pitch and the ask

Walk in **2–4pm on a Tuesday or Wednesday**, when the owner is doing inventory.
Not at night, not by email. These are independent, owner-operated, often
decades-old businesses — this is a relationship sale, and the owner is the only
person who can say yes.

Thirty seconds:

> "I run WeRewards — a rewards app that a bunch of downtown spots share.
> Students earn points everywhere in town, one app. What I actually do for you
> is fill Sunday through Wednesday: I can flip your points to 3x on the nights
> you're slow and push it to every student on the app. Costs you nothing to try,
> I install the tablet, I train your staff, and you never give away liquor —
> people redeem for wings, merch, or cover. Free through September 30. Want to
> try it on one Tuesday?"

**The ask is one Tuesday, not a contract.** Get a yes to a small thing.

Bring: the tablet (let them hold it), a one-page sheet, and a printed table tent
so they see the in-house materials are already done. If any vendors are live,
bring their numbers.

**The two objections, every time:**

| Objection | Answer |
|---|---|
| "We're already packed on weekends." | "Right — that's why this is a Sunday-to-Wednesday tool. I don't want to touch your Saturday." |
| "Bartenders won't do it." | "They won't. That's why it's at the door, one tap for a check-in, not a dollar amount." |

**On pricing.** We're competing against what they already spend — Instagram
promoters, Onward State ads, greek org bar nights, koozies. That's the
comparison set, and it's a few hundred dollars a month. Bars can bear a higher
tier than a coffee shop because tickets are bigger, but only if the slow-night
lever is real. Given the **Oct 1 2026 founding→paid conversion**, a bar must have
*seen* a full slow-night cycle before the bill arrives or it churns at
conversion.

---

# Part 2 — Marketing to freshmen

## The window is ~3 weeks, then it closes

As of 2026-07-29, fall move-in is roughly three weeks out (confirm exact dates
on the PSU academic calendar). **Freshman habits lock in during the first two to
three weeks.** Whoever gets them in that window keeps them until they graduate.
Miss it and the next opening is January.

Which sets the sequencing: **vendors first, students second.** An app with three
vendors does not convert a freshman, and we only get one first impression.
Between now and mid-August the entire priority is signing downtown food vendors.

## Why freshmen specifically are the right user

They're the only students who **don't know the town**. A sophomore already has
their spot. A freshman just arrived, has a campus meal plan and no idea where to
eat downtown, and is actively looking. So the real pitch is not "loyalty points":

> **"One app that shows you every good local spot downtown — and pays you to try
> new ones."**

That's the breadth tier in `src/lib/tiers.js` stated as a benefit instead of a
mechanic, and it's a better story than any punch card. It also needs the
map/discovery feed (ADD #1 in [`notes.md`](notes.md), unbuilt) to be *true* when
they open the app.

## Channels, best first

1. **The vendors themselves.** Cheapest, highest-intent channel we have — a card
   at every register, at the moment a freshman is already paying, reaching
   someone who is already a customer of a participating shop. **Build the table
   tent + register sign into the vendor agreement.** Costs the vendor nothing and
   it's how density compounds.
2. **Class of 2030 GroupMe.** The class GroupMes are the real freshman social
   layer and already exist (formed spring/summer 2026). Get in early; post the
   offer once, from a real person — ideally a current student we've recruited.
3. **RAs and floor events.** An RA running a floor event with free pizza where
   everyone signs up is the highest-conversion thing available — dense, captive,
   social. **Check Residence Life policy first**; PSU restricts commercial
   solicitation in dorms. The clean version is sponsoring an RA's event, not
   marketing inside a residence hall.
4. **Move-in week, physically, on the strip.** East Halls alone is thousands of
   freshmen in one place. Table on College Ave with free food from a partner
   vendor and a QR code. Move-in day is also the one day of the year parents are
   present and the wallet is open.
5. **Involvement fair.** Everyone goes, everyone's collecting free stuff —
   hundreds of signups in an afternoon.
6. **Instagram / TikTok, local accounts.** Onward State, Barstool Penn State, PSU
   meme and food accounts. A paid post on a local account beats broad
   geo-targeted ads by a lot, because the credibility transfers. Budget a few
   hundred dollars for launch week specifically.
7. **Greek rush, September.** Enormous concentration of freshmen in one social
   funnel.

## The offer

An 18-year-old does not respond to "earn points." They respond to **free food,
right now, today**:

> **"Sign up, get a free [slice / coffee / boba] at [vendor] today."**

Delayed gratification converts nobody. Give the reward on signup, redeemable
that day, at a specific named place they can walk to.

Then the highest-leverage unbuilt thing: **referrals** (ADD #3 in
[`notes.md`](notes.md)). Freshmen arrive in dense clusters — floor, roommates,
orientation group — and a "you both get points" loop moves through a dorm floor
in days. A PWA has no app-store discovery, so **referral is the only viral
surface we have.** If we build one growth feature before move-in, build this.

## Three things to be careful about

- **Don't use "Penn State," "PSU," or the Nittany Lion in marketing materials.**
  Penn State licenses its marks aggressively. "WeRewards" is the right call —
  keep the PSU naming confined to the folder name (and see `notes.md` IMPROVE #5
  on branding coherence generally).
- **Flyering and chalking have rules**, both PSU's and the borough's. Get them
  before printing.
- **Keep the freshman campaign entirely food-facing.** Even once bars are signed,
  nothing in freshman-targeted marketing should mention them.

---

## Calendar

| When | Do |
|---|---|
| **Now → Aug 10** | Sign 8–12 downtown **food** vendors. Nothing else matters as much. |
| **Now → Aug 10** | Build **referrals** and the **map/discovery** view. Both are freshman-launch-critical, both unbuilt. |
| **Aug 10 → move-in** | Print register cards + table tents for every vendor. Line up one paid local IG post. Get into the class GroupMes. Lock a signup-day free item with 2–3 vendors. |
| **Move-in week** | Table on the strip. Involvement fair. This is the whole year's acquisition. |
| **Sept** | Start walking into bars, with student numbers in hand. Build the **slow-night multiplier** first. |
| **Oct 1 2026** | Founding vendors convert to paid. Every vendor must have *seen* its ROI in the terminal before this. |

## Bottom line

Two unbuilt features gate this plan:

1. **Referrals** — the freshman growth loop, and the only viral surface a PWA
   has.
2. **Time-boxed point multipliers** — the only thing a bar actually wants, and
   the thing that turns a dead Tuesday into the pitch.

Everything else in this doc is legwork that can start today.
