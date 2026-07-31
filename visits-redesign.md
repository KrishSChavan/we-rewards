# Visits redesign — implementation spec

Replaces the vendor-level punch card ("10 punches = a free coffee") with **visits as a
second per-vendor currency**. Every reward may be priced in points, in visits, or both.

## Confirmed decisions

| # | Decision |
|---|---|
| D1 | Visits are a **threshold currency that resets**. A reward costing 5 visits is redeemable at >= 5 visits. Redeeming with visits sets the counter to **0** regardless of the reward's price. Surplus is forfeited by design. |
| D2 | `vendors.punch_target` / `punch_reward` and the whole card-full / `completed_at` / `readyCards` concept are **retired**. `vendors.punch_enabled` stays as the per-vendor toggle. |
| D3 | The punch modal is **progress-only**. No redeem button. All redemption happens in the reward sheet. |
| D4 | `cost_in_points` becomes **nullable**, `cost_in_visits` is new and nullable, **at least one** must be set and positive. |
| D5 | Reward rows show both prices; a reward is redeemable if **either** currency covers it. |
| D6 | Reward sheet shows up to two buttons, "Redeem with points" and "Redeem with punches", each only when affordable. Neither affordable renders "Not ready yet" / "Visit more locations and come back!". |
| D7 | The visits path **re-verifies server-side** before minting. |
| D8 | The dot grid becomes a **visit counter**. |
| D9 | **One code table.** `redeem_codes` gains `paid_with`; `punch_redeem_codes` is retired. A code is never ambiguous again. |
| D10 | **Undo reimburses both currencies.** Points are refunded as today; visits are **added back** from a snapshot taken at burn time. |
| D11 | **The forfeit is disclosed on the student's phone before they tap**, and again on the counter confirm screen. |
| D12 | **Raising a visit price warns the vendor** with a count of students who would lose access. They may still proceed. |
| D13 | **History shows visits, not "-0 pts"**, for a visits redemption. |
| D14 | **The user-visible word is "visits"**, everywhere: the counter, reward prices, both sheets, history, the vendor tab and settings, and every server `message`. The earning action moved with it ("Add a visit", "visit code") rather than leaving "Punch in" beside a visits balance. Error CODES and internal identifiers keep their `punch_*` names — `PUNCH_DISABLED`, `punch_cards`, `cost_in_visits`, `paid_with='visits'` — since they match the SQL and are never read by a user. |

---

## 1. SQL migration

