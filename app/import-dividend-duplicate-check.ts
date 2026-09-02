// BUG-013: the dividend equivalent of `import-trade-duplicate-check.ts`'s
// cap/degrade decision, for the query(ies) backing the cross-route dividend
// near-duplicate check (`DIVIDEND_MATCHES_EXISTING_ENTRY` /
// `DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE`, `domain/imports/reconciliation.ts`)
// and DIV-004's proximity check (`DIVIDEND_NEAR_EXISTING_ENTRY`), which now
// share the same widened, uncapped-before-this-task query. Re-exports the
// SAME generic `capExistingTradeRows` decision under a dividend-scoped alias
// (it is a pure `rows.length > max` boundary with no trade-specific logic)
// rather than re-deriving an identical function under a second name --
// mirrors DIV-004's own precedent of reusing DIV-001's
// `PROXIMITY_WINDOW_DAYS` instead of a duplicate constant.
export { capExistingTradeRows as capExistingDividendRows } from "./import-trade-duplicate-check.ts";

// Kept as its own constant (not shared with `MAX_EXISTING_TRADE_ENTRIES_FOR_
// DUPLICATE_CHECK`, even though the value happens to match) so the two
// comparison sets can be tuned independently -- they bound genuinely
// different tables/query shapes.
export const MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK = 5_000;
