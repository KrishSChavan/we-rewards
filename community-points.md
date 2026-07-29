# Community points — the cross-vendor wallet

_Plan written 2026-07-29; **step 5 revised the same day** — spending is a
one-way **transfer** into a vendor balance, not a cross-vendor redemption.
The **UI counter is built** (step 0 below, shipped). Everything from step 1
down is the earn/transfer engine and is **not built yet**._

---

## The idea, in one paragraph

Today every point a student holds is **locked to the shop that issued it**. 200
points at Irving's buys nothing at Waffle Shop. Community points are a second,
**parallel** balance that fixes that: every time a student earns at any spot,
**10% of those points are also minted into a single community pool**, and the
student can move that pool into **any** WeRewards vendor's balance, whenever
they choose.

It is **additive, not a tax.** The student does not give up 10% of their vendor
points — the vendor points are untouched and the community 10% is minted on top.
That matters for how it's pitched ("free extra points, everywhere") and for who
absorbs the cost (see [the open question](#-the-one-real-open-question-who-pays)).

### The flow, end to end

```
  Student spends $10 at Vendor A (10 pts/$, 1.5x tier)
                 │
                 ▼
    award_points(user, A, 150)             ← unchanged, existing path
                 │
     ┌───────────┴────────────┐
     ▼                        ▼
  +150 pts at Vendor A     +15 community pts        ← floor(150 × 10%)
  (point_balances)         (community_balances)
                                   │
                                   ▼
     Student taps the counter, picks Vendor B and an amount
                                   │
                                   ▼
      transfer_community_points(user, B, 80)     ← one-way, confirmed
                                   │
     ┌─────────────────────────────┴──────────────┐
     ▼                                            ▼
  −80 community pts                        +80 pts at Vendor B
  (community_balances)                     (point_balances)
                                                  │
                                                  ▼
              Redeems at Vendor B through the EXISTING WRW:R: flow
              — ordinary vendor points, cashier sees nothing new
```

**The defining property:** community points are the only balance in WeRewards
that is *not* keyed to a vendor. Every schema, API, and UI decision below falls
out of that one fact. They *become* keyed to one the moment they're transferred
— that is the whole spend mechanic, and it is why nothing at the register
changes.

---

## ⚠ The one real open question: who pays?

This is a **business** decision, not a code one, and it should be settled before
step 5 (transfer) is built. Steps 1–4 (minting, storing, showing) are safe to
build regardless — they only ever *accumulate* a number.

When a student moves points earned at **Vendor A** into **Vendor B** and redeems
a free drink there, Vendor B gives away real product for a liability Vendor A
created. The transfer model doesn't dissolve the question — but it makes the
liability **measurable at the moment of transfer**, before any product leaves
the shelf, which is exactly what makes option A's cap enforceable.

| Option | How it works | Trade-off |
|---|---|---|
| **A. Goodwill / reciprocity** (recommended for the pilot) | Every vendor accepts inbound transfers; over time the flows roughly net out. Platform publishes a per-vendor "transferred in vs. minted here" report so nobody feels cheated. | Zero settlement plumbing. Breaks down if one vendor is a big net receiver. Needs a **per-vendor monthly inbound cap** as the safety valve. |
| **B. Platform-funded** | WeRewards reimburses the receiving vendor in cash or subscription credit. | Cleanest for vendors, real cost to the platform. Needs a transfer ledger with dollar values. |
| **C. Inter-vendor settlement** | Issuing vendor is billed, receiving vendor is credited. | Fairest in theory, by far the most plumbing, and a monthly invoice line nobody enjoys. |

**Recommendation: A, with a per-vendor monthly inbound cap and an opt-in flag**
on the vendor row. The cap makes the downside bounded and knowable, and vendors
joining a *community* program is a genuinely good pitch — it drives foot traffic
from students who have never walked in.

Until this is settled the UI says moving points is "coming soon," which is
honest and lets the balance build up in the meantime (a student with 80
community points they can't move yet is a student with a reason to come back
when it launches).

---

## Rules — decided

| Rule | Decision | Why |
|---|---|---|
| **Rate** | 10% of the points *actually awarded* | Post-multiplier, so the tier bonus flows through. A 2x-tier student earning 300 gets 30 community points, not 15. Rewards the behavior the tier system already rewards. |
| **Rounding** | `floor(points × 0.10)` | Integer columns everywhere. Awards under 10 points mint 0 — acceptable (a sub-$1 purchase). See [carry](#deferred) if that ever matters. |
| **Source** | `earn` transactions only | Redemptions, reversals and transfers never mint. |
| **Reversals** | A voided earn also voids its community points | The 10% rides on the same transaction row, so `reverse_transaction` negates it for free. Non-negotiable — otherwise "award, undo, repeat" is an infinite community-point printer. |
| **Idempotency** | Inherited from `client_token` | Same reason: same row. A retried award can't double-mint. |
| **Expiry** | None for v1 | One less thing to explain and to litigate in the ToS. Revisit if the liability grows. |
| **Spending** | Transferred into **one vendor's** balance, then spent as ordinary vendor points | Nothing at the register changes: no new QR type, no cashier training, no second catalog to curate. The cross-vendor freedom is spent at transfer time, not at the counter. |
| **Transfers** | Student-initiated, explicit, and **one-way** | Silently draining a cross-vendor balance to cover a vendor redemption would be infuriating. A *reversible* transfer is an exploit — see step 5. |
| **`lifetime_earned`** | Counts minting only: transfers don't decrement it, reversals do | It answers "how much has this student been given," which a spend shouldn't change and a voided earn should. |
| **Daily mint cap** | 200 community points per student per day, enforced inside `award_points` | Built in from the start rather than retrofitted, because every edit to `award_points` costs a drop-and-recreate (see step 2). |

---

## Constraints this must respect

These are load-bearing facts about the existing codebase. Violating any one of
them produces a bug that is hard to find later.

1. **`migration-025` locks the points tables.** `point_balances` and
   `transactions` reject any write that doesn't set the transaction-local GUC.
   **Every new or edited SQL function that touches them must begin with:**
   ```sql
   perform set_config('app.points_write', 'server', true);
   ```
   `community_balances` should get the *same* guard triggers — it is a money
   table too, and the whole point of 025 is that money tables aren't editable
   from the Studio table editor.

2. **`migration-025` recreates four functions verbatim.** `award_points` is one
   of them. Editing it means editing the *025 version* (or writing 026 as a
   `create or replace` that carries the guard line forward). Re-running an older
   migration afterwards silently strips the guard flag and awards start failing
   — see the "ORDERING FOOTGUN" note at the top of `migration-025.sql`.

3. **Never trust client-sent point values.** `/api/vendor/award` recomputes
   points from the vendor's own ratio and the server-computed tier. The community
   10% is derived inside the RPC, from the number the RPC is already writing —
   it never crosses the wire as an input. The same rule applies to a transfer:
   the *amount* comes from the client (it's the student's choice), but whether
   they have it is decided by the RPC's `balance >= amount` guard, never by the
   client.

4. **`transactions.type` has a CHECK constraint** (`in ('earn','redeem')`,
   `schema.sql:73`). Adding `community_transfer` means altering it, and then
   auditing every consumer (listed in step 5).

5. **Deleting an account must not orphan a balance.**
   `community_balances.user_id` gets `references profiles(user_id) on delete
   cascade`, matching `point_balances`.

6. **`award_points` returns `table (new_balance integer)`.** Postgres will not
   let `create or replace` change a return type, so adding a second output
   column means `drop function public.award_points(uuid, uuid, integer, numeric,
   text)` first, then recreating it **and re-applying the revoke/grant pair**
   from 025. Forget the grants and every award fails with a permission error.

---

## Steps

### Step 0 — Home-screen counter ✅ DONE

Shipped in this change. The card sits above `YOUR SPOTS`, overlapping the navy
banner's bottom curve so the header reads as one block.

- `public/student/index.html` — `#community-card` (a real `<button>`, so it's
  keyboard- and screen-reader-reachable from day one) + the `#community-info`
  explainer popover.
- `public/student/styles.css` — `.community-card` and friends; the tier
  popover's CSS was generalized from `.tier-info-*` to `.info-*` so both
  popovers share it.
- `public/student/app.js` — `loadCommunity()` / `setCommunityPoints()`, with the
  same eased ticker the vendor meter uses so points landing over the socket are
  visible. Tapping the card opens the explainer.

**The counter reads 0 and that is the truth** — nothing mints community points
yet. `loadCommunity()` is the single seam: when step 4 ships, that one function
body changes and the rest of the UI already works.

### Step 1 — `migration-026.sql`: storage

```sql
-- the pool itself
create table public.community_balances (
  user_id         uuid primary key references public.profiles (user_id) on delete cascade,
  balance         integer not null default 0 check (balance >= 0),
  lifetime_earned integer not null default 0 check (lifetime_earned >= 0),
  updated_at      timestamptz not null default now()
);

-- the 10% minted by a given earn, on the earn's own row
alter table public.transactions
  add column if not exists community_points integer not null default 0;
```

Then:

- Point the `migration-025` guard triggers at `community_balances` as well
  (`enforce_points_write_guard`, both the row and TRUNCATE triggers).
- RLS: `enable row level security` + an `own community balance` select policy
  mirroring `"own balances"` on `point_balances`.
- Revoke `insert, update, delete` from `anon`, `authenticated`, **and**
  `service_role` — same belt-and-braces as 025. Only the RPCs write it.

**Why the 10% lives on the transaction row rather than in its own table:** it
inherits `client_token` idempotency and `reverse_transaction` for free, and the
ledger stays reconstructible. Two tables would mean re-implementing both.

**The ledger invariants**, stated exactly, because the doc used to fudge this:

- `sum(community_points)` over a student's **`earn`** rows = `lifetime_earned`
- `sum(community_points)` over **all** their rows = `balance`
  (transfers write a negative into the same column)

Both hold except where a reversal clamps at 0 — see the note in step 2. That is
the same trade the vendor balance already makes.

### Step 2 — `migration-026.sql`: minting

Extend `award_points` (the **025** body — copy it forward, guard line and all).
Per constraint 6 this is a `drop function` + recreate, because the return type
grows a second column:

```sql
returns table (new_balance integer, new_community integer)
```

The mint, after the existing `point_balances` upsert:

```sql
  v_community := floor(p_points * 0.10);

  -- Daily cap (step 6, built in from the start): never mint more than
  -- COMMUNITY_DAILY_CAP in a rolling calendar day, counting earn rows only.
  select coalesce(sum(community_points), 0) into v_today
  from transactions
  where user_id = p_user_id and type = 'earn' and created_at::date = current_date;

  v_community := least(v_community, greatest(0, 200 - v_today));

  if v_community > 0 then
    insert into community_balances (user_id, balance, lifetime_earned)
    values (p_user_id, v_community, v_community)
    on conflict (user_id) do update
      set balance         = community_balances.balance + v_community,
          lifetime_earned = community_balances.lifetime_earned + v_community,
          updated_at      = now();
  end if;
```

…and write `v_community` into the transaction row's new `community_points`
column in the same `insert`. The early-return idempotency branch is already
above all of this, so a retried token still mints nothing.

**Inactive vendors don't mint.** `tiers.js` already drops txns at hidden vendors
(`vendors.active = false`) from the tier math; the mint path follows the same
rule — check `active` before computing `v_community`. The vendor points still
award; only the community 10% is withheld.

Then extend `reverse_transaction` (also the 025 body) to subtract
`orig.community_points` from **both** `community_balances.balance` and
`lifetime_earned`, each clamped at `greatest(0, …)` exactly like the vendor
balance is, and to carry `-orig.community_points` onto the compensating row.

> **Clamping is a real edge case.** A student can earn 15 community points,
> transfer them, and *then* the vendor voids the earn — the balance would go
> negative. `greatest(0, …)` is the same trade the vendor balance already makes
> (migration-010). Alternative: block reversal of an earn whose community points
> are already moved. The 1-minute reversal window makes this vanishingly rare;
> the clamp is fine.

**Both functions must keep `perform set_config('app.points_write','server', true)`
as their first statement.** See constraint 1.

### Step 3 — realtime push

`/api/vendor/award` now has both numbers back from the RPC, so push them on the
existing `balance` event rather than inventing a second one:

```js
emitBalance(userId, { vendorId, balance: newBalance, community: newCommunity });
```

`public/student/app.js:1167` already reads `payload.community` when present and
falls back to `loadCommunity()` when it isn't — **the client half of this step
is already shipped.** One event, no new room plumbing.

### Step 4 — `GET /api/me/community`

```js
router.get('/community', requireConsent, async (req, res, next) => {
  const { data } = await supabaseAdmin
    .from('community_balances')
    .select('balance, lifetime_earned')
    .eq('user_id', req.user.id)
    .maybeSingle();
  res.json({ balance: data?.balance ?? 0, lifetimeEarned: data?.lifetime_earned ?? 0 });
});
```

Then swap the marked TODO in `loadCommunity()` (`public/student/app.js:925`) for
the real fetch. **This is the moment the counter goes live** — no other UI change.

Also, in the same pass:
- `GET /api/me/export` — add `community` to the export payload. The Privacy
  Policy promises everything we hold; a balance is a thing we hold.
- `GET /api/me/history` — surface `community_points` on earn rows so the History
  tab can show "+150 pts · +15 community".

### Step 5 — Transfer: move community points into a vendor balance

The biggest step, and the one gated on
[the open question](#-the-one-real-open-question-who-pays).

**The model.** Community points are never spent directly. The student moves an
amount into **one** vendor's balance; from that moment they are ordinary vendor
points, and every existing path — the meter, the catalog, the `WRW:R:` redeem
code, the cashier's confirm screen — works unchanged.

**What the vendor terminal has to learn: nothing.** No new QR prefix, no third
scan mode, no cashier training. A redemption funded by transferred points is
indistinguishable from any other at the counter, and that is correct — the
vendor is honoring their own points. (The terminal still needs *history labels*,
below, but no new flow.)

**Student side**
- Tapping the community card opens a **Move points** sheet: a vendor picker
  (every `active` vendor with `accepts_community_points`, the student's existing
  spots listed first) and an amount, defaulting to the full balance.
- The confirm state names the destination and the amount and says plainly that
  **the move can't be undone.**
- On success both meters update from the response and the sheet closes.

**Why one-way.** Transferred points are spendable the instant they land. A
reversible transfer means a student can move 100 into Irving's, redeem a
100-point reward, and move the 100 back — item *and* points. Making that safe
needs a time window **plus** a `point_balances.balance >= amount` guard on the
return leg, which is exactly the shape `reverse_transaction` already carries for
its 1-minute rule. A clear confirm sheet costs nothing and closes the hole. If
undo is ever wanted it is a new RPC with both guards, not a relaxation of this one.

**API** — `POST /api/me/community-transfer` `{ vendorId, amount }` →
`transfer_community_points(p_user_id, p_vendor_id, p_amount)`:

```sql
  perform set_config('app.points_write', 'server', true);   -- constraint 1

  if p_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;

  -- Destination must be a real, active, opted-in vendor. Checked here, not just
  -- hidden in the picker — the client controls the request body.
  if not exists (select 1 from vendors
                 where id = p_vendor_id and active and accepts_community_points) then
    raise exception 'VENDOR_INELIGIBLE';
  end if;

  -- Atomic decrement, same shape as redeem_by_code's balance guard. A student
  -- with no community_balances row simply doesn't match: INSUFFICIENT_POINTS.
  update community_balances
     set balance = balance - p_amount, updated_at = now()
   where user_id = p_user_id and balance >= p_amount
  returning balance into v_community;

  if not found then raise exception 'INSUFFICIENT_POINTS'; end if;

  insert into point_balances (user_id, vendor_id, balance)
  values (p_user_id, p_vendor_id, p_amount)
  on conflict (user_id, vendor_id)
  do update set balance = point_balances.balance + p_amount, updated_at = now()
  returning balance into v_vendor;

  insert into transactions (user_id, vendor_id, type, points, community_points)
  values (p_user_id, p_vendor_id, 'community_transfer', p_amount, -p_amount);
```

Returns both balances, so the HTTP response and the socket push carry them.
`lifetime_earned` is untouched — it counts minting, not movement.

> **⚠ A transfer row must not be reversible by the vendor.** It carries the
> destination vendor's `vendor_id`, and `GET /api/vendor/recent`
> (`src/routes/vendor.js:407`) filters on `vendor_id` alone with no type filter.
> So an inbound transfer lands in the terminal's history strip, becomes
> `lastActivity`, and `terminal.js:1214` marks it undoable inside the 1-minute
> window. `reverse_transaction` would then negate `point_balances` by −80 and
> **never return the 80 to `community_balances`** — the student's points simply
> evaporate. Fix both ends: `reverse_transaction` raises
> `CANNOT_REVERSE_TRANSFER` on `type = 'community_transfer'`, and the terminal
> renders those rows as not-undoable.

**Schema (`migration-027.sql`)**
- `alter table transactions drop constraint transactions_type_check`, re-add
  with `in ('earn','redeem','community_transfer')`. (Confirm the auto-generated
  constraint name with `\d transactions` first — it's inline in `schema.sql:73`.)
- `vendors.accepts_community_points boolean not null default true` — the opt-in.
- `vendors.community_monthly_cap integer` — now an **inbound transfer** cap
  rather than a redemption cap. Strictly easier to reason about: the liability
  is countable when it arrives, before any product is given away.
- No codes table, no new redeem RPC. `redeem_by_code` is untouched.

**Audit every `type` consumer before altering that CHECK.** Every site below
branches on `tx.type === 'earn'` as a *binary*, so a third type silently falls
into the redeem branch:

| Site | What breaks if missed |
|---|---|
| `src/lib/tiers.js` → `computeTierProfile` | Filters `.eq('type','earn')` — **safe as written, and load-bearing.** A transfer written as an `earn` would register as a visit to a shop the student has never entered, inflating breadth and loyalty. Points would buy tier. Confirm the filter stays. |
| `src/lib/analytics.js:36,113` | Concretely: a `+80` transfer hits the `else` branch, so `redeemPoints` drops by 80 and `redemptions` is **decremented** (`pts <= 0 ? 1 : -1` with a positive `pts`). Inbound transfers would quietly erase real redemptions from the vendor's numbers. |
| `public/student/app.js` → `historyRow():595` | Falls to the redeem branch and renders "Redeemed a reward · −80". Needs a third branch: "Moved to Irving's · +80". |
| `public/vendor/terminal.js:1218,1341` | `last-activity` and the history strip mislabel an inbound transfer as a redemption. The vendor *should* see the row — "community points moved in" is information they want — but labeled honestly. Also the undo guard above. |
| `src/routes/admin.js` | Platform totals double-count: the mint and the transfer are the same points moving, not two events. |

### Step 6 — Anti-abuse

Community points are cross-vendor, which makes them a more attractive target
than vendor points: a vendor colluding with a friend can mint spendable value
that leaves their own shop.

- **Daily community-earn cap per student** (200/day) — **built into step 2**,
  not retrofitted, since every `award_points` edit costs a drop-and-recreate.
  The existing `MAX_AWARD_DOLLARS = 200` bounds a single award but not a string
  of them.
- **Reversed transactions never mint** — covered by step 2, but assert it in a
  test.
- **Inactive vendors don't mint** — covered by step 2.
- **Transfers to ineligible vendors are rejected server-side**, not merely
  hidden from the picker.
- **Per-vendor monthly inbound-transfer cap** (option A's safety valve) enforced
  in the RPC, not just in the UI.
- Rate-limit `/api/me/community-transfer` the way `/redeem-code` is.

### Step 7 — Tests

`test/` already covers the tier math. Add:

- `award_points` mints `floor(points × 0.10)`; 9 points mints 0; 10 mints 1.
- A repeated `client_token` mints once.
- The daily cap: awards past 200 community points in a day mint 0, and the
  vendor points still land in full.
- An award at an inactive vendor mints 0 community points.
- `reverse_transaction` unwinds the community points from both `balance` and
  `lifetime_earned`, and clamps at 0.
- A transfer of 80 to Vendor B moves exactly 80: community balance −80, Vendor
  B's `point_balances` +80, **Vendor A's untouched**.
- Insufficient community points → clean `INSUFFICIENT_POINTS`, nothing moves.
- A transfer to an inactive or opted-out vendor → `VENDOR_INELIGIBLE`.
- `reverse_transaction` on a `community_transfer` row raises
  `CANNOT_REVERSE_TRANSFER` and leaves both balances alone.
- Direct `update community_balances` from a service-role client is **rejected**
  by the guard trigger.

### Step 8 — Copy, legal, rollout

- **ToS / Privacy Policy** (`legal/`): community points are a second currency
  with no cash value, no expiry (v1), forfeited on account deletion, and
  **transfers into a vendor balance are final**. Same treatment the vendor
  points already get.
- **Vendor agreement**: the accept-inbound-transfers commitment and the cap.
- **Vendor terminal onboarding**: cashiers need *no* new scan training — but the
  vendor-facing dashboard should explain what a "community points moved in" row
  means when they see it in history.
- **Rollout order**: steps 1–4 can ship quietly — the balance accrues invisibly
  and students watch a number grow. Ship step 5 only once enough vendors are on
  board that "move them anywhere" is actually true; a launch where two shops
  accept them reads as broken.

---

## Deferred

Explicitly out of scope, recorded so they aren't re-litigated:

- **Fractional carry.** Award of 9 points → 0 community points, remainder lost.
  A `community_remainder` column on `community_balances` would carry it. Not
  worth the complexity until sub-10-point awards are common.
- **Community points minted on a transfer.** Moving points must not mint more of
  them. Guaranteed by minting only on `type = 'earn'` — no code needed, but
  worth stating.
- **Un-transfer / undo.** See step 5: it needs a time window *and* a
  `balance >= amount` guard on the return leg, or it's a free-item exploit.
- **Splitting one transfer across several vendors.** The sheet moves points to
  one vendor at a time; doing it twice is fine.
- **Gifting / transfers between students.** Interesting, and a whole fraud
  surface of its own.
- **Community points as a tier input.** `tiers.js` scores breadth, loyalty, and
  spend. Community points are *downstream* of those; feeding them back in would
  double-count. The transfer model makes this sharper: a transfer must never
  look like a visit.
- **Expiry.** See the rules table.

---

## Files this will touch

| File | Step |
|---|---|
| `public/student/index.html`, `styles.css`, `app.js` | 0 ✅, 4, 5 |
| `public/student/sw.js` | 0 ✅ (cache bump), 5 |
| `supabase/migration-026.sql` | 1, 2 |
| `supabase/migration-027.sql` (transfer) | 5 |
| `src/routes/vendor.js` | 3 (push `community`), 5 (audit `/recent`) |
| `src/routes/student.js` | 4, 5 |
| `src/lib/analytics.js` | 5 (audit — see the table) |
| `src/routes/admin.js` | 5 (audit) |
| `public/vendor/terminal.js` | 5 (history labels + undo guard — **no scan changes**) |
| `src/lib/realtime.js` | — (unchanged; `emitBalance` already carries the payload) |
| `test/` | 7 |
| `legal/` | 8 |
