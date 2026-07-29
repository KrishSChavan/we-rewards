# Community points — the cross-vendor wallet

_Plan written 2026-07-29. The **UI counter is built** (step 0 below, shipped).
Everything from step 1 down is the earn/redeem engine and is **not built yet**._

---

## The idea, in one paragraph

Today every point a student holds is **locked to the shop that issued it**. 200
points at Irving's buys nothing at Waffle Shop. Community points are a second,
**parallel** balance that fixes that: every time a student earns at any spot,
**10% of those points are also minted into a single community pool**, and that
pool spends at **any** WeRewards vendor.

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
        Student walks into Vendor B (never visited)
                                   │
                                   ▼
             Redeems a reward there with community points
                                   │
                                   ▼
       −N community pts · Vendor B hands over the item
```

**The defining property:** community points are the only balance in WeRewards
that is *not* keyed to a vendor. Every schema, API, and UI decision below falls
out of that one fact.

---

## ⚠ The one real open question: who pays?

This is a **business** decision, not a code one, and it should be settled before
step 5 (redemption) is built. Steps 1–4 (minting, storing, showing) are safe to
build regardless — they only ever *accumulate* a number.

When a student redeems a free drink at **Vendor B** using points earned at
**Vendor A**, Vendor B gives away real product for a liability Vendor A created.
Three ways to resolve it:

| Option | How it works | Trade-off |
|---|---|---|
| **A. Goodwill / reciprocity** (recommended for the pilot) | Every vendor honors community points; over time the flows roughly net out. Platform publishes a per-vendor "community points honored vs. issued" report so nobody feels cheated. | Zero settlement plumbing. Breaks down if one vendor is a big net receiver. Needs a **per-vendor monthly cap** as the safety valve. |
| **B. Platform-funded** | WeRewards reimburses the redeeming vendor in cash or subscription credit. | Cleanest for vendors, real cost to the platform. Needs a redemption ledger with dollar values. |
| **C. Inter-vendor settlement** | Issuing vendor is billed, redeeming vendor is credited. | Fairest in theory, by far the most plumbing, and a monthly invoice line nobody enjoys. |

**Recommendation: A, with a per-vendor monthly cap and an opt-in flag** on the
vendor row. The cap makes the downside bounded and knowable, and vendors joining
a *community* program is a genuinely good pitch — it drives foot traffic from
students who have never walked in.

Until this is settled the UI says redeeming is "coming soon," which is honest and
lets the balance build up in the meantime (a student with 80 unspendable
community points is a student with a reason to come back when it launches).

---

## Rules — decided

| Rule | Decision | Why |
|---|---|---|
| **Rate** | 10% of the points *actually awarded* | Post-multiplier, so the tier bonus flows through. A 2x-tier student earning 300 gets 30 community points, not 15. Rewards the behavior the tier system already rewards. |
| **Rounding** | `floor(points × 0.10)` | Integer columns everywhere. Awards under 10 points mint 0 — acceptable (a sub-$1 purchase). See [carry](#deferred) if that ever matters. |
| **Source** | `earn` transactions only | Redemptions and reversals never mint. |
| **Reversals** | A voided earn also voids its community points | The 10% rides on the same transaction row, so `reverse_transaction` negates it for free. Non-negotiable — otherwise "award, undo, repeat" is an infinite community-point printer. |
| **Idempotency** | Inherited from `client_token` | Same reason: same row. A retried award can't double-mint. |
| **Expiry** | None for v1 | One less thing to explain and to litigate in the ToS. Revisit if the liability grows. |
| **Redeems against** | The host vendor's **own** reward catalog | No separate platform catalog to curate. The student sees "Free drink · 120 community pts" at whichever spot they're standing in. |
| **Spend order** | Community points are spent **explicitly**, never automatically | A student must choose "use community points." Silently draining a cross-vendor balance to cover a vendor redemption would be infuriating. |

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
   it never crosses the wire as an input.

4. **`transactions.type` has a CHECK constraint** (`in ('earn','redeem')`).
   Adding `community_redeem` means altering it, and then auditing every consumer
   (listed in step 5).

5. **Deleting an account must not orphan a balance.**
   `community_balances.user_id` gets `references profiles(user_id) on delete
   cascade`, matching `point_balances`.

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
ledger stays reconstructible (`sum(community_points)` over all of a student's
transactions must equal `lifetime_earned` minus nothing — redemptions are
negative rows in the same column). Two tables would mean re-implementing both.

### Step 2 — `migration-026.sql`: minting

Extend `award_points` (the **025** body — copy it forward, guard line and all):

```sql
  -- after the existing point_balances upsert and the transactions insert:
  v_community := floor(p_points * 0.10);   -- integer division on an integer column

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

