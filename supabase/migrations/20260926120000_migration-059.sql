-- ============================================================
-- Migration 059 — two narrow fixes, both about a key that is scoped to the
--                 wrong thing.
--
--   1. A RECEIPT CAN BE CLAIMED ONCE PER LOCATION OF A CHAIN, not once per
--      piece of paper. (claim_receipt)
--   2. A SELF-SERVE RESET REQUEST RETIRES THE CODE THE OPERATOR JUST READ DOWN
--      THE PHONE. (vendor_reset_request)
--
--   ------------------------------------------------------------------
--   1. ONE RECEIPT, ONE CLAIM — ACROSS THE WHOLE BUSINESS
--   ------------------------------------------------------------------
--   migration-038's header calls `unique (vendor_id, receipt_at, total)` "THE
--   rule: one claim per physical receipt, ever". It is only that rule if the
--   vendor_id a given piece of paper resolves to is FIXED. It is not.
--
--   matchVendor (src/lib/receipt.js) cannot tell a chain's locations apart —
--   both Sher Halal storefronts print the identical header, so scoring them can
--   only ever produce a tie, and sameBusiness() deliberately collapses that tie
--   rather than reading it as "two vendors both look right" and refusing every
--   receipt the chain prints. The winner is then broken out by lexicographic
--   vendor id, chosen from among ONLY the rows the route handed it —
--   `vendors where active = true` in GET-time cache terms.
--
--   So the resolved vendor id is a function of the ACTIVE SET, and the active
--   set is an operator control:
--
--     · deactivate the location that used to win (the admin guard in
--       src/routes/admin.js explicitly permits deactivating any non-last pool
--       member, so this is a normal Tuesday, not an edge case), or
--     · add a location whose uuid happens to sort lower,
--
--   and the same photograph now resolves to a DIFFERENT vendor_id. Every dedup
--   key downstream is per-vendor, so every one of them misses:
--
--     · idx_receipt_claims_once is (vendor_id, receipt_at, total) — different
--       leading column, no conflict;
--     · the counter double-dip check is keyed on t.vendor_id = p_vendor_id;
--     · award_points' client_token is md5(p_vendor_id|receipt_at|total) under
--       uq_tx_client_token (vendor_id, client_token) — different token.
--
--   The receipt is paid twice. For a pooled chain (migration-044) both earns
--   land in the SAME purse, so the student is simply paid double for one meal;
--   unpooled, they collect at two cards for a meal they ate once.
--
--   THE FIX is to ask the question the rule always meant to ask: has this
--   printed time and total already been claimed at this BUSINESS? "Same
--   business" is not a column, so it is the same two-part test sameBusiness()
--   makes in Node, and for the same stated reasons:
--
--     · a shared pool_id is the strong signal — those locations already spend
--       one balance;
--     · an identical printed name is the weak one, and it is what carries a
--       chain that has not been pooled yet.
--
--   Mirroring sameBusiness() EXACTLY (pool OR name, not pool-else-name) is the
--   point, and the scope of that claim matters: the rows this guard fences are
--   the rows matchVendor may swap between BY TIE-COLLAPSE — the sameBusiness()
--   siblings whose scores are equal by construction (same printed header, so
--   scoring cannot separate them), where the winner is then broken out by uuid
--   from the active set. That is the swap described above, and it is the common
--   one because it needs no OCR luck at all. Narrowing either arm would leave one
--   of those tie-collapse swaps unpoliced; widening it would refuse receipts no
--   tie-collapse could have produced.
--
--   ⚠ WHAT THIS DOES NOT FENCE. "Mirrors sameBusiness()" is NOT the same claim as
--   "a receipt can no longer be paid twice", and a reader must not take it for
--   one. matchVendor's ambiguity guard (src/lib/receipt.js:125-127) compares the
--   winner only against the best-scoring DIFFERENT business, so dropping the
--   winner out of the active set can PROMOTE a row that was never sameBusiness()
--   with it — no tie, no collapse, and therefore nothing this guard can see:
--
--     'Sher Halal' and 'Sher Halal West', both active, unpooled, header
--     "SHER HALAL". Verified in node against src/lib/receipt.js: 'Sher Halal'
--     scores 1 (substring hit), the runner-up scores
--     diceSimilarity('sher halal','sher halal west') = 0.7826, and the margin
--     1 − 0.7826 = 0.217 ≥ MATCH_MARGIN (0.1), so 'Sher Halal' is accepted
--     outright. Deactivate it and the SAME photograph resolves to 'Sher Halal
--     West' at 0.7826 ≥ MATCH_MIN (0.6) with no runner-up left to be ambiguous
--     against. Different vendor_id, different name key, no shared pool — so 2c
--     below finds no sibling and the receipt is paid a second time.
--
--   The guard is right not to widen to cover that, which is why this is a
--   documented residual and not a TODO here: "these two names are 78% alike" is
--   not a business identity, and fencing on it would refuse the genuinely
--   different shop two doors down that happens to share a word. Closing it needs
--   a different shape of key — one that does not mention vendor_id at all (a
--   per-student (receipt_at, total) claim key, which costs a student two real
--   meals of the same total in the same minute anywhere on campus), or a
--   margin re-check in matchVendor that survives a deactivation. Neither belongs
--   in a narrow migration. So residual (i) is the SCORE-MARGIN swap: it stays
--   open, and is written down here so that "mirrors sameBusiness() EXACTLY" (above)
--   is not read as "mirrors every way a receipt can change vendor_id".
--
--   ⚠ AND RESIDUAL (ii): even the tie-collapse swap is closed only against
--   COMMITTED sibling claims. 2c is a plain non-locking `if exists` read, so it
--   cannot see a sibling claim that another transaction has inserted but not yet
--   committed, and the advisory lock above it is keyed on the STUDENT
--   ('receipt_claims:' || p_user_id), so two students submitting the same
--   photograph in the same instant do not contend. Their inserts then land at
--   different vendor_id values, which is exactly what idx_receipt_claims_once
--   (vendor_id, receipt_at, total) and award_points' uq_tx_client_token cannot
--   span — so that one overlap window still pays one receipt twice. Everything
--   outside it (the common case: a re-scan minutes or days later, after a
--   deactivation) is fenced.
--
--   No unique index can close (ii), because "same business" is `pool OR name`
--   (sameBusiness in src/lib/receipt.js) and that is not a single column. Nor can
--   one extra advisory lock: keying it on coalesce(pool_id, name_key) would put a
--   pooled location and an unpooled same-name sibling — siblings by the name arm —
--   on two DIFFERENT lock keys, so the pair that races would still not contend.
--   Serialising properly means locking every key a row could match under, or
--   materialising a real business_id column; both are a schema change and neither
--   belongs in a narrow migration. Written down rather than half-fixed, and
--   restated beside 2c's insert.
--
--   ⚠ WHAT THIS COSTS, stated plainly: two tills of one chain that print the
--   same total in the same MINUTE (receiptLocal in src/routes/student.js is
--   built with :00 seconds, so receipt_at has minute resolution) now collide,
--   and the second student is told RECEIPT_CLAIMED for a receipt that is
--   genuinely theirs. That is not a new trade-off — it is migration-038's
--   trade-off, which already refuses exactly this collision at ONE till, widened
--   from a till to a business. Paying one receipt twice is the worse failure,
--   and the student has a counter they can be awarded at.
--
--   What it does NOT cost: the same total at the same shop on a DIFFERENT day,
--   or twenty minutes later, still claims fine. receipt_at is part of the key
--   for a reason and it stays in the key. behavior-038's step 4 (same amount
--   outside ±5 min) and step 5 (identical-total second receipt) both exercise
--   that and both still pass.
--
--   ------------------------------------------------------------------
--   2. AN OPERATOR-MINTED RESET CODE IS NOT SUPERSEDABLE FROM THE STREET
--   ------------------------------------------------------------------
--   migration-047 §6 gave vendor_reset_request a 120-second cooldown and said
--   why in its own header: "vendor_reset_issue SUPERSEDES any outstanding code,
--   so an unthrottled public endpoint lets anyone who knows a vendor's address
--   invalidate that vendor's live code on repeat, forever. The cooldown is what
--   stops a denial of service against a vendor mid-reset."
--
--   The cooldown only asks WHEN the live code was created, never WHO created
--   it. Past 120 seconds the function falls through to
--
--     update vendor_password_resets set used_at = now()
--      where user_id = v_user and used_at is null
--
--   which has no created_by filter, so it retires the operator-minted row
--   (created_by = the admin's email, from migration-031's vendor_reset_issue via
--   src/routes/admin.js) along with everything else, and replaces it with a
--   self-serve code mailed to an inbox the vendor may no longer be able to
--   reach — which is the whole reason the phone path exists. vendor_reset_begin
--   only ever claims the NEWEST live row (order by created_at desc limit 1), so
--   the code the operator is reading aloud now fails with RESET_INVALID and
--   burns one of five attempts while doing it.
--
--   The per-IP limiter in src/routes/vendor-recover.js allows roughly one of
--   these every three minutes, so it is a usable attack; it also happens purely
--   by ACCIDENT when the vendor on the phone taps "Email me a code" two minutes
--   into the call.
--
--   THE FIX: an operator-minted code that is still USABLE is protected for its
--   whole remaining lifetime, not for 120 seconds. A self-serve request that
--   arrives while one is outstanding is throttled instead of superseding it.
--   "Usable" is unexpired, not yet used_at, AND with at least one of its five
--   guesses left — vendor_reset_begin charges the burn on attempt cap+1, so a code
--   whose guesses are all spent still has used_at null while being impossible to
--   compare against; protecting THAT would leave a vendor who mis-heard the
--   dictated code with no recovery path at all for the rest of the TTL. The
--   throttle body spells this out beside the predicate. Nothing else changes:
--   the route already renders reset_throttled exactly as it renders success (the
--   ACCEPTED body — the endpoint is public and must not become a directory of
--   which addresses are vendor logins), so there is no client change and no
--   information leak, and the operator still gets the real story in the log.
--
--   THE WORST CASE THIS INTRODUCES is bounded and small: a vendor with a usable
--   dictated code who would rather have an emailed one waits out that code's TTL
--   (RESET_TTL_MINUTES / SELF_TTL_MINUTES — 30 minutes, and the operator sets
--   both), or uses the code they already have, or asks the operator for another
--   — vendor_reset_issue is untouched and still supersedes anything outstanding,
--   because an operator IS the trust anchor migration-031 was built around.
--
--   Self-serve-supersedes-self-serve is deliberately preserved: a vendor who
--   lost the first mail to a spam folder must still be able to ask again past
--   the cooldown. test/sql/behavior-047.sql section O pins that and is expected
--   to keep passing unchanged.
--
--   The sentinel is the literal 'self-serve', written by migration-047 and
--   asserted by behavior-047 section M2. Everything else in created_by — an
--   admin's email address, or NULL from an older vendor_reset_issue call that
--   passed no p_created_by — is treated as operator-minted and therefore
--   protected, because the conservative reading of an unknown minter is "a human
--   may be reading this code down a phone line right now".
--
--   ------------------------------------------------------------------
--   Both functions are restated in full rather than patched, per the house
--   convention: `create or replace` needs the whole body anyway, and a reader
--   diffing 059 against 038 / 047 should see one function, not a fragment.
--   Signatures are byte-identical to the versions they replace, so no drop is
--   needed (migration-033's overload trap does not apply) and src/routes/
--   student.js and vendor-recover.js keep working untouched.
--
--   Idempotent and safe to re-run.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-058. Nothing in this file depends on server code shipping first
--   or second — both changes only ever refuse something that is currently
--   wrongly accepted, so either order is safe.
-- ============================================================

begin;

-- ---------- 1. the business key ----------
--
-- The SQL half of normalizeName() in src/lib/receipt.js: lowercase, strip
-- diacritics, collapse every non-alphanumeric run to one space, trim. It exists
-- as a function because claim_receipt needs it on BOTH sides of a comparison (the
-- scanned vendor's name and every candidate sibling's), and inlining the
-- expression twice is how the two halves drift apart.
--
-- normalizeName() (src/lib/receipt.js:18-25) is exactly five operations:
--
--     .toLowerCase()
--     .normalize('NFKD')
--     .replace(/[\u0300-\u036f]/g, '')
--     .replace(/[^a-z0-9]+/g, ' ')
--     .trim()
--
-- and the body below is those same five, in that order, one call each: lower(),
-- normalize(…, nfkd), the U+0300..U+036F strip, the [^a-z0-9]+ collapse, btrim().
-- Being operation-for-operation is the whole point. It is the only way the two
-- halves agree over ALL of Unicode instead of over whatever range somebody
-- thought to tabulate, and 2c below is a dedup gate: where the two halves
-- disagree, a double-pay reopens.
--
-- WHY THE BUILT-IN normalize() AND NOT unaccent(): normalize(text, nfkd) has been
-- in core PostgreSQL since 13 (Supabase is 15+; test/sql/run.ps1 builds
-- postgres:16) and is IMMUTABLE, so it needs no extension and this function stays
-- indexable. unaccent would need contrib AND would give a DIFFERENT answer:
-- unaccent.rules is a transliteration table that also folds æ→ae ø→o ł→l đ→d
-- ß→ss, which normalizeName() pointedly does not — NFKD leaves those codepoints
-- whole and the [^a-z0-9] pass then turns them into a separator. The body below
-- does the same, because it runs that same NFKD-then-[^a-z0-9] pair in that order.
-- (Extensions are not unheard-of here — 021/023/031/032/057 each
-- `create extension if not exists pg_cron` — but always inside a best-effort DO
-- block that degrades to a NOTICE when the extension is missing. A business key
-- cannot degrade: if it silently stopped folding accents, 2c would silently stop
-- fencing.)
--
-- WHY NOT THE HAND-ROLLED translate() PAIR THIS FILE FIRST CARRIED: it
-- tabulated the 123 lowercase codepoints of U+00C0..U+024F, and that range is not
-- the range normalizeName() folds — NFKD folds all of Unicode. Enumerated in node
-- against the real module: 761 BMP codepoints that normalizeName() reduces to
-- bare ASCII were turned into a SEPARATOR by the pair instead. 246 of them sit in
-- U+1E00..U+1EFF (126 lowercase) — that is every Vietnamese vowel-with-tone — and
-- the rest are the fullwidth forms (62), enclosed alphanumerics (139), the
-- enclosed-CJK and CJK-compatibility blocks (181, e.g. ㎏), the letterlike,
-- number-form and superscript blocks, the phonetic extensions, the
-- ª º ¹ ² ³ ordinals and the ﬁ ﬂ ligatures. Concretely, and this is the
-- failing case the fix exists for: vendor_name_key('Phở Saigon') came out
-- 'ph saigon' where normalizeName() gives 'pho saigon', so a chain's second row
-- typed without tone marks ('Pho Saigon') was NOT recognised as a sibling, the
-- EXISTS in 2c was false, and the cross-location double-pay stayed open for
-- exactly the cuisine most likely to trigger it. Both spellings now key to
-- 'pho saigon'. The lesson is not "the table was too short" — it is that a table
-- is the wrong tool; core Unicode data is already in the server.
--
-- ⚠ ONE INHERITED ASSUMPTION, unchanged by this rewrite: lower() must fold
-- non-ASCII, i.e. the database must not be C-collated (it is en_US.UTF-8 on
-- Supabase and in the run.ps1 container). normalize() also requires a UTF-8
-- server encoding. Both were already required by the translate() version, which
-- likewise only listed lowercase codepoints.
create or replace function public.vendor_name_key(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(
           regexp_replace(
             normalize(lower(coalesce(p_name, '')), nfkd),
             E'[\u0300-\u036F]', '', 'g'      -- JS: .replace(/[\u0300-\u036f]/g, '')
           ),
           '[^a-z0-9]+', ' ', 'g'
         ));
$$;

comment on function public.vendor_name_key(text) is
  'Normalised form of a vendors.name, for "is this the same business?" '
  'comparisons. The SQL twin of normalizeName() in src/lib/receipt.js, built '
  'from the same five operations (lower, NFKD, strip U+0300..U+036F, collapse, '
  'trim), so the two agree over all of Unicode — keep them in step, since '
  'claim_receipt uses this to fence the rows matchVendor() may swap between by '
  'tie-collapse. '
  'Immutable, so it may be indexed.';

revoke execute on function public.vendor_name_key(text) from public, anon, authenticated;
grant  execute on function public.vendor_name_key(text) to service_role;


-- ---------- 2. claim_receipt ----------
--
-- migration-038's body verbatim, with ONE new gate immediately before the
-- insert (section 2c below). Everything else — the freshness window, the skew
-- allowance, the 3/day advisory-locked cap, the counter double-dip check, the
-- rcpt- token and the award_points hand-off — is unchanged, in the same order,
-- for the reasons migration-038 gives.
--
-- The new gate goes LAST, just before the insert, so no existing error changes
-- precedence: a student who is already at their daily cap still sees
-- RECEIPT_DAILY_LIMIT rather than RECEIPT_CLAIMED, exactly as they do today
-- when the unique index is what would have caught them.

create or replace function public.claim_receipt(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_receipt_local timestamp,   -- naive printed date+time, e.g. '2026-08-07 18:42:00'
  p_timezone      text,        -- punchTimezone() — one campus clock, same as punch_in
  p_total         numeric,
  p_points        integer      -- computed server-side: floor(total × ratio × tier), like /api/vendor/award
)
returns table (claim_id uuid, new_balance integer, new_community integer)
language plpgsql security definer set search_path = public
as $$
declare
  c_max_age   constant interval := interval '7 days';
  c_skew      constant interval := interval '1 hour';    -- receipt printers keep loose clocks
  c_dup_slop  constant interval := interval '5 minutes'; -- counter award vs printed time
  c_daily_cap constant integer  := 3;
  c_max_total constant numeric  := 200;                  -- mirror of MAX_AWARD_DOLLARS

  v_receipt_at timestamptz;
  v_claims_today integer;
  v_claim_id uuid;
  v_token text;
  -- Which business this till belongs to, for the cross-location dedup below.
  v_pool uuid;
  v_name_key text;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- award_points() sets it again itself; both are transaction-local.
  perform set_config('app.points_write', 'server', true);

  if p_total is null or p_total <= 0 then
    raise exception 'RECEIPT_TOTAL_MISSING';
  end if;
  if p_total > c_max_total then
    raise exception 'RECEIPT_TOTAL_TOO_LARGE';
  end if;
  if p_points is null or p_points <= 0 then
    raise exception 'RECEIPT_TOTAL_MISSING';
  end if;

  -- The printed wall-clock time, pinned to the campus timezone. Same policy as
  -- punch_in: the server passes the zone so there is exactly one definition.
  v_receipt_at := p_receipt_local at time zone p_timezone;

  if v_receipt_at > now() + c_skew then
    raise exception 'RECEIPT_IN_FUTURE';
  end if;
  if v_receipt_at < now() - c_max_age then
    raise exception 'RECEIPT_TOO_OLD';
  end if;

  -- Daily cap, race-proof. A bare count can't be: two concurrent claims both
  -- read 2 and both insert. The advisory xact-lock serializes THIS student's
  -- claims for the transaction; different students don't contend.
  perform pg_advisory_xact_lock(hashtextextended('receipt_claims:' || p_user_id::text, 0));

  select count(*) into v_claims_today
  from receipt_claims rc
  where rc.user_id = p_user_id
    and (rc.created_at at time zone p_timezone)::date = (now() at time zone p_timezone)::date;
  if v_claims_today >= c_daily_cap then
    raise exception 'RECEIPT_DAILY_LIMIT';
  end if;

  -- Counter double-dip: the vendor already awarded this student this exact
  -- amount at the terminal within ±5 min of the printed time — that IS this
  -- purchase, already paid out. Excludes rcpt-* rows so receipt-vs-receipt
  -- dedup stays the unique index's job (a second, genuinely different receipt
  -- with an identical total minutes later must not false-positive against the
  -- student's own first claim). Uses idx (user_id, vendor_id, created_at).
  if exists (
    select 1 from transactions t
    where t.user_id = p_user_id
      and t.vendor_id = p_vendor_id
      and t.type = 'earn'
      and t.dollar_amount = p_total
      and t.created_at between v_receipt_at - c_dup_slop and v_receipt_at + c_dup_slop
      and (t.client_token is null or t.client_token not like 'rcpt-%')
  ) then
    raise exception 'RECEIPT_ALREADY_EARNED';
  end if;

  -- ---- 2c. ONE CLAIM PER RECEIPT, PER BUSINESS (new in migration-059) ----
  --
  -- The unique index below can only see one vendor_id, and which vendor_id a
  -- chain's receipt resolves to is decided by matchVendor from the ACTIVE
  -- vendor list — so deactivating a location, or adding one whose uuid sorts
  -- lower, re-points the same photograph at a sibling and every per-vendor
  -- dedup key misses. See the migration header for the full walk-through.
  --
  -- Read the scanned vendor's identity without a row lock, deliberately: this
  -- branch writes nothing to vendors, and a pool join committing in the same
  -- instant can at worst cost us the pool arm of the test — the name arm still
  -- covers a chain that spells its name the same way at every till, which is
  -- every chain that has not been pooled yet. Same reasoning as the read-only
  -- pool lookups in migration-045.
  select v.pool_id, public.vendor_name_key(v.name)
    into v_pool, v_name_key
    from vendors v
   where v.id = p_vendor_id;

  -- `active` is pointedly NOT in the sibling query: the location that won the
  -- FIRST claim being switched off is the commonest way this bug is triggered,
  -- so the retired till must still be able to refuse a re-scan of its own
  -- receipt. Expressed as `vendor_id in (...)` rather than a join so the lookup
  -- still leads with idx_receipt_claims_once's first column, one probe per
  -- sibling — the same shape migration-045 uses to clear a pool's live redeem
  -- codes. A chain is a dozen rows at the outside.
  --
  -- The two arms are sameBusiness() in src/lib/receipt.js, character for
  -- character: a shared pool, OR an identical normalised name. An empty name key
  -- matches nothing, mirroring matchVendor's `if (!vn) continue;` — a vendor
  -- whose name normalises away cannot be matched from a receipt at all, and
  -- without this every such row would count as a sibling of every other.
  if exists (
    select 1
      from receipt_claims rc
     where rc.receipt_at = v_receipt_at
       and rc.total      = p_total
       and rc.vendor_id in (
         select sib.id
           from vendors sib
          where (v_pool is not null and sib.pool_id = v_pool)
             or (coalesce(v_name_key, '') <> ''
                 and public.vendor_name_key(sib.name) = v_name_key)
       )
  ) then
    -- The same error the unique index's own handler raises, on purpose: to the
    -- student this IS "that receipt has already been claimed", and server.js's
    -- central error map matches by SUBSTRING, so reusing the string reuses the
    -- message, the status code and the terminal copy with no new mapping.
    raise exception 'RECEIPT_CLAIMED';
  end if;

  -- First insert wins. The check above is a sequential guard — it cannot see an
  -- uncommitted sibling claim, and the advisory lock serialises one STUDENT's
  -- claims rather than one business's — so the unique index stays exactly what
  -- migration-038 made it: the race backstop that turns two-phones-ONE-TILL into
  -- a clean loser-sees-RECEIPT_CLAIMED, whatever the commit interleaving.
  --
  -- What it cannot do is span vendor_ids, which is what 2c is for — and 2c in turn
  -- only sees COMMITTED rows, so two overlapping submissions that resolve to two
  -- SIBLING vendor_ids fall between the two guards and are paid twice. That is
  -- residual (ii) in this file's header, where the reasons a second advisory lock
  -- or a wider unique index cannot close it are set out; do not read this comment
  -- as saying the race is fenced.
  begin
    insert into receipt_claims (user_id, vendor_id, receipt_at, total, points)
    values (p_user_id, p_vendor_id, v_receipt_at, p_total, p_points)
    returning id into v_claim_id;
  exception when unique_violation then
    raise exception 'RECEIPT_CLAIMED';
  end;

  -- Token from the receipt's natural key: the same receipt always derives the
  -- same token, so award_points' (vendor_id, client_token) unique index is a
  -- second backstop behind the index above — and the community mint, revisit
  -- bump, and idempotency arrive with it for free.
  --
  -- ⚠ Still keyed on p_vendor_id, and therefore still blind to the sibling
  -- swap on its own. That is not a second hole: 2c refuses the claim before
  -- this line is ever reached. Changing the token to a business key would be a
  -- worse fix — it would silently re-point every future token for every pooled
  -- vendor and break idempotency against the rows already in transactions.
  v_token := 'rcpt-' || md5(p_vendor_id::text || '|' || v_receipt_at::text || '|' || p_total::text);

  return query
    select v_claim_id, a.new_balance, a.new_community
    from award_points(p_user_id, p_vendor_id, p_points, p_total, v_token) a;
end;
$$;

revoke execute on function public.claim_receipt(uuid, uuid, timestamp, text, numeric, integer) from public, anon, authenticated;
grant  execute on function public.claim_receipt(uuid, uuid, timestamp, text, numeric, integer) to service_role;


-- ---------- 3. vendor_reset_request ----------
--
-- migration-047 §6's body verbatim, with one clause added to the throttle
-- predicate (and the guess cap it needs declared above the body). The doc comment
-- below is migration-047's, extended to say what the throttle now covers — the old
-- text described a 120-second window as the whole rule, and it no longer is.
--
-- The lookup-by-address twin of migration-031's vendor_reset_issue. Everything
-- security-relevant about that function is preserved: the code arrives already
-- hashed (Node holds the only plaintext, exactly once), the TTL is applied
-- here, and any outstanding SELF-SERVE code for the login is superseded.
--
-- ZERO ROWS means "no vendor login at that address" and MUST be rendered by the
-- caller exactly as success is. One row with reset_throttled = true means "there
-- is a login, but it is not time to mint another code" — either a self-serve
-- code was minted moments ago, or an operator-minted code is still usable (live
-- AND with a guess left; see the throttle comment in the body). The caller still
-- answers identically to the client, and simply does not send a second email.

create or replace function public.vendor_reset_request(
  p_email            text,
  p_code_hash        text,
  p_ttl_minutes      integer default 30,
  p_cooldown_seconds integer default 120
)
returns table (
  reset_id          uuid,
  reset_email       text,
  reset_expires_at  timestamptz,
  reset_vendor_name text,
  reset_throttled   boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  -- The guess cap the recover endpoint actually charges against: MAX_ATTEMPTS in
  -- src/routes/vendor-recover.js, passed to vendor_reset_begin as p_max_attempts,
  -- which itself defaults to the same 5 (migration-031, vendor_reset_begin). This
  -- function cannot take the cap as an argument — its signature is byte-identical
  -- to migration-047's on purpose (see this file's header) — so the constant is
  -- restated here. If MAX_ATTEMPTS ever changes, change it here too; being too
  -- HIGH only costs one throttled self-serve request, being too LOW only costs one
  -- superseded operator code, so neither direction is a security hole.
  c_attempt_cap constant integer := 5;

  v_email   text := lower(trim(coalesce(p_email, '')));
  v_user    uuid;
  v_vendor  uuid;
  v_name    text;
  v_expires timestamptz;
begin
  if v_email = '' then return; end if;

  select u.id into v_user from auth.users u
   where lower(u.email) = v_email
   limit 1;
  if v_user is null then return; end if;              -- no account: zero rows

  -- Must be staff of SOMETHING. A student account at the same address is not a
  -- vendor login and must not be resettable through the terminal's form; the
  -- student app has Supabase's own recovery for that.
  --
  -- One login can run several locations (migration-043). Which vendor id is
  -- recorded matters only for the audit trail, since the reset targets the
  -- LOGIN — so take the oldest link, deterministically.
  select vs.vendor_id, v.name into v_vendor, v_name
    from public.vendor_staff vs
    join public.vendors v on v.id = vs.vendor_id
   where vs.user_id = v_user
   order by v.created_at, v.id
   limit 1;
  if v_vendor is null then return; end if;            -- not a vendor: zero rows

  -- Throttle. See the migration-047 header: the real risk is not mailbombing, it
  -- is that an unthrottled public endpoint can supersede a vendor's live code on
  -- repeat and lock them out of their own recovery.
  --
  -- TWO REASONS TO REFUSE, not one:
  --
  --   (a) a SELF-SERVE code was minted for this login inside the cooldown. The
  --       original rule, unchanged: past the cooldown a fresh self-serve code
  --       supersedes the stale one, so a vendor whose first mail went to spam
  --       can ask again. behavior-047 section O pins this.
  --
  --   (b) an OPERATOR-MINTED code is still USABLE — protected for its whole
  --       remaining lifetime, not for 120 seconds (new in migration-059), but only
  --       for as long as it can still be typed; "usable" is defined exactly in the
  --       note below these two arms, and it is NOT simply `used_at is null`. Such a
  --       code exists because somebody phoned in, very often because they CANNOT
  --       reach the mailbox this function would mail; retiring it mid-call replaces
  --       a code being read aloud with one that will never be read. The vendor then
  --       types the dictated code, vendor_reset_begin compares it against the
  --       newest live row (which is now the self-serve one), and they get
  --       RESET_INVALID plus one attempt off their five. Either an attacker who
  --       knows the address does that on a loop — src/routes/vendor-recover.js's
  --       per-IP limiter allows one every ~3 minutes — or the vendor does it to
  --       themselves by tapping "Email me a code" two minutes into the call.
  --
  --       The minter is created_by. 'self-serve' is the literal migration-047
  --       writes (behavior-047 M2 asserts it); anything else is an admin's email
  --       from vendor_reset_issue, or NULL where no p_created_by was passed.
  --       coalesce() therefore reads NULL as operator-minted, which is the
  --       conservative direction: the cost of being wrong is one throttled
  --       self-serve request that the caller already renders as success, against
  --       a vendor locked out mid-recovery.
  --
  -- WHAT "STILL USABLE" MEANS, EXACTLY — and it is not `used_at is null`.
  --
  -- vendor_reset_begin (migration-031) charges the burn on attempt cap+1, not on
  -- cap: it sets used_at only `when r.attempts + 1 > greatest(coalesce(
  -- p_max_attempts, 5), 1)`, so that a vendor's LAST allowed try still gets a real
  -- comparison. The consequence here is that a code whose five allowed guesses are
  -- all spent sits at attempts = 5 with used_at STILL NULL and expires_at still in
  -- the future — and it is already dead: the next vendor_reset_begin burns it and
  -- returns the hash as null, so no further comparison is possible and nobody can
  -- be reading a usable code down a phone line.
  --
  -- So arm (b) below tests attempts as well. Without that test, a vendor who
  -- mis-heard the dictated code and used up all five guesses would be refused a
  -- self-serve code for the REST of the 30-minute TTL, leaving them with no
  -- working recovery path at all (short of a deliberate sixth wrong guess to
  -- trigger the burn) — strictly worse than the denial of service this arm was
  -- added to fix.
  --
  -- Arm (a) stays purely time-based, deliberately: 120 seconds is the
  -- self-serve-supersedes-self-serve cooldown that behavior-047 section O pins,
  -- and an exhausted self-serve code is superseded by the next request as soon as
  -- that cooldown lapses anyway.
  --
  -- Both arms still require used_at is null and expires_at > now(), so a used,
  -- burned, superseded or expired code blocks nothing either way.
  if exists (
    select 1 from public.vendor_password_resets pr
    where pr.user_id = v_user
      and pr.used_at is null
      and pr.expires_at > now()
      and (
        pr.created_at > now() - make_interval(secs => greatest(coalesce(p_cooldown_seconds, 120), 0))
        or (coalesce(pr.created_by, '') <> 'self-serve'
            and coalesce(pr.attempts, 0) < c_attempt_cap)
      )
  ) then
    reset_id := null;
    reset_email := v_email;
    reset_expires_at := null;
    reset_vendor_name := v_name;
    reset_throttled := true;
    return next;
    return;
  end if;

  v_expires := now() + make_interval(mins => greatest(coalesce(p_ttl_minutes, 30), 1));

  -- Supersede whatever is still outstanding. By the time control reaches here the
  -- test above has established that nothing STILL USABLE is in the way, so the
  -- filter-free update can only retire (i) a self-serve code past its cooldown —
  -- exactly the case migration-047 wrote it for — or (ii) an operator-minted code
  -- that has already spent all c_attempt_cap of its guesses and can therefore
  -- never be compared again. Retiring (ii) is the point: it is what gives the
  -- vendor a way back in, and it costs nothing, because the row it clears would
  -- have been burned by the next vendor_reset_begin anyway.
  update public.vendor_password_resets
     set used_at = now()
   where user_id = v_user
     and used_at is null;

  insert into public.vendor_password_resets
    (vendor_id, user_id, email, code_hash, expires_at, created_by)
  values
    (v_vendor, v_user, v_email, p_code_hash, v_expires, 'self-serve')
  returning id, email, expires_at into reset_id, reset_email, reset_expires_at;

  reset_vendor_name := v_name;
  reset_throttled := false;
  return next;
end;
$$;

revoke execute on function public.vendor_reset_request(text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.vendor_reset_request(text, text, integer, integer) to service_role;

commit;
