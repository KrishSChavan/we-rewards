# Next steps

Deferred work, roughly in priority order. Each entry says *why it matters*, *what
to build*, and *where it touches the code*.

---

## 0. Landing page UI

**changes** there is a bar that is covering the EAT FREE words so move that bar down a little. Also the Free drink pill is hiding the hint behind it so move the pill down a little.


## 1. Automated tests + CI

**Why.** Points behave like money. The atomic RPCs (`award_points`,
`redeem_by_code`) and the tier math (`src/lib/tiers.js`) are the places a subtle
regression silently hands out free food or double-redeems a reward. There is
currently no test suite, so every change is validated by hand.

**What to build.**
- A test runner (Node's built-in `node:test`, or Vitest) with an npm `test` script.
- **Unit tests** for `computeTierProfile` — feed synthetic transaction sets and
  assert the score/tier/multiplier and the anti-farming caps (one visit per
  vendor per day, $30 spend cap per visit).
- **Integration tests** against a disposable Supabase (local `supabase start`, or
  a throwaway project) for the money paths: award adds the right points, redeem
  deducts atomically, a double-submit of one redeem code only redeems once, an
  insufficient balance rolls back, and an expired/rotated code is rejected.
- **Security regression tests** that lock in migration-007: an `anon`/`authenticated`
  client is *denied* on `award_points`/`redeem_by_code`, and a redeem/manage
  request without a valid `X-Vendor-Pin` returns `PIN_REQUIRED`.
- **CI** (GitHub Actions): run the suite on every push/PR. Optionally `npm audit`.

**Where.** New `test/` dir; `package.json` scripts; `.github/workflows/ci.yml`.
No product code changes — this documents and protects existing behavior.

---

## 2. Void / refund flow

**Why.** Cashiers will fat-finger amounts (award on $150 instead of $15) and
redeem the wrong item. Today the only fix is editing rows in the Supabase
dashboard — impractical mid-shift and invisible in the audit trail.

**What to build.**
- A new RPC `reverse_transaction(p_transaction_id, p_vendor_id)` (SECURITY
  DEFINER, service-role only like the others) that, in one transaction: verifies
  the transaction belongs to this vendor, writes a *compensating* transaction
  (an `earn` becomes a negative correction, a `redeem` refunds the points),
  adjusts `point_balances`, and refuses to double-reverse. Keep the original row
  — never delete — so history stays auditable.
- A server route `POST /api/vendor/reverse` (behind `requireVendor` + `requirePin`).
- Terminal UI: a "Last transaction" strip on the AWARD/REDEEM result with an
  "Undo" affordance, or a short recent-activity list on the STATS tab with a
  reverse button. Confirm-before-acting, then a flood result.

**Where.** New `supabase/migration-008.sql`; `src/routes/vendor.js`;
`public/vendor/terminal.js` + `terminal.css`. Consider a `reversed_by`/`reverses`
column on `transactions` to link the pair.

---

## 3. Vendor self-service settings

**Why.** `points_per_dollar`, the tier button ranges (`vendors.tiers`),
`allow_exact_entry`, and the staff PIN can only be changed by editing the
`vendors` row in the dashboard or re-running the onboarding script. A vendor
can't tune their own economics.

**What to build.**
- `GET`/`PATCH /api/vendor/settings` (behind `requireVendor` + `requirePin`) with
  strict validation: ratio within sane bounds, tiers well-formed
  (ascending, non-overlapping), PIN re-hashed with bcrypt when changed.
- A "Settings" area on the terminal (likely a section within STATS or a 5th tab)
  to edit ratio, toggle exact entry, edit tier buttons, and change the PIN.
- Changing the PIN should invalidate existing `vendor_pin_sessions` for that
  vendor (delete its rows) so old sessions can't linger.

**Where.** `src/routes/vendor.js`; `public/vendor/*`. Reuse the existing bcrypt
hashing from `scripts/onboard-vendor.js`. No schema change needed (columns exist).

---

## 4. Student data deletion + export

**Why.** The app collects Google identity (name, email, avatar) and full spend
history. "Delete my data" and "download my data" are baseline privacy
expectations (and GDPR/CCPA-style obligations) and there is no path today.

**What to build.**
- `GET /api/me/export` — returns the signed-in student's profile, balances, and
  transaction history as JSON (a download in the Account tab).
- `POST /api/me/delete` — deletes the auth user via the admin API; the existing
  `on delete cascade` foreign keys already remove `profiles`, `point_balances`,
  `transactions`, `earn_codes`, `redeem_codes`, `user_scores`. Decide the policy
  for vendor-side history: keep **anonymized** transaction rows (so a vendor's
  revenue totals don't silently change) vs. full cascade — document whichever you
  choose.
- Account tab UI: "Download my data" and a confirm-guarded "Delete my account."

**Where.** `src/routes/student.js`; `public/student/app.js` + `index.html`
(Account tab). Deletion uses `supabaseAdmin.auth.admin.deleteUser(...)`.

---

*Not tracked here because they're already done: the security hardening
(migration-007 RPC lockdown, server-side PIN, rate limiting, helmet), the tier
write-amplification fix, the vendor analytics screen, and the UX/docs cleanup.*
