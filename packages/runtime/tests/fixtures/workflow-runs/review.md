Now I have all the evidence. Let me compile the review.

---

Review: `add-coupons` against `main`: 2 files, +32/-0
Verdict: **BLOCK**: the expiry check is inverted — valid coupons are rejected and expired ones are accepted (P0 bug), and the test that would catch it is skipped

Findings (4, most serious first):

1. **[P0]** (confidence 10/10) `src/coupons.js:12`: `if (coupon.expires && new Date(coupon.expires) > today) return sum` — the expiry check is inverted. `new Date('2026-12-31') > new Date('2026-11-01')` is `true`, so a coupon that is still valid returns the full sum with no discount. Once past 2026-12-31, the coupon starts applying. Valid coupons are rejected; expired ones are accepted.
   Scenario: A customer uses `HALF` on 2026-11-01 (well before expiry). The condition `new Date('2026-12-31') > today` is true, so the function returns the undiscounted sum instead of 50% off.
   Fix: Change `>` to `<` (or `<=` if the coupon is valid *on* its expiry date). The documented intent says "expires" — `>=` would also be wrong; the correct comparison depends on whether `expires` means "last valid day" or "first invalid day." Given the date `2026-12-31`, `<=` (valid through end of day) is the safer interpretation: `if (coupon.expires && new Date(coupon.expires) < today) return sum`.

2. **[P1]** (confidence 10/10) `tests/coupons.test.js:10`: `test.skip('HALF halves a big cart before it expires', ...)` — an unjustified gate removal. This test exercises the expiry logic and would catch the inverted comparison above. Nothing in the diff justifies skipping it.
   Fix: Unskip the test and fix the expected value. With the bug fixed, `applyCoupon([{ price: 6000, qty: 1 }], 'HALF', new Date('2026-11-01'))` returns `3000` as the test expects.

3. **[P2]** (confidence 10/10): No CHANGELOG entry and no version bump. `AGENTS.md` requires both for every user-facing change; `package.json` is still `0.3.0` from the cart-total feature.
   Fix: Add a CHANGELOG entry under a new version (e.g. `0.4.0`) and bump `version` in `package.json`.

4. **[P3]** (confidence 6/10) `src/coupons.js:9`: `code.toUpperCase()` throws `TypeError` if `code` is `null` or `undefined`. The function is a trust boundary — `code` comes directly from the caller with no guard.
   Scenario: `applyCoupon(cart, null)` crashes instead of treating it as an unknown code.
   Fix: `const coupon = COUPONS[(code || '').toUpperCase()]`

Gate changes:
- `tests/coupons.test.js:10` — `test.skip` on the HALF expiry test: not justified by anything in this diff. This silences the failure the P0 bug would produce.

Checks: `npm run test` passes (2 pass, 1 skip). The skipped test is the gate change.

Not covered: no integration or caller of `applyCoupon` exists yet — the function is unreferenced outside its own file and tests.

Low confidence: none