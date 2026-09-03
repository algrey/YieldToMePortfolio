// BUG-013 review follow-up ("fail-open cap"), folded into PRF-009: the
// cap/degrade decision for `existingTradeSourceReferences`
// (`app/import-actions.ts`) extracted into this plain, no-`next/headers`
// sibling so the boundary itself can be unit-tested directly -- mirrors
// `./import-trade-duplicate-check.ts`'s `capExistingTradeRows` extraction
// and the identical constraint it documents (`app/import-actions.ts`
// statically imports `getAuthenticatedSqlContext`, which pulls in
// `next/headers` transitively, so this repo's plain Node test runner cannot
// import it at all). `loadReview`'s use of this function is pinned by a
// source-text assertion instead (see `tests/bug-013.test.ts`).
//
// PRF-009 correction round B1 (BLOCKING): this function is USED ONLY for
// `existingTradeSourceReferences` now. It was originally applied to
// `existingDividendSourceReferences` too, on the reasoning that both were
// pure SUPPRESSION sets; that was WRONG for the dividend set --
// `createImportReconciliationPreview` (`domain/imports/reconciliation.ts`)
// also uses it to split the dividend matching pool into `freshRows`/
// `alreadyImportedRows`, so a fail-open overflow (collapsing it to empty)
// could put a genuinely dedupe-bound row back into `freshRows` and earn it
// a false `DIVIDEND_RECONCILIATION_PROPOSED`. The dividend query
// (`app/import-actions.ts`) is therefore left deliberately UNBOUNDED as a
// COMPARISON set (DIV-016C) and never passed through this function -- see
// its own query's doc comment.
//
// THIS DEGRADE RUNS THE OPPOSITE DIRECTION from `capExistingTradeRows`/
// `capExistingDividendRows` above. Those cap a COMPARISON set: truncating it
// risks a silent FALSE NEGATIVE (an existing entry that would have matched
// falls outside the truncated set, indistinguishable from a genuine
// non-match), so they fail CLOSED -- degrade to "not computed" and disclose
// it. `existingTradeSourceReferences` is a pure SUPPRESSION set instead:
// membership only ever SILENCES an advisory warning for a row already
// independently bound for a commit-time exact-match skip
// (`sourceReferenceKey`, `domain/imports/reconciliation.ts`), and never
// feeds any matching-pool split. Truncating a pure suppression set can only
// ever ADD noise (a row that would have been suppressed shows its warning
// again) -- it can never hide a duplicate, because the row is still skipped
// at commit regardless of whether its warning fired in preview. Failing
// OPEN here (an overflow degrades to an EMPTY set, not a truncated one)
// simply reverts that route to the noisier pre-BUG-013 behaviour a full
// re-sync already regularly produced before that fix -- never a fail-closed
// degrade, which would be strictly wrong for a suppression set.
export function capSuppressionReferenceRows<T>(
  rows: readonly T[],
  max: number,
): { rows: readonly T[]; overflowed: boolean } {
  if (rows.length > max) return { rows: [], overflowed: true };
  return { rows, overflowed: false };
}
