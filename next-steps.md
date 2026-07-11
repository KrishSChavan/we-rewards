# Next steps

The four items that used to live here — **automated tests + CI**, a **void/refund
flow**, **vendor self-service settings**, and **student data export/deletion** —
are now implemented. What each became, and the smaller follow-ups they left behind,
are below.

---

## ✅ Done

### 1. Automated tests + CI
- `node:test` (no new runtime deps). `npm test` / `npm run test:unit` / `npm run test:integration`.
- **Unit:** `scoreProfile` (extracted as a pure function from `computeTierProfile`)
  covers the score/tier/multiplier mapping and both anti-farming caps; a middleware
  test covers the `requirePin` no-token / no-PIN branches.
- **Integration + security** (`test/integration/`): award, single-use redeem,
  insufficient-balance rollback, expired code, and the void/refund reversal;
  anon/authenticated denied on `award_points`/`redeem_by_code`; a PIN route with no
  `X-Vendor-Pin` returns `PIN_REQUIRED`. **Opt-in** — skip unless `TEST_SUPABASE_*`
  point at a disposable project.
- **CI:** `.github/workflows/ci.yml` runs the unit suite on push/PR (+ advisory `npm audit`).

### 2. Void / refund
- `supabase/migration-010.sql`: `reverses` / `reversed_by` link columns +
  `reverse_transaction(p_transaction_id, p_vendor_id)` (SECURITY DEFINER,
  service-role only). Writes a compensating (negated) row, never deletes; balance
  clamps at 0; refuses to double-reverse or reverse a reversal.
- `POST /api/vendor/reverse` (PIN-gated); analytics rollup made sign-aware so a
  void nets out. Terminal **STATS → Recent activity** has a two-tap **Undo**.

### 3. Vendor self-service settings
- `GET`/`PATCH /api/vendor/settings` (PIN-gated) with strict validation; PIN
  re-hashed with bcrypt and existing sessions invalidated on change. Terminal
  **SETTINGS** tab edits ratio, exact-entry, tier buttons, and PIN. No schema change.

### 4. Student data export + deletion
- `GET /api/me/export` (JSON download) and `POST /api/me/delete` in the Account tab.
- Deletion cascades profile/balances/codes/score; `supabase/migration-011.sql`
  switches `transactions.user_id` to `ON DELETE SET NULL` so history is **anonymized**
  (kept), not cascade-deleted — vendor revenue totals stay intact.

---

## ✅ Also done (a second pass)

- **Quick-amount buttons are now a set dollar value** (`{label, amount}`, was a
  `{min,max}` range) and **render as tap-to-award buttons on the AWARD screen**.
  `migration-012.sql` converts existing rows; `allow_exact_entry = false` now hides
  the keypad (falling back to it if a vendor has no quick buttons).
- **Cashier-facing "Undo last"** on the AWARD/REDEEM scan screens (two-tap confirm,
  PIN-gated), in addition to the per-row Undo on STATS.

## Smaller follow-ups still open

- **Run the DB test suite for real.** The integration/security suites are written
  but unverified here (no local Docker for `supabase start`). Stand up a disposable
  project (or a CI `supabase/setup-cli` job), apply schema + migrations, set
  `TEST_SUPABASE_*`, and confirm they pass; add the secrets to CI.
- **Multi-instance rate limiting.** The in-memory `express-rate-limit` store is
  correct for one instance only; swap in a shared store (e.g. `rate-limit-redis`)
  before running more than one.

---

*Already done before this pass (unchanged): the security hardening (migration-007
RPC lockdown, server-side PIN + idle timeout, rate limiting, helmet), the tier
write-amplification fix, fractional multipliers, the vendor analytics screen, and
the UX/docs cleanup.*