Two migrations, not one. The columns cannot be dropped in the same deploy that stops
reading them: [student.js:140](src/routes/student.js#L140) names `punch_target` and
`punch_reward` inside the *same* PostgREST query that fetches the whole vendor list, and
PostgREST 400s the entire request on an unknown column. Dropping early takes down the
student home screen wholesale, not just the punch section.

- **migration-029** — additive + function rewrites. Columns stay.
- **deploy the code** in section 2-5.
- **migration-030** — drop the dead columns, `notify pgrst, 'reload schema'`.

### 1a. rewards: dual pricing

The existing inline `check (cost_in_points > 0)` is **left alone**. A CHECK that evaluates
to NULL is treated as satisfied, so it stays valid once the column is nullable, and we
avoid dropping an unnamed constraint whose generated name differs per environment
(the trap [migration-027.sql:55-68](supabase/migration-027.sql#L55-L68) already worked around).

```sql
alter table public.rewards alter column cost_in_points drop not null;

alter table public.rewards
  add column if not exists cost_in_visits integer;

-- Named, so a later migration can find it without guessing.
alter table public.rewards drop constraint if exists rewards_visits_positive;
alter table public.rewards
  add constraint rewards_visits_positive
  check (cost_in_visits is null or cost_in_visits > 0);

alter table public.rewards drop constraint if exists rewards_has_a_price;
alter table public.rewards
  add constraint rewards_has_a_price
  check (coalesce(cost_in_points, 0) > 0 or coalesce(cost_in_visits, 0) > 0);

create index if not exists idx_rewards_vendor on public.rewards (vendor_id);
```

Pre-flight before the CHECK, since it must not fail to apply:

```sql
select count(*) from public.rewards where coalesce(cost_in_points, 0) <= 0;  -- expect 0
```

### 1b. punch_cards: collapse to one visit counter per (student, vendor)

**This is the dangerous step.** `idx_punch_cards_one_open` is partial on
`completed_at is null`, and Postgres silently drops any index whose column is dropped.
`punch_in`'s concurrency safety is built entirely on that index (insert →
`exception when unique_violation` → re-select the winner). Drop the column first and two
concurrent first-punches both insert, forking the student's count with no error.

A plain `unique (user_id, vendor_id)` also **cannot be built on today's data** — completed
cards deliberately pile up, so multiple rows per pair already exist.

Order matters. Back up, collapse, index, *then* drop.

```sql
-- 1. Pre-image. This file is NOT re-runnable; the backup is the recovery path.
create table if not exists public.punch_cards_pre_029 as select * from public.punch_cards;

-- 2. Collapse. Survivor = oldest row per pair. Its new count is the open card's
--    punches PLUS `target` for every completed-but-unredeemed card, so a student
--    holding an outstanding IOU converts it into spendable visits instead of
--    losing it. (There is no audit table recording "owed a free cover" - once
--    completed_at is gone the IOU is unrecoverable, hence the credit.)
with ranked as (
  select id, user_id, vendor_id,
         row_number() over (partition by user_id, vendor_id order by created_at) as rn
  from public.punch_cards
),
survivors as (select id, user_id, vendor_id from ranked where rn = 1),
totals as (
  select pc.user_id, pc.vendor_id,
         sum(case when pc.completed_at is not null and pc.redeemed_at is null
                  then pc.target else pc.punches end) as visits
  from public.punch_cards pc
  group by pc.user_id, pc.vendor_id
)
update public.punch_cards pc
set punches = t.visits
from survivors s
join totals t on t.user_id = s.user_id and t.vendor_id = s.vendor_id
where pc.id = s.id;

-- 3. Repoint the audit rows at the survivor BEFORE deleting losers - punches.card_id
--    is ON DELETE CASCADE and those rows are the once-per-night replay stop.
update public.punches p
set card_id = s.id
from public.punch_cards old
join (select id, user_id, vendor_id from (
        select id, user_id, vendor_id,
               row_number() over (partition by user_id, vendor_id order by created_at) as rn
        from public.punch_cards) r where rn = 1) s
  on s.user_id = old.user_id and s.vendor_id = old.vendor_id
where p.card_id = old.id and old.id <> s.id;

delete from public.punch_cards pc
where not exists (
  select 1 from (
    select id from (
      select id, row_number() over (partition by user_id, vendor_id order by created_at) as rn
      from public.punch_cards) r where rn = 1) s
  where s.id = pc.id);

-- 4. Full unique index. Verify it built before step 5.
drop index if exists public.idx_punch_cards_one_open;
create unique index if not exists idx_punch_cards_one_per_vendor
  on public.punch_cards (user_id, vendor_id);

-- 5. Only now retire the card columns. `target` loses NOT NULL because
--    vendors.punch_target (its source) is going away in 030.
alter table public.punch_cards alter column target drop not null;
alter table public.punch_cards drop column if exists completed_at;
alter table public.punch_cards drop column if exists redeemed_at;
```

`punches` rows are **never deleted**. They are the audit log and they carry
`idx_punches_once_per_night`, which is the same-night replay stop. Resetting a counter is
always `set punches = 0`, never a row delete.

### 1c. One code table (D9)

`punch_redeem_codes` existed only because `redeem_codes.reward_id` is NOT NULL and a punch
reward was vendor free-text rather than a catalog row ([migration-028.sql:34](supabase/migration-028.sql#L34)).
A visits redemption now targets a real reward, so that reason is gone.

```sql
alter table public.redeem_codes
  add column if not exists paid_with text not null default 'points',
  add column if not exists visits_charged integer;

alter table public.redeem_codes drop constraint if exists redeem_codes_paid_with;
alter table public.redeem_codes
  add constraint redeem_codes_paid_with check (paid_with in ('points', 'visits'));

-- A visits code must carry the price it was minted at; a points code must not.
alter table public.redeem_codes drop constraint if exists redeem_codes_visits_charged;
alter table public.redeem_codes
  add constraint redeem_codes_visits_charged check (
    (paid_with = 'visits' and visits_charged > 0) or
    (paid_with = 'points' and visits_charged is null));

drop table if exists public.punch_redeem_codes;
```

`visits_charged` is **snapshotted at mint**. Without it the burn cannot know what it is
charging: a vendor editing `cost_in_visits` between mint and burn would otherwise silently
change the price while the student is standing at the counter.

Collapsing to one table also kills the collision dance — the two mint functions currently
cross-check each other's tables under an advisory lock
([migration-028.sql:494](supabase/migration-028.sql#L494), [:590](supabase/migration-028.sql#L590)).
With one table the 4-digit `code` primary key makes collisions structurally impossible.

### 1d. punch_in — plain counter increment

Return type changes, so the old signature must be **explicitly dropped**.
`create or replace` cannot change a return type, and a mismatched signature would sit
alongside as a live, still-granted overload with none of the new checks — the exact trap
[migration-028.sql](supabase/migration-028.sql) documents.

```sql
drop function if exists public.punch_in(uuid, uuid, bigint, uuid, text, text);

create or replace function public.punch_in(
  p_user_id uuid, p_vendor_id uuid, p_window bigint, p_hold_id uuid,
  p_timezone text, p_binding_hash text
) returns table (new_punches integer, vendor_name text)
language plpgsql security definer set search_path = public
as $$
declare
  c_id  uuid;
  v_new integer;
  v_name text;
begin
  -- (token/window/hold/binding validation is UNCHANGED from migration-028 - the
  --  punch-IN flow, the rotating token, the ?punch= link and the once-per-night
  --  unique index all survive this redesign untouched. Only the card/target/
  --  completion tail is replaced.)

  insert into punch_cards (user_id, vendor_id, punches)
  values (p_user_id, p_vendor_id, 0)
  on conflict (user_id, vendor_id) do nothing;

  select id into c_id from punch_cards
  where user_id = p_user_id and vendor_id = p_vendor_id;

  -- the once-per-night guard: unchanged, still the replay stop
  insert into punches (user_id, vendor_id, card_id, punched_on)
  values (p_user_id, p_vendor_id, c_id, (now() at time zone p_timezone)::date);

  update punch_cards set punches = punches + 1
  where id = c_id
  returning punches into v_new;

  select name into v_name from vendors where id = p_vendor_id;
  return query select v_new, v_name;
end;
$$;

revoke execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text) to service_role;
```

Gone from the return: `card_target`, `card_completed`, `ready_cards`.

### 1e. create_redeem_code — currency-aware, re-verifies visits (D7)

```sql
drop function if exists public.create_redeem_code(uuid, uuid, uuid, integer);

create or replace function public.create_redeem_code(
  p_user_id uuid, p_vendor_id uuid, p_reward_id uuid,
  p_paid_with text default 'points', p_ttl_seconds integer default 120
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate  text;
  attempts   integer := 0;
  r_points   integer;
  r_visits   integer;
  v_have     integer;
begin
  if p_paid_with not in ('points', 'visits') then
    raise exception 'BAD_CURRENCY';
  end if;

  select cost_in_points, cost_in_visits into r_points, r_visits
  from rewards where id = p_reward_id and vendor_id = p_vendor_id and active = true;
  if not found then raise exception 'REWARD_NOT_FOUND'; end if;

  if p_paid_with = 'visits' then
    if r_visits is null then raise exception 'REWARD_NOT_VISITS_PRICED'; end if;
    -- D7: the DB is the authority, never the client.
    select coalesce(punches, 0) into v_have from punch_cards
    where user_id = p_user_id and vendor_id = p_vendor_id;
    if coalesce(v_have, 0) < r_visits then raise exception 'INSUFFICIENT_VISITS'; end if;
  else
    if r_points is null then raise exception 'REWARD_NOT_POINTS_PRICED'; end if;
  end if;

  delete from redeem_codes where expires_at < now();
  -- ONE live code per (student, vendor) across BOTH currencies. Tapping the other
  -- button replaces the code rather than leaving two live codes at one counter.
  delete from redeem_codes where user_id = p_user_id and vendor_id = p_vendor_id;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into redeem_codes (code, user_id, vendor_id, reward_id, paid_with,
                                visits_charged, expires_at)
      values (candidate, p_user_id, p_vendor_id, p_reward_id, p_paid_with,
              case when p_paid_with = 'visits' then r_visits else null end,
              now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.create_redeem_code(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_redeem_code(uuid, uuid, uuid, text, integer) to service_role;
```

**Minting never spends anything.** An expired unspent code costs the student nothing —
the counter is only touched at the counter. This matters because codes have a 120s TTL and
are routinely never shown.

### 1f. redeem_by_code — branches on currency, snapshots for undo (D10)

```sql
create or replace function public.redeem_by_code(p_code text, p_vendor_id uuid)
returns table (new_balance integer, reward_title text, paid_with text, visits_left integer)
language plpgsql security definer set search_path = public
as $$
declare
  c_user     uuid;
  c_reward   uuid;
  c_paid     text;
  c_visits   integer;
  r_points   integer;
  r_title    text;
  v_have     integer;
  v_bal      integer;
begin
  perform set_config('app.points_write', 'server', true);   -- migration-025 guard

  delete from redeem_codes
  where code = p_code and vendor_id = p_vendor_id and expires_at > now()
  returning user_id, reward_id, paid_with, visits_charged
  into c_user, c_reward, c_paid, c_visits;

  if c_user is null then raise exception 'CODE_INVALID'; end if;

  -- Separate existence from price. The old body used a NULL cost as a proxy for
  -- "row missing", which breaks the moment cost_in_points is nullable.
  select cost_in_points, title into r_points, r_title
  from rewards where id = c_reward and vendor_id = p_vendor_id and active = true;
  if not found then raise exception 'REWARD_NOT_FOUND'; end if;

  if c_paid = 'visits' then
    -- Lock the counter, then compare against the SNAPSHOT, then assign.
    select punches into v_have from punch_cards
    where user_id = c_user and vendor_id = p_vendor_id
    for update;

    if coalesce(v_have, 0) < c_visits then raise exception 'INSUFFICIENT_VISITS'; end if;

    update punch_cards set punches = 0                      -- assignment, never subtraction
    where user_id = c_user and vendor_id = p_vendor_id;

    -- visits_spent is what D10's undo adds back. Under reset-to-0 the reward's
    -- price does NOT tell you what was forfeited, so it must be recorded.
    insert into transactions (user_id, vendor_id, type, points, reward_id,
                              paid_with, visits_spent)
    values (c_user, p_vendor_id, 'redeem', 0, c_reward, 'visits', v_have);

    select balance into v_bal from point_balances
    where user_id = c_user and vendor_id = p_vendor_id;

    return query select coalesce(v_bal, 0), r_title, 'visits'::text, 0;
  else
    if r_points is null then raise exception 'REWARD_NOT_POINTS_PRICED'; end if;

    update point_balances
    set balance = balance - r_points, updated_at = now()
    where user_id = c_user and vendor_id = p_vendor_id and balance >= r_points;
    if not found then raise exception 'INSUFFICIENT_POINTS'; end if;

    insert into transactions (user_id, vendor_id, type, points, reward_id, paid_with)
    values (c_user, p_vendor_id, 'redeem', -r_points, c_reward, 'points');

    select punches into v_have from punch_cards
    where user_id = c_user and vendor_id = p_vendor_id;

    return query
      select pb.balance, r_title, 'points'::text, coalesce(v_have, 0)
      from point_balances pb
      where pb.user_id = c_user and pb.vendor_id = p_vendor_id;
  end if;
end;
$$;
```

The `delete ... returning` stays the single-use gate. `INSUFFICIENT_VISITS` raised after it
rolls the deletion back, so a failed burn does not eat the code — same shape
`redeem_punch_card` already used.

**`for update` on the counter is load-bearing.** Without it, a burn racing a `punch_in`, or
two terminals resolving the same code, can each read the pre-reset count.

### 1g. transactions: record the currency

```sql
alter table public.transactions
  add column if not exists paid_with text not null default 'points',
  add column if not exists visits_spent integer;

alter table public.transactions drop constraint if exists transactions_paid_with;
alter table public.transactions
  add constraint transactions_paid_with check (paid_with in ('points', 'visits'));
```

`type` stays `'redeem'` — no change to `transactions_type_check`. A visits redemption is
`points = 0`, `paid_with = 'visits'`, `visits_spent = <pre-burn count>`.

### 1h. reverse_transaction — reimburse both currencies (D10)

```sql
-- inside the existing body, after the guards and before the compensating insert:
if orig.paid_with = 'visits' then
  -- ADD BACK, never SET. A punch earned after the redemption must survive the
  -- undo: 12 forfeited, 1 earned since, undo -> 13, not 12.
  update punch_cards
  set punches = punches + coalesce(orig.visits_spent, 0)
  where user_id = orig.user_id and vendor_id = orig.vendor_id;
end if;
```

The compensating row carries `paid_with = orig.paid_with` and
`visits_spent = -orig.visits_spent` so signed sums still net to zero in analytics.

The existing 60s window, the `reverses` / `reversed_by` linkage, the balance clamp and the
community unwind are all unchanged. Points redemptions behave exactly as today.

### 1i. Error codes

New codes must be registered in [server.js:466-495](server.js#L466-L495) or they fall
through to a logged 500. Matching is a **substring scan over `Object.keys`**, so ordering
matters: `REWARD_NOT_POINTS_PRICED` must be listed **before** `REWARD_NOT_FOUND` would
otherwise shadow nothing, but `INSUFFICIENT_VISITS` must not be placed where
`INSUFFICIENT_POINTS` could mis-match it.

```js
INSUFFICIENT_VISITS:      [400, 'Not enough visits for this reward.'],
REWARD_NOT_POINTS_PRICED: [400, 'This reward is not priced in points.'],
REWARD_NOT_VISITS_PRICED: [400, 'This reward is not priced in visits.'],
BAD_CURRENCY:             [400, 'Pick points or visits.'],
```

### 1j. migration-030 (after the code deploy)

```sql
alter table public.vendors drop column if exists punch_target;
alter table public.vendors drop column if exists punch_reward;
notify pgrst, 'reload schema';
```

Note `punch_in` and `redeem_punch_card` currently read `v.punch_target` / `v.punch_reward`;
029 replaces both bodies first. plpgsql is late-bound and **not** dependency-tracked, so
dropping the columns while an old body survives fails at runtime, not at migration time.

---

## 2. API layer

### GET /api/me/balances — [student.js:136-190](src/routes/student.js#L136-L190)

Select list (029 phase, columns still present — drop the two names in the same deploy):

```js
.select('id, name, slug, address, latitude, longitude, has_logo, accepts_community_points, punch_enabled, rewards(id, title, cost_in_points, cost_in_visits, emoji, active)')
```

`punchMap` collapses to a single count per vendor:

```js
const punchMap = {};
for (const c of cards ?? []) punchMap[c.vendor_id] = c.punches ?? 0;
```

Per-vendor payload:

```js
punch: {
  enabled: Boolean(v.punch_enabled),
  visits: punchMap[v.id] ?? 0,
},
```

`target`, `reward`, `punches`, `cardTarget`, `readyCards` all go. `rewards` keeps riding
through raw (snake_case, `cost_in_points` + `cost_in_visits`) — it is the one field in this
response that is not hand-mapped, and renaming it would break three call sites at once.

### POST /api/me/redeem-code — [student.js:314-348](src/routes/student.js#L314-L348)

Body gains `paidWith`. The affordability pre-check must become **currency-explicit** — the
current `(bal?.balance ?? 0) < reward.cost_in_points` silently passes when the cost is NULL
(`0 < null` is `false` in JS), minting a code that dies at the counter in front of the cashier.

```js
const { vendorId, rewardId, paidWith = 'points' } = req.body ?? {};
if (!isUuid(vendorId) || !isUuid(rewardId)) return res.status(400).json({ ... });
if (paidWith !== 'points' && paidWith !== 'visits') {
  return res.status(400).json({ error: 'BAD_REQUEST', message: 'Pick points or visits.' });
}

// ...reward select now includes cost_in_visits; add a punch_cards read.

if (!vendorRow?.active) throw new Error('VENDOR_UNAVAILABLE');
if (!reward?.active) throw new Error('REWARD_NOT_FOUND');

if (paidWith === 'points') {
  if (reward.cost_in_points == null) throw new Error('REWARD_NOT_POINTS_PRICED');
  if ((bal?.balance ?? 0) < reward.cost_in_points) throw new Error('INSUFFICIENT_POINTS');
} else {
  if (!vendorRow.punch_enabled) throw new Error('VENDOR_UNAVAILABLE');
  if (reward.cost_in_visits == null) throw new Error('REWARD_NOT_VISITS_PRICED');
  if ((card?.punches ?? 0) < reward.cost_in_visits) throw new Error('INSUFFICIENT_VISITS');
}
```

These stay advisory — `create_redeem_code` re-checks authoritatively (D7). Response is
unchanged: `{ code, ttlSeconds: 120 }`.

**Also add this route to `redeemLimiter`** ([server.js:194-214](server.js#L194-L214)). Today
the mint endpoint is covered only by the 1000/15min general limiter while all four vendor
paths share the 240/15min one.

### POST /api/vendor/redeem-preview — [vendor.js:213-234](src/routes/vendor.js#L213-L234)

`resolveRedeemCode` now returns `paid_with` and `visits_charged`. Response gains the fields
the confirm screen needs to describe a visits redemption:

```js
res.json({
  name, balance,
  rewardTitle: reward.title,
  cost: reward.cost_in_points,
  emoji: reward.emoji || '🎁',
  paidWith: code.paid_with,
  visitsCharged: code.visits_charged,
  visitsBalance: card?.punches ?? 0,
});
```

### POST /api/vendor/redeem — [vendor.js:242-264](src/routes/vendor.js#L242-L264)

Response gains `paidWith` and `visitsLeft` from the RPC. Emission branches:

```js
emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance });
if (row.paid_with === 'visits') {
  emitPunch(userId, { vendorId: req.vendor.id, visits: row.visits_left, redeemed: true,
                      reward: row.reward_title });
}
```

Without the second emit the student's counter stays at its pre-reset value and the reward
keeps rendering as redeemable until a manual reload, inviting a second tap that fails.

### Routes deleted

`POST /api/me/punch-redeem-code` ([student.js:263-283](src/routes/student.js#L263-L283)),
`POST /api/vendor/punch-redeem-preview` and `POST /api/vendor/punch-redeem`
([vendor.js:287-331](src/routes/vendor.js#L287-L331)). Remove the last two from the
`redeemLimiter` array too.

### Socket

`emitPunch` payload becomes `{ vendorId, visits, redeemed?, reward? }`. The client handler
must read `visits` on **every** punch event, not only redemptions — today it branches solely
on `payload.redeemed` and drops fill events entirely.

---

## 3. Vendor admin UI

Reward CRUD lives in the terminal's ITEMS tab, not the operator dashboard.

### Form — [public/vendor/index.html:449-479](public/vendor/index.html#L449-L479)

Add a second price input beside `#reward-cost`:

```html
<label>Points to redeem <span class="field-optional">(optional)</span>
  <input id="reward-cost" type="number" inputmode="numeric" min="1" max="100000" step="1" placeholder="150" />
</label>
<label id="reward-visits-label">Visits to redeem <span class="field-optional">(optional)</span>
  <input id="reward-visits" type="number" inputmode="numeric" min="1" max="50" step="1" placeholder="5" />
</label>
<p class="manage-note">Set at least one. An item can be earned with points, with visits, or with either.</p>
```

`#reward-visits-label` is hidden when `punch_enabled` is off, so a vendor cannot author a
visits-only reward that no student can reach. Note the existing `#reward-cost` has **no
`max`** while the server caps at 100000 — fix that inconsistency here.

### validReward — [vendor.js:378-385](src/routes/vendor.js#L378-L385)

Rewrite to allow either price, allow explicit `null` to clear one, and mirror the DB CHECK.
This is the sole validator for both POST and PATCH.

```js
function validReward(title, cost, visits, emoji) {
  const t = String(title ?? '').trim();
  const e = String(emoji ?? '🎁').trim().slice(0, 16) || '🎁';
  if (!t || t.length > 60) return { error: 'Give the item a name (up to 60 characters).' };

  const num = (raw, label, max) => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      return { error: `${label} must be a whole number from 1 to ${max}.` };
    }
    return n;
  };
  const c = num(cost, 'Point cost', 100000);
  if (c?.error) return c;
  const v = num(visits, 'Visit cost', 50);
  if (v?.error) return v;
  if (c == null && v == null) {
    return { error: 'Set a point cost, a visit cost, or both.' };
  }
  return { title: t, cost: c, visits: v, emoji: e };
}
```

The PATCH sentinel at [vendor.js:414-418](src/routes/vendor.js#L414-L418) passes
`costInPoints ?? 1`, which makes clearing a price impossible — the exact operation D4
introduces. Replace the sentinel with a merge against the stored row.

Add `cost_in_visits` to the select at [:368](src/routes/vendor.js#L368), the insert
whitelist at [:395](src/routes/vendor.js#L395), and the update whitelist at
[:421](src/routes/vendor.js#L421). Map constraint violation `rewards_has_a_price` to a 400,
not a raw 500.

### Punch settings card — [public/vendor/index.html:378-397](public/vendor/index.html#L378-L397)

Delete `#set-punch-target`, `#set-punch-reward` and the `#punch-fields` wrapper. Keep
`#set-punch` and `data-card="punch"` (load-bearing for the dirty-tracking border).

Same-change edits or the settings screen throws on render:
`settingsSnapshot()` [terminal.js:1798-1812](public/vendor/terminal.js#L1798-L1812) →
`punch: { enabled }`; `syncPunchFields()` [:1816-1818](public/vendor/terminal.js#L1816-L1818)
deleted along with its two call sites ([:99](public/vendor/terminal.js#L99) and
[:1889](public/vendor/terminal.js#L1889)); `renderSettings()`
[:1886-1889](public/vendor/terminal.js#L1886-L1889); `saveSettings()`
[:2045-2057](public/vendor/terminal.js#L2045-L2057).

Server: drop the `punchTarget` / `punchReward` blocks from `validSettings`
[vendor.js:638-648](src/routes/vendor.js#L638-L648), from `settingsView`
[:663-664](src/routes/vendor.js#L663-L664), and from `GET /config`
[:76-77](src/routes/vendor.js#L76-L77).

**Toggling punch off does not void banked visits** — counters are left intact, the student
UI simply hides them. Add a confirm on toggle-off naming how many rewards are visits-priced.

---

## 4. Student UI

### 4a. Visit counter replaces the dot grid (D8)

[index.html:285-296](public/student/index.html#L285-L296):

```html
<div id="punch-block" hidden>
  <p class="app-sub">VISITS</p>
  <button id="punch-card-btn" class="punch-card" type="button"
          aria-haspopup="dialog" aria-expanded="false" aria-controls="punch-modal">
    <span class="punch-card-head">
      <span id="punch-count" class="punch-count">0</span>
      <span id="punch-count-unit" class="punch-count-unit">visits</span>
    </span>
    <span id="punch-next" class="punch-next"></span>
  </button>
</div>
```

The dot grid was `aria-hidden="true"` because the accessible text lived in `#punch-progress`.
A bare number is a meaningless button label, so `renderPunchUi` sets an explicit `aria-label`.

```js
function renderPunchUi() {
  const p = vendor?.punch;
  const enabled = Boolean(p?.enabled);
  $('punch-block').hidden = !enabled;
  $('punch-scan-btn').hidden = !enabled;
  if (!enabled) return;

  const visits = p.visits ?? 0;
  const unit = visits === 1 ? 'visit' : 'visits';
  $('punch-count').textContent = visits;
  $('punch-count-unit').textContent = unit;
  $('punch-card-btn').setAttribute('aria-label',
    `${visits} ${unit} at ${vendor.name}, open your visit card`);

  const next = nextVisitReward(visits);
  $('punch-next').textContent =
    visits === 0 ? 'Scan the code at the counter to start'
    : next       ? `${next.cost_in_visits - visits} more for ${next.title}`
                 : 'Ready to redeem, see the rewards below';
  $('punch-scan-sub').textContent = 'Scan the code at the counter';
}

// cheapest visits-priced reward still out of reach; null when all are affordable
function nextVisitReward(visits) {
  return (vendor?.rewards ?? [])
    .filter((r) => r.cost_in_visits != null && r.cost_in_visits > visits)
    .sort((a, b) => a.cost_in_visits - b.cost_in_visits)[0] ?? null;
}
```

**Delete:** `PUNCH_ROW_FALLBACK`, `punchGridWidth`, `renderPunchDots`, `punchDot`,
`onPunchResize` ([app.js:2129-2186](public/student/app.js#L2129-L2186)) **and** the resize
listener at [app.js:171](public/student/app.js#L171). Removing the functions without
unwiring the listener throws on every rotate.

**CSS** ([styles.css:1241-1283](public/student/styles.css#L1241-L1283)): drop
`.punch-grid`, `.punch-row`, `.punch-dot`, `.punch-dot.is-filled`, `.punch-ready`. Keep
`.punch-card`'s sticker treatment (3px `--edge`, `0 4px 0` shadow, `translateY(3px)` press)
so it stays native with `.data-btn` / `.setting-row`.

```css
.punch-count { font-weight: 900; font-size: 2.4rem; color: var(--brand); line-height: 1; }
.punch-count-unit { font-weight: 800; font-size: 1rem; color: var(--muted); }
.punch-next { font-weight: 700; font-size: 0.95rem; color: var(--success); }
```

### 4b. Reward rows show both prices (D5)

Three sites break on a null cost today: the sort does `a.cost_in_points - b.cost_in_points`
(NaN), `dataset.cost` becomes the string `"null"` (so `balance >= NaN` is false and every
visits-only reward renders permanently locked), and the description reads "for null points".

`renderItems` — separate dataset keys, and **hide visits-only rewards when punch is off**
rather than rendering a card that can never be redeemed:

```js
const live = (vendor?.rewards ?? [])
  .filter((r) => r.cost_in_points != null || vendor?.punch?.enabled)
  .slice()
  .sort(rewardOrder);

live.forEach((r) => {
  const card = document.createElement('button');
  card.className = 'item-card live';
  card.dataset.id = r.id;
  card.dataset.title = r.title;
  card.dataset.costPoints = r.cost_in_points ?? '';
  card.dataset.costVisits = r.cost_in_visits ?? '';
  card.dataset.emoji = r.emoji || '🎁';
  wrap.appendChild(card);
});

// redeemable first, then cheapest by whichever currency the student is closest in
function rewardOrder(a, b) {
  const key = (r) => Math.min(r.cost_in_points ?? Infinity, (r.cost_in_visits ?? Infinity) * 100);
  return key(a) - key(b);
}
```

One affordability helper, used by both the row and the sheet so they cannot drift:

```js
function affordability(card) {
  const pts = card.dataset.costPoints === '' ? null : Number(card.dataset.costPoints);
  const vis = card.dataset.costVisits === '' ? null : Number(card.dataset.costVisits);
  const visitsOn = Boolean(vendor?.punch?.enabled);
  const visits = vendor?.punch?.visits ?? 0;
  return {
    pts, vis, visitsOn, visits,
    byPoints: pts != null && balance >= pts,
    byVisits: visitsOn && vis != null && visits >= vis,
  };
}

function priceBits(a) {
  const bits = [];
  if (a.pts != null) bits.push(`${a.pts} pts`);
  if (a.vis != null && a.visitsOn) bits.push(`${a.vis} visits`);
  return bits;
}
```

`decorateCard` — the shortfall stays visible, per currency. Never say "pts" for a
visits-only reward:

```js
function decorateCard(card) {
  const a = affordability(card);
  const ready = a.byPoints || a.byVisits;
  card.classList.toggle('locked', !ready);

  const gaps = [];
  if (a.pts != null && !a.byPoints) gaps.push(`${a.pts - balance} pts to go`);
  if (a.vis != null && a.visitsOn && !a.byVisits) gaps.push(`${a.vis - a.visits} visits to go`);

  card.innerHTML = `
    <span class="ic-emoji">${escapeHtml(card.dataset.emoji || '🎁')}</span>
    <span class="ic-body">
      <span class="ic-title">${escapeHtml(card.dataset.title)}</span>
      <p class="ic-status">${ready ? 'Ready to redeem ✓' : escapeHtml(gaps.join(' or '))}</p>
    </span>
    <span class="ic-cost">${escapeHtml(priceBits(a).join(' / '))}</span>`;
}
```

`decorateCard` is re-run over every row by `applyBalance`
([app.js:1718](public/student/app.js#L1718)), which rebuilds `innerHTML` — so all new row
DOM must be produced **inside** it, never appended afterwards.

### 4c. Dual redeem buttons + the "Not ready yet" state (D6)

[index.html:624](public/student/index.html#L624), replacing the single button:

```html
<p id="item-cost" class="detail-cost"></p>
...
<button id="item-redeem" class="btn-redeem" hidden>Redeem with points</button>
<button id="item-redeem-visits" class="btn-redeem secondary" hidden>Redeem with punches</button>
<div id="item-notready" class="item-notready" role="status" hidden>
  <span class="inr-icon" aria-hidden="true">🔒</span>
  <span class="inr-head">Not ready yet</span>
  <span class="inr-sub">Visit more locations and come back!</span>
</div>
```

`.btn-redeem` is shared by seven buttons, so the secondary style must be a **modifier**,
never an edit in place. There is no outline slab variant in the stylesheet today; two
identical navy blocks would read as one duplicated control.

```css
.btn-redeem.secondary {
  background: var(--card); color: var(--navy);
  border: 3px solid var(--navy); padding: calc(1.1rem - 3px);
}
.btn-redeem.secondary:active { background: var(--sky); }
.btn-redeem:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }

.item-notready {
  margin-top: 0.6rem; width: 100%;
  display: flex; flex-direction: column; align-items: center; gap: 0.15rem;
  padding: 1rem; border-radius: 0.9rem;
  background: var(--sky); border: 2px dashed var(--sky-line);
}
.inr-icon { font-size: 1.6rem; }
.inr-head { font-weight: 900; font-size: 1.15rem; color: var(--ink); }
.inr-sub  { font-weight: 600; font-size: 0.92rem; color: var(--muted); }
```

`onItemTap` — the two user-supplied strings own the button slot, but the **numbers stay
alive** in the lines above so the student can still see why something is locked:

```js
const a = affordability(card);
$('item-cost').textContent = priceBits(a).join(' / ');
$('item-cost').setAttribute('aria-label', priceBits(a).join(' or '));   // not "slash"
$('item-status').textContent =
  `You have ${balance} pts${a.visitsOn ? ` · ${a.visits} visits` : ''}`;
$('item-status').className = (a.byPoints || a.byVisits) ? 'detail-status ok' : 'detail-status locked';

$('item-redeem').hidden        = !a.byPoints;
$('item-redeem-visits').hidden = !a.byVisits;
$('item-notready').hidden      = a.byPoints || a.byVisits;
```

The dead `selectedItem.sample` branch ([app.js:1843](public/student/app.js#L1843)) can go —
nothing has set `data-sample` since `renderItems` stopped writing it.

`onRedeemTap(paidWith)` passes the currency through; `boot()` gains
`$('item-redeem-visits').addEventListener('click', () => onRedeemTap('visits'))`
at [app.js:158-161](public/student/app.js#L158-L161).

`showRedemptionCode` must hide **all three** new nodes, not just `#item-redeem`, or a live
button sits next to the QR. `closeItemModal`'s 360ms reset must restore all three, or state
leaks into the next open.

### 4d. Punch modal becomes progress-only (D3)

Delete `#punch-redeem-btn` and the whole `#punch-code` block
([index.html:651-660](public/student/index.html#L651-L660)), plus `onPunchRedeemTap`,
`showPunchRedeemCode`, `punchCodeCountdown` and the wiring at
[app.js:167](public/student/app.js#L167). `openPunchModal` keeps only the progress copy.

### 4e. Socket handler

Today it branches solely on `payload.redeemed` and drops fill events. It must read `visits`
on every event and repaint both the counter and the rows:

```js
socket.on('punch', (payload) => {
  if (!payload?.vendorId) return;
  const v = allVendors.find((x) => x.vendorId === payload.vendorId);
  if (v?.punch) v.punch.visits = payload.visits ?? v.punch.visits;
  if (vendor && vendor.vendorId === payload.vendorId) {
    renderPunchUi();
    document.querySelectorAll('.item-card').forEach(decorateCard);
  }
  punchToast(payload.redeemed
    ? `🎉 Redeemed${payload.reward ? ` · ${payload.reward}` : ''}`
    : `🎟️ Visit counted · ${payload.visits} total`);
});
```

### 4f. Card-era copy to remove

Every one of these asserts a card that no longer exists. **Copy rule: no em dashes in
user-visible text** ([index.html:3-15](public/student/index.html#L3-L15)).

| Where | Current |
|---|---|
| [app.js:2118](public/student/app.js#L2118) | `Full card = X` |
| [index.html:294](public/student/index.html#L294) | `🎉 Card full, tap to redeem` |
| [app.js:2119-2121](public/student/app.js#L2119-L2121) | `Card full, tap your punch card above` |
| [app.js:2204-2214](public/student/app.js#L2204-L2214) | `Card full! 🎉` / `X of Y punches...` |
| [app.js:2098-2100](public/student/app.js#L2098-L2100) | `Card full at X! Tap your punch card to redeem` |
| [app.js:1697](public/student/app.js#L1697) | `Punch card redeemed` |
| [index.html:56](public/student/index.html#L56) | `no punch card to lose` |
| [terminal.js:1268-1270](public/vendor/terminal.js#L1268-L1270) | `10 punches = Free cover` |

---

## 5. Vendor terminal

**The guess-and-fallback dies.** [terminal.js:1037-1071](public/vendor/terminal.js#L1037-L1071)
currently tries `/redeem-preview` and falls back to `/punch-redeem-preview` on
`CODE_INVALID`. With one code table, one preview call returns `paidWith` on the row. Delete
the fallback, delete `pendingRedeemKind`, delete the `WRW:P:` branch at
[terminal.js:1102-1123](public/vendor/terminal.js#L1102-L1123). `WRW:R:` is the only prefix.

Confirm screen branches on `paidWith`. The visits variant hides the balance chip and — this
matters — **discloses the forfeit** before staff confirm, since D1 zeroes the counter
regardless of price:

```
🎟️  Free coffee
    5 visits needed · uses all 12 visits
    [ Confirm and use visits ]
```

**Call `refreshLastActivity()` after a visits redemption.** The punch branch at
[terminal.js:1140-1143](public/vendor/terminal.js#L1140-L1143) deliberately does not today,
which is exactly why punch redemptions have no Undo. D10 requires it.

PUNCH tab: `#punch-reward-line` loses its meaning. Replace with the cheapest visits-priced
reward, or plain "Scan to collect a visit".

Note `syncPunchTab()` only runs at sign-in and after a local settings save
([terminal.js:1207-1213](public/vendor/terminal.js#L1207-L1213)), so flipping `punch_enabled`
elsewhere will not reveal the tab until reload. Pre-existing, worth fixing while here.

Per project memory: `terminal.js` mixes literal `\uXXXX` escapes with real unicode — keep
edit blocks small and ASCII-anchored.

---

## 6. Tests

**Breaks immediately:** [test/integration/punch.test.js:29](test/integration/punch.test.js#L29)
sets `punch_target: 3, punch_reward: 'Free cover'` in fixture setup, so the whole suite
fails at setup and masks real regressions.

**New coverage needed:**

- `create_redeem_code` with `paid_with='visits'` raises `INSUFFICIENT_VISITS` when the
  counter is short, even if the client claimed otherwise (D7).
- Mint does **not** decrement; an expired unspent visits code leaves the counter untouched.
- Burn resets to exactly 0 from a surplus counter, and records `visits_spent` = pre-burn count.
- Burn raises `INSUFFICIENT_VISITS` and **rolls back the code deletion** when a race drains
  the counter between mint and burn.
- Two concurrent `punch_in` calls for a new (student, vendor) produce **one** row.
- Undo of a visits redemption adds back `visits_spent`, and a punch earned in between
  survives (12 → redeem → 0 → punch → 1 → undo → 13).
- `rewards_has_a_price` rejects a reward with neither price; accepts points-only,
  visits-only, and both.
- A points redemption is byte-for-byte unchanged in `transactions` (points negative,
  `paid_with='points'`, `visits_spent` null).

Per project memory: there is no local DB. Verify migration-029 against a throwaway
`postgres:16` container with a stub schema, run from PowerShell.

---

## 7. Ordered task list

| # | Task | Status |
|---|---|---|
| 1 | Write `migration-029.sql` (1a-1i), wrapped in `begin; ... commit;`. | **done** |
| 2 | Verify 029 against a throwaway `postgres:16` container running the real schema + 002-028. | **done** — 13/13 behaviour checks, structural checks, one-shot guard all pass |
| 3 | Four new error codes in `server.js`; `/api/me/redeem-code` added to `redeemLimiter`; punch-redeem paths removed. | **done** |
| 4 | `student.js`: `/balances` payload, `/punch` payload, `/redeem-code` currency branch, `/history` columns, `/punch-redeem-code` deleted. | **done** |
| 5 | `vendor.js`: `resolveRedeemCode`, preview + burn + reverse responses, `validReward` dual pricing, reward CRUD columns, `/visit-impact`, settings + config + punch-token cleanup, punch-redeem routes deleted. | **done** |
| 6 | `emitPunch` payload shape (`{ vendorId, visits, redeemed?, reward? }`). | **done** (callers updated; `realtime.js` itself is payload-agnostic) |
| 7 | Student UI 4a + 4b (counter, dual-price rows). | **done** |
| 8 | Student UI 4c + 4d (dual buttons, empty state, progress-only modal). | **done** |
| 9 | Student UI 4e + 4f (socket handler, copy sweep). | **done** |
| 9b | Adversarial review of tasks 1-9; 11 of 26 findings confirmed, all fixed. | **done** |
| 10 | Terminal: preview/confirm/burn, delete the fallback, add `refreshLastActivity()`, Undo + Recent copy. | **done** |
| 11 | Terminal: reward form punch input + raise-price warning, settings card cleanup, PUNCH tab line. | **done** |
| 12 | Tests (section 6). | **done** — `test/sql/` harness (19 assertions, runs here) + rewritten `test/integration/punch.test.js` |
| 13 | Deploy. Confirm the app runs clean with the columns still present. | |
| 14 | Write and run `migration-030.sql` (drop the two columns, `notify pgrst`). | |

### Bugs the client review caught (all fixed)

| | Defect | Why it mattered |
|---|---|---|
| 1 | No `dropItemModal` on sign-out | `#item-modal` is a body-level sibling of `#app`, so hiding `#app` could not hide it. Session expiry mid-redemption left a live QR and a ticking countdown on the signed-out landing page. |
| 2 | `rewardOrder` ranked by a hidden visit price | With punch off, an 8000 pts reward sorted above a 200 pts one because its 1-visit price still counted. |
| 3 | `/api/me/export` missing `paid_with` / `visits_spent` | The GDPR-style export reported `points: 0` for every visits redemption. |
| 5 | `.ic-cost` was `nowrap` with no `min-width` | Two prices at 320px crushed the title column and overran the card. |
| 6 | History rendered an undo identically to the redemption | Redeem then undo read as two redemptions, 24 visits spent. |
| 7 | `+${tx.points}` on a reversed earn | Printed the literal `+-150 pts`. Pre-existing, fixed while here. |
| 8 | Counter dead-ended with nothing priced in visits | Deactivating the visits rewards stranded banked visits behind a blank subtitle and an empty sheet. |
| 9 | Forfeit warning sat above the points button | Implied paying with points also burned visits. |
| 10 | Card-era copy on the landing page | "no punch card to lose" and "it lands on your card". |

### Bugs the container run caught (both runtime-only)

1. **`paid_with` ambiguous** in `redeem_by_code` — `RETURNS TABLE` columns become plpgsql
   variables, so `DELETE ... RETURNING paid_with` could not tell the OUT parameter from the
   column. Every redemption would have failed at the counter. Fixed by table-qualifying.
2. **`ON CONFLICT (user_id, vendor_id)` ambiguous** against `punch_in`'s `vendor_id` OUT
   parameter — every punch scan would have thrown. Replaced with the find-or-create +
   `exception when unique_violation` shape migration-028 already proved.

---

## Resolved (was: open questions)

### D11 — disclose the forfeit on the student's phone

In the reward sheet, whenever `byVisits` is true, a warning line sits directly above the
buttons. It renders **only** when there is surplus to lose (`visits > cost_in_visits`), so a
student spending exactly what they have is not warned about nothing.

```js
const surplus = a.byVisits && a.visits > a.vis;
$('item-forfeit').hidden = !surplus;
$('item-forfeit').textContent = `Uses all ${a.visits} of your visits`;
```

```html
<p id="item-forfeit" class="item-forfeit" hidden></p>
```

```css
.item-forfeit { font-weight: 800; font-size: 0.95rem; color: var(--danger); }
```

Reset it in `closeItemModal` and hide it in `showRedemptionCode` alongside the buttons.
The counter confirm screen keeps its own line (section 5).

### D12 — warn the vendor when raising a visit price

New preflight route, PIN-gated, read-only:

```
GET /api/vendor/visit-impact?from=<int>&to=<int>  ->  { affected: <int> }
```

```js
// counts students who can afford it now but would not after the raise
const { count } = await supabaseAdmin
  .from('punch_cards')
  .select('user_id', { count: 'exact', head: true })
  .eq('vendor_id', req.vendor.id)
  .gte('punches', from)
  .lt('punches', to);
```

`saveReward()` calls it only when editing an existing reward **and** the new
`cost_in_visits` is strictly greater than the stored one. `affected > 0` opens a confirm
step ("N customers can afford this right now and will lose access") with Cancel / Save
anyway. Lowering a price, or setting one for the first time, never prompts.

### D13 — history shows visits

[app.js:924-935](public/student/app.js#L924-L935) renders the points chip from
`tx.points`. For `paid_with === 'visits'`, suppress it and render the visit count instead:

```js
const chip = tx.paid_with === 'visits'
  ? `${tx.visits_spent} visits`
  : `${tx.points > 0 ? '+' : ''}${tx.points} pts`;
```

`GET /api/me/history` must add `paid_with, visits_spent` to its select list, and
`GET /api/vendor/recent` needs the same two columns so the terminal's Undo copy can say
"visits restored" rather than "points refunded".

## Blast radius

- **One-shot migration.** 029 collapses rows, credits outstanding cards and drops columns.
  A second paste re-credits visits. Guard on the existence of `punch_cards_pre_029` and keep
  that backup until 030 is confirmed.
- **Live data.** Every student holding a completed unredeemed card gets `target` visits
  credited. That includes you — your full card converts to a visit balance rather than
  disappearing.
- **Two-phase deploy is mandatory.** Dropping `punch_target` / `punch_reward` before the code
  stops selecting them takes down the entire student home screen, not just the punch section.
- **Running dev server.** HTML edits are memoised; touch `server.js` to restart nodemon.
  CSS/JS go live on their own.
- **Tests.** `test/integration/punch.test.js` fails at setup until fixed.
- **Docs.** `notes.md` and `go-to-market.md` both describe punch cards in card language.
- **In-flight codes.** Any live `punch_redeem_codes` row dies when the table drops. TTL is
  120s, so run 029 outside service hours and confirm the table is empty first.
