---
name: sharesight-already-imported-classification
description: why identity-only matching (fingerprint/source_reference) cannot answer "is this row already imported" for Sharesight sync, the value-aware pattern BRK-014 used, why the value-comparison field set must match the batch-digest's field set (review B1), and why a digest field also needs a FAITHFUL (unconditional or knowably-null) committed counterpart before it can be compared, not just a mention in the digest (review round 3)
metadata:
  type: project
---

A Sharesight trade/payout's `fingerprint` (and therefore its commit-time
`source_reference`) is IDENTITY-ONLY — `sharesight-trade:<id>` or
`payoutIdentityKey` (`sharesight-payout:<portfolioId>:<holdingId>:<paidOnDate>`)
— and is deliberately unaffected by a value correction (see
`canonicalRowDigestFields`'s BRK-005 finding-B1 doc comment in
`app/sharesight-sync-service.ts`: a corrected re-fetch changes the BATCH
digest via value-bearing fields, precisely so the row's identity/source_reference
stays the SAME and cross-batch dedupe still finds it).

This means: for ANY feature that needs to answer "does this incoming row
represent a genuine no-op versus new information" (BRK-014's "already
imported" sync-result count was the concrete case), identity match alone
(`existingDividendSourceReferences`/`existingTradeSourceReferences` in
`domain/imports/reconciliation.ts`, or any query keyed purely on
`source_reference`) is NOT sufficient and will wrongly classify a genuine
value CORRECTION as "already imported" — exactly the case the digest fields
exist to keep visible. `dividendAlreadyBoundForSkip`/`tradeAlreadyBoundForSkip`
in `reconciliation.ts` are identity-only for a DIFFERENT, narrower reason
(suppressing an advisory warning that's guaranteed noise on a row that will
skip regardless of value) — do not reuse those flags as a value-correction-aware
signal; they are not one.

**The fix pattern** (`app/sharesight-sync-service.ts`'s `isRowAlreadyImported`,
`db/repositories/sharesight-sync-state.ts`'s `loadCommittedSharesightRowValues`):
add a query returning the CURRENTLY-COMMITTED VALUE fields keyed by
`source_reference`, mirroring `import-commit.ts`'s own exact-match identity
predicates (no `status`/`superseded_by_record_id` filter — must match what
commit itself treats as "already present", per the established "reproduce
the reviewer's exact predicate" discipline in
[[import-reconciliation-advisory-warning-pattern]] note 15). Then classify a
row as already-imported only when identity AND value both match
(exact-decimal comparison via `parseDecimal`/`compareDecimal`, never
string/`Number()` compare; a business date via exact string equality); a
value mismatch, or either side missing, must count as "new" (the
conservative direction — an uncertain comparison must never read as
confirmed-unchanged).

**REVIEW ROUND B1 CORRECTION (2026-09-03, blocking): the value-comparison field
set must match the field set that decided whether a batch is new at all, not
some smaller "seems representative" subset.** The first version of this fix
compared only trade quantity/price and payout cash-total — 3 of the 13
value-bearing fields `canonicalRowDigestFields` hashes to decide whether a
Sharesight re-fetch stages as a NEW batch. A franking-only or trade-date-only
correction therefore changed the digest (genuinely new batch) while the
narrower classifier still called it "already imported" — self-contradictory:
"no new rows" printed for a batch that exists only because something
changed. **The general lesson: whenever a "did this change" classifier sits
downstream of a "is this a new batch/version" digest over the same entity,
the classifier's field set must be a superset of (ideally identical to) the
digest's value-bearing fields — never picked independently by guessing which
fields "matter most."** The fix widened to: payout `totalFrankingDecimal`
(vs `total_franking_decimal`) and `localTradeDate` (vs `payment_date`, exact
string — `localTradeDate` holds the payment date for a dividend-class row);
trade `commission ?? "0"` (vs `fee_amount_decimal`, mirroring
`import-commit.ts`'s exact `feeAmountDecimal: normalized.commission ?? "0"`
mapping — commission is not asserted non-null upstream, comparing the raw
field against a NOT-NULL-default column would spuriously mismatch),
`localTradeDate` (vs `local_trade_date`, exact string), and `type` (vs
`type`, exact string — the Sharesight transform never populates `cashEvent`,
so `normalized.type` alone already matches `transactions.type`'s vocabulary,
no `cashEvent ?? type` remapping needed here unlike `import-commit.ts`'s
general CSV path). Two tests were added proving the exact failure mode
(franking-only and trade-date-only corrections), each confirmed to fail
against the pre-fix code before the fix landed.

**Honesty-rule interaction**: any such classification computed inside
`runSharesightSyncWithContext` must follow the SAME reused-vs-fresh
discipline `rowsStaged`/`skippedPayouts` already established (BRK-005
review finding B1): on the fresh path, use `transformed.rows`; on the
REUSED path (`started.reused === true`), never trust `transformed.rows`
again — re-derive from the STORED staged rows (`staging.listRows`,
`ImportRowRecord.normalizedFingerprint`/`normalizedFields`) instead. Unlike
`rowsStaged`, this classification must ALSO be recomputed against CURRENT
committed state even on the reused path (not cached from original staging
time), since "is this already committed" can change between when a batch
was first staged and when a later identical-fetch sync reuses it.

**REVIEW ROUND 3 CORRECTION (2026-09-03, blocking): "the digest hashes this
field" is necessary but NOT sufficient to add it to the classifier — the
column it would be compared against must be a FAITHFUL, unconditional
counterpart, or a stored NULL is ambiguous between "unchanged" and "never
independently recorded."** Round 2 (B1 above) widened to a superset of the
digest fields but its own doc comments asserted three false things: that
`symbol`/`exchange`/`currency` were "identity fields already folded into
`sourceReference`" (false — `sourceReference` is
`sharesight-trade:<id>`/`<portfolioId>:<holdingId>:<paidOnDate>` and never
encodes any of them) and that `exchangeRateDecimal` "has no committed
counterpart" (false — `dividend_manual_records.fx_rate_to_portfolio_decimal`
is exactly that). Reproduced end to end: an FX-only payout correction, a
symbol-only payout correction, and a trade currency correction each staged a
new batch while the classifier still called every row "already imported."