Then extend `reverse_transaction` (also the 025 body) to subtract
`orig.community_points` from `community_balances.balance`, clamped at
`greatest(0, …)` exactly like the vendor balance is, and to carry
`-orig.community_points` onto the compensating row.

> **Clamping is a real edge case.** A student can earn 15 community points,
> spend them, and *then* the vendor voids the earn — the balance would go
> negative. `greatest(0, …)` is the same trade the vendor balance already makes
> (migration-010). Alternative: block reversal of an earn whose community points
> are already spent. The 1-minute reversal window makes this vanishingly rare;
> the clamp is fine.

**Both functions must keep `perform set_config('app.points_write','server', true)`
as their first statement.** See constraint 1.

### Step 3 — realtime push

`src/lib/realtime.js` gets an `emitCommunity(userId, payload)` alongside
`emitBalance`, or — simpler — `award_points` already returns; have
`/api/vendor/award` return the new community balance and push it on the existing
`balance` event as an extra field:

```js
emitBalance(userId, { vendorId, balance: newBalance, community: newCommunity });
```

The student's socket handler then calls `setCommunityPoints(payload.community)`
when the field is present. **Prefer this** — one event, no new room plumbing, and
the student app already re-renders on it.

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

Then swap the marked TODO in `loadCommunity()` (`public/student/app.js`) for the
real fetch. **This is the moment the counter goes live** — no other UI change.

Also, in the same pass:
- `GET /api/me/export` — add `community` to the export payload. The Privacy
  Policy promises everything we hold; a balance is a thing we hold.
- `GET /api/me/history` — surface `community_points` on earn rows so the History
  tab can show "+150 pts · +15 community".

### Step 5 — Redemption: spend anywhere

