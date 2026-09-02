// BUG-011 review round F-a: the cap/degrade decision for the cross-route
// trade-duplicate check (`TRADE_NEAR_EXISTING_ENTRY` /
// `TRADE_DUPLICATE_CHECK_UNAVAILABLE`, `domain/imports/reconciliation.ts`)
// extracted into this plain, no-`next/headers` sibling so it can be
// unit-tested directly. `app/import-actions.ts` (`loadReview`, the sole
// caller) statically imports `getAuthenticatedSqlContext` from
// `./portfolio-actions`, which pulls in `next/headers` transitively -- this
// repo's plain Node test runner cannot import that file at all (confirmed
// repeatedly elsewhere in this codebase), so before this extraction the
// `length > MAX` boundary itself had no real test, only the already-computed
// `existingTradeEntriesUnavailable` FLAG's downstream handling (which
// `tests/bug-011.test.ts` already covers against the pure reconciliation
// function). `loadReview`'s use of this function is pinned by a
// source-text assertion instead (see `tests/bug-011.test.ts`).
export const MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK = 5_000;

// A query fetches at most `max + 1` rows (the caller's `LIMIT`) so this
// function never needs to count beyond that -- `rows.length > max` is exact
// either way. Exceeding the cap degrades to "not computed" (empty entries,
// `unavailable: true`) rather than returning the truncated first `max` rows,
// which could produce a false NEGATIVE (a real duplicate whose match fell
// outside the truncated set) indistinguishable from a genuine non-match --
// worse than visibly not checking at all.
export function capExistingTradeRows<T>(
  rows: readonly T[],
  max: number,
): { entries: readonly T[]; unavailable: boolean } {
  if (rows.length > max) return { entries: [], unavailable: true };
  return { entries: rows, unavailable: false };
}