Before adding a digest field to the classifier, check where `import-commit.ts`
actually writes its committed counterpart — three outcomes, three different
treatments:

1. **Unconditionally written, verbatim** (e.g. `transactions.currency_code`
   from `normalized.currency`, `import-commit.ts:909`) — a faithful
   counterpart; compare it directly (exact match / `decimalValuesMatch`).
2. **Written only under a condition, with a knowable meaning when absent**
   (e.g. `dividend_manual_records.fx_rate_to_portfolio_decimal`, written only
   when a payout is foreign to its OWN security's currency AND Sharesight
   supplied a rate — `import-commit.ts`'s case B/C-with-rate; NULL for a
   native payout or a foreign payout with no rate) — a stored NULL means "not
   independently recorded," not "unchanged" and not "changed." Compare with
   an explicit three-way helper: stored NULL → not comparable → treat as a
   PASS (does not itself indicate a change) rather than calling the normal
   comparator against it. Getting the default backwards (treating NULL as a
   mismatch) reports every row in the common case — here, every
   native-currency payout — as "new" on every routine no-op re-sync, which
   directly breaks the feature's own core acceptance criterion. This is the
   OPPOSITE default from ordinary null handling elsewhere in this codebase
   (`decimalValuesMatch` conservatively treats a null mismatch as "changed"
   because that comparison OUGHT to have been possible) — the three-way
   helper exists specifically for the "genuinely not comparable" case.
3. **Written under the SAME condition as (2), for a DIFFERENT reason
   (identity/labelling, not economics)** (e.g.
   `dividend_manual_records.currency_code`, populated only when foreign to
   security — same gate as the FX rate) — do NOT apply the three-way
   treatment here. A NULL currency_code for a native payout does not mean
   "matches whatever currency the security has" in a way the classifier can
   safely assume without joining `securities.primary_currency_code` (out of
   scope for a sync-result classifier); leave it genuinely RESIDUAL
   (uncompared) and document why, the same as `symbol`/`exchange` (no
   committed column at all, for either row kind — a mapping decision can
   repoint an identity at a different resolved security independently of any
   other stored value).

**A residual field means the sync result CAN still misreport `alreadyImportedRows`
for a row whose only change is on that field.** Do not let this become
silent: if `startUpload`'s digest still creates a new batch (it will, since
the digest hashes the raw field regardless of what the classifier compares)
while every row the classifier checks reads as unchanged, the caller-facing
message must say so honestly rather than claim "every staged row already
matches an existing record" — see the message-composition rule below.

**Message-composition rule this feeds:** `formatSyncResultMessage`
(`app/sharesight-sync-panel-helpers.ts`) must distinguish `reused: true` +
`newRows: 0` (the fetch was byte-identical to the prior sync — "No new rows"
is literally true) from `reused: false` + `newRows: 0` (a NEW batch — by
construction the digest changed, so if the classifier still reports zero new
rows, the change necessarily landed on a residual/uncompared field). The
second case needs its own sentence naming what WAS checked and that
something outside that set differs; repeating the reused-path wording there
is self-contradictory (a new batch that changed nothing cannot exist). When
fixing a pre-existing test to match this, check whether it was ALREADY
pinning the false shape (a `reused: false` + zero-new fixture asserting the
old universal "No new rows" text) — round 3 found exactly one such test and
had to correct its fixture (`reused: true`), not just add a new one.

See [[import-commit-polymorphic-fk]] and [[import-reconciliation-advisory-warning-pattern]]
for the neighbouring identity/dedupe machinery this sits next to.