The biggest step, and the one gated on
[the open question](#-the-one-real-open-question-who-pays).

**Student side**
- The community card becomes a real destination instead of an explainer: tapping
  it opens a **Community** screen listing every active vendor's rewards that
  accept community points, grouped by spot, cheapest first.
- Picking one mints a code via `POST /api/me/community-redeem-code`
  `{ vendorId, rewardId }`, and shows the same QR + digits + countdown sheet the
  vendor redemption already uses.
- **New QR payload prefix: `WRW:C:<4 digits>`.** The existing contract is
  `WRW:E:` (earn) and `WRW:R:` (redeem); `C` is the third. Keep it uppercase and
  numeric so it stays a version-1 alphanumeric symbol (see `drawQr` in
  `app.js`).

**Vendor terminal side**
- `public/vendor/terminal.js` must recognize the `WRW:C:` prefix and route it to
  a confirm screen that says, unmistakably, **"Community points — this is not
  from your balance."** A cashier must never be confused about which pool paid.
- `POST /api/vendor/community-redeem` → a `redeem_community_by_code` RPC:
  consume the code, decrement `community_balances` atomically with a
  `balance >= cost` guard, write the transaction row.

**Schema**
- `community_redeem_codes` table mirroring `redeem_codes` (code, user, vendor,
  reward, expires_at), plus a `create_community_redeem_code` RPC mirroring
  `create_redeem_code`.
- `alter table transactions drop constraint …_type_check`, re-add with
  `in ('earn','redeem','community_redeem')`.
- `vendors.accepts_community_points boolean not null default true` and
  `vendors.community_monthly_cap integer` — the opt-in and the safety valve from
  option A.

**Audit every `type` consumer before altering that CHECK:**

| Site | What breaks if missed |
|---|---|
| `src/lib/analytics.js` → `rollupVendorAnalytics` | A `community_redeem` counted as revenue or as a vendor-points redemption |
| `src/routes/vendor.js` → `/recent`, `/analytics` | Terminal history mislabels the row |
| `src/routes/admin.js` | Platform totals double-count |
| `public/student/app.js` → `historyRow()` | `tx.type === 'earn'` is false → falls through to the redeem branch and renders wrong |
| `public/vendor/terminal.js` | History strip mislabels |
| `src/lib/tiers.js` → `computeTierProfile` | Filters `.eq('type','earn')` — **safe as written**, confirm it stays that way |

### Step 6 — Anti-abuse

Community points are cross-vendor, which makes them a more attractive target
than vendor points: a vendor colluding with a friend can mint spendable value
that leaves their own shop.

- **Daily community-earn cap per student** (e.g. 200/day). The existing
  `MAX_AWARD_DOLLARS = 200` bounds a single award but not a string of them.
- **Reversed transactions never mint** — covered by step 2, but assert it in a
  test.
- **Inactive vendors don't mint.** `tiers.js` already drops txns at hidden
  vendors from the tier math; the mint path should follow the same rule.
- **Per-vendor monthly redemption cap** (option A's safety valve) enforced
  server-side, not just in the terminal UI.
- Rate-limit `/api/me/community-redeem-code` the way `/redeem-code` is.

### Step 7 — Tests

`test/` already covers the tier math. Add:

- `award_points` mints `floor(points × 0.10)`; 9 points mints 0; 10 mints 1.
- A repeated `client_token` mints once.
- `reverse_transaction` unwinds the community points and clamps at 0.
- A community redemption at Vendor B with points earned at Vendor A leaves
  Vendor A's and Vendor B's `point_balances` untouched.
- Insufficient community points → clean `INSUFFICIENT_POINTS`, code stays live.
- Direct `update community_balances` from a service-role client is **rejected**
  by the guard trigger.

### Step 8 — Copy, legal, rollout

- **ToS / Privacy Policy** (`legal/`): community points are a second currency
  with no cash value, no expiry (v1), and are forfeited on account deletion.
  Same treatment the vendor points already get.
- **Vendor agreement**: the honor-community-points commitment and the cap.
- **Vendor terminal onboarding**: cashiers need to know what a `WRW:C:` scan is
  before the first student shows one.
- **Rollout order**: steps 1–4 can ship quietly — the balance accrues invisibly
  and students watch a number grow. Ship step 5 only once enough vendors are on
  board that "spend anywhere" is actually true; a launch where two shops accept
  them reads as broken.

---

## Deferred

Explicitly out of scope, recorded so they aren't re-litigated:

- **Fractional carry.** Award of 9 points → 0 community points, remainder lost.
  A `community_remainder` column on `community_balances` would carry it. Not
  worth the complexity until sub-10-point awards are common.
- **Community points on community redemptions.** Spending community points must
  not mint more of them. Guaranteed by minting only on `type = 'earn'` — no code
  needed, but worth stating.
- **Gifting / transfers between students.** Interesting, and a whole fraud
  surface of its own.
- **Community points as a tier input.** `tiers.js` scores breadth, loyalty, and
  spend. Community points are *downstream* of those; feeding them back in would
  double-count.
- **Expiry.** See the rules table.

---

## Files this will touch

| File | Step |
|---|---|
| `public/student/index.html`, `styles.css`, `app.js` | 0 ✅, 4, 5 |
| `public/student/sw.js` | 0 ✅ (cache bump), 5 |
| `supabase/migration-026.sql` | 1, 2 |
| `supabase/migration-027.sql` (redemption) | 5 |
| `src/lib/realtime.js` | 3 |
| `src/routes/student.js` | 4, 5 |
| `src/routes/vendor.js` | 3, 5 |
| `src/lib/analytics.js` | 5 (audit) |
| `src/routes/admin.js` | 5 (audit) |
| `public/vendor/terminal.js` | 5 |
| `test/` | 7 |
| `legal/` | 8 |
